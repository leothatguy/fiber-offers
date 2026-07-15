# Independent Merchant Setup

Each Fiber Offers merchant owns four things:

1. A Fiber Network Node that can receive payments.
2. A resolver deployment connected to that node.
3. Resolver infrastructure secrets kept on the server.
4. Per-offer lifecycle keys kept by the merchant for signed revocation.

No shared platform key, Loavix account, or payer private key is required.

## 1. Prepare The Merchant Node

Run an FNN with RPC available on host loopback. The Docker defaults expect:

```text
http://127.0.0.1:8227
```

Verify it before starting the resolver:

```bash
curl -sS -X POST http://127.0.0.1:8227 \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"node_info","params":[]}'
```

The resolver never receives the node's private key. It calls the node's private
RPC to mint standard Fiber invoices.

## 2. Initialize The Resolver

Use the final HTTPS resolver URL here. It becomes part of every signed offer.

```bash
npm install
npm run cli -- init \
  --resolver-url https://offers.merchant.example \
  --fiber-rpc-url http://127.0.0.1:8227
```

This creates:

- `.env`, mode `0600`, containing random API, encryption, and PostgreSQL secrets;
- `.fiber-offers/keys`, mode `0700`, for per-offer lifecycle keys;
- `.fiber-offers/.gitignore`, preventing lifecycle keys from being committed.

Run `init` before the first `docker compose up`. PostgreSQL only applies
`POSTGRES_PASSWORD` when initializing a new volume. On an existing volume,
change the database role password explicitly before changing the connection URL.

Never casually replace `RESOLVER_SECRET_ENCRYPTION_KEY`: existing encrypted
webhook secrets require the same key or a deliberate decrypt-and-reencrypt
rotation.

## 3. Start And Verify

```bash
docker compose up -d --build
npm run cli -- doctor
```

Open the resolver URL and enter `RESOLVER_API_KEY` in the operator unlock dialog
to use the merchant dashboard. The server exchanges it for a signed `HttpOnly`
session cookie; the dashboard does not persist the raw key. Customer payment
links under `/pay/:offer_id` remain public and do not require this session.

`doctor` fails unless:

- the resolver is healthy;
- the host-reachable FNN responds to `node_info`;
- the resolver and CLI see the same FNN public key.

The Docker relay uses a private shared Unix socket, so an FNN bound to
`127.0.0.1:8227` remains inaccessible from the public network.

## 4. Create An Offer

Fixed amount:

```bash
npm run cli -- create \
  --description "Merchant checkout" \
  --amount 100000000 \
  --username merchant
```

Open or ranged amount:

```bash
npm run cli -- create \
  --description "Merchant tip jar" \
  --amount-min 100000 \
  --amount-max 10000000000
```

The CLI:

1. Calls the merchant FNN's `node_info`.
2. Generates an Ed25519 lifecycle key locally.
3. Signs and encodes the offer.
4. Saves the private lifecycle key before network registration.
5. Registers the offer with the resolver using `RESOLVER_API_KEY`.
6. Prints the public offer ID, payment link, and optional Fiber Address.

The private key is never printed. If registration fails, retry without creating a
new key:

```bash
npm run cli -- register 0x<offer-id>
```

## 5. Operate And Revoke

```bash
npm run cli -- list
npm run cli -- revoke 0x<offer-id> --reason "Retired checkout"
```

Revocation is signed locally with the saved lifecycle key. The resolver verifies
that proof, so a public API caller cannot revoke an offer without the key.

Back up all three of these together:

- the PostgreSQL volume or managed database;
- `.env` or the equivalent secret-manager entries;
- `.fiber-offers/keys`.

## SDK Consumers

A project can install the SDK and its protocol dependency from npm:

```bash
npm install @fiber-offers/sdk
```

A payer application needs only the public resolver URL:

```js
import { FiberOffersClient } from "@fiber-offers/sdk";

const offers = new FiberOffersClient({
  resolverUrl: "https://offers.merchant.example"
});

const { offer, invoice } = await offers.resolveAndRequestInvoice(offerId, {
  amount: "100000000",
  asset: { asset_type: "ckb", symbol: "CKB" }
});
```

Merchant backend operations add the server-side API key:

```js
const merchant = new FiberOffersClient({
  resolverUrl: process.env.RESOLVER_PUBLIC_URL,
  apiKey: process.env.RESOLVER_API_KEY
});
```

Do not put `RESOLVER_API_KEY`, the encryption key, PostgreSQL credentials, an
offer lifecycle private key, or FNN RPC credentials in browser or mobile bundles.

## Payer-Owned Recurrence

Automatic recurring payments run beside the payer node, not inside the merchant
resolver. A Node wallet service can use the durable reference worker:

```bash
RESOLVER_URL=https://offers.merchant.example \
PAYER_FIBER_RPC_URL=http://127.0.0.1:8229 \
FIBER_RECURRING_OFFER=0x<offer-id> \
npm run example:recurrence
```

The approval file defaults to `.fiber-offers/payer-approvals.json` with mode
`0600`. Browser wallets use `WebStorageRecurringApprovalStore` instead.
