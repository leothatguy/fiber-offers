# Deployment

## Local Production-Like Run

```bash
RESOLVER_API_KEY=change-me \
RESOLVER_SECRET_ENCRYPTION_KEY=replace-with-a-long-random-secret \
RESOLVER_ALLOW_PRIVATE_WEBHOOKS=false \
RESOLVER_RATE_LIMIT_MAX=120 \
npm run dev
```

When `RESOLVER_API_KEY` is set, operator routes require:

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

### After an upgrade: offers that no longer verify

Releases can tighten what a valid offer is. An offer stored before that still
appears in `GET /offers` (and `fiber-offers list`), marked `valid: false` with
an `invalid_code`, and its payment page still loads. Invoice requests for it
are refused with `409 OFFER_INVALID`. Create a replacement with the current
CLI or SDK and share the new link; an offer cannot be repaired, because any
change to it changes its ID and needs a new signature.

### What is public and what needs the key

Open to anyone, because a payer's wallet calls them:

- offer lookup, Fiber Address lookup, the payment page and QR codes;
- `POST /offers/:offer_id/check` and `POST /offers/:offer_id/invoice`;
- one resolution and its receipt, addressed by the resolution ID that only the
  payer who requested that invoice holds;
- one subscription's recurrence status, addressed by the subscription ID that
  is derived from the payer's own key;
- revoking an offer, which is authorised by a signature from the offer's key;
- `GET /health`, which says only whether the resolver is up.

Everything else needs the key: registering and listing offers, Fiber Address
binding, the list of an offer's resolutions, reconciliation exports, the
recurrence summary across subscribers, settlement sync and status changes,
webhooks, `GET /diagnostics` and `GET /topology`. An offer ID is printed in
every payment link, so anything that lists an offer's payments would otherwise
hand the merchant's payment history to anyone holding a link.

Public responses carry the invoice and its payment hash, never the raw request
sent to the Fiber node or its raw answer. `POST /offers/:offer_id/check` runs a
route check on the payer node only for operators.

The full table is `EXPECTED_ACCESS` in
`apps/resolver/test/route-access.test.js`; that test fails if a route is added
without stating who may call it.

### Demo mode

`RESOLVER_DEMO_MODE=true` switches on what exists for a public demo and has no
place on a merchant's resolver. It is off by default, and the resolver prints a
warning at startup when it is on.

| With demo mode on | Why it is off by default |
| --- | --- |
| `POST /demo/offers` creates an offer with a key generated on the server and returns the private key | An offer's key should never be held by the resolver |
| `POST` and `GET /demo/webhook-receiver`, a sample webhook inbox (last 50 deliveries, 64 KiB each, no request headers kept) | Unauthenticated writes |
| `RESOLVER_PUBLIC_OPERATOR_ACCESS=true` gives every visitor an operator session | It makes every operator route public |
| Anonymous `POST /offers/:offer_id/check` calls run route checks on `PAYER_FIBER_RPC_URL` | They run on the operator's own payer node and report its channels |

`RESOLVER_PUBLIC_OPERATOR_ACCESS` is ignored, with a warning in the log, unless
demo mode is on.

## Docker

For a local stack, with the example secrets:

```bash
NODE_ENV=development docker compose up --build
```

For production, supply real secrets (`fiber-offers init` writes them to `.env`)
and add the production overrides:

```bash
docker compose -f docker-compose.yml -f docker-compose.production.yml up -d --build
```

### Production startup checks

With `NODE_ENV=production` the resolver and the queue worker refuse to start,
and say why, unless all of these hold:

| Setting | Requirement |
| --- | --- |
| `RESOLVER_API_KEY` | Set, at least 24 characters, not an example value. Without it every operator endpoint is open. |
| `RESOLVER_SECRET_ENCRYPTION_KEY` | Set, at least 32 characters, not an example value. Without it webhook secrets are stored in plaintext. |
| `RESOLVER_PUBLIC_URL` | Set, and `https` unless it is a localhost address. |
| `DATABASE_URL` | Set, without an example password. To run a single process on the JSON file store instead, set `RESOLVER_ALLOW_JSON_STORE=true`. |

