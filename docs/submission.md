# Fiber Offers Hackathon Submission

## Project Summary

Fiber Offers is reusable payment-offer infrastructure for Fiber Network. It lets a merchant, wallet, or service publish one static signed offer and resolve it into fresh Fiber invoices on demand.

The project provides:

- A signed `fbroffer1...` offer protocol.
- A resolver API for offer registration and invoice resolution.
- Fiber Address lookup.
- QR generation for payment links and full encoded offers.
- Payment readiness diagnostics.
- Invoice resolution status tracking.
- Merchant reconciliation exports and receipts.
- Webhook subscriptions, signed webhook delivery, and an inspectable delivery outbox.
- A Node SDK and browser demo.
- An independent merchant CLI for secure initialization and offer lifecycle management.

## Selected Category

Wallet and Payment UX Infrastructure.

The project also supports merchant infrastructure, but the primary category is wallet/payment UX because it abstracts one-time invoice complexity into reusable, wallet-consumable payment offers.

## Fiber Infrastructure Gap Addressed

Fiber invoices are payment-attempt specific. That works for direct payments, but it is not enough for reusable merchant checkouts, tipping links, donation pages, static QR codes, payment handles, subscriptions, API metering, and wallet address flows.

Fiber Offers adds the missing reusable payment-intent layer:

1. A stable signed offer can be shared once.
2. The resolver verifies payment constraints.
3. Each payer action produces a fresh invoice.
4. Operators get status, receipts, reconciliation, diagnostics, and webhook integration.

## What Is Fully Working

- Signed offer creation and verification.
- Canonical offer IDs.
- `fbroffer1...` encoding and decoding.
- Resolver-hosted offer registration.
- Fiber Address lookup at `/.well-known/fiberoffer/:username`.
- QR SVG generation for payment links and encoded offers.
- Payment readiness checks before invoice creation.
- Fresh live Fiber invoice generation from the same static offer.
- Fiber RPC invoice creation and status polling via `FIBER_RPC_URL`.
- Invoice resolution logs and status lifecycle.
- Manual paid/failed/expired/cancelled status updates.
- Receipt JSON per invoice attempt.
- JSON and CSV reconciliation exports.
- Webhook registration and lifecycle management, generated and rotated signing secrets, signed test delivery, event outbox, retries, and inspectable delivery attempt records.
- Optional resolver API-key protection for write/admin operations.
- Docker deployment assets.
- PostgreSQL authoritative storage, Redis distributed rate limits, and BullMQ maintenance jobs.
- Two horizontally scaled resolver replicas behind Nginx.
- Private Unix-socket relay from Docker to a host-loopback merchant FNN.
- Merchant CLI for generated secrets, node ownership checks, offer creation, registration recovery, listing, and signed revocation.
- SDK methods for protocol, resolver, readiness, status, reconciliation, and webhooks.
- Browser demo.
- API-key exchange for signed, short-lived, `HttpOnly` operator dashboard sessions.
- Durable payer-owned automatic recurrence with retries and revocation.
- A two-session live E2E harness that pays two fresh invoices from one static offer.
- A verified two-session testnet run: both 1 CKB payments reached payer `Success`, merchant `Paid`, and resolver `invoice_paid` with zero fees.
- Automated tests.

## What Is Mocked Or Simulated

- The standard demo runtime uses real local Fiber testnet nodes. The mock invoice adapter is retained only for automated tests and explicit isolated UI work.
- Manual status controls remain available for operator testing, but live settlement is reconciled automatically from Fiber RPC.
- Webhook delivery and retry scheduling run through background workers; the built-in receiver remains a local demonstration endpoint.
- API-key mode is resolver-wide, not merchant-scoped yet; the browser exchanges it for an `HttpOnly` operator session.
- Webhook secrets can be encrypted at rest with `RESOLVER_SECRET_ENCRYPTION_KEY`; external secret-manager integration remains deployment work.

## Technical Breakdown

### Protocol

Package: `packages/protocol`

- Ed25519 signatures.
- Canonical JSON.
- Deterministic `offer_id`.
- Supported assets: `ckb`, `udt`, `rgbpp`.
- Amount bounds, expiry, recurrence cap validation.

### Resolver

App: `apps/resolver`

- Plain Node.js HTTP server with a PostgreSQL production adapter and JSON development fallback.
- Atomic cross-replica invoice reservations and idempotency enforcement.
- Redis/BullMQ distributed maintenance and rate limiting.
- Fiber RPC invoice adapter for the standard runtime.
- Explicit mock adapter for automated tests.
- QR generation through `qrcode`.
- Reconciliation and webhook infrastructure.
- Optional API-key protection.

### SDK

Package: `packages/sdk`

- Resolver client.
- Fiber Address resolution.
- Offer registration.
- Invoice request and readiness check.
- Resolution status helpers.
- Reconciliation helpers.
- Webhook helpers.
- Durable browser and Node recurrence stores plus an automatic payer scheduler.

### CLI

App: `apps/cli`

- Generates deployment secrets without printing them.
- Verifies resolver-to-FNN node ownership.
- Generates and privately persists per-offer lifecycle keys.
- Creates, registers, retries, lists, and cryptographically revokes offers.

### Demo

App: `apps/demo`

- Merchant offer creation.
- QR and payment link display.
- Fiber Address lookup.
- Readiness check.
- Invoice request and request-twice proof.
- Status tracking.
- Webhook registration and delivery drain.
- JSON/CSV reconciliation links.

## How To Run

```bash
npm install
npm run cli -- init --resolver-url http://localhost:8787 --fiber-rpc-url http://127.0.0.1:8227
docker compose up -d --build
npm run cli -- doctor
```

Open:

```text
http://localhost:8787
```

## Live Fiber Mode

```bash
FIBER_RPC_URL=http://127.0.0.1:8227 npm run fiber:check
FIBER_RPC_URL=http://127.0.0.1:8227 npm run dev
```

## Docker

```bash
docker compose up --build
```

## Demo Link

Local demo:

```text
http://localhost:8787
```

Hosted demo:

```text
Pending final server/domain deployment
```

## Repository Link

```text
https://github.com/leothatguy/fiber-offers
```

## Team Members

```text
Leo (Dilamme / Independent)
```

## Future Roadmap

1. Deploy the final HTTPS demo with managed secrets, backups, metrics, and alerting.
2. Add merchant accounts, scoped API keys, and a multi-tenant Fiber node profile registry.
3. Validate live UDT/RGB++ settlement with funded compatible channels.
4. Run cross-wallet QR interoperability testing with external Fiber wallet teams.
5. Propose the offer format and resolver-attested identity model for community review.

The original draft requirement assumptions that changed after FNN RPC validation
are recorded in [requirements-errata.md](requirements-errata.md).

## AI Allowance Claim

AI tooling was used for research, implementation assistance, and documentation drafting. Claim: yes, if eligible.
