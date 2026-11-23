# Fiber Offers SDK Guide

This guide documents the public `@fiber-offers/sdk` package for merchant
backends, payer services, wallets, and operational tooling.

## Install

```bash
npm install @fiber-offers/sdk
```

The core SDK is ESM and requires Node.js 20.19 or newer. TypeScript declarations
ship with the package; no separate `@types` package is needed.

## What the SDK connects

```text
merchant or payer application
  -> @fiber-offers/sdk
  -> Fiber Offers resolver
  -> merchant Fiber node

payer payment execution
  -> @fiber-offers/sdk
  -> payer Fiber node
  -> Fiber Network
  -> merchant Fiber node
```

The SDK does not host a resolver and does not replace a Fiber node. Merchant
invoice creation needs an online merchant node connected to the resolver.
Payment execution needs an online payer node or compatible wallet adapter.

## Package entry points

| Import | Intended use |
| --- | --- |
| `@fiber-offers/sdk` | Resolver, payment, diagnostics, topology, and recurrence clients |
| `@fiber-offers/sdk/node` | Core SDK plus atomic JSON-file recurrence storage |
| `@fiber-offers/sdk/react` | React `OfferQR` and `RecurringApproval` components |
| `@fiber-offers/sdk/react-native` | React Native QR and recurring approval components |
| `@fiber-offers/sdk/browser` | Browser-facing core exports for compatible toolchains |

Core offer signing currently depends on Node's cryptography runtime. Use the
framework subpaths for UI components, and keep lifecycle keys and operator API
keys in trusted backend or wallet environments.

## Resolver client

Public payer operations need only a resolver URL:

```js
import { FiberOffersClient } from "@fiber-offers/sdk";

const resolver = new FiberOffersClient({
  resolverUrl: "https://offers.merchant.example"
});
```

Merchant administration adds the server-side API key:

```js
const merchant = new FiberOffersClient({
  resolverUrl: process.env.RESOLVER_PUBLIC_URL,
  apiKey: process.env.RESOLVER_API_KEY
});
```

Never embed `RESOLVER_API_KEY` in a browser or mobile application. Payment-page,
offer lookup, Fiber Address discovery, readiness, and invoice-resolution paths
are public by design; inventory mutation and operator paths are protected.

## Create an offer from a merchant Fiber node

The SDK can obtain the merchant `node_id` from `node_info`, generate a lifecycle
key, sign the offer, and register it:

```js
const created = await merchant.createAndRegisterOfferFromNode(
  {
    resolver_url: process.env.RESOLVER_PUBLIC_URL,
    network: "testnet",
    description: "Coffee",
    assets: [{ asset_type: "ckb", symbol: "CKB" }],
    amount_min: "100000000",
    amount_max: "100000000",
    single_use: false
  },
  {
    fiberRpcUrl: "http://127.0.0.1:8227",
    username: "coffee"
  }
);

console.log(created.offer.offer_id);
console.log(created.registered.payment_link);
console.log(created.registered.fiber_address);
```

The returned `offer_private_key_pem` is lifecycle authority. Store it with mode
`0600`, in a secret manager, or through equivalent protected storage. Do not log
it or send it to the resolver.

For routine merchant operation, the published CLI already implements this
storage and recovery workflow.

## Resolve an offer and request an invoice

```js
const { offer, invoice } = await resolver.resolveAndRequestInvoice(
  offerId,
  {
    amount: "100000000",
    asset: { asset_type: "ckb", symbol: "CKB" }
  },
  { idempotencyKey: crypto.randomUUID() }
);

console.log(offer.description);
console.log(invoice.invoice);
```

The same method accepts an encoded `fbroffer1...` offer. The SDK verifies a
scanned encoded offer before trusting its ID.

Use one stable idempotency key for retries of the same logical checkout. Reusing
that key for a different amount or asset is rejected by the resolver.

## Check readiness before creating an invoice

```js
const readiness = await resolver.checkPayment(offerId, {
  amount: "100000000",
  asset: { asset_type: "ckb", symbol: "CKB" }
});

if (!readiness.ready) {
  console.error(readiness.blockers, readiness.next_actions);
}
```

This checks signed terms, resolver state, merchant invoice-source availability,
and known topology information. Before a fresh invoice exists, it cannot prove
the payer's route. Perform a payer-side dry run after invoice creation.

