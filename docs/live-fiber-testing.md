# Live Fiber Testing

The resolver runs in live Fiber RPC mode by default. A normal local run targets only the merchant node on `8227` and starts automatic settlement workers. The payer node on `8229` is an optional controlled fixture for the route and E2E sections below.

## 0. Run Local Fiber Nodes

`scripts/local-fiber.js` runs real Fiber nodes on this machine without Docker. It
downloads an official `fnn` release, checks it against the SHA-256 GitHub
publishes, and manages a merchant node and a payer node on the CKB testnet.

```bash
npm run fiber:local -- init      # download, verify, create both nodes
npm run fiber:local -- start
npm run fiber:local -- status    # identity, peers, channels, funding address
npm run fiber:local -- stop
```

| Node | RPC | P2P |
| --- | --- | --- |
| `merchant` | `http://127.0.0.1:8227` | `127.0.0.1:8228` |
| `payer` | `http://127.0.0.1:8229` | `127.0.0.1:8230` |

These are the ports the rest of this guide and `npm run dev:fiber:pair` expect.
Both nodes listen on loopback only and do not announce an address. Their data,
keys and logs live in `.fiber-offers/local-fiber`, which git ignores. The keys
and their passwords are generated on this machine and stored unencrypted beside
the nodes, so treat them as test nodes and never fund them with mainnet assets.

