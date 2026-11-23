import {
  createHash,
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify
} from "node:crypto";
import { decodeBech32m, encodeBech32m } from "./bech32m.js";
import { canonicalize, canonicalStringify } from "./canonical.js";
import { FiberOfferError } from "./errors.js";

export { canonicalize, canonicalStringify, FiberOfferError };
export { ckbHash, ckbScriptHash, normalizeCkbScript, parseCkbScript, serializeCkbScript } from "./ckb-script.js";

export const OFFER_PREFIX = "fbroffer1";
export const OFFER_SCHEME = "fiberoffer-v1";
export const OFFER_HRP = "fbroffer";
export const REVOCATION_SCHEME = "fiberoffer-revocation-v1";
export const RECURRENCE_REQUEST_SCHEME = "fiberoffer-recurrence-v1";
export const SUPPORTED_ASSET_TYPES = new Set(["ckb", "udt", "rgbpp"]);
export const SUPPORTED_NETWORKS = new Set(["mainnet", "testnet", "dev"]);

// Upper bounds on what an offer may carry. An offer is passed around as a
// link or a QR code and stored by resolvers that did not create it, so its
// size is bounded by the format, not left to each implementation.
export const OFFER_LIMITS = Object.freeze({
  // Canonical JSON of the whole signed offer, in bytes.
  offer_bytes: 4096,
  // The encoded form: prefix, payload, checksum.
  encoded_length: OFFER_PREFIX.length + Math.ceil((4096 * 8) / 5) + 6,
  description_bytes: 512,
  resolver_url_length: 512,
  assets: 16,
  symbol_length: 16,
  // Canonical JSON of `metadata`, and of all extension fields together.
  metadata_bytes: 2048,
  extensions_bytes: 2048,
  // How deeply `metadata` and extension fields may nest.
  json_depth: 8
});

// Keys that would change an object's behaviour if a consumer merged or copied
// it carelessly. They are refused anywhere in an offer.
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const KNOWN_OFFER_FIELDS = new Set([
  "scheme",
  "version",
  "network",
  "node_id",
  "public_key",
  "resolver_url",
  "description",
  "assets",
  "amount_min",
  "amount_max",
  "recurrence",
  "expiry",
  "single_use",
  "metadata",
  "offer_id",
  "signature"
]);

export function generateOfferKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" })
  };
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

// The encoded form is Bech32m over the offer's canonical JSON, lowercase.
// `encodeOffer(decodeOffer(text))` returns `text` (lowercased), because a
// decoder accepts exactly one encoding of each offer.
export function encodeOffer(offer) {
  assertValidOffer(offer, { requireSignature: true });
  return encodeBech32m(OFFER_HRP, Buffer.from(canonicalStringify(offer)));
}

// Whether a string is written as an encoded offer, in either case. Says
// nothing about whether it decodes.
export function isEncodedOffer(value) {
  return typeof value === "string" && value.toLowerCase().startsWith(OFFER_PREFIX);
}

// Accepts the all-lowercase or the all-uppercase form (as a QR code carries
// it). A damaged string fails with INVALID_OFFER_CHECKSUM; anything else that
// is not exactly an encoded offer fails with INVALID_OFFER_ENCODING and
// `details.reason`.
export function decodeOffer(encoded) {
  if (!isEncodedOffer(encoded)) {
    throw encodingError("encoded offer must start with fbroffer1", "prefix");
  }
  if (encoded.length > OFFER_LIMITS.encoded_length) {
    throw encodingError(`encoded offer is longer than ${OFFER_LIMITS.encoded_length} characters`, "length");
  }

  let decoded;
  try {
    decoded = decodeBech32m(encoded);
  } catch (error) {
    if (error.reason === "checksum") {
      throw new FiberOfferError(
        "encoded offer is damaged: its checksum does not match",
        "INVALID_OFFER_CHECKSUM",
        { reason: "checksum" }
      );
    }
    throw encodingError(`encoded offer is not valid bech32m: ${error.message}`, error.reason ?? "bech32m");
  }
  if (decoded.hrp !== OFFER_HRP) throw encodingError("encoded offer must start with fbroffer1", "prefix");

  let text;
  let parsed;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(decoded.bytes);
    parsed = JSON.parse(text);
  } catch (error) {
    throw encodingError("encoded offer body is not valid JSON", "json", error.message);
  }
  assertValidOffer(parsed, { requireSignature: true });
  // The body must be the canonical JSON itself: no whitespace, no reordered or
  // repeated members. Otherwise one offer would have many encodings.
  if (canonicalStringify(parsed) !== text) {
    throw encodingError("encoded offer body is not in canonical form", "not_canonical");
  }
  return parsed;
}

