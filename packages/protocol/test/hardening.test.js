// Signing, canonical form and decoding: the cases where a loose implementation
// would accept something it should not, or give one offer two identities.
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import test from "node:test";
import {
  base64UrlDecode,
  base64UrlEncode,
  buildUnsignedOffer,
  canonicalize,
  canonicalStringify,
  createOfferRevocation,
  createSignedOffer,
  decodeOffer,
  encodeOffer,
  generateOfferKeyPair,
  isEncodedOffer,
  OFFER_LIMITS,
  signOffer,
  signRecurrenceRequest,
  verifyOffer,
  verifyOfferRevocation,
  verifyRecurrenceRequest
} from "../src/index.js";

const NODE_ID = `02${"a".repeat(64)}`;
const CKB = { asset_type: "ckb", symbol: "CKB" };

function input(keys, overrides = {}) {
  return {
    node_id: NODE_ID,
    public_key: keys.publicKeyPem,
    resolver_url: "https://resolver.example",
    description: "Coffee checkout",
    amount_min: "1000",
    amount_max: "5000",
    assets: [CKB],
    ...overrides
  };
}

function makeOffer(overrides = {}) {
  const keys = generateOfferKeyPair();
  return { keys, offer: createSignedOffer(input(keys, overrides), keys.privateKeyPem) };
}

// Re-signs an offer after changing it, the way a careless or hostile producer
// would: the ID and signature are valid for the content as written.
function resign(offer, keys, changes) {
  const content = { ...offer, ...changes };
  delete content.offer_id;
  delete content.signature;
  for (const key of Object.keys(content)) if (content[key] === undefined) delete content[key];
  const withId = { ...content, offer_id: `0x${createHash("sha256").update(canonicalStringify(content)).digest("hex")}` };
  const signature = cryptoSign(null, Buffer.from(canonicalStringify(withId)), keys.privateKey ?? pemKey(keys.privateKeyPem));
  return { ...withId, signature: { scheme: "ed25519", value: base64UrlEncode(signature) } };
}

function pemKey(pem) {
  return { key: pem, format: "pem" };
}

function codeOf(run) {
  try {
    run();
  } catch (error) {
    return error.code;
  }
  return "accepted";
}

// --- C1: canonical JSON -----------------------------------------------------

test("canonical JSON orders members by key text, including number-like keys", () => {
  // A JavaScript object would list "2" before "10"; the canonical order is by
  // the key's text, as in RFC 8785.
  assert.equal(canonicalStringify({ a: 1, 10: "ten", 2: "two", "-x": 0 }), '{"-x":0,"10":"ten","2":"two","a":1}');
  assert.equal(canonicalStringify({ b: [{ z: 1, y: 2 }], a: null, skipped: undefined }), '{"a":null,"b":[{"y":2,"z":1}]}');
  assert.equal(canonicalStringify({ "é": 1, e: 2, "€": 3, E: 4 }), '{"E":4,"e":2,"é":1,"€":3}');
  assert.equal(canonicalStringify("a\n\"b\" "), JSON.stringify("a\n\"b\" "));
  assert.equal(canonicalStringify([1, -0, 1e21, 0.1]), "[1,0,1e+21,0.1]");
  // The same value written in any member order has the same bytes.
  assert.equal(canonicalStringify({ x: 1, y: { b: 2, a: 1 } }), canonicalStringify({ y: { a: 1, b: 2 }, x: 1 }));
  assert.deepEqual(canonicalize({ b: 1, a: { d: 1, c: 2 } }), { a: { c: 2, d: 1 }, b: 1 });
});

test("a member named __proto__ is part of the canonical text, not dropped from it", () => {
  const parsed = JSON.parse('{"a":1,"__proto__":{"admin":true}}');
  assert.equal(canonicalStringify(parsed), '{"__proto__":{"admin":true},"a":1}');
  assert.notEqual(canonicalStringify(parsed), canonicalStringify({ a: 1 }));
});

