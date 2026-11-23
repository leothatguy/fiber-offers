// Holds the published JSON Schemas (docs/schemas/v1) to the conformance
// vectors and to this package. A schema states the shape of an object; it
// cannot hash, verify a signature or compare two amounts. These tests pin down
// which rules each side covers, so neither can drift without a test failing.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assertValidOffer,
  createSignedOffer,
  OFFER_LIMITS,
  OFFER_SCHEME,
  RECURRENCE_REQUEST_SCHEME,
  REVOCATION_SCHEME,
  SUPPORTED_ASSET_TYPES,
  SUPPORTED_NETWORKS
} from "../src/index.js";
import { mutations, randomOfferInput, sequence } from "./helpers/offer-corpus.js";
import { loadSchemas } from "./helpers/schemas.js";

const vectors = JSON.parse(await readFile(new URL("../../../docs/test-vectors/v1.json", import.meta.url), "utf8"));
const { files, problems } = loadSchemas();
const fits = (schema, value) => problems(schema, value) === undefined;

// Invalid offers in the vectors that have the right shape. Refusing them takes
// the step named beside each, which is why an offer that fits the schema still
// has to be verified.
const INVALID_OFFERS_BEYOND_A_SCHEMA = {
  "description changed after signing": "recompute offer_id",
  "content and ID changed, signature kept": "verify the signature",
  "signed by another Ed25519 key": "verify the signature",
  "recurrence amount outside the bounds": "compare recurrence.amount with amount_min and amount_max",
  "amount_min above amount_max": "compare amount_min with amount_max"
};

// Request vectors the schema refuses. The first is accepted by the reference
// resolver all the same: it reads an amount written as a number.
const REQUESTS_THE_SCHEMA_REFUSES = {
  "amount written loosely": "the schema describes what a wallet sends: a decimal string and the asset as the offer spells it",
  "a zero amount": "an amount is at least 1",
  "without the proof": "a cycle request carries all four subscription members"
};

const REVOCATIONS_THE_SCHEMA_REFUSES = {
  "extra member in the signature object": "the signature object has exactly two members"
};

// What the package refuses although the schema accepts it, by error code. A
// code missing from this list means the schema has a gap nobody decided on.
const RULES_BEYOND_A_SCHEMA = new Set([
  "INVALID_AMOUNT_BOUNDS", // amount_min <= amount_max
  "RECURRENCE_AMOUNT_OUT_OF_BOUNDS", // recurrence.amount within the bounds
  "INVALID_RECURRENCE", // spending_cap_total >= amount
  "DUPLICATE_ASSET", // the same token under two symbols
  "DESCRIPTION_TOO_LONG", // 512 bytes, where the schema can only count characters
  "OFFER_FIELD_TOO_LARGE", // metadata and extensions, in bytes
  "OFFER_TOO_LARGE", // the whole offer, in bytes
  "INVALID_SIGNED_JSON", // nesting deeper than 8 levels
  "INVALID_URL", // a default port, a "." segment, an IPv6 literal not in RFC 5952 form
  "INVALID_CANONICAL_VALUE", // text that is not well-formed Unicode
  "NON_CANONICAL_OFFER" // the same, where the package can still name the field
]);

test("every schema says what it is and which dialect it is written in", () => {
  assert.ok(Object.keys(files).length >= 13);
  for (const [name, schema] of Object.entries(files)) {
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema", name);
    assert.ok(schema.$id.endsWith(`/docs/schemas/v1/${name}`), `${name} has the $id ${schema.$id}`);
    assert.ok(schema.title && schema.description, `${name} needs a title and a description`);
  }
});

test("every valid offer in the vectors fits the offer schema", () => {
  for (const vector of vectors.valid_offers) {
    assert.equal(problems("offer.schema.json", vector.offer), undefined, vector.name);
    assert.equal(problems("offer.schema.json", JSON.parse(vector.canonical_json)), undefined, vector.name);
  }
});

test("the offer schema refuses every invalid offer a schema can refuse", () => {
  const accepted = [];
  for (const vector of vectors.invalid_offers) {
    const offer = vector.offer_json ? JSON.parse(vector.offer_json) : vector.offer;
    if (fits("offer.schema.json", offer)) accepted.push(vector.name);
  }
  assert.deepEqual(accepted.sort(), Object.keys(INVALID_OFFERS_BEYOND_A_SCHEMA).sort());
});

test("the test keys are written the one way the offer schema accepts", () => {
  for (const [label, key] of Object.entries(vectors.keys)) {
    assert.ok(fits("common.schema.json#/$defs/ed25519PublicKeyPem", key.public_key_pem), label);
    // A private key, or the same key with a final line break, is not that spelling.
    assert.ok(!fits("common.schema.json#/$defs/ed25519PublicKeyPem", key.private_key_pem), label);
    assert.ok(!fits("common.schema.json#/$defs/ed25519PublicKeyPem", `${key.public_key_pem}\n`), label);
  }
  assert.ok(fits("common.schema.json#/$defs/subscriptionId", vectors.keys.subscriber.subscription_id));
});

test("invoice requests in the vectors fit the request schema", () => {
  const refused = vectors.resolution_requests
    .concat(vectors.recurrence_requests)
    .filter((vector) => !fits("invoice-request.schema.json", vector.request))
    .map((vector) => vector.name);
  assert.deepEqual(refused.sort(), Object.keys(REQUESTS_THE_SCHEMA_REFUSES).sort());

  // What a request resolves to is itself a well-formed amount and asset.
  for (const vector of vectors.resolution_requests) {
    if (!vector.result) continue;
    assert.ok(fits("common.schema.json#/$defs/amount", vector.result.amount), vector.name);
    assert.ok(fits("common.schema.json#/$defs/asset", vector.result.asset), vector.name);
  }
});