function encodingError(message, reason, cause = undefined) {
  return new FiberOfferError(message, "INVALID_OFFER_ENCODING", cause === undefined ? { reason } : { reason, cause });
}

// Builds the offer from loosely written input: values are brought to their
// canonical form (lowercase node ID, uppercase symbol, amounts as decimal
// strings, the resolver URL without a trailing slash) before the ID is taken.
// `options.now` (unix seconds) is the time an `expiry` is checked against.
export function buildUnsignedOffer(input, options = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new FiberOfferError("offer input must be an object", "INVALID_OFFER");
  }
  const content = normalizeOfferContent({
    ...input,
    network: input.network ?? "testnet",
    single_use: Boolean(input.single_use ?? false)
  });

  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (content.expiry !== undefined && content.expiry <= now) {
    throw new FiberOfferError("expiry must be in the future", "OFFER_EXPIRY_IN_PAST", { expiry: content.expiry, now });
  }
  assertOfferSize(content);

  return {
    ...content,
    offer_id: `0x${sha256Hex(content)}`
  };
}

export function signOffer(unsignedOffer, privateKeyPem) {
  assertValidOffer(unsignedOffer, { requireSignature: false });
  const key = ed25519PrivateKey(privateKeyPem, "offer private key");
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

export function createSignedOffer(input, privateKeyPem, options = {}) {
  const unsigned = buildUnsignedOffer(input, options);
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
    // assertValidOffer has already established that this is an Ed25519 key.
    const key = ed25519PublicKey(offer.public_key, "public_key");
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
  const key = ed25519PrivateKey(privateKeyPem, "offer private key");
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
    if (!isCanonicalSignature(revocation.signature)) {
      return {
        ok: false,
        code: "INVALID_REVOCATION_SIGNATURE",
        message: "revocation signature must be { scheme: \"ed25519\", value } with a base64url Ed25519 signature"
      };
    }
    const ok = cryptoVerify(
      null,
      Buffer.from(canonicalStringify(payload)),
      ed25519PublicKey(offer.public_key, "public_key"),
      base64UrlDecode(revocation.signature.value)
    );
    return ok
      ? { ok: true }
      : { ok: false, code: "INVALID_REVOCATION_SIGNATURE", message: "revocation signature is invalid" };
  } catch (error) {
    return { ok: false, code: "INVALID_REVOCATION", message: error.message };
  }
}

