# Resolver API

The [specification](spec-v1.md) defines the routes every wallet needs from
every resolver: fetching an offer, requesting an invoice, reading a
resolution, revoking, subscription status and Fiber Address lookup. This
document covers what the reference resolver offers beyond that, mostly to the
merchant. None of it is required of another resolver.

For the list of routes and which need the API key, see the
[quick reference](api-quick-reference.md). For configuration, see
[Deployment](deployment.md). The wallet-facing routes are also described as
OpenAPI, with a JSON Schema for each body, in [`schemas/`](schemas/README.md).

## Readiness check

```text
POST /offers/:offer_id/check
```

Takes the same body as an invoice request and reports whether one would be
issued, without creating it. It applies the same rules as the invoice route,
after bringing the offer's open invoices up to date with the node, so the two
never disagree.

```json
{ "amount": "1200", "asset": { "asset_type": "ckb", "symbol": "CKB" } }
```

```json
{
  "offer_id": "0x...",
  "ready": true,
  "confidence": "medium",
  "amount": "1200",
  "asset": { "asset_type": "ckb", "symbol": "CKB" },
  "invoice_mode": "fiber-rpc",
  "summary": "Request is valid; a fresh Fiber invoice can be created.",
  "checks": [
    { "id": "offer_state", "status": "pass", "message": "Offer is active" },
    { "id": "signature", "status": "pass", "message": "Offer signature is valid" },
    { "id": "request", "status": "pass", "message": "Amount and asset are accepted by this offer" },
    { "id": "single_use", "status": "pass", "message": "Offer can produce another invoice" },
    { "id": "invoice_source", "status": "pass", "message": "Resolver is configured for Fiber RPC invoices" }
  ],
  "blockers": [],
  "warnings": [],
  "next_actions": ["Request a fresh invoice from the resolver."],
  "next_action": "request_invoice"
}
```

Each check has a `status` of `pass`, `warn` or `fail`, and a failing check
carries the error code the invoice route would return. On a recurring offer
there are also `subscription` and `recurrence` checks. A request that carries
an `invoice` it was already issued, or the idempotency key of an earlier
request, is checked as that same payment, not as a new use of the offer.

A route check on a payer node (`topology`, `route_check`) is included only for
operators, or for everyone when the resolver runs in demo mode. A wallet does
its own route check on its own node.

## Resolutions and settlement

Every invoice request creates a resolution. The specification defines its
statuses and how they move. The resolver learns a status from the merchant
node:

| Fiber invoice status | Resolution status |
| --- | --- |
| `Open` | `invoice_created` |
| `Received` | `invoice_received` |
| `Paid` | `invoice_paid` |
| `Expired` | `invoice_expired` |
| `Cancelled` | `invoice_cancelled` |

Background workers poll the node for open invoices (every three seconds by
default), so a payment is normally recorded within a few seconds without any
call. These routes do the same on demand, and need the API key:

```text
GET  /offers/:offer_id/resolutions
POST /offers/:offer_id/resolutions/:resolution_id/sync
POST /offers/:offer_id/resolutions/sync
POST /offers/:offer_id/resolutions/:resolution_id/status
```

`sync` asks the node about one resolution, or all open ones, and records what
it says. `status` sets a status by hand, for a settlement source other than
the node:

```json
{ "status": "invoice_paid", "source": "backoffice", "settlement_reference": "order-1042" }
```

A change that would move backwards, or out of a final status, is refused with
`409 INVALID_STATUS_TRANSITION`. Setting the status a resolution already has
changes nothing. Each real change is applied once, even when a manual update, a
sync and a background pass race, and produces exactly one webhook event.

A resolution as returned:

```json
{
  "id": "res_...",
  "offer_id": "0x...",
  "status": "invoice_paid",
  "amount": "1200",
  "asset": { "asset_type": "ckb", "symbol": "CKB" },
  "invoice": { "mode": "fiber-rpc", "invoice": "fibt1...", "payment_hash": "0x...", "expires_at": "2027-01-15T08:15:00.000Z" },
  "payment_hash": "0x...",
  "settled_at": "2027-01-15T08:03:10.000Z",
  "recurrence": { "cycle": 2, "approval_id": "sub_...", "interval": "monthly" },
  "status_history": [
    { "status": "invoice_created", "at": "2027-01-15T08:00:00.000Z", "source": "resolver" },
    { "status": "invoice_paid", "at": "2027-01-15T08:03:10.000Z", "source": "fiber-rpc" }
  ]
}
```

`recurrence` is present for a cycle of a recurring offer. The raw request sent
to the node and its raw answer are stored and are not returned.

`status_history` lists every status the resolution has had. Its first entry is
`invoice_pending`: the resolver's own reservation, made before it asks the node
for an invoice so that two requests cannot both be issued one. A request that
is still at that point is the only thing an operator's list shows as
`invoice_pending`; a payer never sees a resolution in that state, because the
resolution ID is handed out with the invoice.

