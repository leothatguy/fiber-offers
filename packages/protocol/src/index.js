import {
  createHash,
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify
} from "node:crypto";

export const OFFER_PREFIX = "fbroffer1";
export const OFFER_SCHEME = "fiberoffer-v1";
export const OFFER_HRP = "fbroffer";
export const REVOCATION_SCHEME = "fiberoffer-revocation-v1";
export const SUPPORTED_ASSET_TYPES = new Set(["ckb", "udt", "rgbpp"]);
export const SUPPORTED_NETWORKS = new Set(["mainnet", "testnet", "dev"]);
const bech32Charset = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const bech32mConstant = 0x2bc830a3;

export class FiberOfferError extends Error {
  constructor(message, code = "FIBER_OFFER_ERROR", details = undefined) {
    super(message);
    this.name = "FiberOfferError";
    this.code = code;
    this.details = details;
  }
}

export function generateOfferKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" })
  };
}

export function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }

  if (value && typeof value === "object") {
    return Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .reduce((result, key) => {
        result[key] = canonicalize(value[key]);
        return result;
      }, {});
  }

  return value;
}

export function canonicalStringify(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256Hex(value) {
  const input = typeof value === "string" || Buffer.isBuffer(value) ? value : canonicalStringify(value);
  return createHash("sha256").update(input).digest("hex");
}

export function base64UrlEncode(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return buffer
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export function base64UrlDecode(value) {
  const padded = value.padEnd(value.length + ((4 - (value.length % 4)) % 4), "=");
  return Buffer.from(padded.replaceAll("-", "+").replaceAll("_", "/"), "base64");
}

export function encodeOffer(offer) {
  assertValidOffer(offer, { requireSignature: true });
  return bech32mEncode(OFFER_HRP, Buffer.from(canonicalStringify(offer)));
}

export function decodeOffer(encoded) {
  if (typeof encoded !== "string" || !encoded.startsWith(OFFER_PREFIX)) {
    throw new FiberOfferError("encoded offer must start with fbroffer1", "INVALID_OFFER_ENCODING");
  }

  try {
    const bytes = decodeOfferBytes(encoded);
    const parsed = JSON.parse(bytes.toString("utf8"));
    assertValidOffer(parsed, { requireSignature: true });
    return parsed;
  } catch (error) {
    if (error instanceof FiberOfferError) throw error;
    throw new FiberOfferError("encoded offer body is not valid JSON", "INVALID_OFFER_ENCODING", {
      cause: error.message
    });
  }
}

export function buildUnsignedOffer(input) {
  const offer = {
    ...extensionFields(input),
    scheme: OFFER_SCHEME,
    version: 1,
    network: input.network ?? "testnet",
    node_id: requiredString(input.node_id, "node_id"),
    public_key: requiredString(input.public_key, "public_key"),
    resolver_url: normalizeUrl(input.resolver_url, "resolver_url"),
    description: optionalString(input.description, "description"),
    assets: normalizeAssets(input.assets),
    amount_min: optionalPositiveIntegerString(input.amount_min, "amount_min"),
    amount_max: optionalPositiveIntegerString(input.amount_max, "amount_max"),
    recurrence: normalizeRecurrence(input.recurrence),
    expiry: optionalPositiveInteger(input.expiry, "expiry"),
    single_use: Boolean(input.single_use ?? false),
    metadata: normalizeMetadata(input.metadata)
  };

  if (!SUPPORTED_NETWORKS.has(offer.network)) {
    throw new FiberOfferError("network must be mainnet, testnet, or dev", "INVALID_NETWORK");
  }

  validateAmountBounds(offer);

  const withoutId = stripFields(offer, ["offer_id", "signature"]);
  return {
    ...offer,
    offer_id: `0x${sha256Hex(withoutId)}`
  };
}

export function signOffer(unsignedOffer, privateKeyPem) {
  assertValidOffer(unsignedOffer, { requireSignature: false });
  const key = createPrivateKey(privateKeyPem);
  const payload = Buffer.from(canonicalStringify(stripFields(unsignedOffer, ["signature"])));
  const signature = cryptoSign(null, payload, key);
  return {
    ...unsignedOffer,
    signature: {
      scheme: "ed25519",
      value: base64UrlEncode(signature)
    }
  };
}

export function createSignedOffer(input, privateKeyPem) {
  const unsigned = buildUnsignedOffer(input);
  return signOffer(unsigned, privateKeyPem);
}

export function verifyOffer(offer) {
  assertValidOffer(offer, { requireSignature: true });

  const expectedId = `0x${sha256Hex(stripFields(offer, ["offer_id", "signature"]))}`;
  if (offer.offer_id !== expectedId) {
    return {
      ok: false,
      code: "OFFER_ID_MISMATCH",
      message: "offer_id does not match canonical offer payload"
    };
  }

  try {
    const key = createPublicKey(offer.public_key);
    const payload = Buffer.from(canonicalStringify(stripFields(offer, ["signature"])));
    const signature = base64UrlDecode(offer.signature.value);
    const ok = cryptoVerify(null, payload, key, signature);
    return ok
      ? { ok: true }
      : { ok: false, code: "INVALID_SIGNATURE", message: "offer signature is invalid" };
  } catch (error) {
    return {
      ok: false,
      code: "SIGNATURE_VERIFICATION_FAILED",
      message: error.message
    };
  }
}

export function createOfferRevocation(offer, privateKeyPem, input = {}) {
  assertValidOffer(offer, { requireSignature: true });
  const revocation = {
    scheme: REVOCATION_SCHEME,
    offer_id: offer.offer_id,
    node_id: offer.node_id,
    revoked_at: normalizeUnixTimestamp(input.revoked_at ?? Math.floor(Date.now() / 1000), "revoked_at"),
    reason: optionalString(input.reason, "reason")
  };
  const key = createPrivateKey(privateKeyPem);
  return {
    ...revocation,
    signature: {
      scheme: "ed25519",
      value: base64UrlEncode(cryptoSign(null, Buffer.from(canonicalStringify(revocation)), key))
    }
  };
}

export function verifyOfferRevocation(offer, revocation, options = {}) {
  assertValidOffer(offer, { requireSignature: true });
  if (!revocation || typeof revocation !== "object" || Array.isArray(revocation)) {
    return { ok: false, code: "INVALID_REVOCATION", message: "revocation proof must be an object" };
  }

  const payload = stripFields(revocation, ["signature"]);
  if (
    payload.scheme !== REVOCATION_SCHEME ||
    payload.offer_id !== offer.offer_id ||
    payload.node_id !== offer.node_id
  ) {
    return { ok: false, code: "INVALID_REVOCATION", message: "revocation proof does not match this offer" };
  }

  try {
    const revokedAt = normalizeUnixTimestamp(payload.revoked_at, "revoked_at");
    const now = options.now ?? Math.floor(Date.now() / 1000);
    const maxAgeSeconds = options.maxAgeSeconds ?? 300;
    if (Math.abs(now - revokedAt) > maxAgeSeconds) {
      return { ok: false, code: "REVOCATION_EXPIRED", message: "revocation proof is outside the accepted time window" };
    }
    if (revocation.signature?.scheme !== "ed25519" || typeof revocation.signature.value !== "string") {
      return { ok: false, code: "INVALID_REVOCATION_SIGNATURE", message: "revocation signature is required" };
    }
    const ok = cryptoVerify(
      null,
      Buffer.from(canonicalStringify(payload)),
      createPublicKey(offer.public_key),
      base64UrlDecode(revocation.signature.value)
    );
    return ok
      ? { ok: true }
      : { ok: false, code: "INVALID_REVOCATION_SIGNATURE", message: "revocation signature is invalid" };
  } catch (error) {
    return { ok: false, code: "INVALID_REVOCATION", message: error.message };
  }
}

export function assertValidOffer(offer, options = {}) {
  if (!offer || typeof offer !== "object" || Array.isArray(offer)) {
    throw new FiberOfferError("offer must be an object", "INVALID_OFFER");
  }

  if (offer.scheme !== OFFER_SCHEME) {
    throw new FiberOfferError("offer scheme must be fiberoffer-v1", "INVALID_SCHEME");
  }

  if (offer.version !== 1) {
    throw new FiberOfferError("offer version must be 1", "INVALID_VERSION");
  }

  normalizeNodeId(offer.node_id);
  requiredString(offer.public_key, "public_key");
  normalizeUrl(offer.resolver_url, "resolver_url");
  normalizeAssets(offer.assets);
  optionalString(offer.description, "description");
  optionalPositiveIntegerString(offer.amount_min, "amount_min");
  optionalPositiveIntegerString(offer.amount_max, "amount_max");
  optionalPositiveInteger(offer.expiry, "expiry");
  normalizeRecurrence(offer.recurrence);
  normalizeMetadata(offer.metadata);
  validateAmountBounds(offer);

  if (typeof offer.single_use !== "boolean") {
    throw new FiberOfferError("single_use must be a boolean", "INVALID_SINGLE_USE");
  }

  if (offer.offer_id !== undefined && !/^0x[0-9a-f]{64}$/.test(offer.offer_id)) {
    throw new FiberOfferError("offer_id must be a 0x-prefixed sha256 hex string", "INVALID_OFFER_ID");
  }

  if (options.requireSignature) {
    if (offer.offer_id === undefined) {
      throw new FiberOfferError("offer_id is required on signed offers", "INVALID_OFFER_ID");
    }

    if (!offer.signature || offer.signature.scheme !== "ed25519" || typeof offer.signature.value !== "string") {
      throw new FiberOfferError("offer signature is required", "INVALID_SIGNATURE");
    }
  }

  return true;
}

export function validateResolutionRequest(offer, request) {
  assertValidOffer(offer, { requireSignature: true });

  const amount = requiredPositiveIntegerString(request?.amount, "amount");
  const asset = request?.asset ?? offer.assets[0];

  if (!asset || !offer.assets.some((candidate) => sameAsset(candidate, asset))) {
    throw new FiberOfferError("requested asset is not accepted by this offer", "UNSUPPORTED_ASSET");
  }

  if (
    offer.amount_min !== undefined &&
    offer.amount_max !== undefined &&
    BigInt(offer.amount_min) === BigInt(offer.amount_max) &&
    BigInt(amount) !== BigInt(offer.amount_min)
  ) {
    throw new FiberOfferError(
      `requested amount must match the fixed offer amount (${offer.amount_min})`,
      "AMOUNT_MUST_MATCH_FIXED_AMOUNT"
    );
  }

  if (offer.amount_min !== undefined && BigInt(amount) < BigInt(offer.amount_min)) {
    throw new FiberOfferError("requested amount is below offer minimum", "AMOUNT_TOO_LOW");
  }

  if (offer.amount_max !== undefined && BigInt(amount) > BigInt(offer.amount_max)) {
    throw new FiberOfferError("requested amount is above offer maximum", "AMOUNT_TOO_HIGH");
  }

  if (offer.expiry !== undefined && Date.now() / 1000 > offer.expiry) {
    throw new FiberOfferError("offer has expired", "OFFER_EXPIRED");
  }

  return {
    amount,
    asset: normalizeAsset(asset)
  };
}

export function offerToPaymentLink(offer, baseUrl = offer.resolver_url) {
  assertValidOffer(offer, { requireSignature: true });
  return `${baseUrl.replace(/\/$/, "")}/pay/${offer.offer_id}`;
}

function stripFields(value, fields) {
  const copy = { ...value };
  for (const field of fields) delete copy[field];
  return copy;
}

function extensionFields(input) {
  if (!input || typeof input !== "object") return {};
  return Object.fromEntries(
    Object.entries(input).filter(([key, value]) => (key === "extensions" || key.startsWith("x_")) && value !== undefined)
  );
}

function normalizeNodeId(value) {
  const nodeId = requiredString(value, "node_id").toLowerCase();
  if (!/^(02|03)[0-9a-f]{64}$/.test(nodeId)) {
    throw new FiberOfferError("node_id must be a compressed secp256k1 public key", "INVALID_NODE_ID");
  }
  return nodeId;
}

function normalizeUnixTimestamp(value, field) {
  const normalized = optionalPositiveInteger(value, field);
  if (normalized === undefined) {
    throw new FiberOfferError(`${field} is required`, "MISSING_FIELD", { field });
  }
  return normalized;
}

function decodeOfferBytes(encoded) {
  try {
    const decoded = bech32mDecode(encoded);
    if (decoded.hrp !== OFFER_HRP) throw new Error("unexpected offer human-readable prefix");
    return decoded.bytes;
  } catch (bech32Error) {
    try {
      return base64UrlDecode(encoded.slice(OFFER_PREFIX.length));
    } catch (legacyError) {
      throw new FiberOfferError("encoded offer is neither valid bech32m nor legacy base64url", "INVALID_OFFER_ENCODING", {
        bech32: bech32Error.message,
        legacy: legacyError.message
      });
    }
  }
}

function bech32mEncode(hrp, bytes) {
  const words = convertBits([...bytes], 8, 5, true);
  const checksum = createBech32Checksum(hrp, words);
  return `${hrp}1${[...words, ...checksum].map((word) => bech32Charset[word]).join("")}`;
}

function bech32mDecode(value) {
  if (typeof value !== "string" || value.length < 8 || value !== value.toLowerCase()) {
    throw new Error("bech32m offer must be a lowercase string");
  }
  const separator = value.lastIndexOf("1");
  if (separator < 1 || separator + 7 > value.length) throw new Error("invalid bech32m separator or checksum length");
  const hrp = value.slice(0, separator);
  const words = [...value.slice(separator + 1)].map((character) => {
    const index = bech32Charset.indexOf(character);
    if (index === -1) throw new Error("invalid bech32m character");
    return index;
  });
  if (bech32Polymod([...bech32HrpExpand(hrp), ...words]) !== bech32mConstant) {
    throw new Error("invalid bech32m checksum");
  }
  return { hrp, bytes: Buffer.from(convertBits(words.slice(0, -6), 5, 8, false)) };
}

function createBech32Checksum(hrp, words) {
  const values = [...bech32HrpExpand(hrp), ...words, 0, 0, 0, 0, 0, 0];
  const polymod = bech32Polymod(values) ^ bech32mConstant;
  return Array.from({ length: 6 }, (_, index) => (polymod >>> (5 * (5 - index))) & 31);
}

function bech32HrpExpand(hrp) {
  return [...hrp].map((character) => character.charCodeAt(0) >>> 5).concat(0, [...hrp].map((character) => character.charCodeAt(0) & 31));
}

function bech32Polymod(values) {
  const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let checksum = 1;
  for (const value of values) {
    const top = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    for (let index = 0; index < generators.length; index += 1) {
      if ((top >>> index) & 1) checksum ^= generators[index];
    }
  }
  return checksum >>> 0;
}

function convertBits(values, fromBits, toBits, pad) {
  let accumulator = 0;
  let bitCount = 0;
  const result = [];
  const maxValue = (1 << toBits) - 1;
  for (const value of values) {
    if (value < 0 || value >>> fromBits !== 0) throw new Error("invalid value while converting bech32m bits");
    accumulator = (accumulator << fromBits) | value;
    bitCount += fromBits;
    while (bitCount >= toBits) {
      bitCount -= toBits;
      result.push((accumulator >>> bitCount) & maxValue);
    }
  }
  if (pad && bitCount > 0) result.push((accumulator << (toBits - bitCount)) & maxValue);
  if (!pad && (bitCount >= fromBits || ((accumulator << (toBits - bitCount)) & maxValue) !== 0)) {
    throw new Error("invalid bech32m padding");
  }
  return result;
}

function normalizeUrl(value, field) {
  const text = requiredString(value, field);
  try {
    const parsed = new URL(text);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("protocol must be http or https");
    }
    return parsed.toString().replace(/\/$/, "");
  } catch (error) {
    throw new FiberOfferError(`${field} must be a valid HTTP(S) URL`, "INVALID_URL", {
      field,
      cause: error.message
    });
  }
}

function normalizeAssets(assets) {
  if (!Array.isArray(assets) || assets.length === 0) {
    throw new FiberOfferError("assets must contain at least one asset", "INVALID_ASSETS");
  }
  return assets.map((asset) => normalizeAsset(asset));
}

function normalizeAsset(asset) {
  if (!asset || typeof asset !== "object") {
    throw new FiberOfferError("asset must be an object", "INVALID_ASSET");
  }

  const asset_type = requiredString(asset.asset_type, "asset.asset_type").toLowerCase();
  if (!SUPPORTED_ASSET_TYPES.has(asset_type)) {
    throw new FiberOfferError("asset_type must be ckb, udt, or rgbpp", "INVALID_ASSET_TYPE");
  }

  const normalized = {
    asset_type,
    symbol: requiredString(asset.symbol, "asset.symbol").toUpperCase()
  };

  if (asset_type !== "ckb") {
    normalized.type_script_hash = requiredHex(asset.type_script_hash, "asset.type_script_hash", 64);
  } else if (asset.type_script_hash !== undefined) {
    normalized.type_script_hash = requiredHex(asset.type_script_hash, "asset.type_script_hash", 64);
  }

  return normalized;
}

function sameAsset(left, right) {
  const a = normalizeAsset(left);
  const b = normalizeAsset(right);
  return (
    a.asset_type === b.asset_type &&
    a.symbol === b.symbol &&
    (a.type_script_hash ?? "") === (b.type_script_hash ?? "")
  );
}

function normalizeRecurrence(recurrence) {
  if (recurrence === undefined || recurrence === null) return undefined;
  if (typeof recurrence !== "object" || Array.isArray(recurrence)) {
    throw new FiberOfferError("recurrence must be an object", "INVALID_RECURRENCE");
  }

  const interval = requiredString(recurrence.interval, "recurrence.interval");
  if (!["daily", "weekly", "monthly", "custom_seconds"].includes(interval)) {
    throw new FiberOfferError("recurrence interval is unsupported", "INVALID_RECURRENCE_INTERVAL");
  }

  const normalized = {
    interval,
    amount: requiredPositiveIntegerString(recurrence.amount, "recurrence.amount"),
    cap_cycles: optionalPositiveInteger(recurrence.cap_cycles, "recurrence.cap_cycles"),
    spending_cap_total: optionalPositiveIntegerString(
      recurrence.spending_cap_total,
      "recurrence.spending_cap_total"
    ),
    custom_seconds: optionalPositiveInteger(recurrence.custom_seconds, "recurrence.custom_seconds")
  };

  if (interval === "custom_seconds" && normalized.custom_seconds === undefined) {
    throw new FiberOfferError("custom recurrence requires custom_seconds", "INVALID_RECURRENCE");
  }

  if (normalized.cap_cycles === undefined && normalized.spending_cap_total === undefined) {
    throw new FiberOfferError("recurring offers require cap_cycles or spending_cap_total", "RECURRENCE_CAP_REQUIRED");
  }

  return normalized;
}

function normalizeMetadata(metadata) {
  if (metadata === undefined || metadata === null) return undefined;
  if (typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new FiberOfferError("metadata must be an object", "INVALID_METADATA");
  }
  return metadata;
}

function validateAmountBounds(offer) {
  if (
    offer.amount_min !== undefined &&
    offer.amount_max !== undefined &&
    BigInt(offer.amount_min) > BigInt(offer.amount_max)
  ) {
    throw new FiberOfferError("amount_min cannot exceed amount_max", "INVALID_AMOUNT_BOUNDS");
  }
}

function requiredString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new FiberOfferError(`${field} is required`, "MISSING_FIELD", { field });
  }
  return value.trim();
}

