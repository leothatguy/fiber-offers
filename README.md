# Fiber Offers

Reusable static payment offers for Fiber Network.

Fiber Offers lets a wallet, merchant, or service publish one signed static offer and resolve it into fresh Fiber invoices on demand. It is infrastructure, not a consumer app: the reusable pieces are the signed offer protocol, resolver API, SDK, Fiber Address lookup, and demo workspace.

## Why This Fits The Hackathon

Category: Wallet and Payment UX Infrastructure.

The infrastructure gap is that a normal invoice is payment-attempt specific. Merchants, wallets, pay links, tip jars, subscriptions, and API metering need a stable payment intent that can be shared once while still producing a fresh invoice for every payment attempt. Fiber Offers adds that missing layer without changing Fiber itself.

## Monorepo Layout

```text
apps/
  cli/           Independent merchant setup and offer lifecycle CLI
  demo/          Browser demo for merchants and payers
  resolver/      Node resolver API and Fiber RPC adapter
packages/
  protocol/      Signed offer encoding, validation, and verification
  sdk/           Client helper for apps, wallets, and tests
docs/
  api-quick-reference.md
  architecture.md
  final-checklist.md
  live-fiber-testing.md
  deployment.md
  prior-art-and-positioning.md
  submission.md
  spec-v1.md
  demo-script.md
  nestjs-migration.md
  requirements-errata.md
```

The monorepo is intentional: the protocol, SDK, resolver, and demo are separate deliverables, but they need to evolve together during the hackathon.

## Quick Start

Requires Node.js 20+ and a merchant Fiber RPC node. The sibling Loavix workspace provides one on `8227`:

```bash
cd ../loavix
docker compose --profile fiber up -d fiber

cd ../fiber-offers
npm test
npm run smoke
npm run verify
npm run dev
```

Open `http://localhost:8787`.

The standard runtime uses live Fiber RPC invoices and starts automatic settlement polling and webhook delivery. Use `npm run dev:mock` only for isolated UI development when a Fiber node is intentionally unavailable.

The offer itself is offline-stable: it can be printed, cached, decoded, and
verified without regeneration. Creating a fresh invoice still requires the
merchant FNN; downtime produces an explicit `503 RECIPIENT_UNAVAILABLE` response.

## Independent Merchant Quickstart

Bring an FNN on host loopback, generate private deployment secrets, start the
horizontal resolver, and verify that both sides see the same node:

```bash
npm install
npm run cli -- init \
  --resolver-url https://offers.merchant.example \
  --fiber-rpc-url http://127.0.0.1:8227
docker compose up -d --build
npm run cli -- doctor
npm run cli -- create \
  --description "Merchant checkout" \
  --amount 100000000 \
  --username merchant
```

The CLI stores offer lifecycle keys under `.fiber-offers/keys` with private file
permissions and never prints them. See
[Independent Merchant Setup](docs/independent-merchant.md) for registration
recovery, revocation, backups, hosted URLs, and SDK separation.

For a horizontally scaled local stack with PostgreSQL, Redis, BullMQ, two API
replicas, and Nginx:

```bash
docker compose up --build
```

Runnable SDK examples are available for wallet, merchant/operator, and topology integration paths:

```bash
npm run example:wallet
npm run example:merchant
RESOLVER_URL=http://127.0.0.1:8787 PAYER_FIBER_RPC_URL=http://127.0.0.1:8229 FIBER_RECURRING_OFFER=0x... npm run example:recurrence
MERCHANT_FIBER_RPC_URL=http://127.0.0.1:8227 PAYER_FIBER_RPC_URL=http://127.0.0.1:8229 npm run example:topology
```

The SDK and protocol packages are plain ESM JavaScript with bundled TypeScript declaration files, so TypeScript apps get typed offers, readiness responses, topology reports, payment-flow results, and Fiber failure objects without requiring a build step in this repo.

## Fiber RPC Mode

Live Fiber RPC is the default. A normal run connects only to the merchant node and starts automatic background settlement workers. The payer uses their own wallet or node; the merchant resolver does not need its URL or credentials.