`docker-compose.production.yml` also makes Compose itself stop when one of the
secrets is missing. The base file keeps example values so a local stack starts
with no setup; they are refused in production.

Open:

```text
http://localhost:8787
```

The Compose stack runs two resolver API replicas behind Nginx, one PostgreSQL
instance, one Redis instance, a one-shot migration service, and a BullMQ worker.
PostgreSQL and Redis data use separate named volumes.

`RESOLVER_SECRET_ENCRYPTION_KEY` must be identical on every API and worker
replica and remain stable across restarts. Simply changing the value makes
existing webhook secrets undecryptable; change it with the procedure below.

### The container user

Every process in the image runs as the unprivileged `node` user (uid 1000),
not as root. It can write in two places: the directory of the file store
(`/app/apps/resolver/data`) and the directory in which the RPC relay keeps its
socket (`/run/fiber-rpc`). A new volume mounted at either gets the right owner
by itself.

Upgrading from an image that ran as root:

- **The Compose stack** needs nothing done. The relay's socket now lives in a
  new volume, `fiber-rpc-relay`. The old one, `fiber-rpc-socket`, held only a
  socket, is no longer used, and can be removed with `docker volume rm`.
- **A file store kept in a volume or a bind mount** still belongs to root, and
  the resolver stops at start with a permission error. Hand it over once:

  ```bash
  docker run --rm --user root -v YOUR_VOLUME:/app/apps/resolver/data IMAGE \
    chown -R node:node /app/apps/resolver/data
  ```

### Checking a running resolver

`npm run resolver:check -- --url URL [--api-key KEY]` uses a resolver from the
outside, as a merchant and a wallet would: it registers an offer signed on the
spot, finds it by Fiber Address, requests invoices, repeats a request with the
same idempotency key, revokes the offer, and confirms that operator routes are
closed without the key. It needs a resolver that issues mock invoices
(`FIBER_INVOICE_MODE=mock`), so it suits a staging stack, not a resolver with a
real node. Without `--api-key` it uses `RESOLVER_API_KEY` from its
environment, which keeps the key off the command line. The script is in the
image too, where that variable is already set:

```bash
docker compose exec fiber-offers node scripts/running-resolver-check.js \
  --url http://127.0.0.1:8787
```

CI runs it against the image on its own and against the whole Compose stack
(`.github/workflows/ci.yml`).

### Secret encryption and key rotation

Webhook signing secrets are stored as `enc:v2:<salt>:<iv>:<tag>:<ciphertext>`:
AES-256-GCM under a key derived from `RESOLVER_SECRET_ENCRYPTION_KEY` with
scrypt and the salt stored beside the value. Someone holding a copy of the
database cannot test guesses at the configured key cheaply.

To change the key:

1. Set `RESOLVER_SECRET_ENCRYPTION_KEY` to the new key and
   `RESOLVER_SECRET_ENCRYPTION_KEY_PREVIOUS` to the old one on every API and
   worker replica, and restart them together. They now read secrets under
   either key and write under the new one.
2. Run `npm run secrets:rotate` with the same two variables (and
   `DATABASE_URL`). It rewrites every stored secret under the new key, checks
   that each one reads back with the new key alone, and prints how many it
   rewrote. With PostgreSQL this is one transaction: on any failure nothing is
   changed.
3. Remove `RESOLVER_SECRET_ENCRYPTION_KEY_PREVIOUS` and restart.

Restart replicas together in step 1: a replica still on the old key alone
cannot read a secret another replica has already written under the new one, and
its webhook deliveries for that secret fail until it restarts (they are retried).

