#!/usr/bin/env node
// Writes docs/test-vectors/v1.json: fixed inputs and the exact outputs an
// implementation of the Fiber Offers v1 format must produce for them.
//
//   node scripts/generate-test-vectors.js
//
// The file is committed and is the reference; this script only documents how
// it was made. packages/protocol/test/vectors.test.js checks the JavaScript
// implementation against the committed file, and docs/test-vectors/verify.py
// checks it again with an independent implementation that shares no code.
//
// The keys are derived from fixed, published seeds. They are test keys: never
// use them for anything else.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeBech32m } from "../packages/protocol/src/bech32m.js";
import {
  base64UrlEncode,
  canonicalStringify,
  ckbScriptHash,
  createOfferRevocation,
  createSignedOffer,
  encodeOffer,
  OFFER_LIMITS,
  signRecurrenceRequest,
  subscriptionId,
  validateResolutionRequest,
  verifyOffer,
  verifyOfferRevocation,
  verifyRecurrenceRequest
} from "../packages/protocol/src/index.js";

const outputPath = resolve(dirname(fileURLToPath(import.meta.url)), "../docs/test-vectors/v1.json");
const NOW = 1_800_000_000; // 2027-01-15T08:00:00Z, the "current time" of every vector
const NODE_ID = `02${"ab".repeat(32)}`;
const CKB = { asset_type: "ckb", symbol: "CKB" };
const RUSD_SCRIPT = {
  code_hash: "0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a",
  hash_type: "type",
  args: "0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b"
};

// An Ed25519 key from a 32-byte seed (RFC 8032): the PKCS#8 wrapping is fixed.
function keyFromSeed(label) {
  const seed = createHash("sha256").update(label).digest();
  const privateKey = createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
    format: "der",
    type: "pkcs8"
  });
  const publicKey = createPublicKey(privateKey);
  return {
    seed_label: label,
    seed_hex: seed.toString("hex"),
    // The raw 32-byte public key, for implementations that do not read PEM.
    public_key_hex: publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex"),
    public_key_pem: publicKey.export({ type: "spki", format: "pem" }).trim(),
    private_key_pem: privateKey.export({ type: "pkcs8", format: "pem" })
  };
}

const offerKey = keyFromSeed("fiber-offers test vector: offer key v1");
const subscriberKey = keyFromSeed("fiber-offers test vector: subscriber key v1");
const strangerKey = keyFromSeed("fiber-offers test vector: stranger key v1");

function baseInput(overrides = {}) {
  return {
    network: "testnet",
    node_id: NODE_ID,
    public_key: offerKey.public_key_pem,
    resolver_url: "https://offers.merchant.example",
    description: "Coffee checkout",
    assets: [CKB],
    amount_min: "100000000",
    amount_max: "100000000",
    ...overrides
  };
}

function sign(input) {
  return createSignedOffer(input, offerKey.private_key_pem, { now: NOW });
}

// Signs content exactly as written, without normalizing it: how a producer
// that ignores the canonical-form rules would. Used for negative vectors.
function signAsWritten(content, privateKeyPem = offerKey.private_key_pem, algorithm = null) {
  const withId = { ...content, offer_id: `0x${createHash("sha256").update(canonicalStringify(content)).digest("hex")}` };
  const signature = cryptoSign(algorithm, Buffer.from(canonicalStringify(withId)), privateKeyPem);
  return { ...withId, signature: { scheme: "ed25519", value: base64UrlEncode(signature) } };
}

function contentOf(offer, changes = {}) {
  const { offer_id: _id, signature: _signature, ...content } = offer;
  const next = { ...content, ...changes };
  for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
  return next;
}

function describeOffer(name, note, offer) {
  const { signature, ...withId } = offer;
  const { offer_id, ...content } = withId;
  const encoded = encodeOffer(offer);
  const verification = verifyOffer(offer);
  if (!verification.ok) throw new Error(`${name} does not verify: ${verification.code}`);
  return {
    name,
    note,
    offer,
    // sha256 of this text is the offer ID.
    id_preimage: canonicalStringify(content),
    offer_id,
    // The Ed25519 signature is over this text.
    signing_payload: canonicalStringify(withId),
    signature: signature.value,
    // The encoded form carries this text.
    canonical_json: canonicalStringify(offer),
    encoded,
    encoded_uppercase: encoded.toUpperCase()
  };
}