test("canonical JSON refuses values that have no single JSON spelling", () => {
  for (const value of [NaN, Infinity, 10n, () => {}, Symbol("s"), new Date(0), new Map(), Buffer.from("x"), [undefined], "\ud800"]) {
    assert.equal(codeOf(() => canonicalStringify({ value })), "INVALID_CANONICAL_VALUE", String(value?.constructor?.name ?? value));
  }
  let nested = {};
  for (let depth = 0; depth < 40; depth += 1) nested = { nested };
  assert.equal(codeOf(() => canonicalStringify(nested)), "INVALID_CANONICAL_VALUE");
});

test("an unsigned __proto__ member cannot ride along with a signed offer", () => {
  const { offer } = makeOffer();
  const wire = JSON.parse(`${JSON.stringify(offer).slice(0, -1)},"__proto__":{"single_use":true}}`);

  // Before: the member was missing from the signed bytes, so this verified.
  assert.equal(codeOf(() => verifyOffer(wire)), "FORBIDDEN_KEY");
  // And it cannot be smuggled into signed free-form content either.
  const keys = generateOfferKeyPair();
  for (const metadata of [JSON.parse('{"__proto__":{"a":1}}'), { nested: { constructor: 1 } }, { list: [{ prototype: 1 }] }]) {
    assert.equal(codeOf(() => createSignedOffer(input(keys, { metadata }), keys.privateKeyPem)), "FORBIDDEN_KEY");
  }
});

test("metadata with number-like keys signs and verifies in canonical order", () => {
  const { offer } = makeOffer({ metadata: { 10: "ten", 2: "two", a: "letter" } });
  assert.equal(verifyOffer(offer).ok, true);
  assert.equal(decodeOffer(encodeOffer(offer)).offer_id, offer.offer_id);
  assert.match(canonicalStringify(offer), /"metadata":\{"10":"ten","2":"two","a":"letter"\}/);
});

// --- C2: key types ----------------------------------------------------------

test("only Ed25519 keys sign and verify offers", () => {
  const { offer, keys } = makeOffer();
  const others = {
    "RSA-2048": generateKeyPairSync("rsa", { modulusLength: 2048 }),
    "P-256": generateKeyPairSync("ec", { namedCurve: "P-256" }),
    Ed448: generateKeyPairSync("ed448")
  };

  for (const [label, pair] of Object.entries(others)) {
    const publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" });
    const privateKeyPem = pair.privateKey.export({ type: "pkcs8", format: "pem" });

    // Creating an offer under such a key, or signing with one, is refused.
    assert.equal(codeOf(() => buildUnsignedOffer(input(keys, { public_key: publicKeyPem }))), "INVALID_KEY_TYPE", label);
    assert.equal(codeOf(() => signOffer(buildUnsignedOffer(input(keys)), privateKeyPem)), "INVALID_KEY_TYPE", label);
    assert.equal(codeOf(() => createOfferRevocation(offer, privateKeyPem)), "INVALID_KEY_TYPE", label);
    assert.equal(codeOf(() => signRecurrenceRequest(offer, { amount: "1000" }, privateKeyPem)), "INVALID_KEY_TYPE", label);

    // An offer that names such a key and carries a signature that key really
    // made (which Node would verify) is refused before any verification.
    const algorithm = label === "Ed448" ? null : "sha256";
    const content = { ...offer, public_key: publicKeyPem.trim() };
    delete content.offer_id;
    delete content.signature;
    const withId = { ...content, offer_id: `0x${createHash("sha256").update(canonicalStringify(content)).digest("hex")}` };
    const forged = {
      ...withId,
      signature: {
        scheme: "ed25519",
        value: base64UrlEncode(cryptoSign(algorithm, Buffer.from(canonicalStringify(withId)), pair.privateKey))
      }
    };
    assert.equal(codeOf(() => verifyOffer(forged)), "INVALID_KEY_TYPE", label);
  }

  assert.equal(codeOf(() => buildUnsignedOffer(input(keys, { public_key: "not a key" }))), "INVALID_PUBLIC_KEY");
  assert.equal(codeOf(() => signOffer(buildUnsignedOffer(input(keys)), "not a key")), "INVALID_PRIVATE_KEY");
});