Upgrading from a version that wrote `enc:v1:` values: those are still read, and
new values are written as `enc:v2:`. Upgrade every replica together (an older
replica cannot read `enc:v2:`), then run `npm run secrets:rotate` once, with no
previous key, to rewrite the old values. The same command encrypts secrets that
were stored as plaintext before a key was configured.

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

`GET /health` checks PostgreSQL, Redis, and the configured invoice source, and
returns `503` when one of them is down (in live mode, when FNN cannot be
reached). Anonymous callers get `ok`, `service` and `invoice_mode` only; with
the API key the response also names the failing dependency and the node. One
probe answers health checks for five seconds, so they cannot be used to load
the node. `GET /diagnostics` (API key required) has the detailed peer and
channel report.

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

## The File Store

Without `DATABASE_URL` the resolver keeps everything in one JSON file, at
`RESOLVER_DATA_PATH` (by default `apps/resolver/data/offers.json`). It suits a
single process on one machine. In production it must be asked for with
`RESOLVER_ALLOW_JSON_STORE=true`; use PostgreSQL for more than one replica or a
separate worker.

- Each change replaces the file in one step: the new contents are written to a
  temporary file beside it, flushed to disk, then renamed over it. A crash or a
  full disk leaves the previous file whole.
- The file is readable only by the resolver's user (mode `0600`).
- A file that is not valid JSON stops the resolver with `STORE_FILE_CORRUPT`
  instead of being replaced by an empty store. Restore it from a backup.
- Back the file up by copying it; a copy is always a complete, consistent store.

## Stopping and Restarting

On `SIGTERM` or `SIGINT` the resolver and the worker stop taking new
connections, answer the requests already in progress, let a background pass
that is running finish, flush pending writes, close the database and Redis
connections, and exit with status 0. Requests still unanswered after
`RESOLVER_SHUTDOWN_TIMEOUT_MS` (default 8000) are cut off, so the process is
gone before Docker's ten-second kill. The image starts Node directly so the
signal reaches it.

A payer whose request was cut off can retry it with the same idempotency key
and gets the same invoice.

## Response Headers

The resolver sets these on every response itself, so they do not depend on the
proxy in front of it:

| Header | Value | Why |
| --- | --- | --- |
| `X-Content-Type-Options` | `nosniff` | A response is never treated as a type it did not declare |
| `Referrer-Policy` | `no-referrer` | Resolution and receipt URLs are readable by whoever holds them, so they must not reach other sites |
| `X-Frame-Options` | `DENY` | The operator console cannot be framed by another site |
| `Content-Security-Policy` | `default-src 'none'; frame-ancestors 'none'` on API responses; pages allow only their own scripts, styles and images | Nothing inline and nothing from another origin runs |
| `Strict-Transport-Security` | `max-age=31536000`, when the public URL is `https` | Browsers keep using HTTPS |

The pages contain no inline script or style, and a test keeps it that way. To
report a vulnerability, see [SECURITY.md](../SECURITY.md).

## Fiber RPC Access

The resolver calls five methods on the merchant node: `node_info`,
`new_invoice`, `get_invoice`, `list_peers` and `list_channels`. It never needs
to send a payment or manage a channel, so it should not hold credentials that
can.

