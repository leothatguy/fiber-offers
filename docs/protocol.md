# Fiber Offers Protocol Guide

This guide documents the public `@fiber-offers/protocol` package. It is the
practical companion to the normative [Fiber Offers V1 specification](spec-v1.md).

## What the package does

A normal Fiber invoice is created for one payment attempt. A Fiber Offer is a
signed, reusable payment intent that can be shared before an invoice exists.
When a payer is ready, a resolver validates the offer and asks the merchant's
Fiber node to create a fresh `fibt...` invoice.

The protocol package handles the portable part of that flow:

- canonical offer documents;
- deterministic offer IDs;
- Ed25519 lifecycle signatures;
- Bech32m `fbroffer1...` encoding;
- amount, asset, expiry, and recurrence validation;
- signed revocation proofs;
- payment-link construction.

It does not connect to a resolver or Fiber node. Use `@fiber-offers/sdk` for
network operations.

## Install

```bash
npm install @fiber-offers/protocol
```

The package is ESM and requires Node.js 20.19 or newer.

## Create and encode an offer

```js
import {
  createSignedOffer,
  encodeOffer,
  generateOfferKeyPair,
  offerToPaymentLink,
  verifyOffer
} from "@fiber-offers/protocol";

const keys = generateOfferKeyPair();

const offer = createSignedOffer(
  {
    network: "testnet",
    node_id: process.env.MERCHANT_FIBER_NODE_ID,
    public_key: keys.publicKeyPem,
    resolver_url: "https://offers.merchant.example",
    description: "Coffee",
    assets: [{ asset_type: "ckb", symbol: "CKB" }],
    amount_min: "100000000",
    amount_max: "100000000",
    single_use: false
  },
  keys.privateKeyPem
);

const verification = verifyOffer(offer);
if (!verification.ok) throw new Error(verification.message);

const encoded = encodeOffer(offer);
const paymentLink = offerToPaymentLink(offer);

console.log({ offerId: offer.offer_id, encoded, paymentLink });
```

The `node_id` must be the compressed public key returned by the merchant Fiber
node's `node_info` RPC method. The lifecycle Ed25519 key is separate from the
Fiber node identity and must remain private.

## Offer fields

| Field | Meaning |
| --- | --- |
| `scheme` | Always `fiberoffer-v1`; added by the package |
| `version` | Always `1`; added by the package |
| `network` | `mainnet`, `testnet`, or `dev` |
| `node_id` | Merchant Fiber node compressed secp256k1 public key |
| `public_key` | Ed25519 public lifecycle key in PEM format |
| `resolver_url` | Resolver that can mint fresh invoices for this offer |
| `description` | Optional human-readable payment description |
| `assets` | One or more accepted CKB, UDT, or RGB++ assets |
| `amount_min` | Optional minimum integer amount in asset base units |
| `amount_max` | Optional maximum integer amount in asset base units |
| `recurrence` | Optional payer-owned recurrence policy |
| `expiry` | Optional Unix timestamp after which resolution is rejected |
| `single_use` | Whether the offer can be paid only once. Payment uses it up; an invoice that lapses unpaid does not |
| `metadata` | Optional application metadata covered by the signature |
| `extensions` / `x_*` | Signed extension data for compatible applications |
| `offer_id` | SHA-256 ID derived from the canonical unsigned content |
| `signature` | Ed25519 signature over the canonical offer with its ID |

All monetary values are positive integer strings. For CKB, amounts are in
shannons:

```text
1 CKB = 100000000 shannons
```

Never use floating-point values for protocol amounts.

## Fixed and flexible pricing

A fixed offer uses equal minimum and maximum amounts:

```js
{
  amount_min: "100000000",
  amount_max: "100000000"
}
```

A ranged offer accepts payer input within the signed bounds:

```js
{
  amount_min: "100000",
  amount_max: "10000000000"
}
```

An omitted maximum means there is no protocol-level upper bound. Applications
should still apply a deliberate user-interface and risk limit.

## Assets

CKB uses:

```js
{ asset_type: "ckb", symbol: "CKB" }
```

UDT and RGB++ assets also require a canonical type-script hash:

```js
{
  asset_type: "udt",
  symbol: "USDI",
  type_script_hash: "0x..."
}
```

`type_script_hash` is the CKB script hash of the token's type script: BLAKE2b-256,
personalized with `ckb-default-hash`, over the molecule encoding of the script.
It is the same value CKB tooling reports as a script's hash. Compute it from the
full script instead of copying it by hand:

```js
import { ckbScriptHash } from "@fiber-offers/protocol";

const type_script_hash = ckbScriptHash({
  code_hash: "0x...",
  hash_type: "type",
  args: "0x..."
});
```

`parseCkbScript()` reads the molecule-encoded script a Fiber invoice carries, so
a wallet can hash it and compare the result with the offer.

The resolver and Fiber channels must actually support the selected asset. A
valid asset descriptor alone does not prove route liquidity.