test("a public key has one spelling in an offer", () => {
  const keys = generateOfferKeyPair();
  const canonical = keys.publicKeyPem.trim();
  const base64 = canonical.split("\n")[1];
  const variants = [
    `${canonical}\n\n`,
    canonical.replaceAll("\n", "\r\n"),
    `-----BEGIN PUBLIC KEY-----\n${base64.slice(0, 30)}\n${base64.slice(30)}\n-----END PUBLIC KEY-----`
  ];

  for (const variant of variants) {
    // However the key is written when the offer is created, the offer carries
    // the canonical form and so has the same ID.
    const built = buildUnsignedOffer(input(keys, { public_key: variant }));
    assert.equal(built.public_key, canonical);
    assert.equal(built.offer_id, buildUnsignedOffer(input(keys)).offer_id);
  }
  // An inbound offer written with another spelling is refused.
  const { offer, keys: signer } = makeOffer();
  const respelled = resign(offer, signer, { public_key: `${offer.public_key}\n` });
  assert.equal(codeOf(() => verifyOffer(respelled)), "NON_CANONICAL_OFFER");
});

// --- C3: canonical form, invariants, bounds ---------------------------------

test("loosely written input is brought to canonical form before the ID is taken", () => {
  const keys = generateOfferKeyPair();
  const canonical = buildUnsignedOffer(input(keys));
  const loose = buildUnsignedOffer(
    input(keys, {
      node_id: NODE_ID.toUpperCase().replace(/^02/, "02"),
      resolver_url: "HTTPS://Resolver.Example:443/",
      description: "  Coffee checkout  ",
      amount_min: 1000,
      amount_max: "0005000",
      assets: [{ asset_type: "CKB", symbol: "ckb" }],
      network: undefined
    })
  );

  assert.equal(loose.offer_id, canonical.offer_id);
  assert.equal(loose.node_id, NODE_ID);
  assert.equal(loose.resolver_url, "https://resolver.example");
  assert.equal(loose.network, "testnet");
  assert.deepEqual(loose.assets, [CKB]);
  assert.equal(loose.amount_min, "1000");
  assert.equal(loose.amount_max, "5000");
  // Absent optional fields are absent, not undefined or null.
  assert.equal("recurrence" in canonical, false);
  assert.equal("metadata" in canonical, false);
});

test("an inbound offer must already be in canonical form", () => {
  const { offer, keys } = makeOffer({ metadata: { order: "42" } });
  assert.equal(verifyOffer(offer).ok, true);

  // Each of these is validly signed by the offer's own key, and describes the
  // same terms as `offer` in a different spelling.
  const respellings = {
    "uppercase node_id": { node_id: NODE_ID.toUpperCase() },
    "trailing slash on resolver_url": { resolver_url: "https://resolver.example/" },
    "default port on resolver_url": { resolver_url: "https://resolver.example:443" },
    "uppercase host": { resolver_url: "https://RESOLVER.example" },
    "uppercase asset_type": { assets: [{ asset_type: "CKB", symbol: "CKB" }] },
    "lowercase symbol": { assets: [{ asset_type: "ckb", symbol: "ckb" }] },
    "leading zeros": { amount_min: "0001000" },
    "amount as a number": { amount_min: 1000 },
    "expiry as a string": { expiry: "4102444800" },
    "untrimmed description": { description: " Coffee checkout" },
    "null for an absent field": { recurrence: null },
    "empty string for an absent field": { description: "" }
  };
  for (const [label, changes] of Object.entries(respellings)) {
    assert.equal(codeOf(() => verifyOffer(resign(offer, keys, changes))), "NON_CANONICAL_OFFER", label);
  }

  const invalid = {
    "missing network": [{ network: undefined }, "INVALID_NETWORK"],
    "unknown network": [{ network: "regtest" }, "INVALID_NETWORK"],
    "unknown top-level field": [{ payer_must: "do something new" }, "UNKNOWN_OFFER_FIELD"],
    "single_use as a string": [{ single_use: "false" }, "INVALID_SINGLE_USE"],
    "version as a string": [{ version: "1" }, "INVALID_VERSION"]
  };
  for (const [label, [changes, code]] of Object.entries(invalid)) {
    assert.equal(codeOf(() => verifyOffer(resign(offer, keys, changes))), code, label);
  }

  // Additions a reader may ignore have a place, and are signed.
  const extended = resign(offer, keys, { x_checkout: "kiosk-7", extensions: { loyalty: { tier: 2 } } });
  assert.equal(verifyOffer(extended).ok, true);
  assert.equal(verifyOffer({ ...extended, x_checkout: "kiosk-8" }).ok, false);
});

