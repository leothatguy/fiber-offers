# Fiber Offers V1

## Goal

Create a reusable payment intent for Fiber that can be shared as a link, address, or encoded payload, then resolved into a fresh invoice for each payment attempt.

## Offer Encoding

An encoded offer uses:

```text
bech32m(hrp = "fbroffer", data = canonical-json-offer)
```

Encoded offers therefore begin with `fbroffer1` and include a bech32m checksum. Decoders retain compatibility with the earlier `fbroffer1<base64url-json>` prototype format.

## Signed Offer Fields

```json
{
  "scheme": "fiberoffer-v1",
  "version": 1,
  "network": "testnet",
  "node_id": "02...",
  "public_key": "-----BEGIN PUBLIC KEY-----...",
  "resolver_url": "http://localhost:8787",
  "description": "Coffee checkout",
  "assets": [{ "asset_type": "ckb", "symbol": "CKB" }],
  "amount_min": "1000",
  "amount_max": "50000",
  "single_use": false,
  "metadata": {},
  "offer_id": "0x...",
  "signature": {
    "scheme": "ed25519",
    "value": "..."
  }
}
```

Rules:

- `offer_id` is `sha256(canonical offer without offer_id or signature)`.
- `signature.value` signs the canonical offer including `offer_id` but excluding `signature`.
- Amounts are integer strings.
- Supported asset types are `ckb`, `udt`, and `rgbpp`.
- `udt` and `rgbpp` assets require `type_script_hash`.
- Recurring offers must include `cap_cycles` or `spending_cap_total`.
- Unknown `extensions` and `x_*` fields are included in the canonical ID and signature.

## Identity And Ownership

The Ed25519 `public_key` is the portable offer lifecycle key. It signs the offer and signed revocation proofs. It is not presented as the Fiber node key.

In live mode, the resolver calls Fiber `node_info` and requires the returned compressed public key to equal `offer.node_id` before registration and again before invoice minting. Each reference resolver maps to one server-controlled merchant Fiber RPC profile. Arbitrary RPC URLs are never accepted from offers or invoice requests.

## Revocation

`DELETE /offers/:offer_id` accepts a `fiberoffer-revocation-v1` proof containing the offer ID, node ID, timestamp, optional reason, and Ed25519 signature from the offer lifecycle key. Revoked offers return `410 OFFER_REVOKED` and cannot create more invoices.

## Recurrence

Recurring invoice attempts carry `recurrence_cycle`, `approval_id`, and `scheduled_for`. The resolver enforces sequential cycles, the signed per-cycle amount, `cap_cycles`, and `spending_cap_total`.

`FiberRecurringPaymentScheduler` runs in the payer environment, where payment authority belongs. It stores explicit approvals, triggers due cycles, retries failures without advancing the schedule, accounts for spending, and supports immediate revocation. Status is available from `GET /offers/:offer_id/recurrence-status`.

## Resolution Flow

1. Merchant creates and signs an offer.
2. Merchant registers the encoded offer with a resolver.
3. Payer opens `/pay/:offer_id`, scans a payload, or resolves a Fiber Address.
4. Wallet can send `{ amount, asset }` to `/offers/:offer_id/check`.
5. Resolver returns readiness diagnostics without minting an invoice.
6. Wallet sends `{ amount, asset }` to `/offers/:offer_id/invoice`.
7. Resolver verifies the offer and request bounds.
8. Resolver asks Fiber RPC for a fresh invoice, or mock mode returns a demo invoice.
9. Wallet pays the returned invoice.

## Fiber Address

Fiber Offers uses a simple well-known lookup:

```text
alice@example.com -> https://example.com/.well-known/fiberoffer/alice
```

The response includes:

```json
{
  "username": "alice",
  "address": "alice@example.com",
  "offer_id": "0x...",
  "encoded_offer": "fbroffer1...",
  "offer": {},
  "payment_link": "https://example.com/pay/0x...",
  "qr_link_url": "https://example.com/offers/0x.../qr.svg?payload=link",
  "qr_offer_url": "https://example.com/offers/0x.../qr.svg?payload=offer"
}
```

## QR Payloads

The resolver exposes QR SVGs for both common scanning paths:

```text
/offers/:offer_id/qr.svg?payload=link
/offers/:offer_id/qr.svg?payload=offer
```

`payload=link` encodes `/pay/:offer_id` and is the default for merchant checkout because the QR is smaller and easier to scan. `payload=offer` encodes the full `fbroffer1...` payload for wallet-level testing.

## Readiness Check

Wallets and merchant tools can check whether a payment request is likely to produce an invoice before creating one:

```text
POST /offers/:offer_id/check
```

Request:

```json
{
  "amount": "1200",
  "asset": { "asset_type": "ckb", "symbol": "CKB" }
}
```

Response:

```json
{
  "offer_id": "0x...",
  "ready": true,
  "amount": "1200",
  "asset": { "asset_type": "ckb", "symbol": "CKB" },
  "invoice_mode": "mock",
  "checks": [
    { "id": "signature", "status": "pass", "message": "Offer signature is valid" },
    { "id": "request", "status": "pass", "message": "Amount and asset are accepted by this offer" },
    { "id": "single_use", "status": "pass", "message": "Offer can produce another invoice" },
    { "id": "invoice_source", "status": "warn", "message": "Resolver is in mock invoice mode" }
  ],
  "next_action": "request_invoice"
}
```

## Resolver Diagnostics

Operators can inspect resolver state and Fiber RPC connectivity:

```text
GET /diagnostics
GET /topology
```

`GET /topology` is optional and available when the resolver process has both merchant and payer Fiber RPC endpoints configured. It returns the same topology shape as `FiberTopologyClient.inspectPair()`: direct-channel readiness, shared counterparties, blockers, warnings, next actions, and deterministic fixture recommendation.

Response:

```json
{
  "ok": true,
  "service": "fiber-offers-resolver",
  "invoice_mode": "mock",
  "invoice_source": {
    "mode": "mock",
    "configured": false,
    "reachable": false,
    "status": "mock"
  },
  "store": {
    "offers": 1,
    "fiber_addresses": 1,
    "resolution_count": 2
  }
}
```

When `FIBER_RPC_URL` is configured, `invoice_source` reports the configured probe method and whether the Fiber RPC endpoint responded.

## Settlement Status Tracking

Every invoice request creates a resolution record:

```text
GET /offers/:offer_id/resolutions
GET /offers/:offer_id/resolutions/:resolution_id
```

Resolution statuses:

```text
invoice_created
invoice_received
invoice_paid
invoice_expired
invoice_failed
invoice_cancelled
```

Manual operators or external systems can update status through:

```text
POST /offers/:offer_id/resolutions/:resolution_id/status
```

Fiber RPC mode can sync status from the Fiber node with:

```text
POST /offers/:offer_id/resolutions/:resolution_id/sync
POST /offers/:offer_id/resolutions/sync
```

Fiber status mapping:

```text
Open      -> invoice_created
Received  -> invoice_received
Paid      -> invoice_paid
Expired   -> invoice_expired
Cancelled -> invoice_cancelled
```

Request:

```json
{
  "status": "invoice_paid",
  "source": "webhook",
  "settlement_reference": "fiber-payment-hash-or-node-reference"
}
```

Response:

```json
{
  "id": "res_...",
  "offer_id": "0x...",
  "status": "invoice_paid",
  "amount": "1200",
  "asset": { "asset_type": "ckb", "symbol": "CKB" },
  "settled_at": "2026-07-03T16:20:00.000Z",
  "status_history": [
    { "status": "invoice_created", "at": "2026-07-03T16:19:00.000Z", "source": "resolver" },
    { "status": "invoice_paid", "at": "2026-07-03T16:20:00.000Z", "source": "webhook" }
  ]
}
```

Terminal statuses cannot be changed to a different terminal status. Read views also report an unpaid invoice as `invoice_expired` after its expiry time.

## Receipts And Reconciliation

Merchants can fetch receipt-style records for individual invoice attempts:

```text
GET /offers/:offer_id/resolutions/:resolution_id/receipt.json
```

Merchants can also export offer-level reconciliation reports:

```text
GET /offers/:offer_id/reconciliation.json
GET /offers/:offer_id/reconciliation.csv
```

The JSON report includes totals by status and by asset plus export rows. The CSV report is intended for accounting tools and includes resolution ID, status, amount, asset, payment hash, settlement reference, invoice URL, and receipt URL.

## Webhook Outbox

Merchants can register webhook subscriptions for offer lifecycle events:

```text
POST /offers/:offer_id/webhooks
GET /offers/:offer_id/webhooks
GET /offers/:offer_id/webhook-events
POST /offers/:offer_id/webhook-events/deliver
POST /offers/:offer_id/webhook-events/:event_id/deliver
```

Request:

```json
{
  "url": "https://merchant.example/webhooks/fiber",
  "events": ["invoice.created", "invoice.paid"]
}
```

Supported events:

```text
invoice.created
invoice.paid
invoice.expired
invoice.failed
invoice.cancelled
```

The resolver records events into an inspectable outbox with pending delivery entries. Calling a delivery endpoint sends signed HTTP POST requests to matching webhook subscriptions.

Delivery requests include:

```text
x-fiber-offers-event-id
x-fiber-offers-event-type
x-fiber-offers-timestamp
x-fiber-offers-delivery-id
x-fiber-offers-signature
```

When a webhook secret is configured, `x-fiber-offers-signature` is an HMAC-SHA256 signature over `timestamp.body` with the `sha256=` prefix.

## Deployment Boundary

Settlement reconciliation, webhook retries, route confidence, channel diagnostics, API-key protection, node ownership checks, and live-node scripts are implemented. The bundled JSON store and in-process workers are the single-instance reference deployment. Hosted horizontal operation still requires a database-backed store, distributed jobs, merchant-scoped accounts, rate limiting, TLS, and operational monitoring.
