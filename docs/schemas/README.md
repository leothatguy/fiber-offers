# Schemas

Machine-readable descriptions of the Fiber Offers v1 objects and of the HTTP
interface a wallet needs from a resolver. The [specification](../spec-v1.md)
is the normative text; these files say the same thing in a form a program can
check.

Everything is in [`v1/`](v1/), in [JSON Schema 2020-12](https://json-schema.org/draft/2020-12/json-schema-core)
and [OpenAPI 3.1](https://spec.openapis.org/oas/v3.1.0).

| File | Describes | Specification |
| --- | --- | --- |
| `offer.schema.json` | A signed offer in canonical form | 2, 4 |
| `revocation.schema.json` | A revocation | 12 |
| `invoice-request.schema.json` | The body of an invoice request, and of a readiness check | 7.2, 11.1 |
| `recurrence-proof.schema.json` | What a subscriber signs for one cycle. Never sent | 11.1 |
| `invoice-response.schema.json` | What an invoice request returns | 7.2 |
| `resolution.schema.json` | One payment attempt, read by its ID | 7.3, 10 |
| `offer-response.schema.json` | What fetching an offer returns | 7.1 |
| `fiber-address-response.schema.json` | What resolving a Fiber Address returns | 6 |
| `subscription-status.schema.json` | Where one subscription stands | 11.2 |
| `revocation-response.schema.json` | What an accepted revocation returns | 7.4 |
| `readiness.schema.json` | What the optional readiness check returns | 8 |
| `error.schema.json` | The body of every error response | 7, 13 |
| `common.schema.json` | Values the files above share: amounts, IDs, keys, assets | |
| `openapi.json` | The seven wallet-facing routes, with the schemas above as their bodies | 6, 7, 8 |

Each schema's `$id` is its address on the `main` branch of this repository.
The files refer to one another by relative path, so they also work from a
checkout or a copy.

## What a schema can and cannot tell you

**An object that does not fit its schema is not valid.** The schemas are
strict about shape: required members, unknown members, the one spelling of
each value (lowercase hex, amounts as decimal strings without a leading zero,
the exact PEM of an Ed25519 key, base64url without padding).

**An offer that fits `offer.schema.json` is not thereby valid.** A schema
cannot hash, check a signature or compare two numbers written as strings. A
reader must still do what the specification says in 4.3. What the offer schema
does not check:

| Rule | Specification |
| --- | --- |
| `offer_id` is the SHA-256 of the offer's content | 4.1 |
| `signature` verifies under `public_key` | 4.2 |
| `amount_min` ≤ `amount_max` | 2.1 |
| `recurrence.amount` lies within the bounds; `spending_cap_total` ≥ `amount` | 11 |
| No two assets share `asset_type` and `type_script_hash` (the schema catches only exact repeats) | 2.3 |
| `description` is at most 512 **bytes** (the schema bounds it at 512 characters) | 2.1 |
| `metadata`, the extension fields and the whole offer are within their byte limits | 2.5, 2.6 |
| Free-form content nests at most 8 levels deep | 2.5 |
| An IPv4 or IPv6 host in `resolver_url` is a real address in its canonical form | 2.2 |
| Strings are well-formed Unicode | 3 |
| The encoded string's body is exactly the canonical JSON | 5 |

The request and response schemas describe one message each. Whether a request
is acceptable for a particular offer (the asset is listed, the amount is within
bounds, the cycle is the next one) is the resolver's to decide, and a wallet's
to check offline with the offer in hand.

The response schemas require what the specification requires and allow more: a
resolver may add members.

## How they are kept true

The schemas are tested, not just published. `npm test` runs:

- **Against the conformance vectors** (`packages/protocol/test/schemas.test.js`).
  Every valid offer in [`../test-vectors/v1.json`](../test-vectors/README.md)
  fits the offer schema. Of the 31 invalid offers, the schema refuses the 26
  whose fault is in their shape, and the test names the 5 it cannot refuse and
  the step that does (recomputing the ID, verifying the signature, comparing
  amounts). Requests, revocations and cycle proofs are checked the same way.
- **Against the reference implementation, on offers the vectors do not
  contain.** About 300 offers produced from random terms all fit the schema.
  About 12,000 offers made by changing a valid one in one place are given to
  both: the schema never refuses an offer `@fiber-offers/protocol` accepts,
  and whatever the package refuses that the schema accepts falls under one of
  the rules in the table above.
- **Against the running resolver** (`apps/resolver/test/openapi.test.js`).
  `openapi.json` is validated with the OpenAPI Initiative's own schema. Every
  route in it must be a public route of the reference resolver, and every
  public route of the resolver must be in it or on a short list of extras.
  Then each route is called for each outcome it can have, 12 statuses on the
  invoice route alone, and every answer must be a status the document lists,
  with a body that fits the schema named for it.
- **Limits and names** in the schemas are compared with the constants the
  package exports, so the two cannot be changed apart.

## Using them

Any JSON Schema 2020-12 validator will do. With [Ajv](https://ajv.js.org/):

```js
import Ajv2020 from "ajv/dist/2020.js";
import { readdirSync, readFileSync } from "node:fs";

const ajv = new Ajv2020({ strict: true, strictRequired: false });
for (const name of readdirSync("docs/schemas/v1")) {
  if (name.endsWith(".schema.json")) ajv.addSchema(JSON.parse(readFileSync(`docs/schemas/v1/${name}`, "utf8")));
}

const offerSchema = "https://raw.githubusercontent.com/leothatguy/fiber-offers/main/docs/schemas/v1/offer.schema.json";
const validate = ajv.getSchema(offerSchema);
if (!validate(offer)) console.log(validate.errors);
```

Patterns are ECMAScript regular expressions, as JSON Schema specifies. They
use nothing beyond character classes, groups and counted repetition, so they
also run under RE2-style engines.

The TypeScript declarations of `@fiber-offers/sdk` describe the same
responses. They are checked separately, against the code and against what the
resolver returns, by `packages/sdk/test/types.test.js`.