// Checks an offer someone else produced. It must be well formed and already in
// canonical form: exactly what buildUnsignedOffer would have produced for the
// same terms. Looser spellings (an uppercase node ID, "0100" for an amount, a
// trailing slash on the resolver URL, a null where a field is absent) are
// refused, so one set of terms has one offer and one offer ID.
//
// Unknown top-level fields are refused. A signed field a wallet does not
// understand could change what it is agreeing to; additions that a reader may
// safely ignore go in `extensions` or in fields named `x_...`.
export function assertValidOffer(offer, options = {}) {
  if (!isPlainObject(offer)) {
    throw new FiberOfferError("offer must be an object", "INVALID_OFFER");
  }

  if (offer.scheme !== OFFER_SCHEME) {
    throw new FiberOfferError("offer scheme must be fiberoffer-v1", "INVALID_SCHEME");
  }

  if (offer.version !== 1) {
    throw new FiberOfferError("offer version must be 1", "INVALID_VERSION");
  }

  if (typeof offer.single_use !== "boolean") {
    throw new FiberOfferError("single_use must be a boolean", "INVALID_SINGLE_USE");
  }

  const content = normalizeOfferContent(offer);
  for (const field of Object.keys(offer)) {
    if (field === "offer_id" || field === "signature" || offer[field] === undefined) continue;
    if (FORBIDDEN_KEYS.has(field)) {
      throw new FiberOfferError(`"${field}" is not allowed as a field name`, "FORBIDDEN_KEY", { field });
    }
    if (!KNOWN_OFFER_FIELDS.has(field) && !isExtensionField(field)) {
      throw new FiberOfferError(
        `"${field}" is not an offer field; put additions in "extensions" or a field named "x_..."`,
        "UNKNOWN_OFFER_FIELD",
        { field }
      );
    }
    if (content[field] === undefined || canonicalStringify(content[field]) !== canonicalStringify(offer[field])) {
      throw new FiberOfferError(`${field} is not in canonical form`, "NON_CANONICAL_OFFER", {
        field,
        ...(content[field] === undefined ? {} : { canonical: content[field] })
      });
    }
  }

  if (offer.offer_id !== undefined && !(typeof offer.offer_id === "string" && /^0x[0-9a-f]{64}$/.test(offer.offer_id))) {
    throw new FiberOfferError("offer_id must be a 0x-prefixed sha256 hex string", "INVALID_OFFER_ID");
  }

  if (options.requireSignature) {
    if (offer.offer_id === undefined) {
      throw new FiberOfferError("offer_id is required on signed offers", "INVALID_OFFER_ID");
    }

    if (!isCanonicalSignature(offer.signature)) {
      throw new FiberOfferError(
        "offer signature must be { scheme: \"ed25519\", value } with a base64url Ed25519 signature",
        "INVALID_SIGNATURE"
      );
    }
  } else if (offer.signature !== undefined && !isCanonicalSignature(offer.signature)) {
    throw new FiberOfferError("offer signature is malformed", "INVALID_SIGNATURE");
  }

  assertOfferSize(offer);
  return true;
}

// The signed content of an offer in canonical form, from input that may be
// written loosely. Every field is checked; anything the format does not define
// is left out, apart from extension fields.
function normalizeOfferContent(input) {
  const network = input.network;
  if (typeof network !== "string" || !SUPPORTED_NETWORKS.has(network)) {
    throw new FiberOfferError("network must be mainnet, testnet, or dev", "INVALID_NETWORK");
  }
  if (typeof input.single_use !== "boolean") {
    throw new FiberOfferError("single_use must be a boolean", "INVALID_SINGLE_USE");
  }

  const content = dropUndefined({
    ...extensionFields(input),
    scheme: OFFER_SCHEME,
    version: 1,
    network,
    node_id: normalizeNodeId(input.node_id),
    public_key: normalizePublicKey(input.public_key),
    resolver_url: normalizeResolverUrl(input.resolver_url, network),
    description: normalizeDescription(input.description),
    assets: normalizeAssets(input.assets),
    amount_min: optionalAmount(input.amount_min, "amount_min"),
    amount_max: optionalAmount(input.amount_max, "amount_max"),
    recurrence: normalizeRecurrence(input.recurrence),
    expiry: optionalPositiveInteger(input.expiry, "expiry"),
    single_use: input.single_use,
    metadata: normalizeMetadata(input.metadata)
  });

  validateAmountBounds(content);
  if (content.recurrence) {
    if (content.single_use) {
      throw new FiberOfferError(
        "an offer cannot be both single_use and recurring",
        "SINGLE_USE_RECURRENCE_CONFLICT"
      );
    }
    const amount = BigInt(content.recurrence.amount);
    if (
      (content.amount_min !== undefined && amount < BigInt(content.amount_min)) ||
      (content.amount_max !== undefined && amount > BigInt(content.amount_max))
    ) {
      throw new FiberOfferError(
        "recurrence.amount must lie within amount_min and amount_max, or no cycle could ever be paid",
        "RECURRENCE_AMOUNT_OUT_OF_BOUNDS"
      );
    }
  }
  return content;
}

function assertOfferSize(offer) {
  const bytes = Buffer.byteLength(canonicalStringify(offer));
  if (bytes > OFFER_LIMITS.offer_bytes) {
    throw new FiberOfferError(`offer is larger than ${OFFER_LIMITS.offer_bytes} bytes`, "OFFER_TOO_LARGE", {
      bytes,
      limit: OFFER_LIMITS.offer_bytes
    });
  }
}