## Decode and verify untrusted input

```js
import { decodeOffer, verifyOffer } from "@fiber-offers/protocol";

const offer = decodeOffer(scannedPayload);
const result = verifyOffer(offer);

if (!result.ok) {
  console.error(result.code, result.message);
  throw new Error("Do not resolve or pay this offer");
}
```

`decodeOffer` validates the Bech32m checksum and offer structure. `verifyOffer`
recomputes the deterministic ID and verifies the Ed25519 signature. Verification
works offline, but requesting a new invoice still requires the resolver and the
merchant Fiber node to be online.

## Validate a payer request

```js
import { validateResolutionRequest } from "@fiber-offers/protocol";

const normalized = validateResolutionRequest(offer, {
  amount: "100000000",
  asset: { asset_type: "ckb", symbol: "CKB" }
});
```

This rejects unsupported assets, amounts outside signed bounds, a different
amount for a fixed offer, and expired offers. Resolver-side state such as
revocation or prior single-use consumption must still be checked by the
resolver.

## Recurrence

Recurrence describes what a payer may approve; it does not give the merchant
permission to pull funds.

```js
{
  recurrence: {
    interval: "monthly",
    amount: "500000000",
    cap_cycles: 12,
    spending_cap_total: "6000000000"
  }
}
```

Supported intervals are `daily`, `weekly`, `monthly`, and `custom_seconds`.
Every recurring offer must include `cap_cycles`, `spending_cap_total`, or both.
The payer-side SDK scheduler creates a fresh invoice and payment for each cycle.

### Subscriptions

Any number of payers can subscribe to one recurring offer. Each subscription is
a key the payer generates, and cycles and caps are counted per subscription, so
`cap_cycles: 12` means twelve payments from each subscriber.

```js
import {
  generateOfferKeyPair,
  signRecurrenceRequest,
  subscriptionId
} from "@fiber-offers/protocol";

const subscriber = generateOfferKeyPair();           // once, when the payer approves
const id = subscriptionId(subscriber.publicKeyPem);  // "sub_…", derived from the key

const request = signRecurrenceRequest(
  offer,
  { amount: "500000000", recurrence_cycle: 1 },
  subscriber.privateKeyPem
);
// request now also carries approval_id, subscriber_public_key and
// subscriber_signature. Send it as the invoice request.
```

The subscription ID is a hash of the public key, so nobody can claim another
payer's subscription. The signature covers the offer ID, subscription ID, cycle
number, amount, asset and schedule, so a request cannot be altered, replayed for
a later cycle, or moved to another offer. `verifyRecurrenceRequest(offer,
request)` checks the proof.

`validateResolutionRequest()` applies the recurrence checks that need no
history: the cycle amount, and that the cycle number is within the signed caps.
How many cycles a subscription has paid is tracked by the resolver. The
subscriber key authorizes cycle requests only; it controls no funds.

## Revoke an offer

```js
import {
  createOfferRevocation,
  verifyOfferRevocation
} from "@fiber-offers/protocol";

const revocation = createOfferRevocation(offer, keys.privateKeyPem, {
  reason: "Product retired"
});

const result = verifyOfferRevocation(offer, revocation);
if (!result.ok) throw new Error(result.message);
```

Send the proof to `DELETE /offers/:offer_id`. The resolver checks that it is
recent, matches the offer and Fiber node ID, and is signed by the lifecycle key.

## Canonical form and extensions

The bytes that are hashed and signed are the offer's canonical JSON (RFC 8785):
members ordered by key, no whitespace, absent fields left out. Use
`canonicalStringify`; do not sort an object and call `JSON.stringify`, which in
JavaScript misorders number-like keys and loses a member named `__proto__`.

`createSignedOffer` accepts loosely written input and brings it to canonical
form before taking the ID: a lowercase `node_id`, the canonical PEM of the
public key, an uppercase asset symbol, amounts as decimal strings, the resolver
URL without a trailing slash. `verifyOffer` and `decodeOffer` do not: an offer
from someone else must already be canonical, or it is refused with
`NON_CANONICAL_OFFER`. One set of terms therefore has one offer ID.

