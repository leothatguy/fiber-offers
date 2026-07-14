import test from "node:test";
import assert from "node:assert/strict";
import {
  base64UrlEncode,
  canonicalStringify,
  createOfferRevocation,
  createSignedOffer,
  decodeOffer,
  encodeOffer,
  generateOfferKeyPair,
  validateResolutionRequest,
  verifyOffer,
  verifyOfferRevocation
} from "../src/index.js";

function makeOffer(overrides = {}) {
  const keys = generateOfferKeyPair();
  const offer = createSignedOffer(
    {
      node_id: "02" + "a".repeat(64),
      public_key: keys.publicKeyPem,
      resolver_url: "http://localhost:8787",
      description: "Coffee checkout",
      amount_min: "1000",
      amount_max: "5000",
      assets: [{ asset_type: "ckb", symbol: "CKB" }],
      ...overrides
    },
    keys.privateKeyPem
  );
  return { offer, keys };
}

test("creates, verifies, encodes, and decodes a signed offer", () => {
  const { offer } = makeOffer();

  assert.equal(verifyOffer(offer).ok, true);
  assert.match(offer.offer_id, /^0x[0-9a-f]{64}$/);

  const encoded = encodeOffer(offer);
  assert.match(encoded, /^fbroffer1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]+$/);
  assert.equal(decodeOffer(encoded).offer_id, offer.offer_id);

  const legacy = `fbroffer1${base64UrlEncode(canonicalStringify(offer))}`;
  assert.equal(decodeOffer(legacy).offer_id, offer.offer_id);
});

test("preserves signed extension fields and validates node identifiers", () => {
  const { offer, keys } = makeOffer({ x_checkout_reference: "merchant-42" });
  assert.equal(offer.x_checkout_reference, "merchant-42");
  assert.equal(verifyOffer(offer).ok, true);

  assert.throws(
    () => createSignedOffer({ ...offer, node_id: "not-a-node", offer_id: undefined, signature: undefined }, keys.privateKeyPem),
    { code: "INVALID_NODE_ID" }
  );
});

test("creates and verifies signed offer revocations", () => {
  const { offer, keys } = makeOffer();
  const revoked_at = Math.floor(Date.now() / 1000);
  const revocation = createOfferRevocation(offer, keys.privateKeyPem, { revoked_at, reason: "rotated" });
  assert.equal(verifyOfferRevocation(offer, revocation, { now: revoked_at }).ok, true);
  assert.equal(
    verifyOfferRevocation(offer, { ...revocation, offer_id: `0x${"f".repeat(64)}` }, { now: revoked_at }).ok,
    false
  );
});

test("detects tampered signed fields", () => {
  const { offer } = makeOffer();
  const tampered = { ...offer, amount_max: "9000" };

  const result = verifyOffer(tampered);
  assert.equal(result.ok, false);
  assert.equal(result.code, "OFFER_ID_MISMATCH");
});

test("validates resolution amount bounds and assets", () => {
  const { offer } = makeOffer();

  assert.deepEqual(validateResolutionRequest(offer, { amount: "1200", asset: offer.assets[0] }), {
    amount: "1200",
    asset: { asset_type: "ckb", symbol: "CKB" }
  });

  assert.throws(() => validateResolutionRequest(offer, { amount: "999", asset: offer.assets[0] }), {
    code: "AMOUNT_TOO_LOW"
  });

  assert.throws(
    () =>
      validateResolutionRequest(offer, {
        amount: "1200",
        asset: { asset_type: "udt", symbol: "USDI", type_script_hash: "0x" + "1".repeat(64) }
      }),
    { code: "UNSUPPORTED_ASSET" }
  );
});

test("requires the exact signed amount for fixed offers", () => {
  const { offer } = makeOffer({ amount_min: "1000", amount_max: "1000" });

  assert.throws(
    () => validateResolutionRequest(offer, { amount: "999", asset: offer.assets[0] }),
    (error) => error.code === "AMOUNT_MUST_MATCH_FIXED_AMOUNT" && error.message.includes("1000")
  );
  assert.throws(
    () => validateResolutionRequest(offer, { amount: "1001", asset: offer.assets[0] }),
    { code: "AMOUNT_MUST_MATCH_FIXED_AMOUNT" }
  );
});

test("requires spending caps on recurring offers", () => {
  const keys = generateOfferKeyPair();

  assert.throws(
    () =>
      createSignedOffer(
        {
          node_id: "02" + "b".repeat(64),
          public_key: keys.publicKeyPem,
          resolver_url: "http://localhost:8787",
          assets: [{ asset_type: "ckb", symbol: "CKB" }],
          recurrence: { interval: "monthly", amount: "1000" }
        },
        keys.privateKeyPem
      ),
    { code: "RECURRENCE_CAP_REQUIRED" }
  );
});