Without funds the nodes already answer everything the resolver needs to mint
and read invoices (`node_info`, `new_invoice`, `parse_invoice`, `get_invoice`).
To send a real payment, the payer needs a channel to the merchant: send testnet
CKB from the [Nervos faucet](https://faucet.nervos.org) to each node's
`funding_address` from `status`, then open the channel (section 7).

To check another Fiber version side by side, add a node on its own ports:

```bash
npm run fiber:local -- add merchant-09 --version v0.9.1 --rpc-port 8327 --p2p-port 8328
```

Pinned releases: `v0.10.1` (default) and `v0.9.1`, x86_64 Linux. On another
platform, install `fnn` yourself and point `FIBER_RPC_URL` at it.

### Verified against a live node

Observed on Fiber `v0.10.1`, testnet, on 2026-11-22:

| Behaviour the code relies on | Observed |
| --- | --- |
| `node_info.chain_hash` is the CKB genesis hash | Yes: the testnet genesis hash |
| `node_info.udt_cfg_infos` lists exact token scripts | Yes: an array of `{ name, script, ... }`; `RUSD` is whitelisted by default |
| `new_invoice` takes hex `amount`, `currency`, `description`, hex `expiry` (seconds), `udt_type_script` | Yes; a decimal amount is refused with `-32602` |
| An invoice states its payee | Yes: `{ "payee_public_key": "02…" }` in `data.attrs`, no `0x` prefix |
| Expiry and token script in `data.attrs` | `{ "expiry_time": "0x384" }` (seconds) and `{ "udt_script": "0x…" }` (molecule bytes) |
| `data.timestamp` | Hex milliseconds; the resolver's `expires_at` equals the invoice's own expiry |
| The node enforces expiry | Yes: `Open` becomes `Expired` once the lifetime has passed |
| Wrong network currency | Refused: `-32000 Currency must be Fibt with the chain network` |
| Description length | At most 639 bytes; longer is refused |
| A token not on the node's whitelist | **Accepted** by `new_invoice`. The resolver's own registry check is the only guard |
| `get_payment` for an unknown hash | `-32000 … Payment session not found` |
| Dry-run with no channel | `-32000 … max outbound liquidity 0 is insufficient` |
| `open_channel` right after `connect_peer` | Refused until the peers have exchanged Init messages (`… waiting for peer to send Init message`); the fixture script retries |
| RPC authentication | `fnn-cli` takes `--auth-token`: the node's own RPC auth is a bearer token, not HTTP Basic |

With a 1,000 CKB channel from the payer node to the merchant node, the same day:

| Flow, through `FiberOffersClient` and `FiberPaymentFlowClient` | Result |
| --- | --- |
| Reusable offer, two payments (1 CKB and 1.5 CKB), `confirm: true` | Both `payment_succeeded` (Fiber `Success`), distinct invoices and payment hashes |
| Resolver sync after payment | `invoice_created` → `invoice_paid` (Fiber `Paid`) |
| Single-use offer | First payment `payment_succeeded`; second attempt `blocked_before_invoice` / `OFFER_ALREADY_USED` |
| Recurring offer, two cycles through `FiberRecurringPaymentScheduler` | Two `cycle.paid`, then `approval.cap_reached` |
| Every invoice above | Verified by the payer node before sending: payee, amount, currency, asset, expiry, binding |

These were run by hand from a scratch script. Turning them into the repeatable
`npm run fiber:e2e-check` with a saved transcript is plan items `F2` and `F3`.

## 1. Probe The Fiber Node

```bash
FIBER_RPC_URL=http://127.0.0.1:8227 npm run fiber:check
```

By default the probe calls `node_info`. If your Fiber build exposes a different health/info method, set:

```bash
FIBER_RPC_PROBE_METHOD=<method> FIBER_RPC_URL=http://127.0.0.1:8227 npm run fiber:check
```

If the probe succeeds, the command prints JSON with `reachable: true`.

## 2. Create And Verify A Live Invoice

This command creates a real Fiber invoice through `new_invoice`, then verifies it with `get_invoice` using the returned `payment_hash`.

```bash
FIBER_RPC_URL=http://127.0.0.1:8227 npm run fiber:invoice-check
```

Optional:

```bash
FIBER_CHECK_AMOUNT=100000000 \
FIBER_CHECK_DESCRIPTION="Fiber Offers live invoice check" \
FIBER_RPC_URL=http://127.0.0.1:8227 \
npm run fiber:invoice-check
```

The command should print `ok: true`, `mocked: false`, a `payment_hash`, and `fiber_invoice_status: "Open"`.

## 3. Start Resolver In Fiber RPC Mode

```bash
FIBER_RPC_URL=http://127.0.0.1:8227 npm run dev
```

Optional:

```bash
FIBER_RPC_USERNAME=<username> \
FIBER_RPC_PASSWORD=<password> \
FIBER_RPC_INVOICE_METHOD=new_invoice \
FIBER_RPC_GET_INVOICE_METHOD=get_invoice \
FIBER_RPC_PROBE_METHOD=node_info \
npm run dev
```

## 4. Confirm Diagnostics

Open:

```text
http://localhost:8787/diagnostics
http://localhost:8787/topology
```

The response should show:

```json
{
  "invoice_mode": "fiber-rpc",
  "invoice_source": {
    "configured": true,
    "reachable": true,
    "status": "ok"
  }
}
```

If `invoice_source.status` is `degraded`, the node is reachable but has an operational warning. The most useful fields are:

```text
invoice_source.peers.count
invoice_source.channels.enabled
invoice_source.channels.usable_outbound
invoice_source.channels.usable_inbound
invoice_source.channels.local_balance_total
invoice_source.channels.remote_balance_total
invoice_source.channels.offline_counterparties
invoice_source.warnings
```

For example, `OFFLINE_CHANNEL_COUNTERPARTIES` means the node has ready channels, but one or more channel counterparties are not connected as live peers. Route building can still fail even when channel balances are non-zero if the first hop or route graph is not reachable.

## 5. Request A Real Invoice

Create an offer in the demo, click `Check Readiness`, then click `Request Invoice`.

In mock mode, invoice strings start with `fibermock_`. In Fiber RPC mode, the invoice field should come from the Fiber node RPC response.

## 6. Sync Invoice Status From Fiber

After the resolver is running in Fiber RPC mode, this command creates a live invoice through the resolver, calls the resolver sync endpoint, and verifies the Fiber invoice status returned by `get_invoice`.

```bash
RESOLVER_URL=http://127.0.0.1:8787 npm run fiber:sync-check
```

Sync endpoints:

```text
POST /offers/:offer_id/resolutions/:resolution_id/sync
POST /offers/:offer_id/resolutions/sync
```

Fiber invoice statuses map into resolver statuses as:

```text
Open      -> invoice_created
Received  -> invoice_received
Paid      -> invoice_paid
Expired   -> invoice_expired
Cancelled -> invoice_cancelled
```

## 7. Inspect Payer-To-Merchant Topology

Before attempting an e2e payment, inspect the payer-to-merchant topology:

```bash
MERCHANT_FIBER_RPC_URL=http://127.0.0.1:8227 \
PAYER_FIBER_RPC_URL=http://127.0.0.1:8229 \
npm run fiber:topology-check
```

The topology report is read-only by default and prints:

```text
status
summary
direct_channel.usable_for_payer_to_merchant
common_channel_counterparties
online_common_channel_counterparties
blockers
warnings
next_actions
fixture_recommendation
```

Direct-channel fixture reports include `already_ready`, `already_opening`, `stalled_opening`, `accept_needed`, `open_needed`, `connect_needed`, and executable `steps`. A stalled one-sided opening is reported as `DIRECT_CHANNEL_HANDSHAKE_STALLED` so the operator can abandon or let the stale pending channel expire before retrying.

Use strict mode when you want a failing exit code for blocked local topology:

```bash
FIBER_TOPOLOGY_STRICT=true \
MERCHANT_FIBER_RPC_URL=http://127.0.0.1:8227 \
PAYER_FIBER_RPC_URL=http://127.0.0.1:8229 \
npm run fiber:topology-check
```

If you already have an invoice, the same command can include a route dry-run and normalized failure:

```bash
FIBER_INVOICE=fibt1... \
MERCHANT_FIBER_RPC_URL=http://127.0.0.1:8227 \
PAYER_FIBER_RPC_URL=http://127.0.0.1:8229 \
npm run fiber:topology-check
```

The report is also available from the resolver at `GET /topology` when the resolver process has both `FIBER_RPC_URL` or `MERCHANT_FIBER_RPC_URL` and `PAYER_FIBER_RPC_URL` configured.

For a deterministic local fixture, generate a direct-channel plan:

```bash
MERCHANT_FIBER_RPC_URL=http://127.0.0.1:8227 \
PAYER_FIBER_RPC_URL=http://127.0.0.1:8229 \
npm run fiber:direct-channel-fixture
```

The command is report-only unless the explicit guard is enabled. With the guard enabled it executes the planned `connect_peer`, `open_channel`, or `accept_channel` step, depending on the current topology:

```bash
FIBER_FIXTURE_OPEN_DIRECT_CHANNEL=true \
FIBER_DIRECT_CHANNEL_FUNDING_AMOUNT=10000000000 \
MERCHANT_FIBER_RPC_URL=http://127.0.0.1:8227 \
PAYER_FIBER_RPC_URL=http://127.0.0.1:8229 \
npm run fiber:direct-channel-fixture
```

If the payer is not already connected to the merchant, provide a multiaddr:

```bash
FIBER_MERCHANT_PEER_ADDRESS=/ip4/127.0.0.1/tcp/8228/p2p/... \
npm run fiber:direct-channel-fixture
```

The equivalent Fiber CLI path is:

```bash
fnn-cli -u "$PAYER_FIBER_RPC_URL" peer connect_peer --address "$MERCHANT_MULTIADDR"
fnn-cli -u "$PAYER_FIBER_RPC_URL" channel open_channel \
  --pubkey "$MERCHANT_PUBKEY" \
  --funding-amount "$FUNDING_AMOUNT" \
  --public false
```

Opening or accepting a channel mutates Fiber/on-chain state and requires spendable funding capacity. If auto-accept is not enabled for the merchant node, the fixture plan reports `status: "ready_to_accept"` and includes an `accept_channel` step. The equivalent manual CLI path is:

```bash
fnn-cli -u "$MERCHANT_FIBER_RPC_URL" channel list_channels --only-pending true
fnn-cli -u "$MERCHANT_FIBER_RPC_URL" channel accept_channel \
  --temporary-channel-id "$TEMPORARY_CHANNEL_ID" \
  --funding-amount "$ACCEPT_FUNDING_AMOUNT"
```

## 8. Run A Payer-To-Merchant E2E Check

With merchant and payer Fiber nodes available, the E2E check creates one static
offer and, by default, constructs two independent payer client sessions. Each
session requests its own invoice, dry-runs the route, sends payment, polls
`get_payment`, polls merchant `get_invoice`, and syncs the resolver status. The
check fails unless both invoices and payment hashes are distinct and both
resolver records reach `invoice_paid`.

```bash
RESOLVER_URL=http://127.0.0.1:8787 \
MERCHANT_FIBER_RPC_URL=http://127.0.0.1:8227 \
PAYER_FIBER_RPC_URL=http://127.0.0.1:8229 \
npm run fiber:e2e-check
```

Set `FIBER_E2E_OFFER_ID=0x...` to pay an offer already created by the merchant
CLI. When it is unset, the check creates a disposable E2E offer. Each run uses
fresh idempotency keys, so rerunning against the same reusable offer still
creates new invoices.

Set `FIBER_E2E_PAYMENT_COUNT` to change the number of independent client
sessions. When multiple funded payer nodes are available, provide their RPC URLs
through `PAYER_FIBER_RPC_URLS` as a comma-separated list; otherwise each session
uses a fresh client instance against `PAYER_FIBER_RPC_URL`.

To only test route construction without sending a payment:

```bash
FIBER_E2E_DRY_RUN_ONLY=true \
RESOLVER_URL=http://127.0.0.1:8787 \
MERCHANT_FIBER_RPC_URL=http://127.0.0.1:8227 \
PAYER_FIBER_RPC_URL=http://127.0.0.1:8229 \
npm run fiber:e2e-check
```

Optional route parameters:

```bash
FIBER_E2E_AMOUNT=1000 \
FIBER_E2E_PAYMENT_COUNT=2 \
FIBER_E2E_TRAMPOLINE_HOPS=<comma-separated-pubkeys> \
FIBER_E2E_MAX_FEE_AMOUNT=100000 \
FIBER_E2E_DRY_RUN_ONLY=true \
RESOLVER_URL=http://127.0.0.1:8787 \
MERCHANT_FIBER_RPC_URL=http://127.0.0.1:8227 \
PAYER_FIBER_RPC_URL=http://127.0.0.1:8229 \
npm run fiber:e2e-check
```

The command prints channel, peer, direct-channel, common-counterparty, and `failure` diagnostics if the route or payment fails. `ROUTE_OUTBOUND_LIQUIDITY_UNUSABLE` usually means Fiber could not find an online route from the payer to the merchant invoice, even if the payer has non-zero local channel balances. Check `route_context.payer_offline_channel_counterparties`, `route_context.offline_common_counterparties`, pending TLCs, and whether there is a direct ready channel.

The same route preflight and failure shape is available to app and wallet code through the SDK helpers `FiberPaymentClient.checkPaymentRoute()` and `normalizeFiberPaymentFailure()`.

Failure output keeps the developer-facing Fiber node error under `fiber_error`:

```json
{
  "code": "ROUTE_OUTBOUND_LIQUIDITY_UNUSABLE",
  "summary": "Fiber could not find a route with usable outbound liquidity from the payer to this invoice.",
  "fiber_error": {
    "method": "send_payment",
    "code": -32000,
    "message": "Send payment error: Failed to build route, Insufficient balance: max outbound liquidity 0 is insufficient, required amount: 1000"
  },
  "likely_causes": [],
  "next_actions": [],
  "route_context": {}
}
```

## 9. Check Any Fiber Invoice From A Payer Node

Use this when a wallet, test harness, or merchant support tool already has a Fiber invoice and only needs to know whether the payer node can route it.

```bash
FIBER_INVOICE=fibt1... \
PAYER_FIBER_RPC_URL=http://127.0.0.1:8229 \
npm run fiber:route-check
```

Optional:

```bash
FIBER_INVOICE=fibt1... \
FIBER_ROUTE_TIMEOUT_SECONDS=60 \
FIBER_ROUTE_TRAMPOLINE_HOPS=<comma-separated-pubkeys> \
FIBER_ROUTE_MAX_FEE_AMOUNT=100000 \
PAYER_FIBER_RPC_URL=http://127.0.0.1:8229 \
npm run fiber:route-check
```

The command returns `payable: true` with dry-run route details or `payable: false` with the normalized `failure` object and payer node diagnostics.

## Notes

The RPC response shape is isolated in `apps/resolver/src/invoice-adapter.js`. If the Fiber node returns a different invoice field name, update `extractInvoice()` there instead of changing the protocol or SDK packages.
