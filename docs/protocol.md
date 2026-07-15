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

The package is ESM and requires Node.js 20 or newer.

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
| `single_use` | Whether only one invoice resolution may be created |
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

## Canonicalization and extensions

Object keys are sorted recursively before hashing or signing. Undefined object
properties are omitted. Array order is preserved. Unknown `extensions` and
`x_*` fields are retained and covered by the ID and signature, so changing them
invalidates the offer.

Do not rebuild canonical signing logic in application code. Use the package on
both creation and verification paths.

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
`AMOUNT_MUST_MATCH_FIXED_AMOUNT`, `AMOUNT_TOO_LOW`, `AMOUNT_TOO_HIGH`,
`UNSUPPORTED_ASSET`, and `OFFER_EXPIRED`.

## Security boundaries

- Keep the lifecycle private key outside browser and mobile bundles.
- Never send a private key to the resolver.
- Confirm that `node_id` belongs to the intended merchant Fiber node.
- Treat `resolver_url`, description, assets, amounts, recurrence, metadata, and
  extensions as immutable signed terms.
- Verify an encoded offer before showing payment confirmation.
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
- [SDK guide](sdk.md)
- [Resolver API quick reference](api-quick-reference.md)
- [Architecture](architecture.md)