function expectError(run) {
  try {
    const result = run();
    if (result && result.ok === false) return result.code;
  } catch (error) {
    if (!error.code) throw error;
    return error.code;
  }
  throw new Error("expected a failure");
}

// --- Canonical JSON ---------------------------------------------------------

const canonicalJson = [
  { name: "members are ordered by key", value: { b: 1, a: 2, c: { z: true, y: null } } },
  { name: "number-like keys are ordered as text, not as numbers", value: { 10: "ten", 2: "two", 1: "one", a: "letter", "-1": "minus" } },
  { name: "keys are compared by UTF-16 code unit", value: { "é": 1, e: 2, E: 3, "😀": 4, "￿": 5, "": 6 } },
  { name: "a member named __proto__ is an ordinary member", json: '{"z":1,"__proto__":{"a":1}}' },
  { name: "arrays keep their order", value: [3, 1, [2, { b: 1, a: 2 }]] },
  { name: "strings are escaped as JSON.stringify escapes them", value: { text: "line\nbreak \"quoted\" back\\slash tab\t unit\u001f del\u007f sep  é 😀" } },
  { name: "whole numbers, booleans and null", value: { zero: 0, negative: -7, large: 9007199254740991, yes: true, no: false, nothing: null } },
  { name: "empty containers", value: { object: {}, array: [], text: "" } }
].map((vector) => {
  const value = vector.json ? JSON.parse(vector.json) : vector.value;
  return { name: vector.name, input_json: vector.json ?? JSON.stringify(vector.value), canonical: canonicalStringify(value) };
});

// --- Type script hashes -----------------------------------------------------

const typeScriptHashes = [
  { name: "RUSD on CKB testnet", script: RUSD_SCRIPT },
  {
    name: "secp256k1_blake160 lock (mainnet system script), empty args",
    script: { code_hash: "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8", hash_type: "type", args: "0x" }
  },
  {
    name: "data1 hash type with 20-byte args",
    script: { code_hash: `0x${"11".repeat(32)}`, hash_type: "data1", args: `0x${"22".repeat(20)}` }
  }
].map((vector) => ({ ...vector, type_script_hash: ckbScriptHash(vector.script) }));
const rusd = { asset_type: "udt", symbol: "RUSD", type_script_hash: ckbScriptHash(RUSD_SCRIPT) };

// --- Valid offers -----------------------------------------------------------

// `leaf` inside `levels` objects and lists, alternating, with an object
// outermost. The outermost is at depth 0, so the leaf is at depth `levels`.
function nested(levels, leaf) {
  let value = leaf;
  for (let level = levels - 1; level >= 0; level -= 1) value = level % 2 === 0 ? { a: value } : [value];
  return value;
}

