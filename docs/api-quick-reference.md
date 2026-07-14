# API Quick Reference

## Merchant CLI

```bash
npm run cli -- init --resolver-url https://offers.example --fiber-rpc-url http://127.0.0.1:8227
docker compose up -d --build
npm run cli -- doctor
npm run cli -- create --description "Checkout" --amount 100000000 --username merchant
npm run cli -- list
npm run cli -- revoke 0x<offer-id> --reason "Retired"
```

See [Independent Merchant Setup](independent-merchant.md) for the complete
self-hosted workflow and secret ownership model.

## Health And Diagnostics

```text
GET /health
GET /diagnostics
GET /topology
GET|POST|DELETE /operator/session
```

`POST /operator/session` exchanges `{ "api_key": "..." }` for a signed,
short-lived, `HttpOnly`, same-site dashboard cookie. CLI and backend clients use
the bearer or `x-api-key` header instead.

`GET /diagnostics` includes resolver health, store counts, Fiber RPC reachability, peer count, enabled channel count, inbound/outbound capacity totals, offline channel counterparties, readiness warnings, and background worker status.

`GET /topology` compares merchant and payer Fiber nodes when `PAYER_FIBER_RPC_URL` is configured. It reports direct-channel readiness, shared counterparties, offline route blockers, fixture recommendations, and next actions.

## Offers

```text
POST /offers
GET  /offers/:offer_id
DELETE /offers/:offer_id
POST /demo/offers
```

## Payment UX

```text
GET  /pay/:offer_id
GET  /offers/:offer_id/qr.svg?payload=link
GET  /offers/:offer_id/qr.svg?payload=offer
POST /offers/:offer_id/check
POST /offers/:offer_id/invoice
GET  /offers/:offer_id/recurrence-status
```

`POST /offers/:offer_id/check` is the merchant-readiness endpoint. It validates the offer request and merchant invoice source. Before an invoice exists, an unknown payer route is neither a pass nor a failure: `payable` is omitted and the next action is `request_invoice`. After invoice creation, the payer wallet uses its own node for a `send_payment` dry-run. A controlled pair fixture can optionally add topology and route evidence.

`POST /offers/:offer_id/invoice` accepts an optional `Idempotency-Key` header (or `idempotency_key` request field). Retrying the same key and payment request returns the original invoice resolution instead of creating a duplicate invoice. Reusing a key for a different amount or asset returns `409 IDEMPOTENCY_KEY_REUSED`.

Readiness responses keep the simple compatibility fields `ready` and `next_action`, and add infrastructure fields:

```json
{
  "ready": true,
  "confidence": "medium",
  "summary": "Request is valid; a fresh Fiber invoice can be created.",
  "checks": [],
  "blockers": [],
  "warnings": [],
  "next_actions": ["Request a fresh invoice from the resolver."],
  "next_action": "request_invoice"
}
```

## Fiber Address

```text
POST /fiber-addresses
GET  /.well-known/fiberoffer/:username
```

## Resolution Status

```text
GET  /offers/:offer_id/resolutions
GET  /offers/:offer_id/resolutions/:resolution_id
POST /offers/:offer_id/resolutions/:resolution_id/status
POST /offers/:offer_id/resolutions/:resolution_id/sync
POST /offers/:offer_id/resolutions/sync
```

## Reconciliation

```text
GET /offers/:offer_id/resolutions/:resolution_id/receipt.json
GET /offers/:offer_id/reconciliation.json
GET /offers/:offer_id/reconciliation.csv
```

## Webhooks

```text
GET  /offers/:offer_id/webhooks
POST /offers/:offer_id/webhooks
PATCH /offers/:offer_id/webhooks/:webhook_id
DELETE /offers/:offer_id/webhooks/:webhook_id
POST /offers/:offer_id/webhooks/:webhook_id/test
POST /offers/:offer_id/webhooks/:webhook_id/rotate-secret
GET  /offers/:offer_id/webhook-events
POST /offers/:offer_id/webhook-events/deliver
POST /offers/:offer_id/webhook-events/:event_id/deliver
```

## SDK Helpers

The SDK is distributed as ESM JavaScript with TypeScript declarations. Wallets and merchant services can import the same package from JavaScript or TypeScript.

React and React Native integrations are available from `@fiber-offers/sdk/react` and `@fiber-offers/sdk/react-native`. Both export `OfferQR` and `RecurringApproval`; the approval action remains disabled unless the signed terms include a visible cycle or spending cap.

