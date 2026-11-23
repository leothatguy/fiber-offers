// Checks this implementation against the published conformance vectors in
// docs/test-vectors/v1.json. The file is the reference: these tests read it and
// never regenerate it.
import assert from "node:assert/strict";
import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  base64UrlDecode,
  canonicalStringify,
  ckbScriptHash,
  createSignedOffer,
  decodeOffer,
  encodeOffer,
  OFFER_LIMITS,
  signRecurrenceRequest,
  subscriptionId,
  validateResolutionRequest,
  verifyOffer,
  verifyOfferRevocation,
  verifyRecurrenceRequest
} from "../src/index.js";

const vectors = JSON.parse(await readFile(new URL("../../../docs/test-vectors/v1.json", import.meta.url), "utf8"));
const sha256 = (text) => `0x${createHash("sha256").update(text).digest("hex")}`;

// What an implementation reports for an offer: "valid", or the code it refused with.
function outcome(run) {
  try {
    const result = run();
    return result?.ok === false ? result.code : "valid";
  } catch (error) {
    return error.code ?? `threw ${error.message}`;
  }
}

test("the vector file is for this format and these limits", () => {
  assert.equal(vectors.format, "fiberoffer-v1");
  assert.deepEqual(vectors.limits, { ...OFFER_LIMITS });
  for (const key of Object.values(vectors.keys)) {
    assert.equal(createHash("sha256").update(key.seed_label).digest("hex"), key.seed_hex);
    const der = createPublicKey(key.public_key_pem).export({ type: "spki", format: "der" });
    assert.equal(der.subarray(-32).toString("hex"), key.public_key_hex);
    assert.equal(createPublicKey(key.private_key_pem).export({ type: "spki", format: "pem" }).trim(), key.public_key_pem);
  }
  assert.equal(subscriptionId(vectors.keys.subscriber.public_key_pem), vectors.keys.subscriber.subscription_id);
});

test("canonical JSON matches every vector", () => {
  for (const vector of vectors.canonical_json) {
    assert.equal(canonicalStringify(JSON.parse(vector.input_json)), vector.canonical, vector.name);
    // Canonical text is its own canonical form.
    assert.equal(canonicalStringify(JSON.parse(vector.canonical)), vector.canonical, vector.name);
  }
});

test("type script hashes match every vector", () => {
  for (const vector of vectors.type_script_hashes) {
    assert.equal(ckbScriptHash(vector.script), vector.type_script_hash, vector.name);
  }
});

test("every valid offer reproduces its ID, signature and encoding", () => {
  const publicKey = createPublicKey(vectors.keys.offer.public_key_pem);
  for (const vector of vectors.valid_offers) {
    const { offer } = vector;
    const { signature, ...withId } = offer;
    const { offer_id: _id, ...content } = withId;

    assert.equal(canonicalStringify(content), vector.id_preimage, vector.name);
    assert.equal(sha256(vector.id_preimage), vector.offer_id, vector.name);
    assert.equal(offer.offer_id, vector.offer_id, vector.name);
    assert.equal(canonicalStringify(withId), vector.signing_payload, vector.name);
    assert.equal(signature.value, vector.signature, vector.name);
    assert.ok(cryptoVerify(null, Buffer.from(vector.signing_payload), publicKey, base64UrlDecode(vector.signature)), vector.name);
    assert.equal(canonicalStringify(offer), vector.canonical_json, vector.name);

    assert.equal(outcome(() => verifyOffer(offer)), "valid", vector.name);
    assert.equal(encodeOffer(offer), vector.encoded, vector.name);
    assert.equal(vector.encoded_uppercase, vector.encoded.toUpperCase(), vector.name);
    assert.deepEqual(decodeOffer(vector.encoded), offer, vector.name);
    assert.deepEqual(decodeOffer(vector.encoded_uppercase), offer, vector.name);

    // Ed25519 is deterministic: signing the same content again with the
    // published key gives the same offer.
    assert.deepEqual(createSignedOffer(content, vectors.keys.offer.private_key_pem, { now: vectors.now }), offer, vector.name);
  }
});

