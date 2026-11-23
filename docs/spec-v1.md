# Fiber Offers v1

**Status:** draft for review · **Format:** `fiberoffer-v1` · **Reference implementation:** `@fiber-offers/protocol`, `@fiber-offers/sdk`, and the resolver in this repository

A Fiber invoice can be paid once and expires. A Fiber Offer is a signed, reusable statement of payment terms that a payer turns into a fresh invoice each time they pay. This document specifies the offer, how it is encoded, how a payer obtains and checks an invoice for it, and what a resolver must do. It is written so that a wallet or a resolver can be built from it alone; [conformance vectors](test-vectors/README.md) and a second, independent implementation are published with it.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be read as in RFC 2119.

Operational features of the reference resolver that a wallet does not depend on (settlement sync, webhooks, reconciliation, diagnostics) are described in [Resolver API](resolver-api.md), not here.

## 1. Roles

| Role | What it holds | What it does |
| --- | --- | --- |
| **Merchant** | A Fiber node, and an Ed25519 *offer key* | Creates and signs offers; revokes them |
| **Resolver** | Access to the merchant node's invoice RPC | Serves offers over HTTPS and asks the node for an invoice per payment. One resolver serves one merchant node |
| **Payer** | A wallet with its own Fiber node | Verifies the offer, requests an invoice, verifies the invoice, pays |

The payer trusts neither the resolver nor the network between them. Everything a payer relies on is either signed by the offer key or signed by the merchant's Fiber node (section 9).

## 2. The offer

An offer is a JSON object.

```json
{
  "scheme": "fiberoffer-v1",
  "version": 1,
  "network": "testnet",
  "node_id": "02abab…ab",
  "public_key": "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA…\n-----END PUBLIC KEY-----",
  "resolver_url": "https://offers.merchant.example",
  "description": "Monthly plan",
  "assets": [{ "asset_type": "ckb", "symbol": "CKB" }],
  "amount_min": "2000",
  "amount_max": "2000",
  "recurrence": { "interval": "monthly", "amount": "2000", "cap_cycles": 12 },
  "expiry": 1900000000,
  "single_use": false,
  "metadata": { "plan": "basic" },
  "offer_id": "0x…",
  "signature": { "scheme": "ed25519", "value": "…" }
}
```

### 2.1 Fields

Each field has exactly one valid spelling, its *canonical form*. A verifier MUST refuse an offer in which any field is not in canonical form, even when its signature is valid, so that one set of terms has one offer ID.

| Field | Required | Canonical form |
| --- | --- | --- |
| `scheme` | yes | The string `fiberoffer-v1` |
| `version` | yes | The JSON integer `1` |
| `network` | yes | `mainnet`, `testnet` or `dev` |
| `node_id` | yes | The merchant node's compressed secp256k1 public key: 66 lowercase hex characters beginning `02` or `03` |
| `public_key` | yes | The offer key: the PEM of an Ed25519 SubjectPublicKeyInfo. `-----BEGIN PUBLIC KEY-----`, a line feed, the 60 base64 characters of the 44-byte DER on one line, a line feed, `-----END PUBLIC KEY-----`, and nothing after it. No other key type is valid |
| `resolver_url` | yes | See 2.2 |
| `description` | no | A non-empty string of at most 512 UTF-8 bytes with no leading or trailing white space (ECMAScript *WhiteSpace* or *LineTerminator*) |
| `assets` | yes | 1 to 16 assets, none listed twice. See 2.3 |
| `amount_min`, `amount_max` | no | Amounts (2.4). When both are present, `amount_min` ≤ `amount_max` |
| `recurrence` | no | See section 11 |
| `expiry` | no | A JSON integer of unix seconds, from 1 to 2^53 − 1. Invoice requests are refused once the current time is greater than it |
| `single_use` | yes | A JSON boolean. See section 10 |
| `metadata` | no | A JSON object of free-form content (2.5) |
| `extensions`, `x_…` | no | Extension fields (2.5) |
| `offer_id` | yes | See 4.1 |
| `signature` | yes | See 4.2 |

An optional field that does not apply MUST be absent. It MUST NOT be `null` or an empty string.

A verifier MUST refuse an offer that contains any other top-level field. A signed field that a wallet does not understand could change what the wallet is agreeing to.

### 2.2 `resolver_url`

```text
resolver_url = scheme "://" host [ ":" port ] *( "/" segment )
scheme       = "https" / "http"
host         = dns-name / ipv4 / "[" ipv6 "]"
segment      = 1*( ALPHA / DIGIT / "-" / "." / "_" / "~" )
```