// Exactly { scheme: "ed25519", value } where value is the one base64url
// spelling of a 64-byte signature. Extra members or an alternative spelling
// would let an offer be altered without invalidating it.
function isCanonicalSignature(signature) {
  if (!isPlainObject(signature)) return false;
  const keys = Object.keys(signature);
  if (keys.length !== 2 || signature.scheme !== "ed25519") return false;
  return isCanonicalBase64Url(signature.value, 64);
}

function isCanonicalBase64Url(value, byteLength) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  const bytes = base64UrlDecode(value);
  return bytes.length === byteLength && base64UrlEncode(bytes) === value;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function dropUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, member]) => member !== undefined));
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

  assertRecurrenceTerms(offer, { ...request, amount });

  return {
    amount,
    asset: normalizeAsset(asset)
  };
}

// The recurrence checks that need no history: they hold or fail on the signed
// terms alone, so a wallet can run them before contacting anyone. How many
// cycles a subscription has already paid is the resolver's to track.
function assertRecurrenceTerms(offer, request) {
  const terms = offer.recurrence;
  const cycle = request?.recurrence_cycle;
  if (!terms) {
    if (cycle !== undefined && cycle !== null) {
      throw new FiberOfferError("offer does not define recurring payment terms", "RECURRENCE_NOT_CONFIGURED");
    }
    return;
  }

  if (BigInt(request.amount) !== BigInt(terms.amount)) {
    throw new FiberOfferError(`recurring cycle amount must equal ${terms.amount}`, "RECURRENCE_AMOUNT_MISMATCH");
  }
  if (cycle === undefined || cycle === null) return;
  if (!Number.isSafeInteger(cycle) || cycle < 1) {
    throw new FiberOfferError("recurrence_cycle must be a positive integer", "INVALID_RECURRENCE_CYCLE");
  }
  if (terms.cap_cycles !== undefined && cycle > terms.cap_cycles) {
    throw new FiberOfferError("recurring payment cycle cap has been reached", "RECURRENCE_CYCLE_CAP_REACHED");
  }
  if (
    terms.spending_cap_total !== undefined &&
    BigInt(cycle) * BigInt(terms.amount) > BigInt(terms.spending_cap_total)
  ) {
    throw new FiberOfferError("recurring payment spending cap has been reached", "RECURRENCE_SPENDING_CAP_REACHED");
  }
}

// --- Recurring subscriptions -------------------------------------------------
//
// A recurring offer can be subscribed to by any number of payers. Each
// subscription is identified by a key the payer generates: its ID is derived
// from the public key, and every cycle request is signed with the private key.
// Cycle numbers and caps are then counted per subscription, and nobody but the
// payer can advance or exhaust it.

// The subscription's identifier: a hash of the subscriber's public key, so an
// ID cannot be claimed by anyone who does not hold the matching private key.
export function subscriptionId(publicKeyPem) {
  const der = ed25519PublicKey(publicKeyPem, "subscriber_public_key").export({ type: "spki", format: "der" });
  return `sub_${createHash("sha256").update(der).digest("hex").slice(0, 40)}`;
}

// Adds the subscription proof to a cycle request: `approval_id`,
// `subscriber_public_key` and `subscriber_signature`. Send the result as the
// invoice request.
export function signRecurrenceRequest(offer, request, subscriberPrivateKeyPem) {
  assertValidOffer(offer, { requireSignature: true });
  const privateKey = ed25519PrivateKey(subscriberPrivateKeyPem, "subscriber key");
  const publicKeyPem = createPublicKey(privateKey).export({ type: "spki", format: "pem" });
  const validated = validateResolutionRequest(offer, request);
  const fields = {
    amount: validated.amount,
    asset: validated.asset,
    recurrence_cycle: request.recurrence_cycle,
    ...(request.scheduled_for !== undefined ? { scheduled_for: request.scheduled_for } : {}),
    approval_id: subscriptionId(publicKeyPem)
  };
  if (!Number.isSafeInteger(fields.recurrence_cycle)) {
    throw new FiberOfferError("recurrence_cycle is required on a recurring cycle request", "INVALID_RECURRENCE_CYCLE");
  }
  const signature = cryptoSign(null, recurrenceSigningPayload(offer, fields), privateKey);
  return {
    ...request,
    ...fields,
    subscriber_public_key: publicKeyPem,
    subscriber_signature: base64UrlEncode(signature)
  };
}

