# Deployment

## Local Production-Like Run

```bash
RESOLVER_API_KEY=change-me \
RESOLVER_SECRET_ENCRYPTION_KEY=replace-with-a-long-random-secret \
RESOLVER_ALLOW_PRIVATE_WEBHOOKS=false \
RESOLVER_RATE_LIMIT_MAX=120 \
npm run dev
```

When `RESOLVER_API_KEY` is set, protected write operations require:

```text
Authorization: Bearer change-me
```

or:

```text
x-api-key: change-me
```

The browser operator workspace exchanges this key at `POST /operator/session`
for a signed, short-lived, `HttpOnly`, same-site cookie. The key is held only in
the login form long enough to complete that exchange and is never written to
browser storage. CLI and backend integrations continue to use bearer or
`x-api-key` authentication.

Public read endpoints such as payment links, QR codes, readiness checks, receipts, and reconciliation reads remain open.

## Docker

```bash
docker compose up --build
```

Open:

```text
http://localhost:8787
```

The Compose stack runs two resolver API replicas behind Nginx, one PostgreSQL
instance, one Redis instance, a one-shot migration service, and a BullMQ worker.
PostgreSQL and Redis data use separate named volumes. The defaults are for local
development; set real passwords, API keys, and encryption keys before exposing
the stack.

`RESOLVER_SECRET_ENCRYPTION_KEY` must be identical on every API and worker
replica and remain stable across restarts. Rotate it with an explicit data
reencryption procedure; simply changing the value makes existing webhook secrets
undecryptable.

Compose defaults to live Fiber RPC mode. `fiber-rpc-host-relay` reaches the host's
loopback FNN at `127.0.0.1:8227` and writes through a private shared Unix socket;
`fiber-rpc-proxy` exposes the other side only inside the Compose network. This
preserves the node's loopback-only RPC listener without opening a host RPC port.
Override `FIBER_RPC_URL` for a different private endpoint, or set
`FIBER_RPC_HOST` and `FIBER_RPC_PORT` for another host-local address.

Start the merchant Fiber node before the resolver stack. The default relay expects
its JSON-RPC endpoint on host loopback at `127.0.0.1:8227`; verify `node_info`
first, then start Fiber Offers:

```bash
curl -sS -X POST http://127.0.0.1:8227 \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"node_info","params":[]}'

docker compose up -d --build
```

A payer node is not part of the merchant deployment. Configure a separate payer
RPC only for controlled topology and end-to-end tests.

`GET /health` checks PostgreSQL, Redis, and the configured invoice source. In
live mode it returns `503` when FNN cannot be reached; `GET /diagnostics` includes
the detailed peer and channel report.

Scale API or worker processes independently:

```bash
docker compose up --build --scale fiber-offers=4 --scale worker=2
```

All API replicas are stateless. PostgreSQL owns offer, address, resolution,
idempotency, recurrence-cycle, webhook, and outbox state. Redis owns distributed
rate-limit counters and BullMQ scheduling state.

## Public URL and reverse proxies

Set `RESOLVER_PUBLIC_URL` to the address others reach the resolver at. Every link
it returns (payment links, Fiber Addresses, QR payloads, webhook payloads) uses
that value, and no request header can change it. Without it, links follow the
`Host` header of each request, which is only suitable for local development.

Rate limits are per client address. Behind reverse proxies the resolver reads
that address from `X-Forwarded-For`, counting `RESOLVER_TRUSTED_PROXY_HOPS`
entries from the right, because each proxy appends the address it received the
request from and anything further left is whatever the client chose to send:

| Deployment | `RESOLVER_TRUSTED_PROXY_HOPS` |
| --- | --- |
| Clients connect straight to the resolver | `0` (default; the header is ignored) |
| The bundled Compose gateway only | `1` (Compose default) |
| Host Nginx in front of the Compose gateway | `2` (set by `docker-compose.production.yml`) |

A value that is too high lets a client choose its own address and evade the
limits; a value that is too low limits your proxy instead of your clients.

Operator login, offer revocation and QR rendering are rate limited along with
readiness checks and invoice creation. If the limiter's Redis is unreachable,
requests are served unlimited and the failure is logged; set
`RESOLVER_RATE_LIMIT_FAIL_OPEN=false` to answer `503` instead.

## PostgreSQL

Set `DATABASE_URL` to select the PostgreSQL store. Without it, the resolver uses
the local JSON adapter for single-process development.

```bash
DATABASE_URL=postgresql://fiber_offers:secret@127.0.0.1:54320/fiber_offers \
npm run db:migrate
```

Migrations are ordered SQL files in `apps/resolver/migrations`. The migration
runner takes a PostgreSQL advisory lock, records applied filenames, and runs each
migration transactionally. Run migrations once before starting new API or worker
releases.

Invoice creation first reserves a resolution in a row-locked transaction. This
makes single-use enforcement, recurrence sequencing, and idempotency consistent
across replicas. Abandoned pending reservations expire after two minutes.

Size `DATABASE_POOL_MAX` per process so the total across API and worker replicas
stays below the database connection limit. Use PgBouncer when replica counts make
direct pools impractical.

## Redis and BullMQ

Set `REDIS_URL` to enable distributed rate limiting. API processes then leave
in-process polling disabled by default; run the shared worker separately:

```bash
DATABASE_URL=postgresql://fiber_offers:secret@127.0.0.1:54320/fiber_offers \
REDIS_URL=redis://127.0.0.1:63790 \
npm run worker
```

The Compose development ports default to loopback-only `54320` and `63790`.
Override them with `POSTGRES_PORT` and `REDIS_PORT`; managed deployments should
not publish either service publicly.