- `dns-name` is lowercase labels of letters, digits and hyphens, joined by dots; an internationalized name is written in its `xn--` form. `ipv4` is a dotted quad. `ipv6` is the lowercase, compressed form of RFC 5952. A host whose last label is a number is an `ipv4`.
- `port` has no leading zero and is never the scheme's default (443, 80).
- A segment is never `.` or `..`. There is no trailing slash, user information, query, fragment or percent-encoding.
- The whole string is at most 512 characters.
- `http` is valid only when `network` is `dev`, or the host is a loopback address (`localhost`, a name ending `.localhost`, `127.0.0.0/8`, `[::1]`). Otherwise the scheme MUST be `https`.

### 2.3 Assets

An asset is an object:

| `asset_type` | Other members | Meaning |
| --- | --- | --- |
| `ckb` | `symbol`, which MUST be `CKB` | CKB itself. No `type_script_hash` |
| `udt` | `symbol`, `type_script_hash` | A User Defined Token on CKB |
| `rgbpp` | `symbol`, `type_script_hash` | An RGB++ asset on CKB |

- `symbol` is a display label of 1 to 16 characters from `A-Z`, `0-9`, `.`, `_`, `-`, beginning with a letter or digit. It does not identify a token.
- `type_script_hash` identifies the token. It is `0x` followed by 64 lowercase hex characters: the CKB script hash of the token's type script, that is, BLAKE2b with a 32-byte digest and the personalization `ckb-default-hash`, over the Molecule encoding of the `Script` (`code_hash`, `hash_type`, `args`).
- Two assets are the same asset when they have the same `asset_type` and `type_script_hash`.
- An asset object has no other members.

### 2.4 Amounts

An amount is a decimal string matching `[1-9][0-9]*`: at least 1, no sign, no leading zero, no fraction. It is never a JSON number.

Amounts count the smallest unit of the asset: shannons for CKB (1 CKB = 10^8 shannons), and the token's own base unit for `udt` and `rgbpp`. How many decimals a wallet displays is outside this format.

With neither bound, a payer may pay any amount. With `amount_min` equal to `amount_max`, the offer has a fixed price.

### 2.5 Free-form content and extensions

`metadata`, `extensions` and any field whose name begins `x_` carry content this format does not define. They are part of the signed offer.

- A reader MAY ignore them. Nothing in them changes the meaning of the fields above. This is the only place for additions a reader may ignore.
- `metadata` and `extensions` are JSON objects. A field named `x_…` may hold any JSON value except `null`.
- Numbers in them MUST be integers with absolute value at most 2^53 − 1. Write a decimal as a string.
- They nest at most 8 levels deep.
- The keys `__proto__`, `constructor` and `prototype` MUST NOT appear anywhere in an offer.
- The canonical JSON of `metadata` is at most 2,048 bytes, and so is that of all extension fields taken together as one object.

Offers are public. `metadata` MUST NOT hold secrets or personal data.

### 2.6 Size

The canonical JSON of a signed offer is at most 4,096 bytes.

### 2.7 Versions

A reader of this document MUST refuse an offer whose `scheme` is not `fiberoffer-v1` or whose `version` is not `1`. A later revision that only adds content a reader may ignore will define it inside `extensions`. A revision that changes or adds meaning will use a new `scheme` and `version`.

## 3. Canonical JSON

Hashes and signatures are computed over the *canonical JSON* of a value, encoded as UTF-8. Canonical JSON follows RFC 8785 (JCS):

