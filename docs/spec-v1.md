# Fiber Offers V1

## Goal

Create a reusable payment intent for Fiber that can be shared as a link, address, or encoded payload, then resolved into a fresh invoice for each payment attempt.

## Offer Encoding

An encoded offer uses:

```text
bech32m(hrp = "fbroffer", data = canonical-json-offer)
```

Encoded offers therefore begin with `fbroffer1` and include a bech32m checksum.

- An encoder writes lowercase. A decoder accepts all-lowercase or all-uppercase and refuses mixed case, as in BIP-173. The uppercase form is what an offer QR code carries, because uppercase letters and digits use the QR alphanumeric mode (a typical offer drops from QR version 27 to 22).
- The data is the offer's canonical JSON, byte for byte. A decoder refuses a body that is valid JSON but not canonical (whitespace, reordered or repeated members), so an offer has exactly one encoding and `encode(decode(x))` returns `x`.
- A string whose checksum does not match fails with `INVALID_OFFER_CHECKSUM`. Any other malformed string fails with `INVALID_OFFER_ENCODING` and a `reason` (`prefix`, `mixed_case`, `character`, `length`, `padding`, `json`, `not_canonical`). There is no fallback to another format: the base64url form used before the first release is not read.
- An encoded offer is at most 6,569 characters (4,096 bytes of canonical JSON).

### Canonical JSON

The bytes that are hashed and signed are the value's canonical JSON, following RFC 8785 (JCS):

- object members ordered by key, comparing UTF-16 code units (`"10"` sorts before `"2"`, and both before `"a"`);
- no whitespace;
- strings and numbers written as ECMAScript's `JSON.stringify` writes them;
- absent optional fields are left out, never written as `null`.

Implementations must build this text directly from sorted members. Building a sorted object and serializing that is wrong in JavaScript, where an object lists number-like keys first in numeric order and a member named `__proto__` is silently lost.

### Canonical form of an offer

An offer has one spelling. A verifier refuses a validly signed offer whose fields are not already in this form (`NON_CANONICAL_OFFER`), so the same terms cannot appear under two offer IDs:

| Field | Canonical form |
| --- | --- |
| `node_id` | 66 lowercase hex characters |
| `public_key` | The PEM of an Ed25519 SubjectPublicKeyInfo, base64 on one line, `\n` line ends, no trailing newline. Any other key type is refused (`INVALID_KEY_TYPE`) |
| `resolver_url` | `scheme "://" host [":" port] *("/" segment)`: scheme `https` (or `http`, see below); host a lowercase DNS name (IDNs in punycode), a dotted-quad IPv4 address, or a bracketed, compressed, lowercase IPv6 address; port without leading zeros and never the scheme's default; each segment one or more of `A-Z a-z 0-9 . _ ~ -`, never `.` or `..`. No trailing slash, credentials, query, fragment or percent-encoding. `http` only on the `dev` network or for a loopback address (`INSECURE_RESOLVER_URL` otherwise) |
| `amount_min`, `amount_max`, recurrence amounts | Decimal strings, at least `1`, no leading zeros |
| `expiry`, `cap_cycles`, `custom_seconds` | JSON integers |
| `assets[].asset_type` / `symbol` | Lowercase type; symbol of 1–16 characters from `A-Z 0-9 . _ -`. A `ckb` asset is exactly `{ "asset_type": "ckb", "symbol": "CKB" }`. No asset is listed twice (a token is identified by its `type_script_hash`) |
| `description` | Trimmed, at most 512 bytes |
| `signature` | Exactly `{ "scheme": "ed25519", "value": <86 base64url characters> }`, no padding, no other members |

Cross-field rules: `amount_min` ≤ `amount_max`; `recurrence.amount` lies within them; an offer is not both `single_use` and recurring; `spending_cap_total` covers at least one cycle; `custom_seconds` appears only with the `custom_seconds` interval. An offer cannot be created with an `expiry` already in the past.

Conformance vectors for all of the above, and a second implementation that checks them, are in [`test-vectors/`](test-vectors/README.md).