## Pay a Fiber invoice

```js
import { FiberPaymentClient } from "@fiber-offers/sdk";

const payer = new FiberPaymentClient({
  url: "http://127.0.0.1:8229",
  username: process.env.FIBER_RPC_USERNAME,
  password: process.env.FIBER_RPC_PASSWORD
});

const route = await payer.checkPaymentRoute(invoice.invoice, {
  timeoutSeconds: 60,
  maxFeeAmount: "100000"
});

if (!route.payable) {
  console.error(route.failure.code, route.failure.next_actions);
  process.exitCode = 1;
} else {
  const payment = await payer.sendPayment(invoice.invoice, {
    timeoutSeconds: 60,
    maxFeeAmount: "100000"
  });
  console.log(payment.payment_hash);
}
```

Fiber quantities may be decimal strings, numbers, bigints, or already encoded
hex values. The SDK sends the JSON-RPC quantity fields in Fiber's expected hex
format.

## Use the guarded end-to-end flow

`FiberPaymentFlowClient` combines resolver readiness, fresh invoice creation,
route dry-run, normalized failures, and optional execution:

```js
import {
  FiberPaymentClient,
  FiberPaymentFlowClient
} from "@fiber-offers/sdk";

const flow = new FiberPaymentFlowClient({
  resolverClient: resolver,
  paymentClient: new FiberPaymentClient({ url: "http://127.0.0.1:8229" })
});

const prepared = await flow.preparePayment(offerId, {
  amount: "100000000",
  asset: { asset_type: "ckb", symbol: "CKB" }
});

if (prepared.ok) {
  const paid = await flow.payOffer(
    offerId,
    {
      amount: "100000000",
      asset: { asset_type: "ckb", symbol: "CKB" }
    },
    { execute: true, idempotencyKey: crypto.randomUUID() }
  );
  console.log(paid.status, paid.payment_hash);
}
```

Real payment is deliberately opt-in. Calling `payOffer` without `execute: true`
returns `execute_required` instead of sending funds.

`payment_sent` means the payer node accepted the payment, not that it arrived:
Fiber reports it as `Created` or `Inflight` and it can still fail. Pass
`confirm: true` to wait for the outcome:

```js
const paid = await flow.payOffer(offer, request, { execute: true, confirm: true });
// paid.status: "payment_succeeded" | "payment_failed" | "payment_pending"
```

`payment_pending` means it had not settled within `confirmTimeoutMs` (default
60 seconds); call `flow.confirmPayment(paid.payment_hash)` later. A failed
payment moved no funds and can be retried with the same idempotency key.

### What the flow verifies

The resolver is treated as untrusted. Before any funds move, the flow checks:

1. **The offer.** Pass an offer ID, an encoded `fbroffer1…` string, or a signed
   offer object. Its signature is verified, and an ID is checked against the
   contents the resolver returns (the ID is the hash of the contents).
2. **The resolver.** The resolver being contacted must be the `resolver_url`
   signed into the offer, otherwise the result is `resolver_mismatch`.
3. **The request.** Amount and asset are checked against the signed terms before
   the resolver is asked for anything.
4. **The invoice.** The payer's own node reads the invoice (`parse_invoice`) and
   the result is compared with the offer: it must pay `offer.node_id`, for the
   requested amount, in the offer's network currency and the requested asset
   (for a token, the invoice's type script must hash to the offer's
   `type_script_hash`), and it must not have expired. A mismatch gives
   `invoice_rejected` with a code such as `INVOICE_PAYEE_MISMATCH`.
5. **The binding.** The invoice's node-signed description must end with a
   commitment naming this offer and the resolution the resolver reported, so a
   genuine invoice for a different order cannot be swapped in
   (`INVOICE_OFFER_MISMATCH`, `INVOICE_RESOLUTION_MISMATCH`,
   `INVOICE_BINDING_MISSING`).

`payOffer` with `execute: true` refuses to send (`invoice_unverified`) when the
invoice could not be verified, for example because the payment client has no
`parseInvoice`. The outcome is on `result.invoice_verification`.

`verifyInvoiceForOffer()` is exported for wallets that run their own flow.
`allowResolverMismatch` and `skipInvoiceVerification` exist for tests and local
setups; do not set them in a wallet. `allowUnboundInvoices` accepts invoices from
a resolver older than 0.2, which did not write the commitment.