const fixed = sign(baseInput());
const validOffers = [
  describeOffer("fixed-price CKB offer", "The smallest useful offer: one asset, one amount.", fixed),
  describeOffer(
    "open amount with a minimum",
    "No amount_max: the payer chooses any amount of at least amount_min.",
    sign(baseInput({ description: "Tip jar", amount_min: "1000", amount_max: undefined }))
  ),
  describeOffer(
    "no amount bounds",
    "Neither bound: any positive amount. Absent fields are left out of the JSON entirely.",
    sign(baseInput({ description: undefined, amount_min: undefined, amount_max: undefined }))
  ),
  describeOffer(
    "token offer (UDT) alongside CKB",
    "A token is named by the hash of its CKB type script.",
    sign(baseInput({ description: "Stablecoin checkout", assets: [CKB, rusd], amount_min: "500", amount_max: "2500" }))
  ),
  describeOffer(
    "RGB++ asset",
    "Same rule as a UDT: asset_type rgbpp, identified by type_script_hash.",
    sign(baseInput({ assets: [{ ...rusd, asset_type: "rgbpp", symbol: "RGBUSD" }] }))
  ),
  describeOffer(
    "single-use offer with an expiry",
    "expiry is a JSON integer of unix seconds.",
    sign(baseInput({ description: "Order 1042", single_use: true, expiry: 1_900_000_000 }))
  ),
  describeOffer(
    "recurring offer capped by cycles",
    "Each subscriber may pay at most cap_cycles cycles.",
    sign(baseInput({ description: "Monthly plan", amount_min: "2000", amount_max: "2000", recurrence: { interval: "monthly", amount: "2000", cap_cycles: 12 } }))
  ),
  describeOffer(
    "recurring offer with a custom interval and a spending cap",
    "custom_seconds is present only with the custom_seconds interval.",
    sign(
      baseInput({
        description: "Metered access",
        amount_min: "50",
        amount_max: "50",
        recurrence: { interval: "custom_seconds", custom_seconds: 3600, amount: "50", spending_cap_total: "1200" }
      })
    )
  ),
  describeOffer(
    "metadata and extension fields",
    "Free-form signed content. Number-like keys show the member order that matters.",
    sign(
      baseInput({
        metadata: { order: "A-42", 10: "ten", 2: "two", tags: ["retail", "eu"], nested: { b: 2, a: 1 } },
        extensions: { loyalty: { tier: 2 } },
        x_checkout: "kiosk-7"
      })
    )
  ),
  describeOffer(
    "mainnet offer with a resolver path",
    "resolver_url keeps a path and drops the trailing slash.",
    sign(baseInput({ network: "mainnet", resolver_url: "https://pay.merchant.example/fiber/" }))
  ),
  describeOffer(
    "dev network over plain http",
    "http is acceptable on the dev network, or for a loopback address on any network.",
    sign(baseInput({ network: "dev", resolver_url: "http://resolver.internal:8787" }))
  ),
  describeOffer(
    "non-ASCII description",
    "Text is UTF-8; the description limit is counted in bytes.",
    sign(baseInput({ description: "Café ☕ — 咖啡" }))
  ),
  describeOffer(
    "free-form content at the depth limit",
    "The value of metadata, of extensions and of an x_ field is at depth 0, and nothing may be deeper than 8. Each of these reaches depth 8: with text, with a number, and with an empty list.",
    sign(baseInput({ metadata: nested(8, "leaf"), extensions: nested(8, 8), x_trail: nested(8, []) }))
  )
];

// --- Normalization ----------------------------------------------------------

const looseInput = baseInput({
  network: undefined,
  node_id: NODE_ID.toUpperCase(),
  public_key: `${offerKey.public_key_pem.replaceAll("\n", "\r\n")}\r\n`,
  resolver_url: "HTTPS://Offers.Merchant.Example:443/",
  description: "  Coffee checkout  ",
  assets: [{ asset_type: "CKB", symbol: "ckb" }],
  amount_min: 100000000,
  amount_max: "000100000000"
});
const normalization = [
  {
    name: "loosely written input",
    note: "A producer brings its input to canonical form before taking the ID. This input yields the fixed-price CKB offer above.",
    input: { ...looseInput, network: null },
    offer_id: sign(looseInput).offer_id
  }
];
if (normalization[0].offer_id !== fixed.offer_id) throw new Error("normalization vector does not match the fixed offer");

// --- Invalid offers ---------------------------------------------------------

const fixedContent = contentOf(fixed);
// An ECDSA signature is different every time it is made, so this one vector is
// kept from the committed file when there is one, and the file stays stable.
const P256_VECTOR = "P-256 key under the ed25519 scheme";
const previous = await readFile(outputPath, "utf8").then(JSON.parse, () => undefined);
const p256Offer =
  previous?.invalid_offers?.find((vector) => vector.name === P256_VECTOR)?.offer ??
  (() => {
    const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
    return signAsWritten(
      contentOf(fixed, { public_key: pair.publicKey.export({ type: "spki", format: "pem" }).trim() }),
      pair.privateKey,
      "sha256"
    );
  })();