test("terms that contradict each other are refused", () => {
  const keys = generateOfferKeyPair();
  const build = (overrides, options) => codeOf(() => buildUnsignedOffer(input(keys, overrides), options));
  const recurrence = { interval: "monthly", amount: "2000", cap_cycles: 12 };

  assert.equal(build({ recurrence }), "accepted");
  assert.equal(build({ recurrence: { ...recurrence, amount: "9000" } }), "RECURRENCE_AMOUNT_OUT_OF_BOUNDS");
  assert.equal(build({ recurrence: { ...recurrence, amount: "500" } }), "RECURRENCE_AMOUNT_OUT_OF_BOUNDS");
  assert.equal(build({ recurrence, single_use: true }), "SINGLE_USE_RECURRENCE_CONFLICT");
  assert.equal(build({ recurrence: { ...recurrence, custom_seconds: 60 } }), "INVALID_RECURRENCE");
  assert.equal(
    build({ recurrence: { interval: "monthly", amount: "2000", spending_cap_total: "1999" } }),
    "INVALID_RECURRENCE"
  );
  assert.equal(build({ amount_min: "5000", amount_max: "1000" }), "INVALID_AMOUNT_BOUNDS");
  assert.equal(build({ amount_min: "0" }), "INVALID_AMOUNT");
  assert.equal(build({ amount_max: 0 }), "INVALID_AMOUNT");

  // An offer cannot be created already expired; one that expires later is
  // still a valid offer afterwards (requests are then refused as expired).
  assert.equal(build({ expiry: 1_000 }, { now: 2_000 }), "OFFER_EXPIRY_IN_PAST");
  assert.equal(build({ expiry: 3_000 }, { now: 2_000 }), "accepted");
  const expiring = createSignedOffer(input(keys, { expiry: 3_000 }), keys.privateKeyPem, { now: 2_000 });
  assert.equal(verifyOffer(expiring).ok, true);
});

test("assets are named and listed unambiguously", () => {
  const keys = generateOfferKeyPair();
  const build = (assets) => codeOf(() => buildUnsignedOffer(input(keys, { assets })));
  const token = (overrides = {}) => ({ asset_type: "udt", symbol: "RUSD", type_script_hash: `0x${"1".repeat(64)}`, ...overrides });

  assert.equal(build([CKB, token()]), "accepted");
  assert.equal(build([CKB, CKB]), "DUPLICATE_ASSET");
  // The same token under another label is still the same token.
  assert.equal(build([token(), token({ symbol: "USD" })]), "DUPLICATE_ASSET");
  assert.equal(build([{ asset_type: "ckb", symbol: "USDT" }]), "INVALID_ASSET_SYMBOL");
  assert.equal(build([{ ...CKB, type_script_hash: `0x${"1".repeat(64)}` }]), "INVALID_ASSET");
  assert.equal(build([token({ symbol: "R USD" })]), "INVALID_ASSET_SYMBOL");
  assert.equal(build([token({ symbol: "RUSD\nCKB" })]), "INVALID_ASSET_SYMBOL");
  assert.equal(build([token({ symbol: "A".repeat(OFFER_LIMITS.symbol_length + 1) })]), "INVALID_ASSET_SYMBOL");
  assert.equal(build([token({ type_script_hash: undefined })]), "MISSING_FIELD");
  assert.equal(
    build(Array.from({ length: OFFER_LIMITS.assets + 1 }, (_, index) => token({ type_script_hash: `0x${String(index).padStart(64, "0")}` }))),
    "TOO_MANY_ASSETS"
  );
});

