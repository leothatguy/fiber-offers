// Encryption of the secrets the resolver stores (webhook signing secrets).
//
// Stored form:  enc:v2:<salt>:<iv>:<tag>:<ciphertext>   (all base64url)
//
// The AES-256-GCM key is derived from RESOLVER_SECRET_ENCRYPTION_KEY with
// scrypt, so someone holding a copy of the database cannot test guesses at the
// configured key cheaply, and the salt stored beside each value means work
// done against one deployment is no use against another. A cipher picks one
// salt for everything it encrypts, so reading a store costs one derivation per
// salt in it, not one per secret; derived keys are cached for the process.
//
// Earlier versions wrote enc:v1:<iv>:<tag>:<ciphertext> with SHA-256 of the
// configured key as the AES key. Those values are still read. They are
// rewritten as v2 by `npm run secrets:rotate`.
//
// Rotation: a cipher can be given previous keys. It encrypts with the current
// key only and decrypts with whichever key fits, so replicas can run with
// both while the stored secrets are re-encrypted.
import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt } from "node:crypto";

const SCRYPT_OPTIONS = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const MAX_CACHED_KEYS = 256;

export class SecretCipher {
  #keys;
  #enabled;
  #salt = randomBytes(16);
  #derived = new Map();

  constructor(options = {}) {
    const usable = (value) => typeof value === "string" && value.length > 0;
    this.#enabled = usable(options.key);
    this.#keys = [options.key, ...(options.previousKeys ?? [])].filter(usable);
  }

  // False when no key is configured: secrets are then stored as given.
  get enabled() {
    return this.#enabled;
  }

  // The same current key and nothing else, to prove a value no longer needs a
  // previous key.
  currentKeyOnly() {
    return new SecretCipher({ key: this.#enabled ? this.#keys[0] : undefined });
  }

  async encrypt(plaintext) {
    if (!this.#enabled || typeof plaintext !== "string") return plaintext;
    const key = await this.#stretchedKey(0, this.#salt);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return ["enc", "v2", this.#salt, iv, cipher.getAuthTag(), ciphertext]
      .map((part) => (Buffer.isBuffer(part) ? part.toString("base64url") : part))
      .join(":");
  }

  async decrypt(value) {
    const format = SecretCipher.formatOf(value);
    if (format === "plaintext") return value;
    if (this.#keys.length === 0) {
      throw cipherError("encrypted webhook secrets require RESOLVER_SECRET_ENCRYPTION_KEY", "ENCRYPTION_KEY_REQUIRED");
    }
    const parts = value.split(":").slice(2);
    if (format === "unknown" || parts.some((part) => part.length === 0)) {
      throw cipherError("stored webhook secret has an invalid encrypted format", "INVALID_ENCRYPTED_SECRET");
    }
    const [salt, iv, tag, ciphertext] = (format === "v2" ? parts : [undefined, ...parts]).map((part) =>
      part === undefined ? undefined : Buffer.from(part, "base64url")
    );

    for (let index = 0; index < this.#keys.length; index += 1) {
      const key = format === "v2" ? await this.#stretchedKey(index, salt) : legacyKey(this.#keys[index]);
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
      } catch {
        // Not this key; try the next one.
      }
    }
    throw cipherError(
      "a stored webhook secret cannot be decrypted with the configured encryption key",
      "SECRET_DECRYPTION_FAILED"
    );
  }

  // "plaintext", "v1", "v2", or "unknown" for an enc: value this version cannot read.
  static formatOf(value) {
    if (typeof value !== "string" || !value.startsWith("enc:")) return "plaintext";
    const parts = value.split(":");
    if (parts[1] === "v1" && parts.length === 5) return "v1";
    if (parts[1] === "v2" && parts.length === 6) return "v2";
    return "unknown";
  }

  // One derivation per (key, salt), shared by concurrent callers.
  #stretchedKey(keyIndex, salt) {
    const id = `${keyIndex}:${salt.toString("base64url")}`;
    let derived = this.#derived.get(id);
    if (!derived) {
      derived = new Promise((resolveKey, rejectKey) => {
        scrypt(this.#keys[keyIndex], salt, 32, SCRYPT_OPTIONS, (error, key) => (error ? rejectKey(error) : resolveKey(key)));
      });
      if (this.#derived.size >= MAX_CACHED_KEYS) this.#derived.delete(this.#derived.keys().next().value);
      this.#derived.set(id, derived);
      derived.catch(() => this.#derived.delete(id));
    }
    return derived;
  }
}

function legacyKey(configuredKey) {
  return createHash("sha256").update(configuredKey).digest();
}

function cipherError(message, code) {
  const error = new Error(message);
  error.code = code;
  error.status = 500;
  return error;
}
