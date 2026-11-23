import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSignedOffer, encodeOffer, generateOfferKeyPair } from "../../../packages/protocol/src/index.js";
import { PostgresOfferStore } from "../src/postgres-store.js";
import { SecretCipher } from "../src/secret-cipher.js";
import { JsonOfferStore } from "../src/store.js";

const OLD_KEY = "old-encryption-key-for-tests-0123456789";
const NEW_KEY = "new-encryption-key-for-tests-9876543210";
const connectionString = process.env.TEST_DATABASE_URL;

test("a secret is encrypted under a stretched key and read back", async () => {
  const cipher = new SecretCipher({ key: NEW_KEY });
  const first = await cipher.encrypt("whsec_alpha");
  const second = await cipher.encrypt("whsec_alpha");

  assert.match(first, /^enc:v2:[\w-]+:[\w-]+:[\w-]+:[\w-]+$/);
  assert.doesNotMatch(first, /whsec_alpha/);
  // A fresh nonce every time, one salt for everything this cipher writes.
  assert.notEqual(first, second);
  assert.equal(first.split(":")[2], second.split(":")[2]);
  assert.equal(await cipher.decrypt(first), "whsec_alpha");
  // Another process with the same key reads it, with its own salt for writes.
  const other = new SecretCipher({ key: NEW_KEY });
  assert.equal(await other.decrypt(first), "whsec_alpha");
  assert.notEqual((await other.encrypt("x")).split(":")[2], first.split(":")[2]);

  // The AES key is not a plain hash of the configured key, as it was in v1.
  const [, , , iv, tag, ciphertext] = first.split(":").map((part) => Buffer.from(part, "base64url"));
  assert.throws(() => openWith(createHash("sha256").update(NEW_KEY).digest(), iv, tag, ciphertext));
});

test("the wrong key, a damaged value and a missing key are each refused", async () => {
  const cipher = new SecretCipher({ key: NEW_KEY });
  const stored = await cipher.encrypt("whsec_alpha");
  const damaged = `${stored.slice(0, -2)}${stored.endsWith("A") ? "B" : "A"}A`;

  await assert.rejects(new SecretCipher({ key: OLD_KEY }).decrypt(stored), { code: "SECRET_DECRYPTION_FAILED" });
  await assert.rejects(cipher.decrypt(damaged), { code: "SECRET_DECRYPTION_FAILED" });
  await assert.rejects(cipher.decrypt("enc:v9:a:b:c:d"), { code: "INVALID_ENCRYPTED_SECRET" });
  await assert.rejects(cipher.decrypt("enc:v2:a:b:c"), { code: "INVALID_ENCRYPTED_SECRET" });
  await assert.rejects(new SecretCipher().decrypt(stored), { code: "ENCRYPTION_KEY_REQUIRED" });
});

test("without a key secrets pass through, and plaintext is always readable", async () => {
  const off = new SecretCipher();
  assert.equal(off.enabled, false);
  assert.equal(await off.encrypt("whsec_plain"), "whsec_plain");
  assert.equal(await off.decrypt("whsec_plain"), "whsec_plain");
  assert.equal(await new SecretCipher({ key: NEW_KEY }).decrypt("whsec_plain"), "whsec_plain");
  assert.equal(SecretCipher.formatOf("whsec_plain"), "plaintext");
});

test("values written by earlier versions are still read", async () => {
  const stored = legacyEncrypt("whsec_legacy", OLD_KEY);
  assert.equal(SecretCipher.formatOf(stored), "v1");
  assert.equal(await new SecretCipher({ key: OLD_KEY }).decrypt(stored), "whsec_legacy");
  await assert.rejects(new SecretCipher({ key: NEW_KEY }).decrypt(stored), { code: "SECRET_DECRYPTION_FAILED" });
});

test("during a key change both keys read and only the new one writes", async () => {
  const before = new SecretCipher({ key: OLD_KEY });
  const during = new SecretCipher({ key: NEW_KEY, previousKeys: [OLD_KEY] });
  const after = new SecretCipher({ key: NEW_KEY });

  const underOld = await before.encrypt("whsec_rotating");
  const legacy = legacyEncrypt("whsec_legacy", OLD_KEY);
  assert.equal(await during.decrypt(underOld), "whsec_rotating");
  assert.equal(await during.decrypt(legacy), "whsec_legacy");

  const rewritten = await during.encrypt(await during.decrypt(underOld));
  assert.equal(await after.decrypt(rewritten), "whsec_rotating");
  await assert.rejects(before.decrypt(rewritten), { code: "SECRET_DECRYPTION_FAILED" });
  assert.equal(await during.currentKeyOnly().decrypt(rewritten), "whsec_rotating");
  await assert.rejects(during.currentKeyOnly().decrypt(underOld), { code: "SECRET_DECRYPTION_FAILED" });
});