const invalidObjects = [
  ["description changed after signing", "The ID no longer matches the content.", { ...fixed, description: "Free coffee" }],
  [
    "content and ID changed, signature kept",
    "The ID is right for the new content; the signature is not.",
    { ...signAsWritten(contentOf(fixed, { description: "Free coffee" })), signature: fixed.signature }
  ],
  ["signed by another Ed25519 key", "A valid signature, but not by the key the offer names.", signAsWritten(fixedContent, strangerKey.private_key_pem)],
  [
    P256_VECTOR,
    "The signature really is by the named key (ECDSA with SHA-256), so a verifier that does not check the key type accepts it.",
    p256Offer
  ],
  ["uppercase node_id", "Validly signed, not canonical.", signAsWritten(contentOf(fixed, { node_id: NODE_ID.toUpperCase() }))],
  ["amount with leading zeros", "Validly signed, not canonical.", signAsWritten(contentOf(fixed, { amount_min: "0100000000" }))],
  ["amount as a JSON number", "Amounts are strings.", signAsWritten(contentOf(fixed, { amount_min: 100000000 }))],
  ["resolver_url with a trailing slash", "Validly signed, not canonical.", signAsWritten(contentOf(fixed, { resolver_url: "https://offers.merchant.example/" }))],
  ["lowercase asset symbol", "Validly signed, not canonical.", signAsWritten(contentOf(fixed, { assets: [{ asset_type: "ckb", symbol: "ckb" }] }))],
  ["null for an absent field", "An absent field is left out, never null.", signAsWritten(contentOf(fixed, { recurrence: null }))],
  ["public key with a trailing newline", "Validly signed, not canonical.", signAsWritten(contentOf(fixed, { public_key: `${offerKey.public_key_pem}\n` }))],
  ["unknown top-level field", "Only extensions and x_ fields may be added.", signAsWritten(contentOf(fixed, { payer_must: "something new" }))],
  ["missing network", "network is required.", signAsWritten(contentOf(fixed, { network: undefined }))],
  ["unsupported version", "A v1 reader refuses any other version.", signAsWritten(contentOf(fixed, { version: 2 }))],
  ["plain http on testnet", "http only on dev or for a loopback address.", signAsWritten(contentOf(fixed, { resolver_url: "http://offers.merchant.example" }))],
  ["credentials in resolver_url", "", signAsWritten(contentOf(fixed, { resolver_url: "https://user:secret@offers.merchant.example" }))],
  ["single_use together with recurrence", "", signAsWritten(contentOf(fixed, { single_use: true, recurrence: { interval: "monthly", amount: "100000000", cap_cycles: 3 } }))],
  ["recurrence amount outside the bounds", "No cycle could ever be paid.", signAsWritten(contentOf(fixed, { recurrence: { interval: "monthly", amount: "5", cap_cycles: 3 } }))],
  ["recurrence without a cap", "", signAsWritten(contentOf(fixed, { recurrence: { interval: "monthly", amount: "100000000" } }))],
  ["amount_min above amount_max", "", signAsWritten(contentOf(fixed, { amount_min: "200000000" }))],
  ["zero amount", "Zero would be a second way to write 'no bound'.", signAsWritten(contentOf(fixed, { amount_min: "0" }))],
  ["the same asset twice", "", signAsWritten(contentOf(fixed, { assets: [CKB, CKB] }))],
  ["ckb asset with another symbol", "", signAsWritten(contentOf(fixed, { assets: [{ asset_type: "ckb", symbol: "USDT" }] }))],
  ["token without a type_script_hash", "", signAsWritten(contentOf(fixed, { assets: [{ asset_type: "udt", symbol: "RUSD" }] }))],
  ["fraction in metadata", "Free-form signed content takes whole numbers only.", signAsWritten(contentOf(fixed, { metadata: { price: 9.5 } }))],
  ["constructor key in metadata", "", signAsWritten(contentOf(fixed, { metadata: { nested: { constructor: "x" } } }))],
  ["metadata nested nine deep", "A value at depth 9, counting metadata itself as depth 0.", signAsWritten(contentOf(fixed, { metadata: nested(9, "leaf") }))],
  ["extensions nested nine deep", "The same limit, counted the same way, for an extension field.", signAsWritten(contentOf(fixed, { extensions: nested(9, "leaf") }))],
  ["an x_ field nested nine deep", "", signAsWritten(contentOf(fixed, { x_trail: nested(9, "leaf") }))],
  ["description over the limit", "", signAsWritten(contentOf(fixed, { description: "x".repeat(OFFER_LIMITS.description_bytes + 1) }))],
  ["extra member in the signature object", "It would not be covered by the signature.", { ...fixed, signature: { ...fixed.signature, note: "unsigned" } }],
  ["padded signature value", "base64url without padding is the one spelling.", { ...fixed, signature: { scheme: "ed25519", value: `${fixed.signature.value}==` } }],
  ["signature scheme other than ed25519", "", { ...fixed, signature: { scheme: "ecdsa", value: fixed.signature.value } }]
].map(([name, note, offer]) => ({ name, ...(note ? { note } : {}), offer, error: expectError(() => verifyOffer(offer)) }));