1. Object members are written in order of their keys, compared as sequences of UTF-16 code units. `"10"` therefore comes before `"2"`, and both before `"a"`.
2. There is no white space between tokens.
3. Strings are written as ECMAScript `JSON.stringify` writes them: `"` and `\` escaped with a backslash; `\b`, `\t`, `\n`, `\f`, `\r` for those control characters; `\u00xx` in lowercase hex for other characters below U+0020; every other character as itself. A string MUST be well-formed Unicode.
4. Integers are written in decimal with no leading zero and no exponent. (Signed content contains no other numbers; see 2.5.)
5. `true`, `false` and `null` are written as such.

An implementation MUST produce this text directly from the sorted members of each object. Sorting keys into a new object and serializing that object is incorrect in languages, JavaScript among them, whose objects reorder number-like keys or treat a key named `__proto__` specially.

## 4. Identifier and signature

### 4.1 `offer_id`

Let *content* be the offer without its `offer_id` and `signature` members.

```text
offer_id = "0x" + lowercase-hex( SHA-256( UTF-8( canonical-json( content ) ) ) )
```

### 4.2 `signature`

Let *signed* be the offer without its `signature` member (so it includes `offer_id`).

```text
signature = { "scheme": "ed25519", "value": base64url( Ed25519-sign( offer key, UTF-8( canonical-json( signed ) ) ) ) }
```

- The signature is pure Ed25519 (RFC 8032), 64 bytes.
- `value` is base64url (RFC 4648 section 5) without padding: exactly 86 characters, the last of which has its two unused bits set to zero.
- The object has exactly the members `scheme` and `value`.

### 4.3 Verifying an offer

To verify an offer a reader MUST, in any order that refuses the same offers:

1. Check every rule of section 2, including canonical form and the absence of unknown fields.
2. Recompute `offer_id` and compare.
3. Check that `public_key` is an Ed25519 key and verify `signature` with it.

An offer that fails any step MUST NOT be paid.

### 4.4 Producing an offer

A producer MAY accept loosely written input (an uppercase node ID, a number for an amount, a resolver URL with a trailing slash, any PEM spelling of the key) and MUST bring every field to canonical form before computing `offer_id`. A producer MUST NOT create an offer whose `expiry` is not in the future.

## 5. Encoded form

An offer is passed around as one string:

```text
encoded = bech32m( hrp = "fbroffer", data = UTF-8( canonical-json( offer ) ) )
```

Bech32m is as in BIP-350, with the data bytes regrouped into 5-bit values and padded with zero bits. The string begins `fbroffer1`. There is no length limit of 90 characters as there is for addresses; a decoder MUST refuse a string longer than 6,569 characters (the size limit of 2.6).

A decoder:

- MUST accept a string that is entirely lowercase or entirely uppercase, and MUST refuse one in mixed case.
- MUST refuse a string whose checksum does not match, and MUST NOT try to read it as any other format.
- MUST refuse padding that is not zero, or of 5 bits or more.
- MUST refuse a body that is not exactly the canonical JSON of the offer it parses to (white space, reordered or repeated members). An offer therefore has exactly one encoding, and encoding a decoded offer returns the original string in lowercase.

An encoder MUST write lowercase.

### 5.1 QR codes and links

A QR code that carries an encoded offer SHOULD carry the uppercase form, which a QR code stores in alphanumeric mode (a typical offer needs QR version 22 instead of 27).

A resolver serves a payment page for each offer at `{resolver_url}/pay/{offer_id}`. That URL is the *payment link*, and is what a merchant normally prints as a QR code. A wallet given a payment link takes `offer_id` from the last path segment and the resolver's address from what precedes `/pay/`, fetches the offer (7.1), and MUST then apply the checks of section 9, including that the offer's own `resolver_url` is the address it contacted.

## 6. Fiber Address

A Fiber Address is a name of the form `user@domain` that leads to an offer.

- `user` is 1 to 64 characters from `a-z`, `0-9`, `.`, `_`, `-`, beginning with a letter or digit. Addresses are compared in lowercase.
- A wallet resolves `user@domain` with `GET https://domain/.well-known/fiberoffer/user`. It MUST use `https`, except for a loopback domain.
- The response is the offer response of 7.1 with two more members, `username` and `address`. The wallet MUST check that `username` is the name it asked for, and MUST verify the offer (4.3).
- The offer's `resolver_url` need not be on `domain`. Invoices are requested from the offer's `resolver_url`.

The link between an address and an offer rests on TLS for `domain` and on whoever controls that path. It is not signed. A wallet SHOULD show the payer the offer's description and node before the first payment to a new address, and SHOULD NOT treat an address as proof of who is being paid. A wallet MAY keep an offer it has verified, by ID, for as long as it likes; it SHOULD resolve the address again for each new payment, since the address may be pointed at another offer.

## 7. Resolver API

This is the HTTP interface every wallet needs from every resolver. All paths are relative to the offer's `resolver_url`. A resolver MAY offer more.

General rules:

- Bodies are JSON, sent and returned as `application/json; charset=utf-8`.
- A resolver MUST allow cross-origin requests to these routes (`Access-Control-Allow-Origin: *`, and the `Idempotency-Key` and `Content-Type` request headers), and MUST NOT require cookies or other credentials for them.
- An error is reported with a 4xx or 5xx status and this body:

  ```json
  { "error": { "code": "AMOUNT_TOO_LOW", "message": "requested amount is below offer minimum", "details": {} } }
  ```

  `code` is one of section 13. `details.retryable`, when present, says whether sending the same request again can succeed.
- A resolver that limits request rates answers `429` with code `RATE_LIMITED`, a `Retry-After` header and the same number in `details.retry_after_seconds`.

### 7.1 Fetch an offer

`GET /offers/{offer_id}` returns `200` with at least:

```json
{ "offer_id": "0x…", "offer": { }, "encoded_offer": "fbroffer1…" }
```

The wallet MUST verify the offer and MUST check that its `offer_id` is the one requested. An unknown ID is `404 OFFER_NOT_FOUND`.

### 7.2 Request an invoice

`POST /offers/{offer_id}/invoice` with:

| Member | Required | Meaning |
| --- | --- | --- |
| `amount` | yes | The amount to pay (2.4) |
| `asset` | no | One of the offer's assets. Defaults to the first |
| `idempotency_key` | no | See below. May instead be sent as the `Idempotency-Key` header |
| subscription members | on a recurring offer | Section 11 |