function optionalString(value, field) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new FiberOfferError(`${field} must be a string`, "INVALID_FIELD", { field });
  }
  return value.trim();
}

function requiredPositiveIntegerString(value, field) {
  const normalized = optionalPositiveIntegerString(value, field);
  if (normalized === undefined || BigInt(normalized) <= 0n) {
    throw new FiberOfferError(`${field} must be a positive integer string`, "INVALID_AMOUNT", { field });
  }
  return normalized;
}

function optionalPositiveIntegerString(value, field) {
  if (value === undefined || value === null || value === "") return undefined;
  const text = typeof value === "bigint" ? value.toString() : String(value).trim();
  if (!/^[0-9]+$/.test(text)) {
    throw new FiberOfferError(`${field} must be an integer string`, "INVALID_INTEGER", { field });
  }
  return text.replace(/^0+(?=\d)/, "");
}

function optionalPositiveInteger(value, field) {
  if (value === undefined || value === null || value === "") return undefined;
  const text = String(value).trim();
  if (!/^[0-9]+$/.test(text) || BigInt(text) <= 0n) {
    throw new FiberOfferError(`${field} must be a positive integer`, "INVALID_INTEGER", { field });
  }
  const number = Number(text);
  if (!Number.isSafeInteger(number)) {
    throw new FiberOfferError(`${field} is too large for this MVP`, "INTEGER_TOO_LARGE", { field });
  }
  return number;
}

function requiredHex(value, field, byteLength) {
  const text = requiredString(value, field).toLowerCase();
  const regex = new RegExp(`^0x[0-9a-f]{${byteLength}}$`);
  if (!regex.test(text)) {
    throw new FiberOfferError(`${field} must be 0x-prefixed hex`, "INVALID_HEX", { field });
  }
  return text;
}