**Invoice lifetime.** The resolver asks the node for an invoice that lasts
`FIBER_INVOICE_TTL_SECONDS` (default 900), shortened so it never outlives the
offer's own `expiry`, and returns the moment it lapses as `expires_at`. The
node enforces it. When that moment passes, the resolver asks the node whether
the invoice expired or was paid at the last moment, records the answer, and
announces it once. A read shows an unpaid invoice as `invoice_expired` from the
moment its expiry passes, even before that is recorded.

## Receipts and reconciliation

```text
GET /offers/:offer_id/resolutions/:resolution_id/receipt.json
GET /offers/:offer_id/reconciliation.json      (API key)
GET /offers/:offer_id/reconciliation.csv       (API key)
```

A receipt is the resolver's record of one payment attempt, readable by whoever
holds the resolution ID. It is not signed: proof of payment is the node-signed
invoice and its preimage, as the specification explains.

The reconciliation report covers every resolution of an offer, with totals by
status and by asset. The CSV has one row per resolution: ID, status, amount,
asset, payment hash, settlement reference, and the resolution and receipt
URLs.

## Webhooks

A merchant registers an HTTPS endpoint per offer and is told about each change
of status. All webhook routes need the API key.

```text
GET    /offers/:offer_id/webhooks
POST   /offers/:offer_id/webhooks
PATCH  /offers/:offer_id/webhooks/:webhook_id
DELETE /offers/:offer_id/webhooks/:webhook_id
POST   /offers/:offer_id/webhooks/:webhook_id/test
POST   /offers/:offer_id/webhooks/:webhook_id/rotate-secret
GET    /offers/:offer_id/webhook-events
POST   /offers/:offer_id/webhook-events/deliver
POST   /offers/:offer_id/webhook-events/:event_id/deliver
```

```json
{ "url": "https://merchant.example/webhooks/fiber", "events": ["invoice.created", "invoice.paid"] }
```

| Event | When |
| --- | --- |
| `invoice.created` | An invoice was issued |
| `invoice.received` | The node holds a payment that has not settled yet |
| `invoice.paid` | The payment settled |
| `invoice.expired` | The invoice lapsed unpaid |
| `invoice.failed` | The payment attempt failed |
| `invoice.cancelled` | The invoice was cancelled |
| `webhook.test` | Sent by the `test` route only |

With no `events` given, a webhook receives all six invoice events. The signing
secret is returned once, when the webhook is created or its secret rotated.

Events go into an outbox and are delivered by a background worker, with
retries. Each delivery is a `POST` with the event as JSON:

```json
{
  "id": "evt_...",
  "offer_id": "0x...",
  "type": "invoice.paid",
  "created_at": "2027-01-15T08:03:10.000Z",
  "payload": { "offer_id": "0x...", "resolution": { } }
}
```

and these headers:

| Header | Value |
| --- | --- |
| `x-fiber-offers-event-id` | The event ID. Use it to ignore a repeated delivery |
| `x-fiber-offers-event-type` | The event type |
| `x-fiber-offers-timestamp` | Unix seconds when the delivery was made |
| `x-fiber-offers-delivery-id` | `<event id>:<webhook id>` |
| `x-fiber-offers-signature` | `sha256=` and the hex HMAC-SHA256, under the webhook's secret, of `<timestamp>.<body>` |

A receiver should verify the signature over the exact bytes it received and
refuse a timestamp that is far from its own clock.

A delivery succeeds on a `2xx` answer. A redirect is never followed and counts
as a failure. Only the status code of the answer is recorded. Where a webhook
may be sent is restricted; see
[Webhook Targets](deployment.md#webhook-targets).

## Diagnostics

```text
GET /health
GET /diagnostics      (API key)
GET /topology         (API key)
```

`/health` answers `200` when the store, the rate limiter and the merchant node
are reachable and `503` otherwise. Anonymous callers get `ok`, `service` and
`invoice_mode`; with the API key the response names each dependency.

`/diagnostics` reports the store's counts, the node's reachability, peers and
channel capacity, the tokens the resolver can issue invoices for, and the
state of the background workers.

`/topology` compares the merchant node with a payer node when
`PAYER_FIBER_RPC_URL` is configured: direct channels, shared counterparties,
blockers and next actions. It is for controlled test setups. A merchant's
resolver has no payer node.

## Operator session

```text
GET    /operator/session
POST   /operator/session
DELETE /operator/session      (API key)
```

The browser console exchanges the API key for a signed, short-lived,
`HttpOnly`, same-site cookie with `POST`. Backends and the CLI send the key as
`Authorization: Bearer` or `x-api-key` instead. `GET` reports whether a key is
required, whether the caller is signed in, and whether the resolver is in demo
mode.

## What the reference resolver stores

Offers, Fiber Address bindings, resolutions with their status history,
webhooks with encrypted signing secrets, and the webhook outbox. With
`DATABASE_URL` set it uses PostgreSQL, which supports several API replicas and
a separate worker; without it, a JSON file for a single process. Rate limits
use Redis when `REDIS_URL` is set and memory otherwise.