A resolver MUST refuse a request the offer does not allow: an asset it does not list (`UNSUPPORTED_ASSET`), an amount outside its bounds (`AMOUNT_TOO_LOW`, `AMOUNT_TOO_HIGH`, `AMOUNT_MUST_MATCH_FIXED_AMOUNT`), an expired offer (`OFFER_EXPIRED`), a revoked offer (`410 OFFER_REVOKED`), an offer that fails verification (`409 OFFER_INVALID`), or a use the offer's history rules out (sections 10 and 11).

On success the resolver answers `201` with at least:

```json
{
  "offer_id": "0x…",
  "resolution_id": "res_…",
  "status": "invoice_created",
  "amount": "2000",
  "asset": { "asset_type": "ckb", "symbol": "CKB" },
  "invoice": "fibt1…",
  "payment_hash": "0x…",
  "expires_at": "2027-01-15T08:15:00.000Z"
}
```

`resolution_id` identifies this payment attempt. It matches `res_[a-z0-9-]+` and MUST be unguessable (at least 122 bits of randomness), because it is the only thing protecting the reads of 7.3.

**The invoice.** The resolver MUST obtain the invoice from the merchant node named by `node_id`, and the invoice MUST:

- be for exactly `amount`, in the currency of the offer's `network`: `Fibb` for `mainnet`, `Fibt` for `testnet`, `Fibd` for `dev`;
- for `ckb`, carry no UDT type script; for a token, carry the type script whose hash is the asset's `type_script_hash`;
- have an expiry, no later than the offer's own `expiry`;
- have a description that ends with the commitment `(fiberoffer:{offer_id}:{resolution_id})`. The reference resolver writes the offer's description, a space, and the commitment, cutting the description so the whole fits the node's 639-byte limit.

A resolver MUST check that its node's public key is the offer's `node_id`, and that the node is on the offer's `network`, before it registers an offer and before it issues an invoice for one.

**Idempotency.** A key is 1 to 128 characters from `A-Z a-z 0-9 . _ : -`, beginning with a letter or digit. A request repeated with the same key and the same terms returns the original response with `200` and `"idempotent_replay": true`; no second invoice is created. The same key with different terms is `409 IDEMPOTENCY_KEY_REUSED`. A wallet SHOULD send a key with every invoice request and reuse it when retrying after a lost response.

**Failures at the node.** When the merchant node cannot be reached, the resolver answers `503 RECIPIENT_UNAVAILABLE` with `retryable: true`. When the node refuses, it answers `502` with `retryable: false` and one of `FIBER_INVOICE_REJECTED`, `FIBER_RPC_UNAUTHORIZED`, `FIBER_RPC_REJECTED`, `FIBER_RPC_INVALID_RESPONSE`. A failed request leaves no resolution behind. A resolver does not queue requests for a node that is offline.

### 7.3 Read a resolution

`GET /offers/{offer_id}/resolutions/{resolution_id}` returns the resolution: at least `id`, `offer_id`, `status` (section 10), `amount`, `asset`, `payment_hash` and `invoice` (an object holding the invoice string and `expires_at`).

Anyone holding the `resolution_id` can read it. A resolver MUST NOT offer anonymous callers a way to list an offer's resolutions, since the offer ID is public.

### 7.4 Revoke an offer

`DELETE /offers/{offer_id}` with a revocation (section 12) in the body, as `{ "revocation": { … } }`. It needs no other credential: the revocation is signed by the offer key.

### 7.5 Subscription status

`GET /offers/{offer_id}/recurrence-status?approval_id={subscription_id}`. See section 11.

## 8. Readiness

A resolver MAY offer `POST /offers/{offer_id}/check`, which takes the same body as an invoice request and reports, without creating an invoice, whether one would be issued. It MUST apply the same rules as 7.2. Its response is described in [Resolver API](resolver-api.md).

## 9. What a payer verifies

A resolver can return any offer and any invoice string. Before paying, a payer MUST establish all of the following. The reference SDK refuses to pay when any of them cannot be established.

1. **The offer.** It verifies (4.3). If it was fetched by ID, it has that ID.
2. **The resolver.** The address the invoice was requested from is the offer's `resolver_url`.
3. **The invoice, as the payer's own node parses it** (`parse_invoice`), not as the resolver describes it:
   - its payee public key is the offer's `node_id`;
   - its amount is the amount requested;
   - its currency is that of the offer's `network`;
   - for `ckb` it has no UDT type script; for a token, its type script hashes to the asset's `type_script_hash`;
   - it has not expired;
   - its payment hash is the `payment_hash` the resolver reported.
4. **The binding.** The invoice description ends with `(fiberoffer:{offer_id}:{resolution_id})`, naming the offer the payer holds and the resolution the resolver reported. Only the end of the description counts; the same text earlier in it does not.

Without step 3 a resolver can make a payer pay anyone. Without step 4 it can hand over a genuine invoice from the right node, for the right amount, that belongs to another order.

After sending, a payer SHOULD treat the payment as made only when its own node reports it settled, not when the node accepts it for sending.

### 9.1 Proof of payment