// Checks the subscription proof on a cycle request. Returns { ok: true } or
// { ok: false, code, message }. It does not check payment history.
export function verifyRecurrenceRequest(offer, request) {
  assertValidOffer(offer, { requireSignature: true });
  if (!offer.recurrence) {
    return { ok: false, code: "RECURRENCE_NOT_CONFIGURED", message: "offer does not define recurring payment terms" };
  }
  const missing = ["approval_id", "subscriber_public_key", "subscriber_signature", "recurrence_cycle"].find(
    (field) => request?.[field] === undefined || request?.[field] === null || request?.[field] === ""
  );
  if (missing) {
    return {
      ok: false,
      code: "SUBSCRIPTION_PROOF_REQUIRED",
      message: `a recurring cycle request must carry ${missing}`
    };
  }

  try {
    const validated = validateResolutionRequest(offer, request);
    const publicKey = ed25519PublicKey(request.subscriber_public_key, "subscriber_public_key");
    if (subscriptionId(request.subscriber_public_key) !== request.approval_id) {
      return {
        ok: false,
        code: "SUBSCRIPTION_KEY_MISMATCH",
        message: "approval_id does not belong to subscriber_public_key"
      };
    }
    const payload = recurrenceSigningPayload(offer, {
      amount: validated.amount,
      asset: validated.asset,
      recurrence_cycle: request.recurrence_cycle,
      ...(request.scheduled_for !== undefined ? { scheduled_for: request.scheduled_for } : {}),
      approval_id: request.approval_id
    });
    const valid =
      isCanonicalBase64Url(request.subscriber_signature, 64) &&
      cryptoVerify(null, payload, publicKey, base64UrlDecode(request.subscriber_signature));
    return valid
      ? { ok: true }
      : { ok: false, code: "INVALID_SUBSCRIPTION_SIGNATURE", message: "subscriber signature is invalid" };
  } catch (error) {
    if (error instanceof FiberOfferError) return { ok: false, code: error.code, message: error.message };
    return { ok: false, code: "INVALID_SUBSCRIPTION_SIGNATURE", message: error.message };
  }
}

// Everything the subscriber commits to for one cycle. Binding the offer ID
// means a signature cannot be replayed against another offer.
function recurrenceSigningPayload(offer, fields) {
  return Buffer.from(
    canonicalStringify({
      scheme: RECURRENCE_REQUEST_SCHEME,
      offer_id: offer.offer_id,
      approval_id: fields.approval_id,
      recurrence_cycle: fields.recurrence_cycle,
      amount: fields.amount,
      asset: fields.asset,
      scheduled_for: fields.scheduled_for
    })
  );
}

function ed25519PublicKey(publicKeyPem, field) {
  let key;
  try {
    key = createPublicKey(requiredString(publicKeyPem, field));
  } catch (error) {
    if (error instanceof FiberOfferError) throw error;
    throw new FiberOfferError(`${field} is not a valid public key`, "INVALID_PUBLIC_KEY");
  }
  // The signature scheme is fixed. Node would otherwise verify with whatever
  // kind of key it was handed (RSA, P-256, Ed448).
  if (key.asymmetricKeyType !== "ed25519") {
    throw new FiberOfferError(`${field} must be an Ed25519 key`, "INVALID_KEY_TYPE");
  }
  return key;
}

function ed25519PrivateKey(privateKeyPem, field) {
  let key;
  try {
    key = createPrivateKey(privateKeyPem);
  } catch {
    throw new FiberOfferError(`${field} is not a valid private key`, "INVALID_PRIVATE_KEY");
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new FiberOfferError(`${field} must be an Ed25519 key`, "INVALID_KEY_TYPE");
  }
  return key;
}