// A member named __proto__ has to be written as JSON text: built as a
// JavaScript object literal it would set the prototype instead.
const protoJson = `${JSON.stringify(fixed).slice(0, -1)},"__proto__":{"single_use":true}}`;
const invalidJson = [
  {
    name: "unsigned __proto__ member beside a signed offer",
    note: "Given as JSON text. A verifier that builds a sorted object loses this member and accepts the offer.",
    offer_json: protoJson,
    error: expectError(() => verifyOffer(JSON.parse(protoJson)))
  }
];

// --- Encoded offers ---------------------------------------------------------

const encoded = encodeOffer(fixed);
const charset = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const swapAt = (text, index) => `${text.slice(0, index)}${charset[(charset.indexOf(text[index]) + 1) % 32]}${text.slice(index + 1)}`;
const wrap = (text) => encodeBech32m("fbroffer", Buffer.from(text));
const { decodeOffer } = await import("../packages/protocol/src/index.js");
const invalidEncoded = [
  ["one character changed in the data", swapAt(encoded, 40)],
  ["one character changed in the checksum", swapAt(encoded, encoded.length - 2)],
  ["truncated", encoded.slice(0, -5)],
  ["mixed case", `${encoded.slice(0, 30)}${encoded.slice(30).toUpperCase()}`],
  ["a character outside the Bech32 alphabet", `${encoded.slice(0, 30)}b${encoded.slice(31)}`],
  ["another prefix", encodeBech32m("lnbc", Buffer.from(canonicalStringify(fixed)))],
  ["body with whitespace", wrap(JSON.stringify(fixed, null, 1))],
  ["body with members in another order", wrap(JSON.stringify(Object.fromEntries(Object.entries(fixed).reverse())))],
  ["body with a repeated member", wrap(`${canonicalStringify(fixed).slice(0, -1)},"single_use":false}`)],
  ["body that is not JSON", wrap("not json")],
  ["body of a validly encoded but tampered offer", wrap(canonicalStringify({ ...fixed, description: "Free coffee" }))]
].map(([name, text]) => {
  let error;
  let reason;
  let decodes = false;
  try {
    const decoded = decodeOffer(text);
    decodes = true;
    error = expectError(() => verifyOffer(decoded));
  } catch (failure) {
    error = failure.code;
    reason = failure.details?.reason;
  }
  return { name, encoded: text, decodes, error, ...(reason ? { reason } : {}) };
});

// --- Requests against an offer ----------------------------------------------

const ranged = sign(baseInput({ description: "Ranged", assets: [CKB, rusd], amount_min: "1000", amount_max: "5000", expiry: 1_900_000_000 }));
const requests = [
  ["amount within the range", ranged, { amount: "2500", asset: CKB }, NOW],
  ["amount written loosely", ranged, { amount: 2500, asset: { asset_type: "CKB", symbol: "ckb" } }, NOW],
  ["asset omitted: the offer's first asset", ranged, { amount: "1000" }, NOW],
  ["the token the offer lists", ranged, { amount: "5000", asset: rusd }, NOW],
  ["below the minimum", ranged, { amount: "999", asset: CKB }, NOW],
  ["above the maximum", ranged, { amount: "5001", asset: CKB }, NOW],
  ["an asset the offer does not list", ranged, { amount: "2500", asset: { ...rusd, type_script_hash: `0x${"0".repeat(64)}` } }, NOW],
  ["after the offer expired", ranged, { amount: "2500", asset: CKB }, 1_900_000_001],
  ["at the moment of expiry", ranged, { amount: "2500", asset: CKB }, 1_900_000_000],
  ["a fixed offer requires its exact amount", fixed, { amount: "100000001", asset: CKB }, NOW],
  ["a zero amount", ranged, { amount: "0", asset: CKB }, NOW]
].map(([name, offer, request, now]) => {
  try {
    return { name, offer, request, now, result: validateResolutionRequest(offer, request, { now }) };
  } catch (error) {
    return { name, offer, request, now, error: error.code };
  }
});

// --- Revocations ------------------------------------------------------------

const revocation = createOfferRevocation(fixed, offerKey.private_key_pem, { revoked_at: NOW, reason: "key rotated" });
const { signature: revocationSignature, ...revocationPayload } = revocation;
const revocations = [
  ["valid", revocation, NOW],
  ["checked 300 seconds later, the edge of the window", revocation, NOW + 300],
  ["checked 301 seconds later", revocation, NOW + 301],
  ["for another offer", { ...revocation, offer_id: `0x${"f".repeat(64)}` }, NOW],
  ["reason changed after signing", { ...revocation, reason: "no reason" }, NOW],
  ["signed by another key", createOfferRevocation(fixed, strangerKey.private_key_pem, { revoked_at: NOW }), NOW],
  ["extra member in the signature object", { ...revocation, signature: { ...revocationSignature, note: "x" } }, NOW]
].map(([name, proof, now]) => {
  const result = verifyOfferRevocation(fixed, proof, { now });
  return { name, offer_id: fixed.offer_id, revocation: proof, now, ...(result.ok ? { valid: true } : { valid: false, error: result.code }) };
});