## Fiber Address discovery

```js
const discovered = await resolver.resolveFiberAddress(
  "coffee@offers.merchant.example"
);

const { offer, invoice } = await resolver.resolveAndRequestInvoice(
  discovered.encoded_offer,
  {
    amount: "100000000",
    asset: discovered.offer.assets[0]
  }
);
```

A Fiber Address is a wallet/SDK discovery identifier, not a browser URL. The SDK
requests `https://<domain>/.well-known/fiberoffer/<username>` and returns the
signed offer plus its browser payment link.

## Settlement and reconciliation

```js
const resolutions = await merchant.getResolutions(offerId);
const synced = await merchant.syncResolution(offerId, resolutionId);
const receipt = await merchant.getReceipt(offerId, resolutionId);
const csv = await merchant.getReconciliationCsv(offerId);
```

`getResolution` and `getReceipt` are addressed by a resolution ID and need no
credentials. The rest list or change the merchant's payments and need the API
key.

Useful methods include:

- `getResolutions` and `getResolution`;
- `syncResolution` and `syncResolutions`;
- `updateResolutionStatus` for trusted external settlement sources;
- `getReceipt`;
- `getReconciliation` and `getReconciliationCsv`.

## Webhooks

```js
const webhook = await merchant.createWebhook(offerId, {
  url: "https://merchant.example/webhooks/fiber-offers",
  events: ["invoice.created", "invoice.paid"]
});

await merchant.testWebhook(offerId, webhook.id);
```

The client also supports listing, updating, deleting, testing, rotating secrets,
viewing delivery events, and triggering delivery. Keep returned webhook secrets
in server-side secret storage.

## Topology and route diagnostics

```js
import { FiberTopologyClient } from "@fiber-offers/sdk";

const topology = new FiberTopologyClient({
  merchant: "http://127.0.0.1:8227",
  payer: "http://127.0.0.1:8229"
});

const report = await topology.inspectPair();
console.log(report.status, report.direct_channel, report.blockers);

const routeReport = await topology.checkInvoiceRoute(invoice.invoice, {
  maxFeeAmount: "100000"
});
```

Topology is evidence, not a guarantee. A final `send_payment` dry run against a
fresh invoice is the authoritative preflight check available to the payer node.

## Payer-owned recurrence

```js
import {
  FiberRecurringPaymentScheduler,
  JsonFileRecurringApprovalStore
} from "@fiber-offers/sdk/node";

const scheduler = new FiberRecurringPaymentScheduler({
  paymentFlow: flow,
  resolverClient: resolver,
  store: new JsonFileRecurringApprovalStore(
    ".fiber-offers/payer-approvals.json"
  ),
  intervalMs: 30000
});

const approval = await scheduler.approve(offerId);
scheduler.start();

// The payer can stop future cycles immediately.
await scheduler.revoke(approval.id);
```

The scheduler enforces signed cycle and spending caps, uses an idempotency key
per cycle, retries without advancing a failed schedule, and stores payer consent
outside the merchant resolver.

Each approval is its own subscription. `approve()` generates a key for it and
stores the key with the approval; every cycle request is signed with that key,
and the resolver counts cycles and caps against `approval.subscription_id`. Two
approvals of the same offer, by the same or different payers, never affect each
other. The key authorizes cycle requests only and controls no funds, but it does
live in the approval store, so keep that store private to the payer.

A cycle counts as paid only once the payer's node confirms the payment. Ask the
resolver where a subscription stands with
`resolver.getRecurrenceStatus(offerId, approval.subscription_id)`.

## React and React Native

```jsx
import { OfferQR, RecurringApproval } from "@fiber-offers/sdk/react";

<OfferQR
  offerId={offer.offer_id}
  resolverUrl={offer.resolver_url}
  payload="link"
/>

<RecurringApproval
  offer={offer}
  approved={approved}
  onApprove={approve}
  onRevoke={revoke}
/>
```

React Native exports components with the same names from
`@fiber-offers/sdk/react-native`. `react` and `react-native` are optional peer
dependencies, so install the one used by your application.

## Failure normalization

```js
import { normalizeFiberPaymentFailure } from "@fiber-offers/sdk";

try {
  await payer.sendPayment(invoice.invoice);
} catch (error) {
  const failure = normalizeFiberPaymentFailure(error, {
    stage: "send_payment"
  });
  console.error(failure.code, failure.summary);
  console.error(failure.likely_causes);
  console.error(failure.next_actions);
}
```