// The one spelling of a public key in an offer: the PEM of its
// SubjectPublicKeyInfo, with no surrounding whitespace.
function normalizePublicKey(value) {
  return ed25519PublicKey(value, "public_key").export({ type: "spki", format: "pem" }).trim();
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

function isExtensionField(key) {
  return key === "extensions" || key.startsWith("x_");
}

// Fields a reader may ignore: `extensions` and anything named `x_...`. They
// are signed like everything else.
function extensionFields(input) {
  const fields = Object.fromEntries(
    Object.entries(input).filter(([key, value]) => isExtensionField(key) && value !== undefined && value !== null)
  );
  if (fields.extensions !== undefined && !isPlainObject(fields.extensions)) {
    throw new FiberOfferError("extensions must be an object", "INVALID_EXTENSIONS");
  }
  assertSignableJson(fields, "extensions", OFFER_LIMITS.extensions_bytes);
  return fields;
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

// The resolver's address: scheme, host, an optional port and path, and nothing
// else. Credentials, a query or a fragment have no meaning here and would give
// one resolver many spellings. A trailing slash is dropped.
//
// Plain http is accepted only where it cannot expose a payer: on the `dev`
// network, or for a resolver on the same machine.
function normalizeResolverUrl(value, network) {
  const text = requiredString(value, "resolver_url");
  const refuse = (cause) =>
    new FiberOfferError("resolver_url must be a valid HTTP(S) URL", "INVALID_URL", { field: "resolver_url", cause });

  let parsed;
  try {
    parsed = new URL(text);
  } catch (error) {
    throw refuse(error.message);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw refuse("protocol must be http or https");
  if (parsed.username || parsed.password) throw refuse("credentials are not allowed");
  if (parsed.search || parsed.hash || text.includes("?") || text.includes("#")) {
    throw refuse("a query or fragment is not allowed");
  }
  if (parsed.protocol === "http:" && network !== "dev" && !isLoopbackHost(parsed.hostname)) {
    throw new FiberOfferError(
      `resolver_url must use https on ${network}; http is accepted only on the dev network or for a local address`,
      "INSECURE_RESOLVER_URL",
      { field: "resolver_url" }
    );
  }
  const normalized = `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
  if (normalized.length > OFFER_LIMITS.resolver_url_length) throw refuse("the URL is too long");
  return normalized;
}

function isLoopbackHost(hostname) {
  const host = hostname.toLowerCase();
  return host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || /^127(\.\d{1,3}){3}$/.test(host);
}

function normalizeDescription(value) {
  const description = optionalString(value, "description");
  if (description !== undefined && Buffer.byteLength(description) > OFFER_LIMITS.description_bytes) {
    throw new FiberOfferError(
      `description is longer than ${OFFER_LIMITS.description_bytes} bytes`,
      "DESCRIPTION_TOO_LONG",
      { limit: OFFER_LIMITS.description_bytes }
    );
  }
  return description;
}

function normalizeAssets(assets) {
  if (!Array.isArray(assets) || assets.length === 0) {
    throw new FiberOfferError("assets must contain at least one asset", "INVALID_ASSETS");
  }
  if (assets.length > OFFER_LIMITS.assets) {
    throw new FiberOfferError(`an offer can list at most ${OFFER_LIMITS.assets} assets`, "TOO_MANY_ASSETS");
  }
  const normalized = assets.map((asset) => normalizeAsset(asset));
  // A token is identified by its type script, not by the label beside it.
  const seen = new Set();
  for (const asset of normalized) {
    const identity = `${asset.asset_type}:${asset.type_script_hash ?? ""}`;
    if (seen.has(identity)) {
      throw new FiberOfferError("assets must not list the same asset twice", "DUPLICATE_ASSET", { asset });
    }
    seen.add(identity);
  }
  return normalized;
}

function normalizeAsset(asset) {
  if (!asset || typeof asset !== "object" || Array.isArray(asset)) {
    throw new FiberOfferError("asset must be an object", "INVALID_ASSET");
  }

  const asset_type = requiredString(asset.asset_type, "asset.asset_type").toLowerCase();
  if (!SUPPORTED_ASSET_TYPES.has(asset_type)) {
    throw new FiberOfferError("asset_type must be ckb, udt, or rgbpp", "INVALID_ASSET_TYPE");
  }

  const symbol = requiredString(asset.symbol, "asset.symbol").toUpperCase();
  if (symbol.length > OFFER_LIMITS.symbol_length || !/^[A-Z0-9][A-Z0-9._-]*$/.test(symbol)) {
    throw new FiberOfferError(
      `asset.symbol must be 1-${OFFER_LIMITS.symbol_length} letters, digits, ".", "_" or "-"`,
      "INVALID_ASSET_SYMBOL"
    );
  }

  if (asset_type === "ckb") {
    // CKB is the chain's own coin: it has one name and no type script.
    if (symbol !== "CKB") {
      throw new FiberOfferError("a ckb asset must have the symbol CKB", "INVALID_ASSET_SYMBOL");
    }
    if (asset.type_script_hash !== undefined && asset.type_script_hash !== null) {
      throw new FiberOfferError("a ckb asset has no type_script_hash", "INVALID_ASSET");
    }
    return { asset_type, symbol };
  }

  return {
    asset_type,
    symbol,
    type_script_hash: requiredHex(asset.type_script_hash, "asset.type_script_hash", 64)
  };
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

  const normalized = dropUndefined({
    interval,
    amount: requiredPositiveIntegerString(recurrence.amount, "recurrence.amount"),
    cap_cycles: optionalPositiveInteger(recurrence.cap_cycles, "recurrence.cap_cycles"),
    spending_cap_total: optionalAmount(recurrence.spending_cap_total, "recurrence.spending_cap_total"),
    custom_seconds: optionalPositiveInteger(recurrence.custom_seconds, "recurrence.custom_seconds")
  });

  if (interval === "custom_seconds" && normalized.custom_seconds === undefined) {
    throw new FiberOfferError("custom recurrence requires custom_seconds", "INVALID_RECURRENCE");
  }
  // On any other interval the field would be signed but mean nothing.
  if (interval !== "custom_seconds" && normalized.custom_seconds !== undefined) {
    throw new FiberOfferError("custom_seconds applies only to the custom_seconds interval", "INVALID_RECURRENCE");
  }
  if (
    normalized.spending_cap_total !== undefined &&
    BigInt(normalized.spending_cap_total) < BigInt(normalized.amount)
  ) {
    throw new FiberOfferError(
      "recurrence.spending_cap_total must cover at least one cycle",
      "INVALID_RECURRENCE"
    );
  }

  if (normalized.cap_cycles === undefined && normalized.spending_cap_total === undefined) {
    throw new FiberOfferError("recurring offers require cap_cycles or spending_cap_total", "RECURRENCE_CAP_REQUIRED");
  }

  return normalized;
}

function normalizeMetadata(metadata) {
  if (metadata === undefined || metadata === null) return undefined;
  if (!isPlainObject(metadata)) {
    throw new FiberOfferError("metadata must be an object", "INVALID_METADATA");
  }
  assertSignableJson(metadata, "metadata", OFFER_LIMITS.metadata_bytes);
  return metadata;
}

// Free-form signed content (metadata, extension fields) must mean the same to
// every implementation: plain JSON, no key that could alter an object, whole
// numbers only (a fraction has more than one spelling across languages), and a
// bounded depth and size.
function assertSignableJson(value, field, maxBytes) {
  const walk = (node, depth) => {
    if (depth > OFFER_LIMITS.json_depth) {
      throw new FiberOfferError(`${field} is nested too deeply`, "INVALID_SIGNED_JSON", { field });
    }
    if (typeof node === "number" && !Number.isSafeInteger(node)) {
      throw new FiberOfferError(
        `numbers in ${field} must be whole numbers; write amounts and decimals as strings`,
        "INVALID_SIGNED_JSON",
        { field }
      );
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
    } else if (node && typeof node === "object") {
      for (const key of Object.keys(node)) {
        if (FORBIDDEN_KEYS.has(key)) {
          throw new FiberOfferError(`"${key}" is not allowed as a key in ${field}`, "FORBIDDEN_KEY", { field, key });
        }
        walk(node[key], depth + 1);
      }
    }
  };
  walk(value, 0);

  // Also refuses anything that is not JSON at all (functions, class instances).
  const bytes = Buffer.byteLength(canonicalStringify(value));
  if (bytes > maxBytes) {
    throw new FiberOfferError(`${field} is larger than ${maxBytes} bytes`, "OFFER_FIELD_TOO_LARGE", {
      field,
      bytes,
      limit: maxBytes
    });
  }
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

// An amount is absent or at least 1. Zero would be a second way of writing
// "no minimum".
function optionalAmount(value, field) {
  const normalized = optionalPositiveIntegerString(value, field);
  if (normalized !== undefined && BigInt(normalized) <= 0n) {
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