Proof that an offer was paid is the invoice, which the merchant node signed and whose description names the offer and resolution, together with the payment preimage for its payment hash. Anyone can check both without trusting the resolver. A resolver's own record of a payment, such as a receipt, is not signed and proves only what the resolver says.

## 10. Resolutions and single-use offers

Each successful invoice request creates a *resolution*, whose status is one of:

```text
invoice_created ──► invoice_received ──► invoice_paid
       │                   │
       └─────────┬─────────┘
                 ▼
 invoice_expired │ invoice_failed │ invoice_cancelled
```

| Status | Meaning | Effect on a limited offer |
| --- | --- | --- |
| `invoice_created` | The invoice is open | Holds |
| `invoice_received` | The node holds a payment that has not settled | Holds |
| `invoice_paid` | Settled | Uses it up |
| `invoice_expired`, `invoice_failed`, `invoice_cancelled` | Ended unpaid | Releases it |

- A status only moves along the arrows. The last four are final.
- The merchant node is the authority on an invoice. A resolver MUST ask the node before treating a live invoice as expired; its own clock is not enough to release an invoice the node might still accept.
- Each change is applied once, however many processes observe it.

**Single-use offers.** An offer with `single_use: true` can be paid once.

- Once a resolution is `invoice_paid`, every later invoice request is refused with `409 OFFER_ALREADY_USED`.
- While a resolution holds the offer, other requests are refused with `409 OFFER_INVOICE_OUTSTANDING`; `details.outstanding_until` says when the invoice lapses. Two payers are never both issued an invoice.
- When that resolution ends unpaid, the next request is issued a new invoice. Requesting an invoice and not paying costs the merchant nothing lasting.

## 11. Recurring offers

A `recurrence` object lets a payer authorise repeated payments within signed limits.

| Member | Required | Canonical form |
| --- | --- | --- |
| `interval` | yes | `daily`, `weekly`, `monthly` or `custom_seconds` |
| `amount` | yes | The amount of every cycle (2.4). It MUST lie within `amount_min` and `amount_max` |
| `cap_cycles` | one of the two | A JSON integer ≥ 1: the most cycles a subscriber pays |
| `spending_cap_total` | one of the two | An amount ≥ `amount`: the most a subscriber pays in total |
| `custom_seconds` | with `custom_seconds` only | A JSON integer ≥ 1 |

At least one cap MUST be present. An offer MUST NOT be both `single_use` and recurring.

### 11.1 Subscriptions

Any number of payers can subscribe to one recurring offer. Limits are counted per subscription.

A subscription is an Ed25519 key pair the payer generates. A wallet MUST generate a new key for each subscription and MUST NOT reuse one across offers. Its identifier is:

```text
subscription_id = "sub_" + first 40 hex characters of SHA-256( DER SubjectPublicKeyInfo of the public key )
```

Every invoice request on a recurring offer is one cycle of one subscription and carries, beside `amount` and `asset`:

| Member | Meaning |
| --- | --- |
| `recurrence_cycle` | The cycle number, from 1 |
| `approval_id` | The `subscription_id` |
| `subscriber_public_key` | The subscription's public key, as PEM |
| `subscriber_signature` | base64url, as in 4.2, of an Ed25519 signature by that key |
| `scheduled_for` | Optional. When the payer's schedule called for this cycle, as an ISO 8601 timestamp |

The signature is over the UTF-8 canonical JSON of:

```json
{ "scheme": "fiberoffer-recurrence-v1", "offer_id": "…", "approval_id": "…", "recurrence_cycle": 1, "amount": "…", "asset": { }, "scheduled_for": "…" }
```

with `scheduled_for` left out when the request has none, and `amount` and `asset` in canonical form. Naming the offer means a signature cannot be replayed against another offer.

A resolver MUST refuse a cycle request with no proof (`400 SUBSCRIPTION_PROOF_REQUIRED`), an `approval_id` that is not the ID of the key presented (`403 SUBSCRIPTION_KEY_MISMATCH`), or a signature that does not verify (`403 INVALID_SUBSCRIPTION_SIGNATURE`). Nobody but the payer can then request, advance or exhaust a subscription.

### 11.2 Cycles

Within one subscription:

- `amount` MUST equal `recurrence.amount` (`RECURRENCE_AMOUNT_MISMATCH`).
- The cycle to request is the number of paid cycles plus one. Any other number is `409 INVALID_RECURRENCE_CYCLE`, with `details.next_cycle`.
- A cycle is used up when its invoice is paid and released when the invoice ends unpaid, exactly as in section 10.
- One cycle can be outstanding at a time (`409 RECURRENCE_CYCLE_OUTSTANDING`).
- Once `cap_cycles` cycles are paid, or the next cycle would take the total past `spending_cap_total`, further requests are `409 RECURRENCE_CYCLE_CAP_REACHED` or `409 RECURRENCE_SPENDING_CAP_REACHED`.

