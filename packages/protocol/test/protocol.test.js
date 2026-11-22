import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  base64UrlEncode,
  canonicalStringify,
  ckbHash,
  ckbScriptHash,
  createOfferRevocation,
  createSignedOffer,
  decodeOffer,
  encodeOffer,
  generateOfferKeyPair,
  normalizeCkbScript,
  parseCkbScript,
  serializeCkbScript,
  signRecurrenceRequest,
  subscriptionId,
  validateResolutionRequest,
  verifyOffer,
  verifyOfferRevocation,
  verifyRecurrenceRequest
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

// Type scripts of three CKB mainnet genesis system cells, read from the public
// chain. Their script hashes are the published code hashes of the secp256k1
// lock, the Nervos DAO and the multisig lock.
const TYPE_ID_CODE_HASH = "0x00000000000000000000000000000000000000000000000000545950455f4944";
const systemScripts = [
  {
    args: "0x8536c9d5d908bd89fc70099e4284870708b6632356aad98734fcf43f6f71c304",
    hash: "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8"
  },
  {
    args: "0xb2a8500929d6a1294bf9bf1bf565f549fa4a5f1316a3306ad3d4783e64bcf626",
    hash: "0x82d76d1b75fe2fd9a27dfbaa65a039221a380d76c926f378d3f81cf3e7e13f2e"
  },
  {
    args: "0xd813c1b15bd79c8321ad7f5819e5d9f659a1042b72e64659a2c092be68ea9758",
    hash: "0x5c5069eb0857efc65e1bca0c07df34c31663b3622fd3876c876320fc9634e2a8"
  }
];

test("computes CKB script hashes that match the chain", () => {
  // CKB's hash of empty input.
  assert.equal(
    Buffer.from(ckbHash(new Uint8Array(0))).toString("hex"),
    "44f4c69744d5f8c55d642062949dcae49bc4e7ef43d388c5a12f42b5633d163e"
  );

  for (const { args, hash } of systemScripts) {
    assert.equal(ckbScriptHash({ code_hash: TYPE_ID_CODE_HASH, hash_type: "type", args }), hash);
  }
});

test("script hashing ignores hex case and round-trips through the molecule encoding", () => {
  const script = { code_hash: TYPE_ID_CODE_HASH, hash_type: "type", args: systemScripts[0].args };
  const upper = { ...script, args: `0x${script.args.slice(2).toUpperCase()}` };
  const encoded = serializeCkbScript(script);
  const encodedHex = `0x${Buffer.from(encoded).toString("hex")}`;

  assert.equal(ckbScriptHash(upper), systemScripts[0].hash);
  assert.deepEqual(normalizeCkbScript(upper), script);
  assert.equal(encoded.length, 16 + 32 + 1 + 4 + 32);
  assert.deepEqual(parseCkbScript(encoded), script);
  assert.deepEqual(parseCkbScript(encodedHex), script);

  const emptyArgs = { code_hash: "0x" + "ab".repeat(32), hash_type: "data1", args: "0x" };
  assert.deepEqual(parseCkbScript(serializeCkbScript(emptyArgs)), emptyArgs);
  // Changing any field changes the hash.
  assert.notEqual(ckbScriptHash({ ...script, hash_type: "data" }), systemScripts[0].hash);
});

test("rejects malformed scripts and non-canonical encodings", () => {
  const script = { code_hash: TYPE_ID_CODE_HASH, hash_type: "type", args: "0x00" };
  const invalid = (candidate) =>
    assert.throws(() => ckbScriptHash(candidate), (error) => error.code === "INVALID_CKB_SCRIPT");

  invalid(undefined);
  invalid({ ...script, code_hash: "0x1234" });
  invalid({ ...script, code_hash: TYPE_ID_CODE_HASH.slice(2) });
  invalid({ ...script, hash_type: "TYPE" });
  invalid({ ...script, args: "0x0" });
  invalid({ ...script, args: "00" });

  const encoded = serializeCkbScript(script);
  const truncated = encoded.slice(0, encoded.length - 1);
  const trailing = new Uint8Array([...encoded, 0]);
  const badHashType = Uint8Array.from(encoded);
  badHashType[48] = 3;
  for (const candidate of [truncated, trailing, badHashType, new Uint8Array(4)]) {
    assert.throws(() => parseCkbScript(candidate), (error) => error.code === "INVALID_CKB_SCRIPT");
  }
});

function makeRecurringOffer(recurrence = { interval: "monthly", amount: "1000", cap_cycles: 3 }) {
  return makeOffer({ amount_min: "1000", amount_max: "1000", recurrence }).offer;
}