The normalized object preserves the raw node error under `fiber_error` while
adding stable categories for route, liquidity, expiry, timeout, and generic RPC
failures.

## Timeouts and retryable errors

Every network call has a deadline, so a stalled node or resolver cannot hang a
wallet. `FiberRpcClient` (and the clients built on it) aborts after `timeoutMs`,
15 seconds by default. `FiberOffersClient` aborts after its own `timeoutMs`, 30
seconds by default. Pass `0` to disable either.

Errors carry a `retryable` flag that says whether repeating the same call can
succeed:

| Thrown by | `code` | `retryable` |
| --- | --- | --- |
| `FiberRpcClient` | `FIBER_RPC_UNREACHABLE`, `FIBER_RPC_TIMEOUT` | `true` |
| `FiberRpcClient` | the node's JSON-RPC error code (`kind: "rpc"`) | `false` |
| `FiberRpcClient` | `FIBER_RPC_HTTP_ERROR` | `true` for `5xx` and `429`, otherwise `false` |
| `FiberRpcClient` | `FIBER_RPC_INVALID_RESPONSE` | `false` |
| `FiberOffersClient` | `RESOLVER_UNREACHABLE`, `RESOLVER_TIMEOUT` | `true` |
| `FiberOffersClient` | `RESOLVER_INVALID_RESPONSE` | `true` for `5xx`, otherwise `false` |
| `FiberOffersClient` | a resolver error code such as `RECIPIENT_UNAVAILABLE` | as reported by the resolver |

`FiberRpcClient` errors also expose `kind` (`transport`, `timeout`, `http`,
`rpc`, `invalid_response`) and `details.method`.

## Resolver-client method groups

The payment path needs no credentials. Everything that reads or changes the
merchant's side needs the resolver's API key (`apiKey` in the client options);
without it the resolver answers `401 UNAUTHORIZED`.

| Group | Methods | API key |
| --- | --- | --- |
| Offers | `getOffer`, `resolveOffer`, `offerQrUrl` | No |
| Offers | `revokeOffer` | No: the revocation is signed with the offer's own key |
| Offers | `registerOffer`, `listOffers` | Yes |
| Creation | `createOffer` (signs locally, calls no resolver) | No |
| Creation | `createAndRegisterOffer`, `createAndRegisterOfferFromNode` | Yes |
| Payment | `checkPayment`, `requestInvoice`, `resolveAndRequestInvoice` | No |
| Fiber Address | `resolveFiberAddress` | No |
| Fiber Address | `bindFiberAddress` | Yes |
| One payment | `getResolution`, `getReceipt` (addressed by the resolution ID) | No |
| Payment history | `getResolutions`, `getReconciliation`, `getReconciliationCsv` | Yes |
| Settlement | `syncResolution`, `syncResolutions`, `updateResolutionStatus` | Yes |
| Recurrence | `getRecurrenceStatus(offer, subscriptionId)` | No: the subscription ID is known only to its payer |
| Recurrence | `getRecurrenceStatus(offer)` (summary across subscribers) | Yes |
| Webhooks | `createWebhook`, `getWebhooks`, `updateWebhook`, `deleteWebhook`, `rotateWebhookSecret`, `testWebhook`, delivery methods | Yes |
| Operations | `diagnostics` | Yes |
| Demo | `demoCreateOffer` | Yes, and only on a resolver running with `RESOLVER_DEMO_MODE=true` |

## Security checklist

- Keep resolver API keys in merchant backends and operator tools only.
- Keep Fiber RPC endpoints private or authenticated; never expose an unrestricted
  node RPC directly to the internet.
- Keep offer lifecycle private keys in protected merchant storage.
- Use one idempotency key per logical checkout or recurrence cycle.
- Perform a route dry run before payment when the payer node supports it.
- Display the signed description, asset, amount, recurrence, and caps before
  payer confirmation.
- Treat `execute: true` as a funds-moving operation.

## Related documentation

- [Protocol guide](protocol.md)
- [CLI guide](cli.md)
- [Resolver API quick reference](api-quick-reference.md)
- [Independent merchant setup](independent-merchant.md)
- [Examples](../examples/README.md)
