# Fiber Offers CLI Guide

This guide documents the public `@fiber-offers/cli` package and the installed
`fiber-offers` command.

## Install

```bash
npm install --global @fiber-offers/cli
fiber-offers --help
```

The CLI requires Node.js 20.12 or newer. It produces JSON on standard output so
commands can be inspected by humans or piped into scripts.

You can also run a pinned version without a global install:

```bash
npx @fiber-offers/cli@0.1.0 --help
```

## What the CLI controls

The CLI is an independent merchant tool. It connects to:

1. the merchant's private Fiber node RPC;
2. the merchant's Fiber Offers resolver;
3. local protected lifecycle-key storage.

The CLI does not run a Fiber node or resolver by itself. A merchant using the
complete open-source deployment runs the resolver from this repository and
connects it to the same Fiber node that the CLI checks.

## Self-hosted merchant quick start

Clone the repository on the resolver host because Docker Compose, PostgreSQL,
Redis, the worker, and the dashboard are deployment applications rather than npm
libraries. Then generate the deployment configuration:

```bash
fiber-offers init \
  --resolver-url https://offers.merchant.example \
  --fiber-rpc-url http://127.0.0.1:8227
```

From the repository directory:

```bash
docker compose up -d --build
fiber-offers doctor
```

Create the first offer:

```bash
fiber-offers create \
  --description "Merchant checkout" \
  --amount 100000000 \
  --username merchant
```

One CKB is `100000000` shannons. CLI amount flags always use integer asset base
units, not decimal CKB.

## Configuration

Configuration precedence is:

1. command-line option;
2. value loaded from `--env-file` (default `.env`);
3. built-in local default.

| CLI option | Environment variable | Default |
| --- | --- | --- |
| `--resolver-url` | `RESOLVER_PUBLIC_URL` | `http://127.0.0.1:8787` |
| `--fiber-rpc-url` | `FIBER_HOST_RPC_URL` | `http://127.0.0.1:8227` or `FIBER_RPC_HOST`/`FIBER_RPC_PORT` |
| `--api-key` | `RESOLVER_API_KEY` | none |
| `--env-file` | n/a | `.env` |
| `--keys-dir` | n/a | `.fiber-offers/keys` |

Prefer environment files over `--api-key` because command-line arguments may be
visible in process listings and shell history.

## `init`

```bash
fiber-offers init \
  --resolver-url https://offers.merchant.example \
  --fiber-rpc-url http://127.0.0.1:8227
```

`init` creates:

- `.env` with a random PostgreSQL password, resolver API key, and encryption key;
- Fiber RPC and public resolver configuration;
- `.fiber-offers/keys/` for lifecycle records;
- `.fiber-offers/.gitignore` to prevent key commits.

The environment file is written with mode `0600`; the key directory uses
`0700`. Existing `.env` files are not overwritten unless `--force` is supplied.
Do not use `--force` casually on an active deployment: rotating database and
encryption values requires a coordinated migration.

## `doctor`

```bash
fiber-offers doctor
```

The command checks:

- resolver health;
- direct `node_info` access to the merchant Fiber node;
- the node ID reported by the resolver;
- whether the CLI and resolver are connected to the same merchant node;
- peer and channel counts.

A healthy HTTP resolver is not enough. `same_node` must be true before creating
merchant offers.

Example output shape:

```json
{
  "ok": true,
  "resolver_healthy": true,
  "fiber_node_id": "03...",
  "resolver_node_id": "03...",
  "same_node": true,
  "peers": 2,
  "channels": 3
}
```

## `create`

Fixed CKB amount:

```bash
fiber-offers create \
  --description "Coffee" \
  --amount 100000000 \
  --username coffee
```

Flexible range:

```bash
fiber-offers create \
  --description "Tip jar" \
  --amount-min 100000 \
  --amount-max 10000000000 \
  --username tips
```

Single-use offer:

```bash
fiber-offers create \
  --description "Order 1042" \
  --amount 250000000 \
  --single-use
```

Useful creation options:

| Option | Meaning |
| --- | --- |
| `--description TEXT` | Required human-readable description |
| `--amount N` | Fixed amount; sets equal min/max |
| `--amount-min N` | Minimum for a flexible offer |
| `--amount-max N` | Optional maximum for a flexible offer |
| `--asset-type TYPE` | Protocol asset type; default `ckb` |
| `--symbol SYMBOL` | Display symbol; default `CKB` |
| `--network NETWORK` | `mainnet`, `testnet`, or `dev`; default `testnet` |
| `--expiry UNIX_SECONDS` | Optional offer expiry |
| `--single-use` | Permit only one invoice resolution |
| `--username NAME` | Bind a Fiber Address username during registration |
| `--local-only` | Create and save without registering |