```bash
FIBER_RPC_URL=http://127.0.0.1:8227 npm run fiber:check
FIBER_RPC_URL=http://127.0.0.1:8227 npm run fiber:invoice-check
FIBER_RPC_URL=http://127.0.0.1:8227 npm run dev
npm run dev:fiber:local
RESOLVER_URL=http://127.0.0.1:8787 npm run fiber:sync-check
MERCHANT_FIBER_RPC_URL=http://127.0.0.1:8227 \
PAYER_FIBER_RPC_URL=http://127.0.0.1:8229 \
npm run fiber:topology-check
MERCHANT_FIBER_RPC_URL=http://127.0.0.1:8227 \
PAYER_FIBER_RPC_URL=http://127.0.0.1:8229 \
npm run fiber:direct-channel-fixture
RESOLVER_URL=http://127.0.0.1:8787 \
MERCHANT_FIBER_RPC_URL=http://127.0.0.1:8227 \
PAYER_FIBER_RPC_URL=http://127.0.0.1:8229 \
npm run fiber:e2e-check
```

`npm run dev:fiber:local` connects only to the local merchant node on `8227`. `npm run dev:fiber:pair` additionally connects the known local payer node on `8229` for controlled route, topology, and end-to-end testing.

Merchant nodes may use any reachable port or private/hosted URL:

```bash
FIBER_RPC_URL=https://fiber-rpc.merchant.example \
FIBER_RPC_USERNAME=resolver \
FIBER_RPC_PASSWORD=secret \
npm run dev
```

The node URL and credentials are deployment secrets, not offer fields. A payment link identifies the resolver and offer; it never exposes the merchant RPC endpoint. Each self-hosted resolver instance currently maps to one merchant node. A multi-tenant hosted resolver should add a server-side tenant connection registry and select a trusted node profile by offer ownership, never accept arbitrary RPC URLs from browser or invoice requests.

`fiber:direct-channel-fixture` is report-only unless `FIBER_FIXTURE_OPEN_DIRECT_CHANNEL=true` is set. The plan can connect the payer, open a direct channel, or accept a merchant-side pending channel when Fiber reports manual acceptance is required.

Optional environment variables:

```text
FIBER_RPC_USERNAME
FIBER_RPC_PASSWORD
MERCHANT_FIBER_RPC_URL
MERCHANT_FIBER_RPC_USERNAME
MERCHANT_FIBER_RPC_PASSWORD
FIBER_RPC_INVOICE_METHOD=new_invoice
FIBER_RPC_GET_INVOICE_METHOD=get_invoice
FIBER_RPC_PROBE_METHOD=node_info
FIBER_INVOICE_MODE=fiber-rpc
RESOLVER_WORKERS_ENABLED=true
RESOLVER_WORKERS_RUN_ON_START=true
RESOLVER_SETTLEMENT_SYNC_INTERVAL_MS=3000
RESOLVER_WEBHOOK_RETRY_INTERVAL_MS=30000
RESOLVER_WEBHOOK_MAX_ATTEMPTS=8
RESOLVER_WEBHOOK_RETRY_MIN_AGE_MS=30000
RESOLVER_PUBLIC_URL=http://localhost:8787
PORT=8787
```

Background workers are enabled by default for the live runtime. Set `RESOLVER_WORKERS_ENABLED=false` only when an external scheduler owns settlement polling and webhook delivery.

The adapter is isolated in `apps/resolver/src/invoice-adapter.js` so node-version-specific RPC shape changes are contained.

## API Surface

