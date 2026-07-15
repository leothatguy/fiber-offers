# Fiber Offers

[![Protocol](https://img.shields.io/npm/v/%40fiber-offers%2Fprotocol?label=protocol)](https://www.npmjs.com/package/@fiber-offers/protocol)
[![SDK](https://img.shields.io/npm/v/%40fiber-offers%2Fsdk?label=sdk)](https://www.npmjs.com/package/@fiber-offers/sdk)
[![CLI](https://img.shields.io/npm/v/%40fiber-offers%2Fcli?label=cli)](https://www.npmjs.com/package/@fiber-offers/cli)
[![GitHub Release](https://img.shields.io/github/v/release/leothatguy/fiber-offers)](https://github.com/leothatguy/fiber-offers/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

Reusable static payment offers for Fiber Network.

Fiber Offers lets a wallet, merchant, or service publish one signed static offer and resolve it into fresh Fiber invoices on demand. It is infrastructure, not a consumer app: the reusable pieces are the signed offer protocol, resolver API, SDK, Fiber Address lookup, and demo workspace.

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
  cli.md
  live-fiber-testing.md
  deployment.md
  protocol.md
  sdk.md
  spec-v1.md
```

The monorepo keeps the protocol, SDK, resolver, CLI, and browser application
versioned and tested together while preserving separate package boundaries.

## Published Packages

Install only the surface needed by your application:

```bash
npm install @fiber-offers/protocol
npm install @fiber-offers/sdk
npm install --global @fiber-offers/cli
```

The resolver and dashboard remain deployment applications in this repository;
they are not published as npm libraries.

Package documentation is available directly on GitHub:

- [Protocol guide](docs/protocol.md)
- [SDK guide](docs/sdk.md)
- [CLI guide](docs/cli.md)
- [Resolver API quick reference](docs/api-quick-reference.md)
- [Independent merchant setup](docs/independent-merchant.md)

## Quick Start

Requires Node.js 20 or newer. Start the interface in explicit mock mode when
evaluating the repository without a Fiber node:

```bash
npm install
npm test
npm run smoke
npm run dev:mock
```

Open `http://localhost:8787`.

For real payments, run a merchant Fiber node and follow the
[Independent Merchant Setup](docs/independent-merchant.md). The standard runtime
uses live Fiber RPC invoices and automatic settlement/webhook workers; mock mode
is only for isolated evaluation and automated tests.

The offer itself is offline-stable: it can be printed, cached, decoded, and
verified without regeneration. Creating a fresh invoice still requires the
merchant FNN; downtime produces an explicit `503 RECIPIENT_UNAVAILABLE` response.

## How A Customer Pays

Fiber Offers separates stable payment discovery from the one-time Fiber invoice
that moves funds:

```text
payment link, QR, or coffee@offers.example
  -> signed reusable offer
  -> fresh fibt... invoice
  -> payer Fiber node or wallet
  -> merchant Fiber node
```

Use the payment link or its QR code for a browser checkout. A Fiber Address such
as `coffee@offers.example` is a human-readable wallet/SDK lookup, not a web URL;
the payer pastes it into a compatible wallet or payment surface. The wallet
resolves `https://offers.example/.well-known/fiberoffer/coffee`, verifies the
signed offer, and requests a fresh invoice. The returned `fibt...` value is then
paid through the payer's own Fiber node.

The merchant shares the stable address or payment link repeatedly. Customers do
not receive the merchant API key, database password, encryption key, lifecycle
key, or Fiber RPC credentials. A raw FNN client currently accepts the final
`fibt...` invoice; the Fiber Offers SDK or browser flow performs the preceding
address-to-offer-to-invoice resolution.

Hosted testnet example:

```text
Fiber Address: coffee@fiber-offers.leothatguy.me
Browser link:  https://fiber-offers.leothatguy.me/pay/0x5e76ba68ea260e2db9813fa333d2a81dc2f17cb1bb9e419825db3d329084591d
```

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
See [docs/live-fiber-testing.md](docs/live-fiber-testing.md) for the live Fiber node path.