`GET /offers/{offer_id}/recurrence-status?approval_id=…` returns where a subscription stands: `cycles_paid`, `paid_total`, `next_cycle` (absent once a cap is reached), `cap_reached`, `outstanding` (the open cycle, if any), `cycle_cap_remaining` and `spending_cap_remaining`. Before answering, the resolver brings that subscription's open invoice up to date with the node. The ID is derived from a key only the payer holds, so the route needs no credential.

A wallet can check, from the signed offer alone and before contacting anyone, that a cycle has the right amount and that its number fits the caps. How many cycles a subscription has paid is the resolver's to track.

### 11.3 What the interval means

The interval tells the payer's wallet when to pay. Payment is always initiated by the payer: nothing in this format lets a merchant or resolver take a payment.

- A wallet computes due times from a fixed starting moment (the moment the payer approved the subscription), not from the previous payment, so a schedule does not drift. A `monthly` cycle falls on the same day of each month, or on the last day of a shorter month.
- A resolver does not enforce the interval. A payer who pays cycles early or late is not refused. What a paid cycle entitles the payer to is the merchant's business logic; the merchant learns of each paid cycle, with its number and `approval_id`, from its resolver.
- A cycle that fails to pay is retried by the wallet; the schedule of later cycles does not move.
- A payer cancels by not requesting further cycles. A merchant cancels every subscription by revoking the offer. v1 has no way for a merchant to end one subscription.

## 12. Revocation

A revocation is a statement by the offer key that an offer should no longer be paid:

```json
{
  "scheme": "fiberoffer-revocation-v1",
  "offer_id": "0x…",
  "node_id": "02…",
  "revoked_at": 1800000000,
  "reason": "key rotated",
  "signature": { "scheme": "ed25519", "value": "…" }
}
```

`reason` is optional. `signature` is as in 4.2, over the UTF-8 canonical JSON of the object without `signature`, made with the offer key.

A resolver accepts a revocation when `offer_id` and `node_id` are the offer's, the signature verifies, and `revoked_at` is within 300 seconds of the resolver's clock. From then on it MUST refuse invoice requests for the offer with `410 OFFER_REVOKED`. A second revocation of the same offer changes nothing and is answered `409 OFFER_REVOKED`.

Revocation reaches payers through the resolver. An offer that has already been copied cannot be recalled; what revocation stops is the issuing of invoices for it.

## 13. Error codes

A resolver reports the first matching failure. Statuses are those of the reference resolver; a resolver MUST use these codes and SHOULD use these statuses.

**The offer or the encoded string** (reported by any implementation; `400` over HTTP)

| Code | Meaning |
| --- | --- |
| `INVALID_OFFER_CHECKSUM` | The encoded string is damaged |
| `INVALID_OFFER_ENCODING` | Not an encoded offer. `details.reason`: `prefix`, `mixed_case`, `character`, `length`, `padding`, `json`, `not_canonical` |
| `NON_CANONICAL_OFFER` | A field is not in canonical form. `details.field` |
| `UNKNOWN_OFFER_FIELD`, `FORBIDDEN_KEY` | A field the format does not allow |
| `INVALID_SCHEME`, `INVALID_VERSION`, `INVALID_NETWORK`, `INVALID_NODE_ID`, `INVALID_URL`, `INSECURE_RESOLVER_URL`, `INVALID_SINGLE_USE`, `INVALID_OFFER_ID` | That field is missing or malformed |
| `INVALID_PUBLIC_KEY`, `INVALID_KEY_TYPE` | The key is unreadable, or not Ed25519 |
| `INVALID_ASSETS`, `INVALID_ASSET`, `INVALID_ASSET_TYPE`, `INVALID_ASSET_SYMBOL`, `DUPLICATE_ASSET`, `TOO_MANY_ASSETS` | The asset list |
| `INVALID_AMOUNT`, `INVALID_INTEGER`, `INVALID_AMOUNT_BOUNDS` | An amount or integer |
| `INVALID_RECURRENCE`, `INVALID_RECURRENCE_INTERVAL`, `RECURRENCE_CAP_REQUIRED`, `RECURRENCE_AMOUNT_OUT_OF_BOUNDS`, `SINGLE_USE_RECURRENCE_CONFLICT` | The recurrence terms |
| `INVALID_METADATA`, `INVALID_EXTENSIONS`, `INVALID_SIGNED_JSON` | Free-form content |
| `DESCRIPTION_TOO_LONG`, `OFFER_FIELD_TOO_LARGE`, `OFFER_TOO_LARGE` | A size limit |
| `OFFER_ID_MISMATCH`, `INVALID_SIGNATURE` | The ID or signature does not check out |
| `OFFER_EXPIRY_IN_PAST` | A producer was asked for an offer that has already expired |

**An invoice request**