test("the JSON store re-encrypts every secret under a new key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fiber-offers-rotate-"));
  try {
    const path = join(directory, "offers.json");
    const offer = signedOffer();
    const original = new JsonOfferStore(path, { encryptionKey: OLD_KEY });
    await original.upsertOffer(offer, encodeOffer(offer));
    await original.addWebhook(offer.offer_id, { url: "https://a.example/hook", events: ["invoice.paid"], secret: "whsec_one" });
    await original.addWebhook(offer.offer_id, { url: "https://b.example/hook", events: ["invoice.paid"], secret: "whsec_two" });
    // One secret as an earlier version stored it.
    const file = JSON.parse(await readFile(path, "utf8"));
    file.webhooks[offer.offer_id][0].secret = legacyEncrypt("whsec_one", OLD_KEY);
    await writeFile(path, JSON.stringify(file));

    // The new key alone cannot read it; with the old key alongside it can.
    await assert.rejects(new JsonOfferStore(path, { encryptionKey: NEW_KEY }).listWebhooks(offer.offer_id), {
      code: "SECRET_DECRYPTION_FAILED"
    });
    const rotating = new JsonOfferStore(path, { encryptionKey: NEW_KEY, previousEncryptionKey: OLD_KEY });
    const result = await rotating.reencryptSecrets();
    assert.deepEqual(result, {
      backend: "json",
      secrets: 2,
      reencrypted: 2,
      stored_as_before: { plaintext: 0, v1: 1, v2: 1 }
    });

    const raw = await readFile(path, "utf8");
    assert.doesNotMatch(raw, /whsec_one|whsec_two|enc:v1:/);
    const rotated = new JsonOfferStore(path, { encryptionKey: NEW_KEY });
    assert.deepEqual(
      (await rotated.listWebhooks(offer.offer_id)).map((webhook) => webhook.secret),
      ["whsec_one", "whsec_two"]
    );
    await assert.rejects(new JsonOfferStore(path, { encryptionKey: OLD_KEY }).listWebhooks(offer.offer_id), {
      code: "SECRET_DECRYPTION_FAILED"
    });
    await assert.rejects(new JsonOfferStore(path).reencryptSecrets(), { code: "ENCRYPTION_KEY_REQUIRED" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the PostgreSQL store re-encrypts every secret under a new key", { skip: !connectionString }, async () => {
  const original = new PostgresOfferStore({ connectionString, encryptionKey: OLD_KEY });
  const rotating = new PostgresOfferStore({ connectionString, encryptionKey: NEW_KEY, previousEncryptionKey: OLD_KEY });
  const rotated = new PostgresOfferStore({ connectionString, encryptionKey: NEW_KEY });
  const offer = signedOffer();
  try {
    await original.pool.query("DELETE FROM fiber_webhooks");
    await original.upsertOffer(offer, encodeOffer(offer));
    const first = await original.addWebhook(offer.offer_id, { url: "https://a.example/hook", events: ["invoice.paid"], secret: "whsec_one" });
    await original.addWebhook(offer.offer_id, { url: "https://b.example/hook", events: ["invoice.paid"], secret: "whsec_two" });
    await original.pool.query("UPDATE fiber_webhooks SET secret=$2 WHERE webhook_id=$1", [first.id, legacyEncrypt("whsec_one", OLD_KEY)]);

    await assert.rejects(rotated.listWebhooks(offer.offer_id), { code: "SECRET_DECRYPTION_FAILED" });
    const result = await rotating.reencryptSecrets();
    assert.deepEqual(result, {
      backend: "postgresql",
      secrets: 2,
      reencrypted: 2,
      stored_as_before: { plaintext: 0, v1: 1, v2: 1 }
    });

    const stored = (await original.pool.query("SELECT secret FROM fiber_webhooks WHERE offer_id=$1", [offer.offer_id])).rows;
    assert.ok(stored.every((row) => row.secret.startsWith("enc:v2:")));
    assert.deepEqual(
      (await rotated.listWebhooks(offer.offer_id)).map((webhook) => webhook.secret).sort(),
      ["whsec_one", "whsec_two"]
    );
    await assert.rejects(original.listWebhooks(offer.offer_id), { code: "SECRET_DECRYPTION_FAILED" });

    // A secret that no configured key can read stops the run and changes nothing.
    await original.pool.query("UPDATE fiber_webhooks SET secret=$2 WHERE webhook_id=$1", [
      first.id,
      legacyEncrypt("whsec_one", "some-other-key-entirely")
    ]);
    const untouched = (await original.pool.query("SELECT secret FROM fiber_webhooks ORDER BY webhook_id")).rows;
    await assert.rejects(rotating.reencryptSecrets(), { code: "SECRET_DECRYPTION_FAILED" });
    assert.deepEqual((await original.pool.query("SELECT secret FROM fiber_webhooks ORDER BY webhook_id")).rows, untouched);
  } finally {
    await original.pool.query("DELETE FROM fiber_offers WHERE offer_id=$1", [offer.offer_id]);
    await Promise.all([original.close(), rotating.close(), rotated.close()]);
  }
});

// The v1 format: AES-256-GCM under SHA-256 of the configured key.
function legacyEncrypt(plaintext, configuredKey) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(configuredKey).digest(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `enc:v1:${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${ciphertext.toString("base64url")}`;
}

function openWith(key, iv, tag, ciphertext) {
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function signedOffer() {
  const keys = generateOfferKeyPair();
  return createSignedOffer(
    {
      node_id: `02${randomBytes(32).toString("hex")}`,
      public_key: keys.publicKeyPem,
      resolver_url: "https://resolver.example",
      assets: [{ asset_type: "ckb", symbol: "CKB" }]
    },
    keys.privateKeyPem
  );
}