```js
import {
  FiberOffersClient,
  FiberPaymentFlowClient,
  FiberPaymentClient,
  FiberTopologyClient,
  analyzePaymentReadiness,
  normalizeFiberPaymentFailure,
  planDirectChannelFixture
} from "@fiber-offers/sdk";

const resolver = new FiberOffersClient({ resolverUrl: "http://localhost:8787" });
const payer = new FiberPaymentClient({ url: "http://127.0.0.1:8229" });
const topology = new FiberTopologyClient({
  merchant: "http://127.0.0.1:8227",
  payer: "http://127.0.0.1:8229"
});

const topologyReport = await topology.inspectPair();
const directFixturePlan = planDirectChannelFixture(topologyReport, {
  fundingAmount: "10000000000",
  merchantPeerAddress: "/ip4/127.0.0.1/tcp/8228/p2p/..."
});

const route = await payer.checkPaymentRoute(invoice, {
  timeoutSeconds: 60,
  maxFeeAmount: 100000,
  diagnostics: topologyReport.diagnostics
});

const failure = normalizeFiberPaymentFailure(fiberRpcError, {
  stage: "dry_run_payment",
  diagnostics: topologyReport.diagnostics
});

const readiness = analyzePaymentReadiness({
  amount: "1200",
  asset: { asset_type: "ckb", symbol: "CKB" },
  topology: topologyReport,
  route_check: route
});

const flow = new FiberPaymentFlowClient({
  resolverClient: resolver,
  paymentClient: payer
});

const prepared = await flow.preparePayment(offerId, {
  amount: "1200",
  asset: { asset_type: "ckb", symbol: "CKB" }
});

// Real payment execution is opt-in.
const paid = await flow.payOffer(
  offerId,
  {
    amount: "1200",
    asset: { asset_type: "ckb", symbol: "CKB" }
  },
  { execute: true }
);
```

`FiberTopologyClient.inspectPair()` reports direct-channel, shared-counterparty, pending-channel, and local fixture readiness before a payment is attempted. `analyzePaymentReadiness()` converts offer validation, topology, amount liquidity, asset visibility, and optional dry-run results into a reusable wallet/app readiness object. `FiberPaymentFlowClient.preparePayment()` runs the wallet flow from offer readiness to fresh invoice to route confidence. `FiberPaymentFlowClient.payOffer()` only sends a real Fiber payment when `execute: true` is explicitly set. `planDirectChannelFixture()` returns guarded direct-channel setup or merchant acceptance steps with Fiber RPC params and equivalent CLI commands. `FiberPaymentClient.checkPaymentRoute()` performs a Fiber `send_payment` dry-run and returns `payable: true` or a normalized `failure`. `normalizeFiberPaymentFailure()` returns the high-level `code`, `summary`, `likely_causes`, and `next_actions` fields while preserving the raw Fiber node error under `fiber_error`.

Runnable integration examples:

```bash
npm run example:wallet
npm run example:merchant
MERCHANT_FIBER_RPC_URL=http://127.0.0.1:8227 PAYER_FIBER_RPC_URL=http://127.0.0.1:8229 npm run example:topology
```

## Common Demo Commands

```bash
npm test
npm run smoke
npm run dev
FIBER_RPC_URL=http://127.0.0.1:8227 npm run fiber:check
FIBER_RPC_URL=http://127.0.0.1:8227 npm run fiber:invoice-check
MERCHANT_FIBER_RPC_URL=http://127.0.0.1:8227 PAYER_FIBER_RPC_URL=http://127.0.0.1:8229 npm run fiber:topology-check
MERCHANT_FIBER_RPC_URL=http://127.0.0.1:8227 PAYER_FIBER_RPC_URL=http://127.0.0.1:8229 npm run fiber:direct-channel-fixture
FIBER_INVOICE=fibt1... PAYER_FIBER_RPC_URL=http://127.0.0.1:8229 npm run fiber:route-check
RESOLVER_URL=http://127.0.0.1:8787 npm run fiber:sync-check
RESOLVER_URL=http://127.0.0.1:8787 MERCHANT_FIBER_RPC_URL=http://127.0.0.1:8227 PAYER_FIBER_RPC_URL=http://127.0.0.1:8229 npm run fiber:e2e-check
FIBER_E2E_DRY_RUN_ONLY=true FIBER_E2E_TRAMPOLINE_HOPS=<pubkey> RESOLVER_URL=http://127.0.0.1:8787 MERCHANT_FIBER_RPC_URL=http://127.0.0.1:8227 PAYER_FIBER_RPC_URL=http://127.0.0.1:8229 npm run fiber:e2e-check
```