test("a resolver address is https, without credentials, query or fragment", () => {
  const keys = generateOfferKeyPair();
  const build = (resolver_url, network) => codeOf(() => buildUnsignedOffer(input(keys, { resolver_url, network })));

  assert.equal(build("https://offers.merchant.example/base/"), "accepted");
  assert.equal(buildUnsignedOffer(input(keys, { resolver_url: "https://offers.merchant.example/base/" })).resolver_url, "https://offers.merchant.example/base");
  assert.equal(build("https://user:secret@offers.merchant.example"), "INVALID_URL");
  assert.equal(build("https://offers.merchant.example/?tenant=1"), "INVALID_URL");
  assert.equal(build("https://offers.merchant.example/#frag"), "INVALID_URL");
  assert.equal(build("ftp://offers.merchant.example"), "INVALID_URL");
  assert.equal(build(`https://offers.merchant.example/${"a".repeat(OFFER_LIMITS.resolver_url_length)}`), "INVALID_URL");

  // Plain http only where it cannot expose a payer.
  for (const network of ["mainnet", "testnet"]) {
    assert.equal(build("http://offers.merchant.example", network), "INSECURE_RESOLVER_URL", network);
    assert.equal(build("http://192.168.1.20:8787", network), "INSECURE_RESOLVER_URL", network);
    assert.equal(build("http://localhost:8787", network), "accepted", network);
    assert.equal(build("http://127.0.0.1:8787", network), "accepted", network);
    assert.equal(build("http://[::1]:8787", network), "accepted", network);
  }
  assert.equal(build("http://offers.merchant.example", "dev"), "accepted");
});

test("an offer's size is bounded by the format", () => {
  const keys = generateOfferKeyPair();
  const build = (overrides) => codeOf(() => buildUnsignedOffer(input(keys, overrides)));

  assert.equal(build({ description: "x".repeat(OFFER_LIMITS.description_bytes) }), "accepted");
  assert.equal(build({ description: "x".repeat(OFFER_LIMITS.description_bytes + 1) }), "DESCRIPTION_TOO_LONG");
  // Counted in bytes, not characters.
  assert.equal(build({ description: "é".repeat(OFFER_LIMITS.description_bytes / 2 + 1) }), "DESCRIPTION_TOO_LONG");
  assert.equal(build({ description: "x".repeat(200_000) }), "DESCRIPTION_TOO_LONG");
  assert.equal(build({ metadata: { note: "x".repeat(OFFER_LIMITS.metadata_bytes) } }), "OFFER_FIELD_TOO_LARGE");
  assert.equal(build({ extensions: { note: "x".repeat(OFFER_LIMITS.extensions_bytes) } }), "OFFER_FIELD_TOO_LARGE");
  assert.equal(build({ x_one: "x".repeat(1200), x_two: "x".repeat(1200) }), "OFFER_FIELD_TOO_LARGE");
  // Each part within its own limit, the whole still too large.
  assert.equal(
    build({
      description: "x".repeat(500),
      metadata: { note: "m".repeat(1900) },
      extensions: { note: "e".repeat(1900) }
    }),
    "OFFER_TOO_LARGE"
  );

  // Free-form signed content is plain JSON with whole numbers only.
  assert.equal(build({ metadata: { price: 9.99 } }), "INVALID_SIGNED_JSON");
  assert.equal(build({ metadata: { big: 2 ** 60 } }), "INVALID_SIGNED_JSON");
  assert.equal(build({ metadata: { count: 3, price: "9.99", tags: ["a", "b"], nested: { ok: true, none: null } } }), "accepted");
  assert.equal(build({ metadata: { when: new Date(0) } }), "INVALID_CANONICAL_VALUE");
  assert.equal(build({ metadata: ["not", "an", "object"] }), "INVALID_METADATA");
  let deep = "leaf";
  for (let depth = 0; depth < OFFER_LIMITS.json_depth + 1; depth += 1) deep = { deep };
  assert.equal(build({ metadata: deep }), "INVALID_SIGNED_JSON");
});