| Status | Code | Meaning |
| --- | --- | --- |
| `400` | `INVALID_AMOUNT`, `INVALID_JSON`, `INVALID_IDEMPOTENCY_KEY`, `IDEMPOTENCY_KEY_MISMATCH` | The request is malformed |
| `400` | `SUBSCRIPTION_PROOF_REQUIRED`, `RECURRENCE_AMOUNT_MISMATCH`, `RECURRENCE_NOT_CONFIGURED` | Section 11 |
| `403` | `SUBSCRIPTION_KEY_MISMATCH`, `INVALID_SUBSCRIPTION_SIGNATURE` | Section 11 |
| `404` | `OFFER_NOT_FOUND`, `RESOLUTION_NOT_FOUND`, `FIBER_ADDRESS_NOT_FOUND` | No such object |
| `409` | `OFFER_ALREADY_USED`, `OFFER_INVOICE_OUTSTANDING` | Section 10 |
| `409` | `INVALID_RECURRENCE_CYCLE`, `RECURRENCE_CYCLE_OUTSTANDING`, `RECURRENCE_CYCLE_CAP_REACHED`, `RECURRENCE_SPENDING_CAP_REACHED` | Section 11 |
| `409` | `IDEMPOTENCY_KEY_REUSED`, `INVOICE_REQUEST_IN_PROGRESS` | The key was used for other terms, or its first request is still running |
| `409` | `OFFER_INVALID` | The stored offer does not pass verification. `details.cause_code` |
| `410` | `OFFER_REVOKED` | Section 12 |
| `413` | `BODY_TOO_LARGE` | |
| `422` | `UNSUPPORTED_ASSET`, `AMOUNT_TOO_LOW`, `AMOUNT_TOO_HIGH`, `AMOUNT_MUST_MATCH_FIXED_AMOUNT`, `OFFER_EXPIRED` | The offer does not allow this request |
| `422` | `ASSET_SCRIPT_NOT_CONFIGURED` | The resolver has no type script for this token |
| `429` | `RATE_LIMITED` | `details.retry_after_seconds` |
| `502` | `FIBER_INVOICE_REJECTED`, `FIBER_RPC_UNAUTHORIZED`, `FIBER_RPC_REJECTED`, `FIBER_RPC_INVALID_RESPONSE` | The merchant node refused. Not retryable |
| `503` | `RECIPIENT_UNAVAILABLE`, `RATE_LIMITER_UNAVAILABLE` | Try again |

**Registering an offer with a resolver:** `403 OFFER_NODE_MISMATCH` (the offer names another node), `422 OFFER_NETWORK_MISMATCH`, `422 ASSET_SCRIPT_NOT_CONFIGURED`, `401 UNAUTHORIZED`.

**A revocation:** `400 INVALID_REVOCATION`, `400 REVOCATION_EXPIRED`, `400 INVALID_REVOCATION_SIGNATURE`.

**What a payer's own checks report** (section 9; these are the reference SDK's): `RESOLVER_MISMATCH`, `INVOICE_PAYEE_MISSING`, `INVOICE_PAYEE_MISMATCH`, `INVOICE_AMOUNT_MISSING`, `INVOICE_AMOUNT_MISMATCH`, `INVOICE_CURRENCY_MISMATCH`, `INVOICE_ASSET_MISMATCH`, `INVOICE_EXPIRED`, `INVOICE_BINDING_MISSING`, `INVOICE_OFFER_MISMATCH`, `INVOICE_RESOLUTION_MISMATCH`, `INVOICE_PAYMENT_HASH_MISMATCH`, `INVOICE_UNPARSEABLE`.

## 14. What is checked where

| Check | Needs | Done by |
| --- | --- | --- |
| The offer is well formed, canonical and signed | The offer | Anyone, offline |
| A request's asset and amount fit the offer; the offer has not expired | The offer and a clock | Wallet offline, and resolver |
| A cycle's amount and number fit the signed caps | The offer | Wallet offline, and resolver |
| The subscription proof | The request | Resolver |
| The offer is not revoked, a single-use offer is unused, a cycle is the next one | History | Resolver only |
| The node is the offer's node, on the offer's network | The node | Resolver |
| The invoice pays the right node, amount, asset and order | The payer's node | Payer only |

## 15. Trust and threats

**What is signed by whom.** The offer key signs the terms. The merchant's Fiber node signs each invoice, including the description that names the offer. Nothing else is trusted.

**The offer key is self-asserted.** Nothing in an offer proves that whoever holds the offer key controls `node_id`. That link is made at payment time, by the node: an invoice whose payee is `node_id` and whose description names `offer_id` is the node's statement that it issues invoices for that offer. Someone who publishes an offer naming another party's node cannot obtain such an invoice, so the offer cannot be paid and no funds can be diverted. Funds only ever go to the node the offer names.

**A hostile or compromised resolver, or an attacker on the network**, can:

| Attempt | Outcome |
| --- | --- |
| Serve a different or altered offer | Fails verification, or has another ID (9.1) |
| Return an invoice to another node, for another amount, asset or network | Refused by the payer's own reading of the invoice (9.3) |
| Return a real invoice from the merchant's node that belongs to another order | Refused by the binding (9.4) |
| Claim a payment was or was not made | A resolver's word is not proof (9.1); the payer's node knows what it paid |
| Refuse service, or serve stale status | Not preventable. Offers remain verifiable; invoices cannot be issued |
| Observe who pays what, and when | Not preventable in v1 (section 16) |

**Other parties.**

- Anyone can request invoices. Unpaid requests hold a single-use offer or a cycle only until the invoice lapses (section 10), and resolvers limit request rates.
- Only the holder of a subscription key can spend that subscription's caps (section 11).
- Only the holder of the offer key can revoke through the protocol. A resolver operator can always stop serving an offer.
- A revocation is accepted only within 300 seconds of its timestamp, and applying it again changes nothing.

**Out of scope.** The security of the merchant's node and its RPC, of the offer key's storage, and of the payer's node. A resolver that holds an RPC credential able to send payments is a risk to the merchant; see the deployment guide for a credential that cannot.

**Checksum strength.** Bech32m's guarantee of detecting up to four errors holds for strings of at most 90 characters. Encoded offers are far longer, as BOLT11 invoices are; a damaged string is still detected with overwhelming probability (a random change passes with probability 2^-30), and a string that passes must still verify as a signed offer.

## 16. Privacy

- **Offers are public.** Anyone with an offer ID can fetch the offer. Do not put personal data or secrets in `description` or `metadata`.
- **The resolver sees payers.** It learns the network address of each requester, the amount and asset, and the time. A wallet that wants to hide the payer's address from the merchant's resolver must reach it through a proxy or an anonymity network; this format adds no such layer.
- **A subscription key links a subscriber's cycles** to one another, by design. It MUST NOT be reused for another offer, or it would link those too.
- **An invoice names its order.** The description carries the offer ID and resolution ID, and is visible to anyone the invoice string is shown to.
- **A resolution ID is a capability.** Anyone who has it can read that payment's status and receipt. Wallets and resolvers SHOULD keep such URLs out of logs and referrers.
- **What a resolver must not expose to anonymous callers:** any list of an offer's payments, any summary across subscribers, and the state of the merchant's node.

## 17. Prior art and rationale

| | Fiber invoice | LNURL-pay / Lightning Address | BOLT12 offer | Fiber Offer |
| --- | --- | --- | --- | --- |
| Reusable | No | Yes | Yes | Yes |
| What the payer holds | An invoice | A URL or `user@domain` | A signed offer | A signed offer |
| How an invoice is obtained | Out of band | HTTPS callback | Onion message to the node | HTTPS request to the resolver |
| Terms signed by the merchant | The one invoice | No | Yes, by the node key | Yes, by an offer key |
| Server trusted for the payee | n/a | Yes | No server | No: the payer checks the invoice against the signed offer |
| Invoice tied to the request | n/a | Description hash of the metadata | Invoice request is signed and echoed | Description commitment to offer and resolution |
| Needs changes to the node | No | No | Yes (onion messages, blinded paths) | No |
| Recipient privacy | Node ID in the invoice | Node ID in the invoice | Blinded paths | Node ID in the offer |
| Recurrence | No | No | Proposed | Yes, with signed caps |

**Why HTTP.** BOLT12 fetches invoices over the payment network itself, which removes the server and hides the payer. It depends on onion messaging and blinded paths in the node. Fiber has neither today, so an offer protocol that needs them cannot be deployed. Fetching over HTTPS works with Fiber nodes as they are, in any wallet and in a browser. The price is a server that must be reachable and that sees who asks. This format accepts that and removes the other usual cost of an HTTP design: unlike LNURL, the server is not trusted for where the money goes.

**Why a separate offer key.** A Fiber node's key signs invoices; its RPC does not sign arbitrary messages. Asking merchants to export the node key to sign offers would put it at risk. A separate Ed25519 key keeps offer management away from the node key. The cost is that the key is self-asserted, which section 15 answers by having the node bind each invoice to the offer.

**Why JSON and PEM.** They are readable and need no new parser, at the cost of size: a typical offer is about 700 bytes, most of it the PEM key and field names. A binary encoding with a raw 32-byte key would be roughly a third of that. It would be a different format (2.7), and is deferred until this one has been reviewed.

**Why one resolver address.** An offer names one resolver, so that resolver is a single point of failure for the offer. A signed list of fallback resolvers is planned as an extension.

## 18. Conformance

An implementation conforms to this document when it reproduces every output in [`test-vectors/v1.json`](test-vectors/README.md) and refuses every invalid case there. The file fixes canonical JSON, type script hashes, twelve valid offers with every intermediate value, and the offers, encodings, requests, revocations and cycle requests that must be refused.

`test-vectors/verify.py` is a second implementation, in Python, written from this document and sharing no code with the reference implementation. It passes every vector.