```text
GET  /health
GET  /diagnostics
GET  /topology
GET  /operator/session
POST /operator/session
DELETE /operator/session
POST /demo/offers
POST /offers
GET  /offers/:offer_id
GET  /offers/:offer_id/qr.svg?payload=link
GET  /offers/:offer_id/qr.svg?payload=offer
POST /offers/:offer_id/check
POST /offers/:offer_id/invoice
GET  /offers/:offer_id/resolutions
GET  /offers/:offer_id/resolutions/:resolution_id
GET  /offers/:offer_id/resolutions/:resolution_id/receipt.json
POST /offers/:offer_id/resolutions/:resolution_id/status
POST /offers/:offer_id/resolutions/:resolution_id/sync
POST /offers/:offer_id/resolutions/sync
GET  /offers/:offer_id/reconciliation.json
GET  /offers/:offer_id/reconciliation.csv
GET  /offers/:offer_id/webhooks
POST /offers/:offer_id/webhooks
PATCH /offers/:offer_id/webhooks/:webhook_id
DELETE /offers/:offer_id/webhooks/:webhook_id
POST /offers/:offer_id/webhooks/:webhook_id/test
POST /offers/:offer_id/webhooks/:webhook_id/rotate-secret
GET  /offers/:offer_id/webhook-events
POST /offers/:offer_id/webhook-events/deliver
POST /offers/:offer_id/webhook-events/:event_id/deliver
POST /fiber-addresses
GET  /.well-known/fiberoffer/:username
GET  /pay/:offer_id
```

## Current Scope

Working:

- Ed25519 signed static offer format.
- Bech32m offer encoding with legacy prototype decode compatibility.
- Live resolver-to-Fiber-node identity binding through `node_info`.
- Signed offer revocation.
- Canonical offer IDs.
- Encoded `fbroffer1...` payloads.
- Resolver-hosted offer registration.
- Fiber Address lookup.
- Scannable QR SVGs for payment links and full encoded offers.
- Payment readiness checks with request validation, topology confidence, direct-channel liquidity, and optional invoice dry-runs.
- Payer-side SDK payment flow for offer readiness, fresh invoice creation, route dry-run, and explicit payment execution.
- Node-backed SDK offer creation and scanned encoded-offer resolution.
- React and React Native QR/link and capped recurrence approval components.
- Payer-owned automatic recurrence scheduler with durable browser/Node stores, retry backoff, cap enforcement, and revocation.
- TypeScript declaration files for the protocol and SDK public surfaces.
- Runnable SDK examples for wallet payment flow, merchant/operator reconciliation, and read-only topology readiness.
- Resolver diagnostics with Fiber RPC peer/channel capacity summaries.
- Payer-to-merchant topology reports for direct-channel, shared-counterparty, and fixture readiness.
- Guarded direct-channel fixture planner/opener for deterministic local live settlement.
- Payer-side SDK route preflight through Fiber `send_payment` dry-runs.
- Standalone payer route-check CLI for arbitrary Fiber invoices.
- SDK failure normalization for Fiber route/payment errors.
- Fresh invoice resolution from the same static offer.
- Settlement status tracking for invoice resolutions.
- Live Fiber invoice status sync from `get_invoice`.
- Opt-in background Fiber settlement polling.
- Merchant reconciliation exports and receipt records.
- Webhook subscriptions, signed delivery, retry limits, background delivery worker, and inspectable event outbox.
- Optional AES-256-GCM webhook-secret encryption and production private-target blocking.
- PostgreSQL durable storage with transactional migrations and atomic cross-replica invoice reservations.
- Redis distributed rate limiting and BullMQ settlement/webhook workers.
- A two-replica Docker Compose topology behind Nginx with dependency health checks.
- Independent merchant CLI for secret initialization, node ownership checks, offer creation, registration recovery, listing, and signed revocation.
- Live Fiber invoice creation and status synchronization, with an explicit mock adapter reserved for automated tests.
- Fiber RPC adapter boundary.
- Browser demo and Node SDK.
- Signed `HttpOnly` operator sessions for API-key-protected dashboard deployments.

Not production-ready yet:

- Production-grade liquidity policy engine.
- Merchant accounts and merchant-scoped dashboard authorization beyond the current single-deployment operator session.
- Managed production secrets, backups, metrics, TLS, and alerting.

See [docs/spec-v1.md](docs/spec-v1.md) for the protocol details.
See [docs/requirements-traceability.md](docs/requirements-traceability.md) for PRD/FRD/TRD acceptance mapping.
See [docs/requirements-errata.md](docs/requirements-errata.md) for implementation-time clarifications to the draft PDFs.
See [docs/live-fiber-testing.md](docs/live-fiber-testing.md) for the live Fiber node path.