test("loosely written input normalizes to the same offer", () => {
  for (const vector of vectors.normalization) {
    const input = Object.fromEntries(Object.entries(vector.input).filter(([, value]) => value !== null));
    const offer = createSignedOffer(input, vectors.keys.offer.private_key_pem, { now: vectors.now });
    assert.equal(offer.offer_id, vector.offer_id, vector.name);
  }
});

test("every invalid offer is refused, for the stated reason", () => {
  for (const vector of vectors.invalid_offers) {
    const offer = vector.offer_json ? JSON.parse(vector.offer_json) : vector.offer;
    assert.equal(outcome(() => verifyOffer(offer)), vector.error, vector.name);
    // An invalid offer cannot be encoded either.
    assert.notEqual(outcome(() => (encodeOffer(offer), verifyOffer(offer))), "valid", vector.name);
  }
});

test("every invalid encoding is refused, for the stated reason", () => {
  for (const vector of vectors.invalid_encoded_offers) {
    let decoded;
    let failure;
    try {
      decoded = decodeOffer(vector.encoded);
    } catch (error) {
      failure = error;
    }
    assert.equal(Boolean(decoded), vector.decodes, vector.name);
    if (decoded) {
      assert.equal(outcome(() => verifyOffer(decoded)), vector.error, vector.name);
    } else {
      assert.equal(failure.code, vector.error, vector.name);
      assert.equal(failure.details?.reason, vector.reason, vector.name);
    }
  }
});

test("requests against an offer match every vector", () => {
  for (const vector of vectors.resolution_requests) {
    if (vector.error) {
      assert.equal(outcome(() => validateResolutionRequest(vector.offer, vector.request, { now: vector.now })), vector.error, vector.name);
    } else {
      assert.deepEqual(validateResolutionRequest(vector.offer, vector.request, { now: vector.now }), vector.result, vector.name);
    }
  }
});

test("revocations match every vector", () => {
  const offer = vectors.valid_offers.find((vector) => vector.offer_id === vectors.revocations[0].offer_id).offer;
  for (const vector of vectors.revocations) {
    const result = verifyOfferRevocation(offer, vector.revocation, { now: vector.now });
    assert.equal(result.ok, vector.valid, vector.name);
    if (!vector.valid) assert.equal(result.code, vector.error, vector.name);
  }

  const { revocation, signing_payload: payload } = vectors.revocation_signing_payload;
  const { signature, ...signed } = revocation;
  assert.equal(canonicalStringify(signed), payload);
  assert.ok(cryptoVerify(null, Buffer.from(payload), createPublicKey(vectors.keys.offer.public_key_pem), base64UrlDecode(signature.value)));
});

test("recurring cycle requests match every vector", () => {
  const offer = vectors.valid_offers.find((vector) => vector.offer_id === vectors.recurrence_requests[0].offer_id).offer;
  const subscriber = createPublicKey(vectors.keys.subscriber.public_key_pem);
  for (const vector of vectors.recurrence_requests) {
    const result = verifyRecurrenceRequest(offer, vector.request);
    assert.equal(result.ok, vector.valid, vector.name);
    if (!vector.valid) {
      assert.equal(result.code, vector.error, vector.name);
      continue;
    }
    assert.equal(vector.request.approval_id, vectors.keys.subscriber.subscription_id, vector.name);
    assert.ok(
      cryptoVerify(null, Buffer.from(vector.signing_payload), subscriber, base64UrlDecode(vector.request.subscriber_signature)),
      vector.name
    );
    // Signing the same cycle again with the published key gives the same proof.
    const { amount, recurrence_cycle, scheduled_for } = vector.request;
    const again = signRecurrenceRequest(
      offer,
      { amount, recurrence_cycle, ...(scheduled_for ? { scheduled_for } : {}) },
      vectors.keys.subscriber.private_key_pem
    );
    assert.equal(again.subscriber_signature, vector.request.subscriber_signature, vector.name);
  }
});