Unknown top-level fields are refused (`UNKNOWN_OFFER_FIELD`): a signed field a wallet does not understand could change what it is agreeing to. Additions a reader may safely ignore go in `extensions` or in fields named `x_…`, which are signed like everything else. `metadata` and extension fields are plain JSON with whole numbers only (write decimals as strings), at most 8 levels deep, without the keys `__proto__`, `constructor` or `prototype`, and at most 2,048 bytes each.

## Signed Offer Fields

```json
{
  "scheme": "fiberoffer-v1",
  "version": 1,
  "network": "testnet",
  "node_id": "02...",
  "public_key": "-----BEGIN PUBLIC KEY-----...",
  "resolver_url": "https://offers.merchant.example",
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
- `extensions` and `x_*` fields are included in the canonical ID and signature. Any other unknown field makes the offer invalid.

## Identity And Ownership

The Ed25519 `public_key` is the portable offer lifecycle key. It signs the offer and signed revocation proofs. It is not presented as the Fiber node key.

In live mode, the resolver calls Fiber `node_info` and requires the returned compressed public key to equal `offer.node_id` before registration and again before invoice minting. Each reference resolver maps to one server-controlled merchant Fiber RPC profile. Arbitrary RPC URLs are never accepted from offers or invoice requests.

The signed `network` decides the currency code of every invoice minted for the offer, for every asset:

| `network` | Fiber invoice currency |
| --- | --- |
| `mainnet` | `Fibb` |
| `testnet` | `Fibt` |
| `dev` | `Fibd` |

A token invoice uses the same currency code and names the token in the node's `udt_type_script` parameter. An offer carries only the token's `type_script_hash` (the CKB script hash: BLAKE2b-256 with the `ckb-default-hash` personalization over the molecule-encoded script), so the resolver maps that hash to a full script it has verified by recomputing the hash. A token it has no script for is refused with `422 ASSET_SCRIPT_NOT_CONFIGURED`, at registration and at invoice time.

The resolver also checks `network` against its node at registration and before each invoice. It learns the node's network from `node_info.chain_hash` (the CKB mainnet or testnet genesis hash) or from an explicit `FIBER_NETWORK` setting. An offer signed for a different network is refused with `422 OFFER_NETWORK_MISMATCH`. A node on any other chain reports no known network; set `FIBER_NETWORK=dev` there to enforce the check.

### What the payer must verify

A resolver is an untrusted intermediary. It can return any offer and any invoice string, so a payer must check both itself:

1. The offer is validly signed and its `offer_id` is the hash of its contents. An offer fetched by ID must have that ID.
2. The resolver contacted is the `resolver_url` signed into the offer.
3. The invoice, as read by the payer's own node, pays `offer.node_id`, for the requested amount, in the currency of `offer.network`, in the requested asset (no token script for CKB; for a token, a type script whose hash is the offer's `type_script_hash`), and has not expired.

4. The invoice names this offer. The resolver sets the invoice description to the offer's description followed by a commitment, and the node signs it as part of the invoice:

   ```text
   <description> (fiberoffer:<offer_id>:<resolution_id>)
   ```

   The commitment is the last thing in the description; text earlier in it does not count. The payer checks that `offer_id` is the offer it holds and that `resolution_id` is the resolution the resolver reported. Without this, a resolver could hand over a genuine invoice from the right node and for the right amount that belongs to a different order.

A payer that skips steps 3 and 4 can be made to pay anyone, or to pay for someone else's order. The reference SDK refuses to send a payment for an invoice it could not verify.

### Proof of payment

Proof that an offer was paid is the node-signed invoice, whose description names the offer and resolution, together with the payment preimage for its payment hash. Both are verifiable by anyone without trusting the resolver. `GET /offers/:offer_id/resolutions/:resolution_id/receipt.json` is the resolver's own record of the same payment. It is convenient for bookkeeping and is not signed, so on its own it proves only what the resolver asserts.

## Single-Use Offers

An offer with `single_use: true` can be paid once.

- **Payment uses it up.** Once a resolution reaches `invoice_paid`, every later invoice request is refused with `409 OFFER_ALREADY_USED`.
- **An unpaid invoice only holds it.** While an invoice is outstanding, other requests are refused with `409 OFFER_INVOICE_OUTSTANDING`; `error.details.outstanding_until` says when it lapses. Only one invoice can be outstanding, so two payers can never both be issued one.
- **An invoice that ends unpaid releases it.** After `invoice_expired`, `invoice_cancelled` or `invoice_failed`, the next request is issued a new invoice. Requesting an invoice and not paying therefore costs the merchant nothing lasting.

Before answering, the resolver brings the offer's open invoices up to date. For a live invoice it asks the node, which decides whether the invoice was paid, expired or is still open; the resolver's own clock is never enough to release an invoice the node could still accept. `POST /offers/:offer_id/check` applies the same rules, so it never disagrees with the invoice endpoint.

Recurring offers follow the same rule per cycle: a cycle is used up when its invoice is paid, and released if the invoice ends unpaid.

## Revocation

`DELETE /offers/:offer_id` accepts a `fiberoffer-revocation-v1` proof containing the offer ID, node ID, timestamp, optional reason, and Ed25519 signature from the offer lifecycle key. Revoked offers return `410 OFFER_REVOKED` and cannot create more invoices.

## Recurrence

A recurring offer can have any number of subscribers. Cycles and caps are counted per subscription, so `cap_cycles` and `spending_cap_total` limit what each subscriber pays.

A subscription is an Ed25519 key the payer generates. Its identifier is derived from the public key:

```text
approval_id = "sub_" + first 40 hex characters of sha256(DER SubjectPublicKeyInfo)
```

Every invoice request on a recurring offer is a cycle of one subscription and carries its proof:

```json
{
  "amount": "500000000",
  "asset": { "asset_type": "ckb", "symbol": "CKB" },
  "recurrence_cycle": 1,
  "scheduled_for": "2026-01-01T00:00:00.000Z",
  "approval_id": "sub_…",
  "subscriber_public_key": "-----BEGIN PUBLIC KEY-----…",
  "subscriber_signature": "base64url(Ed25519 signature)"
}
```

The signature is over the canonical JSON of `{ scheme: "fiberoffer-recurrence-v1", offer_id, approval_id, recurrence_cycle, amount, asset, scheduled_for }`, with `scheduled_for` omitted when absent. The resolver refuses a request with no proof (`400 SUBSCRIPTION_PROOF_REQUIRED`), an `approval_id` that does not belong to the key (`403 SUBSCRIPTION_KEY_MISMATCH`), or a bad signature (`403 INVALID_SUBSCRIPTION_SIGNATURE`). Nobody but the payer can therefore request, advance or exhaust a subscription's cycles.

Within a subscription:

- The cycle to request is the number of paid cycles plus one. Any other number is `409 INVALID_RECURRENCE_CYCLE`, with `error.details.next_cycle`.
- A cycle is used up when its invoice is paid. An invoice that ends unpaid releases the cycle, which can then be requested again.
- Only one cycle can be outstanding. A second request while an invoice is unpaid is `409 RECURRENCE_CYCLE_OUTSTANDING`.
- When the caps are spent, further requests are `409 RECURRENCE_CYCLE_CAP_REACHED` or `409 RECURRENCE_SPENDING_CAP_REACHED`.

`GET /offers/:offer_id/recurrence-status?approval_id=sub_…` reports where a subscription stands (`cycles_paid`, `next_cycle`, `outstanding`, remaining caps). A subscription ID is derived from a key only its payer holds, so this needs no other credential. Without `approval_id` the route summarises the offer across subscriptions and needs the resolver's API key.

The checks that need no history (the cycle amount, and that the cycle number fits the signed caps) are made by `validateResolutionRequest()` in the protocol package, so a wallet runs them offline before it contacts the resolver. Payment history is the resolver's to track.

`FiberRecurringPaymentScheduler` runs in the payer environment, where payment authority belongs. It stores explicit approvals, triggers due cycles from its internal timer, retries failures without advancing the schedule, accounts for spending, and supports immediate revocation. A cycle counts as paid only once the payer's node reports the payment settled; the scheduler records each payment before sending it, so after a restart it asks the node what happened instead of paying again. Due dates are computed from the approval's fixed start, so a monthly plan begun on the 31st falls on the last day of shorter months. Browser wallets can use `WebStorageRecurringApprovalStore`; Node wallet services can use the private atomic `JsonFileRecurringApprovalStore` export from `@fiber-offers/sdk/node`. Each approval holds its subscription key and signs every cycle with it.

## Availability Boundary

An encoded offer remains portable and verifiable while the merchant node is
offline, but invoice creation does not. The resolver returns
`503 RECIPIENT_UNAVAILABLE` when its configured merchant FNN cannot mint a fresh
invoice. V1 does not queue an invoice request that lacks a current FNN-generated
invoice.

An invoice request that fails at the merchant node tells the payer whether a
retry can help. `error.details.retryable` is always present on these responses:

| Status | Code | `retryable` | Meaning |
| --- | --- | --- | --- |
| `503` | `RECIPIENT_UNAVAILABLE` | `true` | The node could not be reached, timed out, or its endpoint returned a server error. |
| `502` | `FIBER_INVOICE_REJECTED` | `false` | The node answered and refused this invoice request. |
| `502` | `FIBER_RPC_UNAUTHORIZED` | `false` | The resolver's credentials for its node were refused. |
| `502` | `FIBER_RPC_REJECTED` | `false` | The node endpoint refused the request with a client error. |
| `502` | `FIBER_RPC_INVALID_RESPONSE` | `false` | The node's reply did not contain a usable invoice. |

`error.details.cause_code` carries the underlying cause, such as the node's
JSON-RPC error code. The node's error message is written to the resolver log and
is not returned to the payer. A failed request leaves no resolution behind.

A stored offer that does not pass verification is not payable. An invoice
request for it fails with `409 OFFER_INVALID` (`retryable: false`), with the
verification failure in `error.details.cause_code`. This happens to offers
stored by an earlier version when the rules tighten, for example one signed
with an uppercase `node_id`. `GET /offers` and `GET /offers/:offer_id` report
such an offer with `valid: false` and `invalid_code`, so the merchant can find
it and issue a new one.

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

Operators can inspect resolver state and Fiber RPC connectivity. Both routes need the resolver's API key, because they report the node's peers and channel balances:

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

One resolution is public to whoever holds its ID: the payer who requested that invoice, and the merchant. The list of an offer's resolutions is the merchant's payment history and needs the resolver's API key, as do the reconciliation exports. An offer ID is not a secret (it is in every payment link), so it never grants access to more than the offer itself.

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

Statuses only move forward:

```text
invoice_created ─► invoice_received ─► invoice_paid
        │                  │
        └────────┬─────────┘
                 ▼
invoice_expired | invoice_failed | invoice_cancelled
```

`invoice_paid`, `invoice_expired`, `invoice_failed` and `invoice_cancelled` are final. A request to move backwards, or out of a final status, is refused with `409 INVALID_STATUS_TRANSITION`. Setting the status a resolution already has changes nothing and emits no event. Each real change is applied once, even when a manual update, a node sync and a background pass race, and emits exactly one webhook event.

An invoice whose lifetime has run out is recorded as `invoice_expired` and announced with one `invoice.expired` event. For a live invoice the resolver asks the node, which decides whether it expired or was paid at the last moment. Read views also show an unpaid invoice as `invoice_expired` from the moment its expiry passes, before that is recorded.

Every invoice has an expiry. The resolver asks the node for an invoice that lasts `FIBER_INVOICE_TTL_SECONDS` (default 900), shortened so it never outlives the offer's own `expiry`, and returns the moment it lapses as `expires_at`. The node enforces the expiry: it stops accepting payment and reports the invoice as `Expired`, which sync records as `invoice_expired`.

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