test("what a subscriber signs fits the cycle proof schema", () => {
  const signed = vectors.recurrence_requests.filter((vector) => vector.signing_payload);
  assert.ok(signed.length >= 2);
  for (const vector of signed) {
    const payload = JSON.parse(vector.signing_payload);
    assert.equal(problems("recurrence-proof.schema.json", payload), undefined, vector.name);
    assert.equal(payload.offer_id, vector.offer_id, vector.name);
  }
});

test("revocations in the vectors fit the revocation schema", () => {
  const refused = vectors.revocations
    .filter((vector) => !fits("revocation.schema.json", vector.revocation))
    .map((vector) => vector.name);
  assert.deepEqual(refused.sort(), Object.keys(REVOCATIONS_THE_SCHEMA_REFUSES).sort());

  // What is signed is the revocation without its signature.
  const { revocation, signing_payload: payload } = vectors.revocation_signing_payload;
  const { signature: _signature, ...unsigned } = revocation;
  assert.equal(problems("revocation.schema.json", revocation), undefined);
  assert.deepEqual(JSON.parse(payload), unsigned);
});

test("the schemas carry the package's own limits and names", () => {
  const offer = files["offer.schema.json"];
  const common = files["common.schema.json"];

  assert.equal(offer.properties.scheme.const, OFFER_SCHEME);
  assert.equal(files["revocation.schema.json"].properties.scheme.const, REVOCATION_SCHEME);
  assert.equal(files["recurrence-proof.schema.json"].properties.scheme.const, RECURRENCE_REQUEST_SCHEME);
  assert.deepEqual([...offer.properties.network.enum].sort(), [...SUPPORTED_NETWORKS].sort());
  assert.deepEqual(
    common.$defs.asset.oneOf.flatMap((branch) => branch.properties.asset_type.enum ?? [branch.properties.asset_type.const]).sort(),
    [...SUPPORTED_ASSET_TYPES].sort()
  );

  assert.equal(offer.properties.assets.maxItems, OFFER_LIMITS.assets);
  assert.equal(offer.properties.description.maxLength, OFFER_LIMITS.description_bytes);
  assert.equal(offer.$defs.resolverUrl.maxLength, OFFER_LIMITS.resolver_url_length);
  assert.equal(files["offer-response.schema.json"].properties.encoded_offer.maxLength, OFFER_LIMITS.encoded_length);
  assert.ok(fits("common.schema.json#/$defs/assetSymbol", "A".repeat(OFFER_LIMITS.symbol_length)));
  assert.ok(!fits("common.schema.json#/$defs/assetSymbol", "A".repeat(OFFER_LIMITS.symbol_length + 1)));
});

// The vectors are a fixed list. The next two tests compare the schema with
// the package over a few thousand offers the vectors do not contain.

test("every offer the package produces fits the offer schema", () => {
  const random = sequence(20261123);
  const key = vectors.keys.offer;
  let produced = 0;
  for (let index = 0; index < 400; index += 1) {
    const input = randomOfferInput(random, key.public_key_pem, vectors.now);
    let offer;
    try {
      offer = createSignedOffer(input, key.private_key_pem, { now: vectors.now });
    } catch (error) {
      // The generator sometimes asks for terms the format rules out.
      assert.ok(error.code, `unexpected failure: ${error.stack}`);
      continue;
    }
    produced += 1;
    assert.equal(problems("offer.schema.json", offer), undefined, JSON.stringify(offer));
  }
  assert.ok(produced > 250, `only ${produced} offers were produced`);
});

test("the schema never refuses an offer the package accepts, and its gaps are the listed ones", () => {
  const verdicts = { both_accept: 0, both_refuse: 0, package_only: 0 };
  const beyond = new Set();
  for (const vector of vectors.valid_offers) {
    for (const [label, offer] of mutations(vector.offer)) {
      const context = `${vector.name}: ${label}`;
      const code = refusalCode(offer);
      if (!fits("offer.schema.json", offer)) {
        assert.notEqual(code, undefined, `the schema refuses what the package accepts (${context})`);
        verdicts.both_refuse += 1;
      } else if (code === undefined) {
        verdicts.both_accept += 1;
      } else {
        assert.ok(RULES_BEYOND_A_SCHEMA.has(code), `the schema accepts what the package refuses with ${code} (${context})`);
        beyond.add(code);
        verdicts.package_only += 1;
      }
    }
  }
  // The comparison is only worth something if all three outcomes occur.
  assert.ok(verdicts.both_refuse > 1000, JSON.stringify(verdicts));
  assert.ok(verdicts.both_accept > 20, JSON.stringify(verdicts));
  assert.ok(verdicts.package_only > 20, JSON.stringify(verdicts));
  assert.ok(beyond.size >= 6, `rules reached beyond the schema: ${[...beyond].join(", ")}`);
});

// The package's verdict on an offer's shape and canonical form, without the
// ID and signature checks: undefined when it accepts, or the error code.
function refusalCode(offer) {
  try {
    assertValidOffer(offer, { requireSignature: true });
    return undefined;
  } catch (error) {
    return error.code ?? `threw ${error.message}`;
  }
}