Run the cross-instance store checks against the Compose dependencies with:

```bash
TEST_DATABASE_URL=postgresql://fiber_offers:fiber_offers_dev@127.0.0.1:54320/fiber_offers \
TEST_REDIS_URL=redis://127.0.0.1:63790 \
npm run test:infra
```

These tests use independent PostgreSQL pools and Redis clients, and remove their
fixtures after completion.

BullMQ Job Schedulers enqueue settlement synchronization and webhook delivery
passes. Multiple workers may run for availability; BullMQ coordinates job claims,
and the underlying store operations remain retry-safe.

Recurring payment execution remains in the payer trust boundary through
`FiberRecurringPaymentScheduler`: the merchant resolver must never hold payer
payment authority. A wallet service that needs horizontal recurrence scheduling
should run that SDK scheduler with its own durable approval store and BullMQ queue.

## Live Fiber RPC

```bash
FIBER_RPC_URL=http://127.0.0.1:8227 npm run fiber:check
FIBER_RPC_URL=http://127.0.0.1:8227 npm run dev
```

`FIBER_RPC_URL` is the merchant/payee node. It can use any port or a hosted private endpoint:

```bash
FIBER_RPC_URL=https://fiber-rpc.merchant.example \
FIBER_RPC_USERNAME=resolver \
FIBER_RPC_PASSWORD=secret \
npm run dev
```

The resolver reads the node's network from `node_info` on mainnet and testnet and refuses offers signed for a different one. On a private chain, set `FIBER_NETWORK=dev` so the same check applies. `FIBER_RPC_TIMEOUT_MS` (default `15000`) bounds every call to the node. `FIBER_INVOICE_TTL_SECONDS` (default `900`) is how long each issued invoice stays payable.

### Token (UDT and RGB++) offers

An offer names a token by `type_script_hash`. To mint a token invoice the
resolver needs the token's full CKB type script, which it sends to the node as
`udt_type_script`. It finds scripts in three places:

- `FIBER_UDT_SCRIPTS`, a JSON array of `{ "name", "code_hash", "hash_type", "args" }`;
- `FIBER_UDT_SCRIPTS_FILE`, a path to a file with the same array;
- the node's own UDT whitelist (`node_info.udt_cfg_infos`), for entries that
  give one exact script rather than an `args` pattern.

Every script is hashed when it is loaded, so a mistyped entry cannot serve a
different token than the one an offer signed. A configuration error stops the
resolver at startup. The node must also whitelist the token (`udt_whitelist` in
its own configuration) and hold a channel in it.

Registering an offer for a token the resolver has no script for fails with
`422 ASSET_SCRIPT_NOT_CONFIGURED`. `GET /diagnostics` lists the tokens it can
serve under `invoice_source.assets.udt`.

With Docker, point `FIBER_RPC_URL` at the host or service address reachable from the container. The payer node is not resolver configuration: each payer wallet uses its own node to dry-run and send the invoice. Set `PAYER_FIBER_RPC_URL` only in controlled topology or E2E test environments.

The current deployment boundary is one resolver instance to one merchant node. For multi-tenant hosting, store encrypted node profiles server-side, bind each offer to an authenticated tenant, and resolve the node profile from that ownership record. Do not accept RPC URLs or credentials in public offer and invoice requests.

## Background Workers

Background workers are enabled in the standard live runtime. They poll Fiber invoice status and retry webhook deliveries without manual API calls:

```bash
RESOLVER_WORKERS_ENABLED=true \
RESOLVER_PUBLIC_URL=https://resolver.example.com \
FIBER_RPC_URL=http://127.0.0.1:8227 \
npm run dev
```

Useful controls:

```text
RESOLVER_WORKERS_RUN_ON_START=true
RESOLVER_SETTLEMENT_SYNC_INTERVAL_MS=3000
RESOLVER_WEBHOOK_RETRY_INTERVAL_MS=30000
RESOLVER_WEBHOOK_MAX_ATTEMPTS=8
RESOLVER_WEBHOOK_RETRY_MIN_AGE_MS=30000
RESOLVER_WEBHOOK_TIMEOUT_MS=10000
RESOLVER_RATE_LIMIT_WINDOW_MS=60000
RESOLVER_RATE_LIMIT_MAX=120
```

Worker status is exposed in `GET /diagnostics`.

The interval-based workers are the local, no-Redis fallback. Do not enable them
on horizontally scaled API replicas; use `npm run worker` instead.

## Hosted Demo Notes

For a public demo:

- deploy behind HTTPS;
- set `RESOLVER_API_KEY`;
- enter that key only in the dashboard unlock dialog or a trusted CLI/backend;
- set `RESOLVER_SECRET_ENCRYPTION_KEY` so webhook secrets are encrypted with AES-256-GCM on disk;
- keep `RESOLVER_ALLOW_PRIVATE_WEBHOOKS=false` to reject loopback, link-local, and private-network webhook targets;
- keep the Fiber RPC endpoint private and continuously monitored;
- treat an unreachable Fiber node as an operational failure rather than silently switching to mock invoices;
- use managed PostgreSQL and Redis or back up both Docker volumes;
- terminate TLS at the ingress and restrict direct database, Redis, and Fiber RPC access.

## Production Hardening Still Needed

- Merchant-scoped identity and API-key management.
- Centralized metrics, tracing, and alerting for API, queue, database, and Fiber RPC health.
- Managed secret rotation and encrypted backups.
- Production TLS certificates and ingress policy; the included Nginx config is HTTP-only.