Version `0.1.0` CLI creation is complete for CKB. Although the parser exposes
`--asset-type` and `--symbol`, UDT and RGB++ offers require a type-script hash
that the current CLI does not accept. Create those offers through the SDK until
that CLI input is added.

The command:

1. calls `node_info` on the merchant node;
2. generates an Ed25519 lifecycle key locally;
3. creates and signs the offer;
4. saves the complete lifecycle record before network registration;
5. registers through the resolver unless `--local-only` is set;
6. prints only public identifiers and links.

The private key is never printed.

## `register`

Register a locally saved offer or recover after a failed registration:

```bash
fiber-offers register 0x<offer-id>
```

The CLI loads the original signed offer and optional username from its lifecycle
record. It does not create a new identity or signature.

If `create` saved the offer but registration failed, its error includes the
preserved key-file path and retry command. Fix the resolver URL or API key, then
run `register`.

## `list`

```bash
fiber-offers list
```

This returns the resolver's authoritative merchant inventory. Offers created by
the CLI and registered with the resolver appear in the same dashboard inventory.

## `revoke`

```bash
fiber-offers revoke 0x<offer-id> --reason "Product retired"
```

The CLI reads the saved lifecycle private key, creates a short-lived signed
revocation proof, and sends it to the resolver. Possession of the resolver API
key alone is not enough to forge this proof.

Revocation is permanent for that offer ID. Create a new signed offer to resume a
retired product.

## Use an existing hosted resolver

The CLI can use a remote resolver only when that resolver is configured for the
same merchant Fiber node and the operator gives you its API key:

```bash
export RESOLVER_PUBLIC_URL=https://offers.merchant.example
export RESOLVER_API_KEY=replace-with-the-merchant-operator-key
export FIBER_HOST_RPC_URL=http://127.0.0.1:8227

fiber-offers doctor
fiber-offers create --description "Coffee" --amount 100000000
```

The public demo resolver is not a general multi-merchant node registry. A new
independent merchant should self-host the resolver and connect its own Fiber node
until account-scoped multi-tenancy is implemented.

## Local files and backup

Default layout:

```text
.env
.fiber-offers/
  .gitignore
  keys/
    0x<offer-id>.json
```

Each key record contains the signed offer, encoded offer, lifecycle private key,
username, resolver URL, and creation time. Back up these records together with
the resolver database and deployment secrets.

Losing a lifecycle record does not lose received Fiber funds, but it removes the
merchant's ability to produce the signed revocation proof for that offer.

## Script-friendly usage

```bash
OFFER_ID=$(fiber-offers create \
  --description "Coffee" \
  --amount 100000000 \
  --username coffee | jq -r .offer_id)

fiber-offers revoke "$OFFER_ID" --reason "Demo complete"
```

Errors are JSON on standard error and use stable codes such as
`CONNECTION_FAILED`, `DOCTOR_CHECK_FAILED`, `INVALID_AMOUNT`,
`OFFER_KEY_NOT_FOUND`, and resolver-provided API codes.

## Troubleshooting

### `valid API key is required`

The CLI is reaching a protected resolver with no key or the wrong key. Load the
same `RESOLVER_API_KEY` used by that resolver. Do not create another offer; use
the preserved `register 0x<offer-id>` command after correcting configuration.

### `resolver and Fiber node are not ready`

Inspect the `doctor` JSON. Confirm the resolver is healthy, the node RPC is
reachable, and `fiber_node_id` equals `resolver_node_id`.

### `lifecycle key was not found`

Use the original `--keys-dir`, restore the `.fiber-offers/keys` backup, or run
the command from the directory containing the original key store.

### Offer exists locally but not in the dashboard

Run `register 0x<offer-id>`, then `list`. The dashboard shows registered resolver
inventory, not unregistered local key records.

## Security checklist

- Never commit `.env` or `.fiber-offers/keys`.
- Do not paste lifecycle private keys into the dashboard or resolver.
- Prefer an environment file to `--api-key`.
- Keep Fiber RPC on loopback, a private network, or behind strong authentication.
- Back up database state, resolver secrets, and lifecycle keys together.
- Run `doctor` after changing node, resolver, proxy, or deployment configuration.
- Review amount base units before signing an offer.

## Related documentation

- [Independent merchant setup](independent-merchant.md)
- [Deployment guide](deployment.md)
- [SDK guide](sdk.md)
- [Protocol guide](protocol.md)
- [Resolver API quick reference](api-quick-reference.md)
