# Architecture

## Components

```text
Browser Demo
  -> HTTP Gateway
      -> Resolver HTTP API replicas
      -> Protocol package
      -> PostgreSQL store
      -> Redis rate limits
      -> Invoice Adapter
          -> Fiber RPC invoices (standard runtime)
          -> Explicit mock invoices (automated tests)
      -> QR generator
      -> Webhook outbox and delivery
      -> Optional API-key protection

BullMQ worker replicas
  -> Redis job schedulers
  -> PostgreSQL outbox and resolution state
  -> Fiber settlement polling / webhook delivery

SDK
  -> Resolver HTTP API
  -> Protocol package
```

## Request Flow

1. Merchant creates a signed offer.
2. Resolver checks `node_info`, binds the offer to its configured merchant node, and stores the encoded offer.
3. Payer opens payment link, scans QR, or resolves Fiber Address.
4. Wallet checks readiness.
5. Wallet requests a fresh invoice.
6. Resolver validates offer and request.
7. Resolver atomically reserves an invoice attempt in PostgreSQL.
8. Resolver creates the invoice through Fiber RPC and finalizes the reservation.
9. Background workers poll Fiber settlement state and emit webhook events into the outbox.
10. Merchant tracks status, receipts, and reconciliation exports.

## Node Ownership Boundary

- The resolver connects to one merchant/payee Fiber node through server-controlled configuration.
- The merchant node may be local, on a custom port, or hosted behind a private HTTPS endpoint.
- The payer uses its own wallet or Fiber node to dry-run and send the returned invoice. Its RPC endpoint is never required by the merchant resolver.
- `PAYER_FIBER_RPC_URL` is only for controlled topology and E2E fixtures where the operator owns both endpoints.
- A payment link contains the resolver and offer identity, not a node RPC URL or credential.
- The offer lifecycle key signs portable offer data and revocations. The resolver attests its binding to the Fiber node identity because FNN does not expose arbitrary message signing.
- Multi-tenant hosting requires trusted tenant-to-node profiles, encrypted credentials, and ownership checks. Per-request arbitrary RPC URLs are intentionally unsupported.

## Data Model

### Offer

- `offer_id`
- signed offer payload
- encoded offer
- verified node-ownership record
- optional signed revocation record
- created/updated timestamps

### Resolution

- `resolution_id`
- `offer_id`
- amount and asset
- invoice object
- status
- status history
- settlement metadata
- optional recurrence cycle and approval identifier

### Webhook

- `webhook_id`
- `offer_id`
- URL
- subscribed event types
- secret hint
- active or paused state
- created and updated timestamps

### Webhook Event

- `event_id`
- event type
- payload
- delivery records

## Production Hardening

The repository includes a PostgreSQL store, Redis distributed rate limits, BullMQ
maintenance workers, migrations, dependency health checks, and a horizontally
scaled Compose topology. A public production service should still add:

- merchant-scoped API keys;
- centralized log aggregation and metrics;
- managed PostgreSQL/Redis backups and secret rotation;
- queue failure alerting and a dead-letter review process;
- end-to-end tests against live Fiber nodes.