test("a signature has one spelling and nothing unsigned beside it", () => {
  const { offer, keys } = makeOffer();
  const { value } = offer.signature;
  const verify = (signature) => codeOf(() => verifyOffer({ ...offer, signature }));

  assert.equal(value.length, 86);
  // An extra member in the signature object is not covered by the signature.
  assert.equal(verify({ ...offer.signature, note: "unsigned" }), "INVALID_SIGNATURE");
  assert.equal(verify({ scheme: "ed25519", value: `${value}==` }), "INVALID_SIGNATURE");
  // The standard base64 alphabet is another spelling (when the two differ here).
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  if (standard !== value) assert.equal(verify({ scheme: "ed25519", value: standard }), "INVALID_SIGNATURE");
  assert.equal(verify({ scheme: "ed25519", value: `${value} ` }), "INVALID_SIGNATURE");
  assert.equal(verify({ scheme: "ed25519", value: value.slice(0, -2) }), "INVALID_SIGNATURE");
  assert.equal(verify({ scheme: "rsa", value }), "INVALID_SIGNATURE");
  assert.equal(verify([]), "INVALID_SIGNATURE");

  // The last character of 86 holds 4 payload bits and 2 that must be zero.
  // Setting them gives a second spelling of the same 64 bytes.
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const twin = `${value.slice(0, -1)}${alphabet[alphabet.indexOf(value.at(-1)) | 1]}`;
  if (twin !== value) {
    assert.deepEqual(base64UrlDecode(twin), base64UrlDecode(value));
    assert.equal(verify({ scheme: "ed25519", value: twin }), "INVALID_SIGNATURE");
  }

  // The same rules hold for a revocation and for a recurring cycle request.
  const revoked_at = Math.floor(Date.now() / 1000);
  const revocation = createOfferRevocation(offer, keys.privateKeyPem, { revoked_at });
  assert.equal(verifyOfferRevocation(offer, revocation, { now: revoked_at }).ok, true);
  assert.equal(
    verifyOfferRevocation(offer, { ...revocation, signature: { ...revocation.signature, note: "x" } }, { now: revoked_at }).code,
    "INVALID_REVOCATION_SIGNATURE"
  );
  assert.equal(
    verifyOfferRevocation(offer, { ...revocation, signature: { scheme: "ed25519", value: `${revocation.signature.value}=` } }, { now: revoked_at }).code,
    "INVALID_REVOCATION_SIGNATURE"
  );

  const recurring = makeOffer({ recurrence: { interval: "monthly", amount: "2000", cap_cycles: 3 } }).offer;
  const subscriber = generateOfferKeyPair();
  const cycle = signRecurrenceRequest(recurring, { amount: "2000", recurrence_cycle: 1 }, subscriber.privateKeyPem);
  assert.equal(verifyRecurrenceRequest(recurring, cycle).ok, true);
  assert.equal(
    verifyRecurrenceRequest(recurring, { ...cycle, subscriber_signature: `${cycle.subscriber_signature}=` }).code,
    "INVALID_SUBSCRIPTION_SIGNATURE"
  );
});

// --- C4: encoding -------------------------------------------------------------