// --- Recurring cycle requests -----------------------------------------------

const recurring = validOffers.find((vector) => vector.name === "recurring offer capped by cycles").offer;
const cycle = signRecurrenceRequest(recurring, { amount: "2000", recurrence_cycle: 1 }, subscriberKey.private_key_pem);
const scheduled = signRecurrenceRequest(
  recurring,
  { amount: "2000", recurrence_cycle: 2, scheduled_for: "2027-02-15T08:00:00.000Z" },
  subscriberKey.private_key_pem
);
const signingPayload = (request) =>
  canonicalStringify({
    scheme: "fiberoffer-recurrence-v1",
    offer_id: recurring.offer_id,
    approval_id: request.approval_id,
    recurrence_cycle: request.recurrence_cycle,
    amount: request.amount,
    asset: request.asset,
    scheduled_for: request.scheduled_for
  });
const recurrenceRequests = [
  ["first cycle", cycle],
  ["a later cycle with scheduled_for", scheduled],
  ["cycle number changed after signing", { ...cycle, recurrence_cycle: 2 }],
  ["another subscription's ID with this key", { ...cycle, approval_id: subscriptionId(strangerKey.public_key_pem) }],
  ["signed by a key other than the one presented", { ...cycle, subscriber_signature: signRecurrenceRequest(recurring, { amount: "2000", recurrence_cycle: 1 }, strangerKey.private_key_pem).subscriber_signature }],
  ["without the proof", { amount: "2000", asset: CKB, recurrence_cycle: 1 }],
  ["an amount other than the cycle amount", { ...cycle, amount: "2001" }],
  ["a cycle beyond the cap", { ...cycle, recurrence_cycle: 13 }]
].map(([name, request]) => {
  const result = verifyRecurrenceRequest(recurring, request);
  return {
    name,
    offer_id: recurring.offer_id,
    request,
    ...(result.ok ? { valid: true, signing_payload: signingPayload(request) } : { valid: false, error: result.code })
  };
});

const vectors = {
  title: "Fiber Offers v1 conformance test vectors",
  format: "fiberoffer-v1",
  // Counts revisions of this file. 2 added the depth-limit cases; no case of
  // revision 1 changed.
  vectors_version: 2,
  notes: [
    "Every value here is fixed. An implementation conforms when it reproduces each output and refuses each invalid case.",
    "Error codes are those of the reference implementation (@fiber-offers/protocol). Another implementation must refuse the same cases; matching the code is recommended, not required.",
    "The keys below are derived from the published seed labels (seed = SHA-256 of the label). They are test keys.",
    `Unless a vector gives its own "now", the current time is ${NOW} (unix seconds).`
  ],
  now: NOW,
  limits: OFFER_LIMITS,
  keys: { offer: offerKey, subscriber: { ...subscriberKey, subscription_id: subscriptionId(subscriberKey.public_key_pem) }, stranger: strangerKey },
  canonical_json: canonicalJson,
  type_script_hashes: typeScriptHashes,
  valid_offers: validOffers,
  normalization,
  invalid_offers: [...invalidObjects, ...invalidJson],
  invalid_encoded_offers: invalidEncoded,
  resolution_requests: requests,
  revocations,
  revocation_signing_payload: { revocation, signing_payload: canonicalStringify(revocationPayload) },
  recurrence_requests: recurrenceRequests
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(vectors, null, 2)}\n`);
const count = (list) => list.length;
console.log(
  `Wrote ${outputPath}: ${count(canonicalJson)} canonical JSON, ${count(typeScriptHashes)} script hashes, ` +
    `${count(validOffers)} valid offers, ${count(vectors.invalid_offers)} invalid offers, ` +
    `${count(invalidEncoded)} invalid encodings, ${count(requests)} requests, ${count(revocations)} revocations, ` +
    `${count(recurrenceRequests)} recurrence requests`
);