| Rule | Error code |
| --- | --- |
| Keys are Ed25519, for offers, revocations and subscriptions | `INVALID_KEY_TYPE`, `INVALID_PUBLIC_KEY`, `INVALID_PRIVATE_KEY` |
| `resolver_url` is `https` (plain `http` only on `dev` or for a local address), with no credentials, query or fragment | `INSECURE_RESOLVER_URL`, `INVALID_URL` |
| `recurrence.amount` lies within `amount_min` and `amount_max` | `RECURRENCE_AMOUNT_OUT_OF_BOUNDS` |
| An offer is not both `single_use` and recurring | `SINGLE_USE_RECURRENCE_CONFLICT` |
| `expiry` is in the future when the offer is created | `OFFER_EXPIRY_IN_PAST` |
| No asset is listed twice; a `ckb` asset is `{ asset_type: "ckb", symbol: "CKB" }` | `DUPLICATE_ASSET`, `INVALID_ASSET_SYMBOL`, `INVALID_ASSET` |
| The signature is exactly `{ scheme, value }` in canonical base64url | `INVALID_SIGNATURE` |
| No unknown top-level fields | `UNKNOWN_OFFER_FIELD` |
| No `__proto__`, `constructor` or `prototype` keys anywhere | `FORBIDDEN_KEY` |
| `metadata` and extension fields are plain JSON with whole numbers only | `INVALID_SIGNED_JSON`, `INVALID_METADATA` |
| Sizes stay within `OFFER_LIMITS` | `DESCRIPTION_TOO_LONG`, `TOO_MANY_ASSETS`, `OFFER_FIELD_TOO_LARGE`, `OFFER_TOO_LARGE` |

`OFFER_LIMITS` is exported: 4,096 bytes for the whole offer, 512 for the
description, 2,048 each for `metadata` and for extension fields together, 16
assets.

Additions that a reader may ignore go in `extensions` or in fields named
`x_...`. They are covered by the ID and signature, so changing them invalidates
the offer. Any other unknown field is refused, because a signed field a wallet
does not understand could change what it is agreeing to.

### Encoded form

`encodeOffer` writes lowercase Bech32m. `decodeOffer` accepts lowercase or
uppercase (the form a QR code carries, which is about five QR versions
smaller), refuses mixed case, and refuses a body that is not the canonical JSON
itself. A damaged string fails with `INVALID_OFFER_CHECKSUM`; anything else
malformed fails with `INVALID_OFFER_ENCODING` and `details.reason`.
`isEncodedOffer(text)` tells an encoded offer from an offer ID in either case.

## Error handling

Validation failures throw `FiberOfferError` with a stable `code`, a readable
message, and optional details:

```js
import { FiberOfferError, validateResolutionRequest } from "@fiber-offers/protocol";

try {
  validateResolutionRequest(offer, request);
} catch (error) {
  if (error instanceof FiberOfferError) {
    console.error(error.code, error.message, error.details);
  }
}
```

Common codes include `INVALID_SIGNATURE`, `OFFER_ID_MISMATCH`,
`NON_CANONICAL_OFFER`, `INVALID_OFFER_CHECKSUM`, `INVALID_OFFER_ENCODING`,
`AMOUNT_MUST_MATCH_FIXED_AMOUNT`, `AMOUNT_TOO_LOW`, `AMOUNT_TOO_HIGH`,
`UNSUPPORTED_ASSET`, and `OFFER_EXPIRED`.

`verifyOffer` returns `{ ok: false, code }` for an offer whose ID or signature
does not check out, and throws `FiberOfferError` for an offer that is not well
formed or not canonical. Treat both as "do not pay".

## Security boundaries

- Keep the lifecycle private key outside browser and mobile bundles.
- Never send a private key to the resolver.
- Confirm that `node_id` belongs to the intended merchant Fiber node.
- Treat `resolver_url`, description, assets, amounts, recurrence, metadata, and
  extensions as immutable signed terms.
- Verify an encoded offer before showing payment confirmation.
- Treat the resolver as untrusted. Verify every offer it returns, and before
  paying, have your own node read the invoice and check that it pays `node_id`,
  for the requested amount, network and asset. `FiberPaymentFlowClient` in
  `@fiber-offers/sdk` does this; `verifyInvoiceForOffer()` does the comparison.
- A valid offer does not guarantee that the merchant node is online or that a
  payer has a liquid Fiber route.
- A `fbroffer1...` value is a reusable offer; a `fibt...` value is a one-time
  Fiber invoice.

## Public API summary

| Export | Purpose |
| --- | --- |
| `generateOfferKeyPair` | Create an Ed25519 lifecycle key pair |
| `buildUnsignedOffer` | Normalize input and derive `offer_id` |
| `signOffer` | Sign an already-built offer |
| `createSignedOffer` | Build and sign in one operation |
| `verifyOffer` | Verify the ID and signature |
| `encodeOffer` / `decodeOffer` | Convert to/from portable `fbroffer1...` form |
| `assertValidOffer` | Validate offer structure |
| `validateResolutionRequest` | Validate and normalize payer amount/asset input |
| `createOfferRevocation` | Sign a revocation proof |
| `verifyOfferRevocation` | Verify a revocation proof |
| `offerToPaymentLink` | Build the browser payment URL |
| `canonicalize` / `canonicalStringify` | Expose canonical JSON utilities |
| `sha256Hex` | Compute a SHA-256 hex digest |

## Related documentation

- [V1 protocol specification](spec-v1.md)
- [Conformance test vectors](test-vectors/README.md)
- [SDK guide](sdk.md)
- [Resolver API quick reference](api-quick-reference.md)
- [Architecture](architecture.md)