test("a subscription is identified by its key and signs each cycle request", () => {
  const offer = makeRecurringOffer();
  const subscriber = generateOfferKeyPair();
  const other = generateOfferKeyPair();
  const id = subscriptionId(subscriber.publicKeyPem);

  const request = signRecurrenceRequest(
    offer,
    { amount: "1000", recurrence_cycle: 1, scheduled_for: "2026-01-01T00:00:00.000Z" },
    subscriber.privateKeyPem
  );

  assert.match(id, /^sub_[0-9a-f]{40}$/);
  assert.notEqual(id, subscriptionId(other.publicKeyPem));
  // The ID does not depend on how the PEM text is laid out.
  assert.equal(subscriptionId(`\n${subscriber.publicKeyPem}\n`), id);
  assert.equal(request.approval_id, id);
  assert.deepEqual(request.asset, { asset_type: "ckb", symbol: "CKB" });
  assert.deepEqual(verifyRecurrenceRequest(offer, request), { ok: true });
});

test("a cycle request cannot be altered, borrowed or moved to another offer", () => {
  const offer = makeRecurringOffer();
  const subscriber = generateOfferKeyPair();
  const attacker = generateOfferKeyPair();
  const request = signRecurrenceRequest(offer, { amount: "1000", recurrence_cycle: 1 }, subscriber.privateKeyPem);
  const codeOf = (candidate, against = offer) => verifyRecurrenceRequest(against, candidate).code;

  // A later cycle, or a different schedule, needs its own signature.
  assert.equal(codeOf({ ...request, recurrence_cycle: 2 }), "INVALID_SUBSCRIPTION_SIGNATURE");
  assert.equal(codeOf({ ...request, scheduled_for: "2026-02-01T00:00:00.000Z" }), "INVALID_SUBSCRIPTION_SIGNATURE");
  // Someone else's key cannot speak for this subscription.
  assert.equal(codeOf({ ...request, subscriber_public_key: attacker.publicKeyPem }), "SUBSCRIPTION_KEY_MISMATCH");
  const forged = signRecurrenceRequest(offer, { amount: "1000", recurrence_cycle: 1 }, attacker.privateKeyPem);
  assert.equal(codeOf({ ...forged, approval_id: request.approval_id }), "SUBSCRIPTION_KEY_MISMATCH");
  // The signature names the offer, so it is useless on another one.
  assert.equal(codeOf(request, makeRecurringOffer()), "INVALID_SUBSCRIPTION_SIGNATURE");
  // The proof is not optional on a recurring offer.
  assert.equal(codeOf({ amount: "1000", recurrence_cycle: 1 }), "SUBSCRIPTION_PROOF_REQUIRED");
  assert.equal(codeOf({ ...request, subscriber_signature: undefined }), "SUBSCRIPTION_PROOF_REQUIRED");
  assert.equal(codeOf(request, makeOffer().offer), "RECURRENCE_NOT_CONFIGURED");

  // Only Ed25519 keys are subscriber keys.
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  assert.throws(
    () => signRecurrenceRequest(offer, { amount: "1000", recurrence_cycle: 1 }, rsa.privateKey.export({ type: "pkcs8", format: "pem" })),
    (error) => error.code === "INVALID_KEY_TYPE"
  );
  assert.throws(
    () => subscriptionId(rsa.publicKey.export({ type: "spki", format: "pem" })),
    (error) => error.code === "INVALID_KEY_TYPE"
  );
});

test("recurrence terms are checked from the signed offer alone", () => {
  const capped = makeRecurringOffer({ interval: "daily", amount: "1000", cap_cycles: 3 });
  const budgeted = makeRecurringOffer({ interval: "daily", amount: "1000", spending_cap_total: "2500" });
  const codeOf = (offer, request) => {
    try {
      validateResolutionRequest(offer, request);
      return "ok";
    } catch (error) {
      return error.code;
    }
  };

  assert.equal(codeOf(capped, { amount: "1000", recurrence_cycle: 3 }), "ok");
  assert.equal(codeOf(capped, { amount: "1000", recurrence_cycle: 4 }), "RECURRENCE_CYCLE_CAP_REACHED");
  assert.equal(codeOf(capped, { amount: "1000", recurrence_cycle: 0 }), "INVALID_RECURRENCE_CYCLE");
  assert.equal(codeOf(capped, { amount: "1000", recurrence_cycle: 1.5 }), "INVALID_RECURRENCE_CYCLE");
  assert.equal(codeOf(budgeted, { amount: "1000", recurrence_cycle: 2 }), "ok");
  assert.equal(codeOf(budgeted, { amount: "1000", recurrence_cycle: 3 }), "RECURRENCE_SPENDING_CAP_REACHED");
  // A one-off offer has no cycles.
  assert.equal(codeOf(makeOffer().offer, { amount: "1000", recurrence_cycle: 1 }), "RECURRENCE_NOT_CONFIGURED");
});