Fiber checks RPC calls against a [Biscuit](https://www.biscuitsec.org/) token
when the node is started with `rpc.biscuit_public_key`; the token names what
its holder may do. Give the resolver a token with exactly this:

```datalog
read("node");
read("invoices");
write("invoices");
read("peers");
read("channels");
```

1. Create a key pair with `biscuit keypair` (see Fiber's
   `docs/biscuit-auth.md`). Keep the private key off the resolver host.
2. Put the public key in the node's `config.yml` and restart the node:

   ```yaml
   rpc:
     biscuit_public_key: "ed25519/<public key>"
   ```

3. Sign the token: `biscuit generate --private-key <private key> resolver.bc`,
   where `resolver.bc` holds the five lines above.
4. Set `FIBER_RPC_TOKEN=<token>` for the resolver and the worker.

Checked against Fiber `v0.10.1`: with this token the resolver creates and
tracks invoices and reports diagnostics, while `send_payment`, `get_payment`,
`open_channel`, `shutdown_channel`, `connect_peer` and `graph_nodes` are refused
with JSON-RPC error `-32999 Unauthorized`. `write("invoices")` also covers
`cancel_invoice` and `settle_invoice`; Fiber has no narrower permission.

If the node refuses the token, invoice requests fail with
`502 FIBER_RPC_UNAUTHORIZED` (not retryable) and `GET /diagnostics` shows the
node as unreachable with cause `-32999`.

`FIBER_RPC_USERNAME` and `FIBER_RPC_PASSWORD` send HTTP Basic credentials
instead, for a node behind a proxy that checks them. A Fiber node itself does
not understand them, and they cannot limit which methods are called. When a
token is set it is the one sent.

A payer node used for the optional topology checks takes its own token in
`PAYER_FIBER_RPC_TOKEN`. That one needs `write("payments")` for route dry-runs,
which is one more reason not to configure a payer node on a merchant's resolver.

## Webhook Targets

A webhook URL makes the resolver send requests from inside your network, so
with `RESOLVER_ALLOW_PRIVATE_WEBHOOKS=false` (the default in production) a
delivery can reach only a public address:

- When a webhook is registered, a URL that names a private target is refused
  with `400 INVALID_WEBHOOK_URL`: a loopback, private, link-local, carrier-NAT
  or unspecified address in any spelling (`0x7f.1`, `[::ffff:127.0.0.1]`), a
  single-label name such as `redis`, or `localhost`, `.local`, `.internal`.
- At every delivery the host name is resolved and each address it returns is
  checked again. If any of them is not public the delivery fails with
  `WEBHOOK_TARGET_PRIVATE`, and the connection can only be opened to an address
  that passed, so a name cannot resolve one way for the check and another way
  for the request.
- A redirect is never followed. It is recorded as a failed delivery
  (`WEBHOOK_REDIRECT_REFUSED`); register the final URL instead.
- Only the status code of the answer is recorded. The response body is not
  read, stored or returned. Migration `005` clears bodies stored by earlier
  versions.

Set `RESOLVER_ALLOW_PRIVATE_WEBHOOKS=true` only for local development, where
the receiver is on the same machine.

## Background Workers

Background workers are enabled in the standard live runtime. They poll Fiber invoice status and retry webhook deliveries without manual API calls:

```bash
RESOLVER_WORKERS_ENABLED=true \
RESOLVER_PUBLIC_URL=https://resolver.example.com \
FIBER_RPC_URL=http://127.0.0.1:8227 \
npm run dev
```

Useful controls, with their defaults:

```text
RESOLVER_WORKERS_RUN_ON_START=true
RESOLVER_SETTLEMENT_SYNC_INTERVAL_MS=3000
RESOLVER_SETTLEMENT_SYNC_BATCH_SIZE=200
RESOLVER_SETTLEMENT_SYNC_CONCURRENCY=8
RESOLVER_WEBHOOK_RETRY_INTERVAL_MS=30000
RESOLVER_WEBHOOK_BATCH_SIZE=50
RESOLVER_WEBHOOK_CONCURRENCY=5
RESOLVER_WEBHOOK_MAX_ATTEMPTS=8
RESOLVER_WEBHOOK_RETRY_MIN_AGE_MS=30000
RESOLVER_WEBHOOK_RETRY_MAX_DELAY_MS=3600000
RESOLVER_WEBHOOK_EVENT_RETENTION_DAYS=30
RESOLVER_WEBHOOK_TIMEOUT_MS=10000
RESOLVER_RATE_LIMIT_WINDOW_MS=60000
RESOLVER_RATE_LIMIT_MAX=120
```

Worker status is exposed in `GET /diagnostics`.

### What a pass does

Neither pass reads every offer. Each asks the store for what is due, a bounded
batch at a time, and goes on to the next batch while batches come back full and
it has time left, which is 80% of its interval. A pass that runs out of time
reports `has_more: true` and the next one carries on.

- **The settlement pass** (every `RESOLVER_SETTLEMENT_SYNC_INTERVAL_MS`) takes
  the invoices that still await an outcome, the ones it asked about longest ago
  first, `RESOLVER_SETTLEMENT_SYNC_BATCH_SIZE` at a time, and asks the node
  about `RESOLVER_SETTLEMENT_SYNC_CONCURRENCY` of them at once. An invoice with
  an outcome is never read again. With more invoices open than the node can
  answer for within one interval, each is simply asked about less often.
- **The delivery pass** (every `RESOLVER_WEBHOOK_RETRY_INTERVAL_MS`) takes the
  webhook deliveries that are due, `RESOLVER_WEBHOOK_BATCH_SIZE` at a time, and
  makes `RESOLVER_WEBHOOK_CONCURRENCY` at once. A failed delivery waits
  `RESOLVER_WEBHOOK_RETRY_MIN_AGE_MS`, then twice as long after each further
  failure, up to `RESOLVER_WEBHOOK_RETRY_MAX_DELAY_MS`. After
  `RESOLVER_WEBHOOK_MAX_ATTEMPTS` attempts it is marked `dead` and left for an
  operator ([Retries](resolver-api.md#retries)). The pass also removes events
  older than `RESOLVER_WEBHOOK_EVENT_RETENTION_DAYS` that have nothing left to
  deliver; `0` keeps them for ever.

With PostgreSQL, work is claimed: a worker takes rows with
`FOR UPDATE SKIP LOCKED`, an invoice it has asked about is not due again for
most of an interval, and a delivery is held under a lease until its answer is
recorded. Two workers, or the passes of two replicas, therefore never ask about
the same invoice twice in an interval or send the same delivery at once. If a
worker dies, its deliveries become due again when the lease runs out.

The interval-based workers inside the resolver are the no-Redis arrangement.
With several API replicas, prefer `npm run worker`: one place to look for the
passes' logs and status. Running the in-process workers on each replica is safe
with PostgreSQL, for the reason above, but each replica then spends connections
and time on passes.

A new event waits for the next delivery pass, so a webhook can arrive up to
`RESOLVER_WEBHOOK_RETRY_INTERVAL_MS` after the payment it reports. Lower the
interval if that matters.

## Hosted Demo Notes

For a public demo:

- deploy behind HTTPS;
- set `RESOLVER_DEMO_MODE=true` (see [Demo mode](#demo-mode)), and
  `RESOLVER_PUBLIC_OPERATOR_ACCESS=true` only if every visitor should get the
  operator workspace;
- use a testnet node with no funds you care about: demo mode lets visitors
  create offers and read the node's diagnostics;
- set `RESOLVER_API_KEY`;
- enter that key only in the dashboard unlock dialog or a trusted CLI/backend;
- set `RESOLVER_SECRET_ENCRYPTION_KEY` so webhook secrets are encrypted with AES-256-GCM on disk;
- keep `RESOLVER_ALLOW_PRIVATE_WEBHOOKS=false` so webhooks can reach public addresses only (see [Webhook Targets](#webhook-targets));
- keep the Fiber RPC endpoint private and continuously monitored;
- treat an unreachable Fiber node as an operational failure rather than silently switching to mock invoices;
- use managed PostgreSQL and Redis or back up both Docker volumes;
- terminate TLS at the ingress and restrict direct database, Redis, and Fiber RPC access.

## Production Hardening Still Needed

- Merchant-scoped identity and API-key management.
- Centralized metrics, tracing, and alerting for API, queue, database, and Fiber RPC health.
- Managed secret rotation and encrypted backups.
- Production TLS certificates and ingress policy; the included Nginx config is HTTP-only.