test("an encoded offer reads in lowercase or uppercase, never mixed", () => {
  const { offer } = makeOffer();
  const encoded = encodeOffer(offer);
  const upper = encoded.toUpperCase();

  assert.match(encoded, /^fbroffer1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]+$/);
  assert.deepEqual(decodeOffer(encoded), offer);
  assert.deepEqual(decodeOffer(upper), offer);
  assert.equal(isEncodedOffer(upper), true);
  assert.equal(isEncodedOffer(offer.offer_id), false);
  // One offer, one encoding: decoding and encoding again gives the same text.
  assert.equal(encodeOffer(decodeOffer(upper)), encoded);

  const mixed = `${encoded.slice(0, 20)}${encoded.slice(20).toUpperCase()}`;
  assert.throws(() => decodeOffer(mixed), (error) => error.code === "INVALID_OFFER_ENCODING" && error.details.reason === "mixed_case");
});

test("a damaged encoded offer is reported as damaged", () => {
  const { offer } = makeOffer();
  const encoded = encodeOffer(offer);
  const charset = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  const swap = (text, index) => `${text.slice(0, index)}${charset[(charset.indexOf(text[index]) + 1) % 32]}${text.slice(index + 1)}`;

  // One wrong character anywhere, including in the checksum itself.
  for (const index of [9, 40, Math.floor(encoded.length / 2), encoded.length - 1]) {
    assert.throws(() => decodeOffer(swap(encoded, index)), { code: "INVALID_OFFER_CHECKSUM" }, `index ${index}`);
  }
  assert.throws(() => decodeOffer(encoded.slice(0, -3)), { code: "INVALID_OFFER_CHECKSUM" });

  const reasons = {
    [`${encoded.slice(0, 30)}b${encoded.slice(31)}`]: "character",
    fbroffer1: "length",
    "fbroffer1qqq": "length",
    [`lnbc1${encoded.slice(9)}`]: "prefix",
    [`${encoded}${"q".repeat(OFFER_LIMITS.encoded_length)}`]: "length"
  };
  for (const [text, reason] of Object.entries(reasons)) {
    assert.throws(
      () => decodeOffer(text),
      (error) => error.code === "INVALID_OFFER_ENCODING" && error.details.reason === reason,
      `${text.slice(0, 24)}… should fail with ${reason}`
    );
  }
  assert.throws(() => decodeOffer(undefined), { code: "INVALID_OFFER_ENCODING" });
});

test("an encoded offer's body must be the canonical JSON itself", async () => {
  const { encodeBech32m } = await import("../src/bech32m.js");
  const { offer } = makeOffer();
  const wrap = (text) => encodeBech32m("fbroffer", Buffer.from(text));
  const canonical = canonicalStringify(offer);

  assert.deepEqual(decodeOffer(wrap(canonical)), offer);
  const variants = {
    "with whitespace": JSON.stringify(offer, null, 2),
    "members in another order": JSON.stringify(Object.fromEntries(Object.entries(offer).reverse())),
    "a repeated member": `${canonical.slice(0, -1)},"single_use":false}`
  };
  for (const [label, text] of Object.entries(variants)) {
    assert.deepEqual(JSON.parse(text), offer, label);
    assert.throws(
      () => decodeOffer(wrap(text)),
      (error) => error.code === "INVALID_OFFER_ENCODING" && error.details.reason === "not_canonical",
      label
    );
  }
  assert.throws(() => decodeOffer(wrap("not json")), (error) => error.details.reason === "json");
  assert.throws(() => decodeOffer(encodeBech32m("fbroffer", Buffer.from([0xff, 0xfe]))), (error) => error.details.reason === "json");
});

test("every error code this package can raise is listed in the specification", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const source = new URL("../src/", import.meta.url);
  const specification = await readFile(new URL("../../../docs/spec-v1.md", import.meta.url), "utf8");
  const listed = new Set(specification.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g));

  const raised = new Set();
  for (const name of (await readdir(source)).filter((file) => file.endsWith(".js"))) {
    const text = await readFile(new URL(name, source), "utf8");
    for (const match of text.matchAll(/"([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)"/g)) raised.add(match[1]);
  }
  // The code of an error raised without one. The package raises none.
  raised.delete("FIBER_OFFER_ERROR");

  assert.ok(raised.size > 40, `only ${raised.size} codes were found in the source`);
  assert.deepEqual([...raised].filter((code) => !listed.has(code)).sort(), []);
});
