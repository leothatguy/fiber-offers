# Fiber Offers Hardening & Remediation Plan

> **Living Document:** Update item checkboxes, status tags, commit/PR references, decisions, and the **New Findings Log** as fixes are implemented or additional issues are discovered.

- **Baseline commit:** `730f113` (`main`)
- **Pinned Fiber node image:** `nervos/fiber:0.9.0-rc1` (upstream is at `v0.10.1`; see `F-040`). Local validation runs on `v0.10.1`.
- **Last updated:** 2026-11-23
- **Audit passes:** #1 2026-11-22 (critique validation → Phases A–F, `F-001`..`F-009`) · #2 2026-11-22 (full repo re-audit → amendments marked *(audit #2)*, new Phases G–H, `D-5`..`D-9`, `F-010`..`F-038`)
- **Status legend:** `[ ]` Not started · `[~]` In progress · `[x]` Done · `[!]` Blocked / Needs decision

---

## 1. Validated Review Critique Assessment

This plan addresses three review critiques raised against v0.1.0, validated directly against the codebase at `730f113` and Fiber `v0.9.0-rc1`.

| # | Critique | Verdict | Summary |
| --- | --- | --- | --- |
| 1 | Specification is not organized into a concise, rigorous framework for larger-scale adoption | **Fair** | `docs/spec-v1.md` is mostly a resolver product/API tour without RFC 2119 norms, formal canonicalization, `type_script_hash` definition, state machine, error registry, threat model, or test vectors. Protocol validation also has real security and determinism holes. |
| 2 | Custom offer format and JSON-file persistence are prototype-level ecosystem infrastructure | **Partly fair** | **Format:** Fair — JSON + PEM key in Bech32m produces ~940–1,250 chars (measured in audit #2: 940 for a bare offer, 1,055 for a typical described CKB offer; anything past 1,023 symbols is outside Bech32m's BCH period, yielding QR v27–v29), legacy base64url fallback masks checksum errors, and `@fiber-offers/protocol` imports `node:crypto` (breaking `@fiber-offers/sdk/browser`). **Persistence:** Outdated in code (PostgreSQL + migrations + `FOR UPDATE` reservations + Redis + BullMQ ship in Docker Compose), but self-inflicted because `server.js` falls back to non-atomic JSON when `DATABASE_URL` is unset (even in production), `spec-v1.md` still denies DB support, and infra tests are skipped by default. |
| 3 | Default demo is mock-based and live Fiber validation is shallow | **Fair** | Quick Start, `npm run smoke`, and unit tests are mocked; no CI exists; release evidence is five prose bullets without hashes/logs; mocks mask real Fiber RPC bugs (hardcoded `Fibt`, invalid UDT `currency` instead of `udt_type_script`, missing `expiry`/`expires_at`, permanent errors masked as `503`); live E2E bypasses the SDK and only tests happy-path CKB. |

### Claims Explicitly Dropped or Refined During Validation

- **Dropped:** *"Bech32m checksum is completely ineffective."* — Precision: beyond 1,023 symbols the BCH distance guarantees break down (2-char errors spaced exactly 1,023 apart pass 100% of the time), while random 2-char errors are still detected.
- **Dropped:** *"Empty `udt_whitelist` alone proves tokens were never tested."* — The definitive proof is the invalid RPC payload in `assetToFiberCurrency` (`apps/resolver/src/fiber-rpc.js`) and the broken mock assertion in `apps/resolver/test/resolver.test.js`.
- **Dropped:** *"Fixing token invoices requires breaking v1."* — A v1-compatible resolver asset registry mapping `type_script_hash` to `{ code_hash, hash_type, args }` can fix UDT/RGB++ invoices without breaking v1 offers; embedding the full script in the offer is only needed if we cut a breaking v2 format.
- **Refined (D-1, decided: reword):** *"The `get_invoice` sync path can still record `Expired` when Fiber reports it."* — At `v0.9.0-rc1`, Fiber only attaches an expiry when `expiry` is passed to `new_invoice`, and `is_expired()` is false without one. At baseline `730f113` the adapter never passed `expiry`, so live invoices never became `Expired`. `A5` changed that on 2026-11-22: every invoice is now requested with an expiry.

### Second Audit Pass (2026-11-22) — What Phases A–F Did Not Cover

Every existing item A1–F5 was re-checked against the code and still holds (`C1`, `C2`, `A1` were reproduced; `npm test` is 108 pass / 4 skipped). The re-audit found gaps in six areas the first plan did not reach:

| Theme | Why it matters to the critiques | Landed in |
| --- | --- | --- |
| Payment flow never confirms settlement, and retries are blocked | Recurring and single-use payments strand on any transient failure; cycles are counted as paid on `send_payment` acceptance | `A1`, `A7`, `A8` |
| Recurrence is single-subscriber by construction | A "reusable" recurring offer can serve exactly one payer | `B2`, `D-5` |
| Abuse controls are bypassable | Rate limits and response origins trust client-supplied `X-Forwarded-*` headers, so `B1`/`B2` cannot rely on them | `B4`, `B5` |
| Resolver access control and deployment defaults | Merchant payment history and node liquidity are world-readable; webhook SSRF filter is bypassable; production compose falls back to known default secrets | Phase G |
| Spec scope and ecosystem path (Critique 1) | Fiber Address, the resolver interop API, versioning, schemas, and a standards path are absent from `D1` | `D1`, `D5`, `D6` |
| Scale, tenancy and release management (Critique 2) | Background passes are O(offers × resolutions); one shared API key; buggy `0.1.0` packages are already on npm with no release path | `E4`, `E5`, Phase H |

---

## 2. Open Decisions

Record chosen decisions here before or during the phase that depends on them.

| ID | Topic | Options | Recommended | Status / Decision |
| --- | --- | --- | --- | --- |
| **D-1** | Expiry wording in assessment | Reword sync-path sentence to reflect that Fiber `v0.9.0-rc1` never expires invoices created without `expiry` vs. leave as-is | Reword as proposed | `[x]` **Decided 2026-11-22: reword** — adopted under the owner's standing instruction to take the best approach |
| **D-2** | Single-use consumption semantics (`B1`) | (a) Consumed on invoice issuance (current docs) vs. (b) Consumed on **paid**, with unpaid invoice locking until expiry and releasing on expiry/cancellation | **(b) Consumed on paid** (closes anonymous exhaustion DoS; requires doc/spec update) | `[x]` **Decided 2026-11-22: (b)** — consumed on paid; an unpaid invoice holds the offer until it expires or is cancelled. Adopted under the owner's standing instruction to take the best approach |
| **D-3** | Offline recurrence validation (`B2` / `D1`) | (a) Keep recurrence state/cap enforcement resolver-only and specify that boundary vs. (b) Add stateless recurrence request validation to `@fiber-offers/protocol`'s `validateResolutionRequest` | **(b)** for stateless checks (cycle amount match, positive cycle index, cap bounds) + resolver-side stateful cap tracking | `[x]` **Decided 2026-11-22: (b)** — stateless checks in `@fiber-offers/protocol`, stateful tracking in the resolver (per subscription, see D-5). Adopted under the owner's standing instruction to take the best approach |
| **D-4** | Format v1 hardening vs. breaking v2 (`E1`) | (a) Stay v1-compatible (asset registry + uppercase Bech32m → QR v22) vs. (b) Cut a breaking v2 format (compact binary/TLV or CBOR + raw 32-byte Ed25519 key + embedded `udt_type_script`) | Decide after Phases A–D; A–D and F do **not** require breaking v1 | `[x]` **Decided 2026-11-23: (a) for now** — stay on v1. Phases A–D are done and none needed a format break. The size argument for v2 is weaker than it was: an offer QR code is five versions smaller in uppercase (`C4`), and the payment-link QR, which is the default, was never large. A compact binary v2 (raw 32-byte key, no field names, about a third of the size) remains the right long-term form, but designing it before anyone outside has reviewed v1 would mean breaking twice. Revisit after the outside review in `D6`; the spec reserves a new `scheme` and `version` for it (section 2.7). Adopted under the owner's standing instruction to take the best approach; reversible |
| **D-5** | Recurrence scope (`B2`, `D1`) *(audit #2)* | (a) Keep one global cycle counter per offer (current; one subscriber per offer) vs. (b) Track cycles and caps per subscription, keyed by `approval_id` and bound to a payer-held key presented on the first cycle | **(b) Per-subscription** — otherwise a recurring offer is not reusable; needs a spec change and a migration of the `(offer_id, cycle)` unique index | `[x]` **Decided 2026-11-22: (b)** — cycles and caps tracked per subscription; payer-held key registered on the first cycle signs later cycle requests |
| **D-6** | Public read surface (`G1`) *(audit #2)* | (a) Keep resolution lists, reconciliation, recurrence status, `/diagnostics`, `/topology` open (current, documented in `docs/deployment.md`) vs. (b) Require the API key for those, keeping only offer lookup, QR, `/check`, `/invoice`, and single-resolution/receipt-by-ID (unguessable capability URLs) public | **(b)** | `[x]` **Decided 2026-11-22: (b)** — API key required for resolution lists, reconciliation, recurrence status, `/diagnostics` and `/topology`. *Refined 2026-11-23 while implementing `G1`:* per-subscription recurrence status (`?approval_id=`) stays public, because D-5 made it the route a payer's scheduler reads its next cycle from and the subscription ID is derived from a key only that payer holds; the summary across subscribers needs the key |
| **D-7** | Release strategy for the already-published `0.1.0` npm packages (`H1`) *(audit #2)* | (a) Patch releases vs. (b) `0.2.0` with CHANGELOG + migration notes and `npm deprecate` on `0.1.0` | **(b)** — `C3`/`C4`/`D-2` change validation and lifecycle behavior | `[x]` **Decided 2026-11-22: (b)** — ship as `0.2.0` with CHANGELOG and migration notes; deprecate `0.1.0` |
| **D-8** | Demo surface in the production image (`G2`) *(audit #2)* | (a) Leave `/demo/*` and `RESOLVER_PUBLIC_OPERATOR_ACCESS` always available vs. (b) Gate all of it behind one explicit `RESOLVER_DEMO_MODE=true`, off by default | **(b)** | `[x]` **Decided 2026-11-22: (b)** — demo routes, public operator access and server-side payer dry-runs gated behind `RESOLVER_DEMO_MODE`, off by default |
| **D-9** | Multi-merchant tenancy (`E5`) *(audit #2)* | (a) Stay one resolver ↔ one merchant node with scoped/rotatable keys only vs. (b) Full merchant accounts with per-merchant node profiles | **(a)**, stated as a design principle rather than a limitation: each merchant runs their own resolver beside their own node. A shared multi-merchant resolver is a non-goal because it would hold RPC access to other merchants' nodes. Pair with resolver independence (`F-039`) | `[x]` **Decided 2026-11-22: (a)** — single-merchant as a design principle; multi-merchant hosting is an explicit non-goal |
| **D-10** | Resolver independence (`E6`, `F-039`) *(audit #2)* | (a) Keep one signed `resolver_url` vs. (b) Signed fallback resolver list in v1 now, with resolver-less payment and updatable discovery recorded as open research questions vs. (c) Build a resolver-less path now | **(b)** — removes the single point of failure cheaply and stays v1-compatible; (c) is unverified against Fiber and gives up the node-signed invoice | `[x]` **Decided 2026-11-22: (b)** — choice delegated by the owner ("go with the best approach") |

---

## 3. Implementation Roadmap

Phases are ordered by user impact and dependency: fix broken payment/security behavior first, then lock down lifecycle and cryptography, codify the normative spec, harden format/persistence, and prove everything in CI against real Fiber nodes. Phases G–H were added by audit #2; `B4` and `G4` are prerequisites for `B1`/`B2` being meaningful (rate limits and production guards must work first), so schedule them alongside Phase A.

---

### Phase A — Payment Correctness & Payer Verification

> **Goal:** Make real CKB, UDT, single-use, and expiry payment flows work end-to-end and close payer-side invoice/offer substitution attacks.

- [x] **A1. Fix single-use payment flow regression in SDK + resolver** — *done 2026-11-22; confirmed live: a single-use offer was paid through the SDK on Fiber `v0.10.1`, and a second attempt was refused*
  - **Problem:** `FiberPaymentFlowClient.preparePayment()` mints the single allowed invoice, then calls `/offers/:offer_id/check` a second time with that invoice. `checkOfferReadiness()` counts the newly minted invoice and returns `OFFER_ALREADY_USED`, causing `payOffer()` to abort with `blocked_after_invoice`.
  - **Files:** `apps/resolver/src/server.js`, `packages/sdk/src/payment-flow.js`, `apps/resolver/test/resolver.test.js`, `packages/sdk/test/sdk.test.js`
  - **Acceptance criteria:**
    - Post-invoice readiness check recognizes the invoice being checked and does not fail `single_use` against itself.
    - `FiberPaymentFlowClient.payOffer(..., { execute: true })` completes on a `single_use: true` offer.
    - Regression tests added for both resolver `/check` and SDK `payOffer`.
    - *(audit #2, `F-010`)* The **pre-invoice** check must not block an idempotent retry. Today a retry with the same idempotency key returns `blocked_before_invoice` with `OFFER_ALREADY_USED` (single-use) or `INVALID_RECURRENCE_CYCLE` (recurring), so a transient failure after invoice issuance can never be retried. `/check` accepts the idempotency key and treats an existing resolution for that key as a replay; `preparePayment()` passes it. Regression tests: retry after a simulated `send_payment` transport failure succeeds for a single-use offer and for recurring cycle N.
  - **Outcome:** `/check` now identifies the resolution a check is about — by the supplied invoice, or by the idempotency key — and excludes it from the single-use and recurrence counts (`apps/resolver/src/resolution-rules.js`). A key reused for a different request fails with `IDEMPOTENCY_KEY_REUSED`. A supplied invoice that this offer did not issue gets an `invoice_match` warning. The SDK sends the key on both readiness checks. Covered by two resolver tests and three SDK-against-resolver tests in the new `apps/resolver/test/payment-flow.test.js`.

- [x] **A2. Implement full payer-side offer & invoice verification** — *done 2026-11-22; invoice attribute shapes to be confirmed on a live node in `F2`*
  - **Problem:** `resolveOffer()` only checks outer `offer_id`; `getOffer()` and `resolveFiberAddress()` do not verify signatures; `payOffer()` never parses the returned Fiber invoice or checks `resolver_url`, allowing a compromised/hostile resolver to substitute an arbitrary payee, amount, asset, or network.
  - **Files:** `packages/sdk/src/index.js`, `packages/sdk/src/payment-flow.js`, `packages/sdk/src/fiber-payment.js`, `packages/sdk/test/sdk.test.js`
  - **Acceptance criteria:**
    - `FiberOffersClient.getOffer()`, `resolveOffer()`, and `resolveFiberAddress()` verify the returned offer structure, `offer_id`, and signature via `verifyOffer()`.
    - Payer flow checks that the contacted resolver origin matches the signed `offer.resolver_url` (unless explicitly overridden for testing).
    - `FiberPaymentClient` exposes `parseInvoice(invoice)` (via Fiber RPC `parse_invoice`) and `FiberPaymentFlowClient.preparePayment()` / `payOffer()` verifies before sending payment:
      - payee pubkey === `offer.node_id`
      - invoice amount === requested amount
      - invoice currency matches `offer.network` (`Fibb` / `Fibt` / `Fibd`)
      - invoice `udt_type_script` matches requested asset (absent for CKB, matching script/hash for UDT/RGB++)
      - invoice is not already expired
    - Negative tests prove substitution of inner offer, payee, amount, currency, UDT, or resolver URL is rejected before `send_payment`.
    - *(audit #2)* Fiber's `parse_invoice` returns the payee key, expiry and UDT script as entries in `invoice.data.attrs` (`payee_public_key`, `expiry_time`, `udt_script`), not as top-level fields. Verification reads them from `attrs` and fails closed when the payee key attribute is absent.
    - *(audit #2, `F-011`)* `resolveFiberAddress("user@domain")` resolves against `https://domain`. Today it silently queries the client's configured `resolverUrl` and ignores the address domain. The returned offer is verified and later calls go to its signed `resolver_url`.
  - **Outcome:** `getOffer()`, `resolveOffer()` and `resolveFiberAddress()` verify the returned offer (signature, ID equals content hash, ID equals the one requested, attached `encoded_offer` is the same offer). `resolveFiberAddress()` looks the address up at its own domain and no longer sends the API key to another host. `FiberPaymentClient.parseInvoice()` wraps `parse_invoice`. `FiberPaymentFlowClient` verifies the offer however it is passed (ID, encoded, object), refuses a resolver other than the signed `resolver_url` (`resolver_mismatch`), validates the request offline, and runs `verifyInvoiceForOffer()` on the payer node's reading of the invoice (`invoice_rejected` on any mismatch). `payOffer({ execute: true })` will not send for an unverified invoice (`invoice_unverified`). Overrides for tests: `allowResolverMismatch`, `skipInvoiceVerification`. Seven substitution attacks are covered end to end in `apps/resolver/test/payment-flow.test.js`.
  - **Confirmed live (2026-11-22, Fiber `v0.10.1` testnet):** invoices carry `{ "payee_public_key": "02…" }`, `{ "expiry_time": "0x384" }` and, for tokens, `{ "udt_script": "0x…" }` (molecule bytes) in `data.attrs`. A CKB invoice and a RUSD invoice minted by the merchant node and read by the payer node passed all six checks.

- [x] **A3. Fix Fiber network-to-currency mapping and node chain validation** — *done 2026-11-22; chain-hash assumption to be confirmed on a live node in `F2`*
  - **Problem:** `assetToFiberCurrency()` hardcodes `"Fibt"` regardless of `offer.network`; mainnet (`Fibb`) and devnet (`Fibd`) CKB invoices are rejected by real Fiber nodes, and the offer's `network` is never checked against the merchant node's chain.
  - **Files:** `apps/resolver/src/fiber-rpc.js`, `apps/resolver/src/invoice-adapter.js`, `apps/resolver/src/server.js`, `apps/resolver/test/invoice-adapter.test.js`, `apps/resolver/test/resolver.test.js`
  - **Acceptance criteria:**
    - Map `mainnet` → `"Fibb"`, `testnet` → `"Fibt"`, `dev` → `"Fibd"` for **all** assets (CKB, UDT, RGB++).
    - Validate offer `network` against the configured merchant Fiber node's chain/network (from `node_info` or explicit config) on offer registration and invoice creation.
    - Unit tests cover `mainnet`, `testnet`, and `dev` mappings and mismatch rejection.
  - **Outcome:** `packages/sdk/src/fiber-network.js` holds the mapping (`Fibb`/`Fibt`/`Fibd`) and the two public genesis hashes, both checked against the public CKB RPC. The adapter takes the currency from the offer's signed network. The resolver learns its node's network from `node_info.chain_hash` or `FIBER_NETWORK` and refuses a mismatched offer with `422 OFFER_NETWORK_MISMATCH` at registration and before each invoice. `createOffer()` and the CLI take the network from the node and refuse a contradicting `--network`. Token requests now fail closed with `422 ASSET_SCRIPT_NOT_CONFIGURED` until `A4` adds the registry; before, the script hash was sent as the currency.
  - **Confirmed live (2026-11-22, Fiber `v0.10.1` testnet):** `node_info.chain_hash` is the testnet genesis hash; the resolver derived `testnet` from it and refused a `mainnet` offer with `422 OFFER_NETWORK_MISMATCH`. The node itself refuses the wrong currency (`-32000`).

- [x] **A4. Fix UDT / RGB++ invoice creation (Asset Registry + CLI support)** — *done 2026-11-22; confirmed live that a RUSD invoice is minted from the node's own whitelist and verifies; an actual token payment still needs a funded UDT channel (`F2`)*
  - **Problem:** `FiberRpcInvoiceAdapter` sends `asset.type_script_hash` in `currency` and omits `udt_type_script`. `resolver.test.js` asserts this broken shape. Also `apps/cli/src/index.js` exposes `--asset-type` without any `--type-script-hash` flag, making non-CKB offer creation impossible via CLI.
  - **Files:** `apps/resolver/src/fiber-rpc.js`, `apps/resolver/src/invoice-adapter.js`, `apps/resolver/src/server.js`, `apps/cli/src/index.js`, `apps/resolver/test/invoice-adapter.test.js`, `apps/resolver/test/resolver.test.js`, `apps/cli/test/cli.test.js`
  - **Acceptance criteria:**
    - Resolver supports a configurable UDT/RGB++ asset registry mapping CKB script hash (`type_script_hash`) → `{ code_hash, hash_type, args }` (and/or querying node UDT config where available).
    - `new_invoice` sends network `currency` (`Fibb`/`Fibt`/`Fibd`) + `udt_type_script: { code_hash, hash_type, args }`.
    - Missing/unregistered `type_script_hash` fails fast with a clear `400`/`422` client/config error (`UNSUPPORTED_ASSET` / `ASSET_SCRIPT_NOT_CONFIGURED`).
    - CLI `create` supports `--type-script-hash` (validating format for `udt`/`rgbpp`).
    - Fix `apps/resolver/test/resolver.test.js` to assert the real Fiber RPC schema.
    - *(audit #2, `F-012`)* CLI `create` also gains recurrence flags (`--recurrence-interval`, `--recurrence-amount`, `--cap-cycles`, `--spending-cap-total`, `--custom-seconds`); recurring offers cannot be created from the CLI today.
  - **Outcome:** `@fiber-offers/protocol` computes CKB script hashes (`ckbScriptHash()`, `parseCkbScript()`), checked against three mainnet system scripts. The resolver keeps a registry (`apps/resolver/src/asset-registry.js`) fed by `FIBER_UDT_SCRIPTS`, `FIBER_UDT_SCRIPTS_FILE` and the exact scripts in `node_info.udt_cfg_infos`; every entry is verified by hash at load, and a bad entry stops startup. `new_invoice` now sends the network currency plus `udt_type_script`. A token with no script is refused with `422 ASSET_SCRIPT_NOT_CONFIGURED` at registration, in `/check` (`asset_source`) and at invoice time. The CLI accepts `--type-script-hash` or `--type-script` (which it hashes) and the recurrence flags.

- [x] **A5. Pass `expiry` to Fiber RPC and populate `expires_at` on live invoices** — *done 2026-11-22; confirmed live: a 3-second invoice went `Open` → `Expired` on the node, and `expires_at` matched the invoice's own expiry*
  - **Problem:** `FiberRpcInvoiceAdapter.createInvoice()` never passes `expiry` to `new_invoice` and never sets `expires_at`. Live invoices never expire on Fiber `v0.9.0-rc1` and resolver expiry-on-read only works in mock mode.
  - **Files:** `apps/resolver/src/invoice-adapter.js`, `apps/resolver/src/server.js`, `apps/resolver/test/invoice-adapter.test.js`, `apps/resolver/test/resolver.test.js`
  - **Acceptance criteria:**
    - Configurable invoice TTL (`FIBER_INVOICE_TTL_SECONDS`, default e.g. `900`) passed as hex `expiry` in `new_invoice` params (clamped to `offer.expiry` if sooner).
    - `FiberRpcInvoiceAdapter.createInvoice()` derives and returns `expires_at` from the invoice response timestamp + expiry (or computed fallback) so read-time expiry and Fiber `get_invoice` `Expired` status both work.
    - Tests verify `expiry` param encoding, offer-expiry clamping, and `expires_at` population.
  - **Outcome:** Both adapters take `FIBER_INVOICE_TTL_SECONDS` (default 900, validated at startup). `new_invoice` is sent `expiry` as a hex number of seconds, cut short so an invoice never outlives its offer. `expires_at` comes from the node's invoice timestamp when it agrees with the local clock within five minutes, otherwise from the local clock read before the call. Read-time expiry now works in live mode.

- [x] **A6. Classify adapter & RPC errors accurately instead of blanket `503 RECIPIENT_UNAVAILABLE`** — *done 2026-11-22*
  - **Problem:** `resolveInvoice()` catches every adapter error and returns `503 RECIPIENT_UNAVAILABLE` ("try again"), masking permanent failures like currency mismatch, unknown UDT script, invalid params, or RPC method errors.
  - **Files:** `apps/resolver/src/invoice-adapter.js`, `apps/resolver/src/server.js`, `apps/resolver/test/resolver.test.js`
  - **Acceptance criteria:**
    - Distinguish transient transport/availability failures (`503 RECIPIENT_UNAVAILABLE`) from permanent configuration/validation errors (`400`/`422`/`502` with specific error codes).
    - Tests cover both transient disconnect and permanent RPC rejection.
    - *(audit #2, `F-013`)* Every Fiber RPC and resolver HTTP `fetch` (resolver `fiber-rpc.js`, SDK `fiber-payment.js`, SDK `index.js`) carries an abort timeout. Today a hung FNN holds the per-offer invoice lock indefinitely and queues every later invoice request for that offer. Non-JSON RPC responses (proxy HTML, `401` text) map to a classified error instead of a `SyntaxError`.
  - **Outcome:** One JSON-RPC client (`packages/sdk/src/fiber-rpc.js`) now serves the SDK and the resolver; the resolver's own copy is gone (this is the client half of `H2`). It enforces a deadline (`timeoutMs`, default 15 s, `FIBER_RPC_TIMEOUT_MS` on the resolver) and tags every failure with `kind` and `retryable`. `apps/resolver/src/invoice-errors.js` maps failures to `503 RECIPIENT_UNAVAILABLE` (retryable) or `502 FIBER_INVOICE_REJECTED` / `FIBER_RPC_UNAUTHORIZED` / `FIBER_RPC_REJECTED` / `FIBER_RPC_INVALID_RESPONSE` (not retryable), with `details.retryable` and `details.cause_code` in the response. The node's error message goes to the log only. `FiberOffersClient` gained its own deadline (30 s) and `RESOLVER_TIMEOUT` / `RESOLVER_UNREACHABLE` / `RESOLVER_INVALID_RESPONSE` errors. Documented in `docs/spec-v1.md` and `docs/sdk.md`.

- [x] **A7. Confirm payment outcome before advancing state** *(audit #2, `F-014`, `F-038`)* — *done 2026-11-22; confirmed live: `confirm: true` ended in `payment_succeeded` (Fiber `Success`) and the scheduler paid two recurring cycles; a fresh invoice for an expired cycle also needs the resolver change in `B2`*
  - **Problem:** `payOffer()` returns `payment_sent` as soon as `send_payment` is accepted (Fiber status `Created`/`Inflight`) and nothing calls `get_payment`. `FiberRecurringPaymentScheduler` then counts the cycle as paid and advances the schedule, so a payment that later ends `Failed` is never noticed. A crash between `send_payment` and `store.put()` re-sends the same invoice on restart and burns the retry budget. The fixed idempotency key `approval:cycle` replays an expired invoice forever.
  - **Files:** `packages/sdk/src/payment-flow.js`, `packages/sdk/src/fiber-payment.js`, `packages/sdk/src/recurrence.js`, `packages/sdk/src/index.d.ts`, `packages/sdk/test/sdk.test.js`
  - **Acceptance criteria:**
    - `FiberPaymentFlowClient` exposes a confirmation step (poll `get_payment` to `Success`/`Failed` with a bounded timeout); `payOffer({ execute: true, confirm: true })` returns `payment_succeeded` / `payment_failed`.
    - The scheduler records the attempt (payment hash) **before** sending, advances `cycles_paid`/`spending_total` only on `Success`, and on restart reconciles an in-flight attempt through `get_payment` instead of re-sending.
    - A replayed invoice that is expired, failed or cancelled triggers a fresh invoice for the same cycle (new key suffix or resolver-side replacement) rather than an endless replay.
    - `monthly` recurrence clamps to the end of the month (today `Jan 31 + 1 month = Mar 3`); `approval.attempts` is bounded so `localStorage` cannot fill up.
    - Tests cover: later-`Failed` payment does not advance the cycle; crash-and-restart mid-payment; expired-invoice retry.
  - **Outcome:** `waitForFiberPayment()` / `FiberPaymentClient.waitForPayment()` poll `get_payment` to `Success` or `Failed`. `payOffer({ execute: true, confirm: true })` ends in `payment_succeeded`, `payment_failed` or `payment_pending`; `confirmPayment()` and `executePrepared()` are public. The scheduler writes `in_flight` (cycle and payment hash) before sending, advances only on `payment_succeeded`, and on its next run asks the node about an in-flight payment instead of sending again. It bumps the idempotency key after `INVOICE_EXPIRED`, computes due dates from a fixed anchor with month-end clamping, and keeps the last 20 attempts. A flow that cannot report status needs `confirm: false`.
  - **Open point:** after an invoice expires the scheduler asks for a new one under a new key, but the resolver still counts the expired resolution as that cycle and answers `INVALID_RECURRENCE_CYCLE`. `B2` (unpaid expired invoices release their cycle) completes this.

- [x] **A8. Bind each invoice to its offer and resolution** *(audit #2, `F-015`)* — *done 2026-11-22*
  - **Problem:** The Fiber invoice description is `offer.description ?? offer.offer_id`, so nothing in the node-signed invoice ties it to a specific offer or resolution. Receipts (`receipt.json`) are unsigned resolver assertions.
  - **Files:** `apps/resolver/src/invoice-adapter.js`, `apps/resolver/src/server.js`, `packages/sdk/src/payment-flow.js`, `docs/spec-v1.md`
  - **Acceptance criteria:**
    - The invoice description carries a specified commitment (for example `fiberoffer:<offer_id>:<resolution_id>`), and the payer check in `A2` verifies it.
    - The spec states what constitutes proof of payment (node-signed invoice + preimage) and what a resolver receipt does and does not prove.
  - **Outcome:** The resolver sets every invoice description to `<description> (fiberoffer:<offer_id>:<resolution_id>)` (`packages/sdk/src/invoice-binding.js`); the human part is capped at 200 characters and only a commitment at the very end counts. `verifyInvoiceForOffer()` rejects an invoice for another offer (`INVOICE_OFFER_MISMATCH`), another resolution (`INVOICE_RESOLUTION_MISMATCH`), or with no commitment (`INVOICE_BINDING_MISSING`; opt out with `allowUnboundInvoices` for pre-0.2 resolvers). `docs/spec-v1.md` gains "Proof of payment".
  - **Confirmed live (2026-11-22, Fiber `v0.10.1` testnet):** the node refuses a description over 639 bytes. `formatInvoiceDescription()` now cuts the human part by UTF-8 bytes (at most 300) so the total always fits; a 600-character multi-byte description produced a 421-byte invoice description that verified.

---

### Phase B — Offer Lifecycle & Abuse Resistance

> **Goal:** Eliminate anonymous offer-exhaustion DoS and reconcile state transitions across readiness, store, and invoice endpoints.

- [x] **B1. Redesign single-use offer consumption lifecycle *(depends on D-2)*** — *done 2026-11-22*
  - **Problem:** Anyone can hit unauthenticated `POST /offers/:offer_id/invoice` once to permanently burn a single-use offer, even if the invoice expires unpaid.
  - **Files:** `apps/resolver/src/store.js`, `apps/resolver/src/postgres-store.js`, `apps/resolver/src/server.js`, `apps/resolver/migrations/`, `apps/resolver/test/`
  - **Acceptance criteria:**
    - Implement chosen D-2 semantics (recommended: active unpaid reservation/invoice holds an exclusive lock until `expires_at` or `invoice_cancelled`/`invoice_failed`; only `invoice_paid` / `invoice_received` permanently consumes the offer; expired unpaid invoices release the offer for a new payer).
    - Concurrent reservation tests pass on both `InMemoryOfferStore`/`JsonOfferStore` and `PostgresOfferStore`.
  - **Outcome:** per D-2, payment uses a single-use offer up (`409 OFFER_ALREADY_USED`). An unpaid invoice holds it (`409 OFFER_INVOICE_OUTSTANDING`, with `outstanding_until`), and an invoice that expires, is cancelled or fails releases it. Before reserving, `settleOpenResolutions()` brings the offer's open invoices up to date: it asks the node for a live invoice, so the resolver's clock alone never releases one the node could still accept. Recurring cycles follow the same rule (migration `003` narrows the cycle uniqueness index to resolutions that still count). Tested on the in-memory store and on PostgreSQL across two pools.

- [x] **B2. Protect recurring offer cycles and spending caps from anonymous exhaustion** — *done 2026-11-22*
  - **Problem:** Unauthenticated back-to-back calls to `POST /offers/:offer_id/invoice` on a recurring offer consume all cycles and caps without any payment or proof of payer approval; `recurrence` validation is also absent from `@fiber-offers/protocol`.
  - **Files:** `apps/resolver/src/store.js`, `apps/resolver/src/postgres-store.js`, `apps/resolver/src/server.js`, `packages/protocol/src/index.js`, `packages/sdk/src/recurrence.js`
  - **Acceptance criteria:**
    - Cycle/cap accounting distinguishes unpaid/expired invoices from paid/active ones (expired unpaid invoices do not permanently burn `cap_cycles` or `spending_cap_total`).
    - Enforce schedule spacing / cooldown or per-approval scoping so one unauthenticated actor cannot drain all future cycles instantaneously.
    - Add stateless recurrence request checks to `validateResolutionRequest()` if chosen in D-3.
    - Regression tests reproduce and verify the fix for the 4-request exhaustion attack.
    - *(audit #2, `F-016`, depends on `D-5`)* The cycle counter is global per offer and is enforced by the unique index `fiber_resolutions_recurrence_cycle_idx (offer_id, cycle)`: a second payer requesting cycle 1 gets `409 INVALID_RECURRENCE_CYCLE`, so a recurring offer can serve exactly one subscriber. Implement the `D-5` scope (recommended: per-subscription counters and caps keyed by `approval_id`), with a new migration replacing the index, and a test with two independent payers each completing cycles 1..N.
  - **Outcome:** per D-5 and D-3. A subscription is an Ed25519 key the payer generates; `approval_id` is derived from the public key (`subscriptionId()`), and every cycle request is signed (`signRecurrenceRequest()` / `verifyRecurrenceRequest()` in `@fiber-offers/protocol`). The resolver refuses unsigned or mis-signed requests and counts cycles and caps per subscription: the next cycle is paid cycles plus one, a cycle is used up on payment and released if its invoice ends unpaid, and one cycle may be outstanding at a time. Migration `004` makes the uniqueness index per subscription. `recurrence-status?approval_id=` reports one subscription. The SDK scheduler creates and stores a key per approval and signs each cycle; the demo page does the same in the browser (`apps/demo/public/subscription.js`, checked against the protocol in `demo-subscription.test.js`). `validateResolutionRequest()` makes the history-free checks offline.
  - **Not done, by design:** schedule spacing is not enforced by the resolver. With signed subscriptions only the payer can request a cycle, and requesting early only means paying early, within the cap they approved.
  - **Not verified:** the demo page's recurring flow was not exercised in a real browser, only its signing helper under Node.

- [x] **B3. Fix readiness vs. invoice endpoint inconsistency after `invoice_failed`** — *done 2026-11-22*
  - **Problem:** `checkOfferReadiness()` (`server.js:965`) checks `priorResolutions.length > 0`, whereas `reserveInvoiceAttempt()` (`store.js:149`, `postgres-store.js`) filters out `invoice_failed` resolutions — so `/check` reports `OFFER_ALREADY_USED` while `/invoice` succeeds.
  - **Files:** `apps/resolver/src/server.js`, `apps/resolver/src/store.js`, `apps/resolver/src/postgres-store.js`, `apps/resolver/test/resolver.test.js`
  - **Acceptance criteria:**
    - Share a single helper/predicate for active/consuming resolutions across readiness checks, `JsonOfferStore`, and `PostgresOfferStore`.
    - Test confirms `/check` and `/invoice` agree after `invoice_failed`, `invoice_expired`, `invoice_cancelled`, and `invoice_paid`.
    - *(audit #2, `F-037`)* The same divergence exists for recurrence: `validateRecurrenceCycle()` in `server.js` counts failed cycles, while the two `recurrenceReservation()` copies in `store.js` and `postgres-store.js` do not. Collapse the three copies into one shared module used by `/check` and both stores. Decide and document whether the internal `invoice_pending` status is visible in public resolution lists.
  - **Outcome:** `assertSingleUseCapacity()` and `recurrenceReservation()` in `resolution-rules.js` are the only copies; `/check` and both stores call them, and the three older recurrence validators are gone. A test walks every outcome (failed, expired, cancelled, paid, still unpaid) and asserts `/check` and `/invoice` agree. `invoice_pending` stays visible in resolution lists as the resolver's short-lived reservation; `G1` puts those lists behind the API key.

- [x] **B4. Stop trusting client-supplied proxy headers** *(audit #2, `F-017`, `F-018`)* — *done 2026-11-22*
  - **Problem:** `enforceRateLimit()` keys on the first `X-Forwarded-For` value, which the client controls even behind the bundled Nginx (`$proxy_add_x_forwarded_for` appends to whatever was sent). Rotating the header bypasses the limit (reproduced: limit 3 → 6/6 requests pass). `requestOrigin()` trusts `X-Forwarded-Host`/`X-Forwarded-Proto`/`Host`, and `deploy/nginx.conf` forwards client-supplied values, so a caller can poison `payment_link`, `lookup_url`, `fiber_address`, `invoice_url`, `receipt_url`, QR payloads and stored webhook payloads (reproduced: `payment_link` → `https://evil.example/pay/...`). `RESOLVER_PUBLIC_URL` is only used by background workers. The in-memory limiter never evicts buckets. `POST /operator/session` (API-key guessing), `DELETE /offers/:id` and QR rendering are not rate limited.
  - **Files:** `apps/resolver/src/server.js`, `apps/resolver/src/redis-rate-limiter.js`, `deploy/nginx.conf`, `deploy/nginx-host-https.conf`, `docs/deployment.md`, `apps/resolver/test/resolver.test.js`
  - **Acceptance criteria:**
    - When `RESOLVER_PUBLIC_URL` is set it is the only origin used in responses, QR payloads and webhook payloads; forwarded headers are honoured only from a configured trusted-proxy hop count/CIDR.
    - Client address for rate limiting is derived from the trusted hop, not the left-most `X-Forwarded-For` entry; Nginx configs overwrite rather than pass through `X-Forwarded-Host`/`-Proto`.
    - Rate limits cover operator login, revocation and QR rendering; the in-memory limiter evicts expired buckets; behaviour when Redis is down is defined (fail-open or fail-closed) and tested.
    - Tests prove spoofed `X-Forwarded-For` and `X-Forwarded-Host` have no effect.
  - **Outcome:** Origin and client address are fixed once per request. `RESOLVER_PUBLIC_URL`, when set, is the only origin used anywhere. `RESOLVER_TRUSTED_PROXY_HOPS` (default 0) says how many proxies to believe: the client is that many entries from the right of `X-Forwarded-For`, and forwarded host/proto are read only with at least one trusted hop. Compose sets 1 hop, the production override 2. Operator login (10 per window), revocation and QR rendering are rate limited. The in-memory limiter evicts expired buckets. A limiter outage fails open by default (`RESOLVER_RATE_LIMIT_FAIL_OPEN`). The gateway Nginx still passes `X-Forwarded-Host` through for the two-proxy case; that is harmless once `RESOLVER_PUBLIC_URL` is set, which `G4` requires in production.

- [x] **B5. Enforce the resolution state machine atomically** *(audit #2, `F-019`, `F-020`)* — *done 2026-11-22*
  - **Problem:** `assertStatusTransition()` only blocks changes out of terminal states, so any non-terminal status can move to any other (reproduced: `invoice_received → invoice_created`). The check runs in `server.js` outside the store transaction, so two concurrent sync passes can both transition a resolution and both emit `invoice.paid`. Expiry is computed at read time only (`effectiveResolutionStatus()`); the stored status stays `invoice_created`, so `invoice.expired` webhooks never fire and API responses disagree with stored state and cap accounting.
  - **Files:** `apps/resolver/src/server.js`, `apps/resolver/src/store.js`, `apps/resolver/src/postgres-store.js`, `apps/resolver/migrations/`, `apps/resolver/test/`
  - **Acceptance criteria:**
    - One explicit transition table (forward-only) shared by manual updates and Fiber sync; the store performs compare-and-set on the expected current status and returns "unchanged" on a lost race.
    - An expiry sweep persists `invoice_expired` and emits exactly one `invoice.expired` event; a `status` CHECK constraint is added in a migration.
    - Concurrency test: two simultaneous sync calls produce one transition and one webhook event.
  - **Outcome:** `resolution-rules.js` holds the transition table. Both stores gained `transitionResolution()`, a compare-and-set on the expected current status (row-locked on PostgreSQL). Manual updates, node sync and the expiry sweep all go through one `applyResolutionTransition()`, which emits the webhook event only when it applied the change. A backward or out-of-final request is `409 INVALID_STATUS_TRANSITION`; repeating a status is a no-op with no event. `settleOverdueResolutions()` records `invoice_expired` (asking the node for live invoices, using the clock for mock ones) and the background pass now runs it in mock mode too. Migration `002` adds the `status` CHECK constraint. Tested on the in-memory store and on PostgreSQL with two pools racing.

---

### Phase C — Signing, Canonicalization & Decoding Hardening

> **Goal:** Make offer hashing, signing, verification, and decoding deterministic, strict, and safe against cryptographic/JS edge cases.

- [x] **C1. Fix canonical JSON serialization (`__proto__` and integer-like keys)** — *done 2026-11-23*
  - **Problem:** `canonicalize()` builds `{}` via `result[key] = ...`, which silently drops `"__proto__"` from signed bytes (allowing unsigned mutation injection) and reorders array-index keys (`"0"`, `"2"`, `"10"`) numerically instead of lexicographically.
  - **Files:** `packages/protocol/src/index.js`, `packages/protocol/test/protocol.test.js`
  - **Acceptance criteria:**
    - Implement deterministic RFC 8785 (JCS)-compatible serialization directly into string output (no intermediate plain-object key insertion order hazards).
    - Reject or safely serialize `"__proto__"`, `"constructor"`, and `"prototype"` (recommended: reject forbidden prototype keys in offer/metadata/extensions, and build canonical JSON strings directly from sorted entries).
    - Tests verify `__proto__` injection fails verification and numeric keys (`"10"`, `"2"`, `"a"`) serialize deterministically in exact spec order.
  - **Outcome:** New `packages/protocol/src/canonical.js` writes the canonical text directly from sorted members, following RFC 8785: key order by UTF-16 code unit, no whitespace, `JSON.stringify` spelling of strings and numbers. It refuses anything without a single JSON spelling (non-finite numbers, `bigint`, functions, class instances, unpaired surrogates, nesting beyond 32 levels). A member named `__proto__` is now part of the signed text, and offers additionally refuse the keys `__proto__`, `constructor` and `prototype` anywhere (`FORBIDDEN_KEY`). **Compatibility:** the bytes are unchanged for every offer except one whose `metadata` or extension fields contain number-like keys in an order where numeric and text order differ; such an offer has to be signed again.

- [x] **C2. Enforce Ed25519 key type on signing and verification** — *done 2026-11-23*
  - **Problem:** `verifyOffer()` and `verifyOfferRevocation()` call `createPublicKey(offer.public_key)` without asserting `key.asymmetricKeyType === "ed25519"`, allowing RSA-2048, P-256, and Ed448 keys to verify under `signature.scheme: "ed25519"`.
  - **Files:** `packages/protocol/src/index.js`, `packages/protocol/test/protocol.test.js`
  - **Acceptance criteria:**
    - Assert `key.asymmetricKeyType === "ed25519"` in `signOffer()`, `verifyOffer()`, `createOfferRevocation()`, and `verifyOfferRevocation()`.
    - Reject non-Ed25519 keys with `INVALID_PUBLIC_KEY` / `INVALID_KEY_TYPE`.
    - Negative tests with RSA-2048, P-256, and Ed448 keys all fail verification.
  - **Outcome:** One pair of helpers checks the key type everywhere a key is used: `signOffer`, `createOfferRevocation`, `signRecurrenceRequest` (private keys, `INVALID_KEY_TYPE` / `INVALID_PRIVATE_KEY`) and `assertValidOffer`, so `verifyOffer`, `verifyOfferRevocation` and `decodeOffer` (public keys, `INVALID_KEY_TYPE` / `INVALID_PUBLIC_KEY`). The test forges an offer under each of RSA-2048, P-256 and Ed448 with a signature that key really made, which Node's `verify` would accept, and each is refused before verification. `public_key` also has one spelling now: the PEM as Node exports it, trimmed.

- [x] **C3. Tighten inbound validation and normalization in `assertValidOffer` & `buildUnsignedOffer`** — *done 2026-11-23*
  - **Problem:** `assertValidOffer()` ignores `offer.network` (accepting unknown/missing values); `buildUnsignedOffer()` does not normalize `node_id` to lowercase before hashing; inbound validation accepts non-normalized asset types (`CKB`), symbols (`ckb`), and leading-zero amounts (`0001000`), creating distinct `offer_id`s for semantically identical offers.
  - **Files:** `packages/protocol/src/index.js`, `packages/protocol/test/protocol.test.js`
  - **Acceptance criteria:**
    - `assertValidOffer()` validates `offer.network` against `SUPPORTED_NETWORKS`.
    - `buildUnsignedOffer()` uses `normalizeNodeId(input.node_id)` before hashing `offer_id`.
    - `assertValidOffer()` enforces canonical field forms on decoded/inbound offers (lowercase `node_id`, lowercase `asset_type`, uppercase `symbol`, canonical integer strings with no leading zeros) so two representations cannot produce distinct IDs.
    - Unit tests cover every rejected non-canonical form.
    - *(audit #2, `F-021`)* Add cross-field invariants and size bounds. All of the following are accepted today (reproduced): `recurrence.amount` outside `[amount_min, amount_max]` (an offer no cycle can ever pay), `single_use: true` together with `recurrence`, an `expiry` already in the past at creation, no amount bounds at all, duplicate `assets` entries, a 200 KB `description` (a 321,000-character encoded offer), a `symbol` containing whitespace or newlines, a `ckb` asset labelled `USDT`, and an `http://` `resolver_url` with embedded credentials, query and fragment on `mainnet`. Define and enforce maximum lengths (description, metadata, assets count), a symbol charset, and `https` for non-dev networks.
    - *(audit #2, `F-022`)* Close encoding malleability: an inbound `resolver_url` with a trailing slash verifies under a distinct `offer_id`; extra unsigned members inside the `signature` object verify; non-canonical base64url signature values verify. Require the canonical `resolver_url` form, a strict `{ scheme, value }` signature object, canonical base64url, and decode→re-encode byte equality for encoded offers. State the policy for unknown top-level fields (signed but otherwise ignored vs. rejected).
  - **Outcome:** One function, `normalizeOfferContent`, produces the canonical content from loosely written input. `buildUnsignedOffer` uses its result; `assertValidOffer` runs it on the inbound offer and refuses any field that differs from it (`NON_CANONICAL_OFFER`, naming the field). So an accepted offer is, by construction, exactly what the builder would have produced, and the two paths cannot drift apart. Covered: every item in the criteria above, with a test per rejected form (`packages/protocol/test/hardening.test.js`).
  - **Decisions made here** (under the owner's standing instruction; each is stated in `docs/spec-v1.md`):
    - *Unknown top-level fields are refused* (`UNKNOWN_OFFER_FIELD`). A signed field a wallet does not understand could change what it is agreeing to. Ignorable additions go in `extensions` or `x_…`.
    - *Plain `http` is allowed on `dev`, and for a loopback address on any network*; otherwise `https` is required (`INSECURE_RESOLVER_URL`). Without the loopback exception no local development against a testnet node would work.
    - *An offer with no amount bounds stays valid.* The audit listed it among things "accepted today", but "pay any amount" is a real use (donations, tips) and is unambiguous. What is refused is an amount of `0`, which was a second spelling of "no bound".
    - *Free-form signed content (`metadata`, extension fields) takes whole numbers only.* A fraction is spelled differently across languages; decimals go in strings.
    - *An `expiry` in the past is refused when an offer is created, not when it is verified*, since a valid offer legitimately outlives its expiry.
    - *Limits* are exported as `OFFER_LIMITS`: 4,096 bytes for the offer, 512 for the description, 2,048 each for metadata and for extension fields, 16 assets, 16-character symbols.
  - **Compatibility:** an offer created by `0.1.0` verifies unchanged unless it used one of the forms now refused: an uppercase `node_id`, a hand-formatted PEM, a `ckb` asset with another symbol or a `type_script_hash`, duplicate assets, an amount of `0`, `single_use` together with `recurrence`, a recurrence amount outside the bounds, plain `http` to a non-local host on mainnet or testnet, credentials, a query or a fragment in `resolver_url`, a fraction in `metadata`, or more than the limits. A resolver upgraded over existing data lists such offers with `valid: false` instead of failing (`F-050`). These go in the `H1` migration notes.

- [x] **C4. Fix Bech32m decoder (uppercase support & legacy base64url fallback)** — *done 2026-11-23*
  - **Problem:** `bech32mDecode()` rejects uppercase input (preventing QR alphanumeric mode, which shrinks QR codes from v27 to v22). `decodeOfferBytes()` catches any Bech32m checksum failure and silently falls through to `base64UrlDecode()`, masking checksum errors as JSON parse errors.
  - **Files:** `packages/protocol/src/index.js`, `packages/protocol/test/protocol.test.js`, `apps/resolver/src/qr.js`
  - **Acceptance criteria:**
    - Follow BIP-173/BIP-350 case rules: accept all-lowercase **or** all-uppercase, reject mixed-case.
    - Remove silent fallback from failed Bech32m to base64url (either remove legacy base64url completely or require an explicit opt-in flag / unambiguous non-Bech32m prefix check so corrupted Bech32m always returns `INVALID_CHECKSUM` / `INVALID_OFFER_ENCODING`).
    - Update `renderOfferQrSvg()` (`apps/resolver/src/qr.js`) to uppercase `encoded_offer` in `payload=offer` QRs for alphanumeric mode compression.
    - Tests verify checksum errors are reported cleanly, uppercase decodes, mixed-case fails, and QR version shrinks.
  - **Outcome:** New `packages/protocol/src/bech32m.js`. `decodeOffer` reads all-lowercase or all-uppercase and refuses mixed case. The base64url fallback is removed outright: it predates the first release, and no published version ever wrote it. A damaged string is `INVALID_OFFER_CHECKSUM`; anything else malformed is `INVALID_OFFER_ENCODING` with `details.reason`. The body must be the canonical JSON itself, so `encodeOffer(decodeOffer(x)) === x` and an offer has one encoding. Encoded length is capped at 6,569 characters before any decoding. `payload=offer` QR codes carry the uppercase form: measured **version 27 → 22** for a typical offer (`apps/resolver/test/qr.test.js`). The SDK recognises an encoded offer in either case (`isEncodedOffer`).

---

### Phase D — Normative Specification Rewrite

> **Goal:** Turn `docs/spec-v1.md` into a concise, self-contained, multi-implementation normative specification.

- [x] **D1. Produce a single concise normative core specification** — *done 2026-11-23*
  - **Files:** `docs/spec-v1.md` (and move resolver ops/diagnostics/CSV/webhooks to `docs/resolver-api.md` or `docs/api-quick-reference.md`)
  - **Acceptance criteria:**
    - Uses RFC 2119 (`MUST`, `SHOULD`, `MAY`) language consistently.
    - Formally defines:
      - wire format & encoding rules (Bech32m / uppercase / payload limits)
      - exact canonical JSON algorithm (RFC 8785 / JCS rules, key ordering, forbidden keys, string/number rules)
      - exact definition of `type_script_hash` (CKB blake2b-256 Molecule script hash)
      - offer & resolution state machines (including single-use and recurrence rules)
      - cryptographic trust model & threat model (self-asserted lifecycle key vs. Fiber node identity, why payer `parse_invoice` + `resolver_url` checks are mandatory)
      - normative error code registry (protocol + resolver error codes and HTTP status mappings)
      - offline vs. resolver-side validation boundary
    - *(audit #2, `F-023`)* The normative core also defines, since none of these are in the list above:
      - the **resolver interop API** — the minimal HTTP surface any wallet needs from any resolver (`GET /offers/:id`, `POST /offers/:id/invoice`, idempotency, `429` semantics, CORS, content types)
      - **Fiber Address** discovery (`user@domain` → `/.well-known/fiberoffer/:user`), its response schema, caching and trust model (rooted in TLS for the domain)
      - **versioning and extension policy** — how a decoder treats `version > 1`, unknown fields, `extensions` and `x_*`, and which extensions a payer may ignore
      - **amount units** per asset type (shannons for CKB, base units for UDT/RGB++)
      - **recurrence semantics** — schedule anchor, subscriber scope (`D-5`), missed cycles, cancellation by either side
      - **invoice binding and proof of payment** (`A8`), the **QR/deep-link payload** format, and a **privacy considerations** section (what the resolver learns about payers, what is public per `D-6`)
  - **Outcome:** `docs/spec-v1.md` is rewritten as one normative document in RFC 2119 terms, 18 numbered sections: roles; the offer and the canonical form of every field (with a grammar for `resolver_url`, the definition of `type_script_hash`, amount units, extension and version policy, size limits); canonical JSON; ID and signature; the encoded form, QR codes and payment links; Fiber Address and what trust it carries; the resolver API a wallet depends on (offer, invoice with its required properties, idempotency, node failures, resolution, revocation, subscription status, CORS, error envelope, `429`); what a payer must verify and what counts as proof of payment; the resolution state machine and single-use rules; recurrence, subscriptions and what the interval does and does not mean; revocation; the error code registry with statuses; what is checked where; the trust and threat model; privacy; prior art (`D4`); conformance. Every normative statement was checked against the code; one was wrong and corrected (a second revocation is answered `409`, not accepted silently). Operational features a wallet does not depend on moved to the new `docs/resolver-api.md`. Rate-limited responses now carry a `Retry-After` header, since the spec requires one.
  - **Stated honestly in the spec:** a resolver does not enforce a recurrence interval (payment is payer-initiated; the interval schedules the payer's wallet); a merchant cannot end a single subscription in v1; Bech32m's four-error guarantee does not hold at this length; a Fiber Address is only as trustworthy as TLS for its domain; the resolver sees who pays.

- [x] **D2. Publish fixed, language-agnostic conformance test vectors** — *done 2026-11-23*
  - **Files:** `docs/test-vectors/` (JSON vectors) + `packages/protocol/test/vectors.test.js`
  - **Acceptance criteria:**
    - Frozen fixtures covering: canonical serialization (including edge-case keys), `offer_id` derivation, Ed25519 signature, Bech32m encoding (lowercase & uppercase), UDT/RGB++ offers, recurring offers, revocations, and negative vectors (tampered field, bad checksum, wrong key type, `__proto__`, non-canonical amount, expired).
    - Automated test suite validates `@fiber-offers/protocol` against the published vectors.
  - **Outcome:** `docs/test-vectors/v1.json` holds 92 fixed cases: 8 canonical JSON, 3 type script hashes, 12 valid offers (each with its ID preimage, ID, signing payload, signature, canonical JSON and both encoded forms), 1 normalization case, 31 invalid offers (most of them validly signed), 11 invalid encodings, 11 requests, 7 revocations and 8 recurring cycle requests. Keys come from published seed labels, and Ed25519 is deterministic, so every signature can be reproduced. `packages/protocol/test/vectors.test.js` checks the package against the committed file and never regenerates it; `scripts/generate-test-vectors.js` reproduces the file byte for byte. `validateResolutionRequest` takes an explicit `now` so an expiry case can be fixed.
  - **Independent verifier (the second criterion of `D6`):** `docs/test-vectors/verify.py` is a second implementation in Python, written from the rules and sharing no code with the package: canonical JSON, Bech32m, Ed25519 checks, every canonical-form rule, the CKB type script hash, request, revocation and subscription checks. It passes all 169 of its checks, agreeing with the JavaScript on every case and, compared one by one, for the same reason. It runs in the test suite where Python and `cryptography` are installed.
  - **Found by writing it:** defining the canonical `resolver_url` as "whatever a WHATWG URL parser prints" cannot be implemented in a language without that parser. The form is now a small grammar any language can check (`F-052`).

- [x] **D3. Reconcile all documentation contradictions** — *done 2026-11-23*
  - **Files:** `docs/spec-v1.md`, `docs/protocol.md`, `docs/architecture.md`, `docs/deployment.md`, `docs/api-quick-reference.md`, `apps/demo/public/docs-*.html`
  - **Acceptance criteria:**
    - Document `invoice.received` in webhook event lists.
    - Include `recurrence` and `expiry` in schema examples.
    - Remove stale `spec-v1.md:327` claim that PostgreSQL / distributed jobs / rate limiting aren't implemented.
    - Align all docs with D-2 (single-use) and A-5 (expiry) behavior.
  - **Outcome:** `invoice.received` is in every webhook event list (`resolver-api.md`, `sdk.md`, the hosted merchants page). The spec's example offer carries `recurrence` and `expiry`. The stale "deployment boundary" paragraph claiming no database-backed store, distributed jobs or rate limiting is gone with the rewrite. Single-use and expiry behaviour are stated once, in the spec, and the other documents link to it. `architecture.md` no longer lists merchant-scoped keys as missing (single-merchant is the design, `D-9`) or live end-to-end tests as missing. Remaining staleness in the `README.md` feature lists is left to `F5`, which rewrites the quick start.

- [x] **D4. Add prior-art & design-rationale section** — *done 2026-11-23*
  - **Files:** `docs/spec-v1.md` or `docs/architecture.md`
  - **Acceptance criteria:**
    - Concise comparison table/section contrasting Fiber Offers with **BOLT12**, **LNURL-pay / Lightning Address (LUD-16)**, and **Fiber native invoices**, explaining why HTTP resolution + lifecycle keys were chosen and what trade-offs they imply.
  - **Outcome:** Section 17 of the spec: a comparison table across nine properties, and the reasons for HTTP (Fiber has no onion messaging or blinded paths, so a BOLT12-style design cannot be deployed), for a separate offer key (the node's RPC does not sign arbitrary messages), for JSON and PEM (readable, about three times the size of a binary form, which is what `D-4` would decide), and for one resolver address (a single point of failure, to be addressed by `E6`).

- [x] **D5. Publish machine-readable schemas and keep types honest** *(audit #2, `F-023`)* — *done 2026-11-23*
  - **Problem:** The only definition of an offer, a revocation, or a resolver response is prose plus the JavaScript validator. `packages/*/src/*.d.ts` are hand-maintained (944 lines in the SDK) and never type-checked against the implementation.
  - **Files:** `docs/schemas/` (JSON Schema for offer, revocation, invoice request/response, error envelope; OpenAPI for the interop API), `packages/protocol/test/`, `packages/*/src/*.d.ts`, CI
  - **Acceptance criteria:**
    - Schemas are published with the spec and every `D2` test vector validates against them in the test suite.
    - A type test (`tsc --noEmit` over a usage file) runs in CI so declarations cannot drift from the code.
  - **Outcome (schemas):** `docs/schemas/v1/` holds thirteen JSON Schemas (2020-12) and `openapi.json` (OpenAPI 3.1) for the seven wallet-facing routes; `docs/schemas/README.md` says what a schema can and cannot establish. They are tested four ways. (1) Vectors: every valid offer fits; of the 31 invalid offers the schema refuses the 26 whose fault is in their shape, and the test names the 5 it cannot (ID, signature, two amount comparisons). (2) Against the package beyond the vectors: about 300 offers produced from random terms all fit, and about 12,000 offers made by changing a valid one in one place are given to both; the schema never refuses what the package accepts, and what the package alone refuses falls under a listed rule. (3) Against the running resolver: the OpenAPI document is validated with the OpenAPI Initiative's own schema, its routes must match the resolver's public route table, and every route is called for every outcome (12 statuses on the invoice route), each answer checked against the schema the document names. Only three documented statuses are not produced, and the test says why. (4) Limits and names are compared with the package's constants.
  - **Outcome (types):** `packages/sdk/test/types.test.js` runs the TypeScript compiler over three things: a hand-written usage file with 20 lines marked as mistakes the declarations must catch; a generated file listing what each of the six entry points really exports and which members each of the eleven classes really has; and a generated file holding what 40 calls to the resolver client really returned from a running resolver, typed as each method's declared return type. It compiles with no DOM and no Node type libraries.
  - **Found by doing it:** `F-053` to `F-056`: declarations that were wrong, a `500` on a public route, an error detail with two types, and several things the reference resolver does that the specification did not say. Two more are open: how nesting depth is counted (`F-057`) and crashes in the Python verifier (`F-058`).
  - **Dev dependencies added, with the owner's go-ahead:** `ajv` 8.20.0 and `typescript` 7.0.2, both exact versions. Nothing was added to what the packages ship.
  - **Left for `F4`:** running this in CI. It already runs in `npm test`.

- [~] **D6. Give the format an ecosystem path** *(audit #2, `F-024`)* — *independent verifier done 2026-11-23; submission for outside review waits for the owner*
  - **Problem:** Critique 2 calls the custom format prototype-level ecosystem infrastructure. A rewritten spec is still a single-author document with one implementation.
  - **Files:** `docs/spec-v1.md`, `docs/architecture.md`, external proposal
  - **Acceptance criteria:**
    - The spec is submitted for review where Fiber and CKB wallet developers work (CKB RFC process or the Fiber repository discussions), and feedback is tracked in this plan's findings log.
    - A second, independent verifier (any other language) decodes, canonicalizes and verifies all `D2` vectors, proving the spec is implementable without reading the JavaScript.
  - **Status:** the second criterion is met by `docs/test-vectors/verify.py` (see `D2`). The first, submitting the spec for outside review, is an outward-facing step that waits for the owner's go-ahead.

---

### Phase E — Format, Browser Portability & Persistence Hardening

> **Goal:** Make client libraries truly browser-portable, eliminate accidental JSON persistence in production, and decide/execute compact v2 format if approved.

- [ ] **E1. Offer size reduction & optional v2 compact format *(depends on D-4)***
  - **Files:** `packages/protocol/src/`, `apps/resolver/src/qr.js`
  - **Acceptance criteria:**
    - **v1 minimum (always):** Uppercase Bech32m in QR codes reduces standard CKB offer from QR v27 → v22.
    - **If D-4 chooses v2:** Define compact binary/CBOR or TLV payload + raw 32-byte Ed25519 public key + embedded `udt_type_script` (`code_hash`, `hash_type`, `args`), staying well under 1,023 Bech32m symbols (or using signed payload without broken >1023-char Bech32m checksum) and maintaining explicit versioned decoding (`v1` vs `v2`).

- [ ] **E2. Make `@fiber-offers/protocol` and `@fiber-offers/sdk/browser` browser-portable**
  - **Problem:** `packages/protocol/src/index.js` imports `"node:crypto"` and uses Node `Buffer`; `packages/sdk/src/browser.js` re-exports from `packages/sdk/src/index.js`, breaking browser/React/mobile bundlers without Node polyfills.
  - **Files:** `packages/protocol/src/index.js`, `packages/protocol/package.json`, `packages/sdk/src/browser.js`, `packages/sdk/src/index.js`, browser bundler smoke test
  - **Acceptance criteria:**
    - Remove direct `Buffer` and `node:crypto` assumptions from browser entrypoints (use `Uint8Array` + Web Crypto / `@noble/ed25519` + `@noble/hashes` or dual conditional exports `"browser"` / `"node"`).
    - Verify `@fiber-offers/sdk/browser` bundles cleanly with zero Node built-ins (e.g. via `esbuild` or Vite check in tests/CI).

- [~] **E3. Harden JSON persistence & enforce database guard in production** — *done 2026-11-23 except the non-root image, which waits for `F4` so the image can be built and booted in CI (Docker is not installed on the development machine)*
  - **Problem:** `Dockerfile` sets `NODE_ENV=production` and runs `npm run dev`; running without `DATABASE_URL` silently falls back to `JsonOfferStore`, whose `save()` uses non-atomic `writeFile()` and rewrites the whole file on every mutation.
  - **Files:** `apps/resolver/src/server.js`, `apps/resolver/src/store.js`, `Dockerfile`, `docs/deployment.md`, `apps/resolver/test/resolver.test.js`
  - **Acceptance criteria:**
    - Refuse startup when `NODE_ENV=production` and `DATABASE_URL` is unset unless an explicit opt-in override (e.g. `RESOLVER_ALLOW_JSON_STORE=true`) is set, with a clear error message.
    - Update `JsonOfferStore.save()` to write to a temp file in the same directory and atomically `rename()` (matching `JsonFileRecurringApprovalStore`).
    - Tests cover both the production guard and crash-safe atomic write behavior.
    - *(audit #2, `F-025`, `F-035`)* `InMemoryOfferStore`/`JsonOfferStore.upsertOffer()` rebuilds the entry and drops `revoked_at` and the `revocation` proof when a revoked offer is re-registered (PostgreSQL keeps them) — preserve both. The image runs `node apps/resolver/src/server.js` directly as a non-root user, and the server handles `SIGTERM` by draining requests and closing the store.
  - **Outcome:** `JsonOfferStore` replaces its file in one step (temporary file beside it, flushed, renamed, then the directory flushed), with mode `0600`. A reader hammering the file during 40 rewrites never sees a partial file; the same reader caught 6 or 7 partial reads out of about 45 against the old in-place write. A write that fails leaves the previous file intact and the store carries on afterwards. A file that is not valid JSON stops the resolver with `STORE_FILE_CORRUPT` instead of being replaced by an empty store. Temporary files left by a crash are cleared at start. Re-registering a revoked offer keeps `revoked_at` and the proof, in all three stores. The resolver handles `SIGTERM` and `SIGINT`: it stops taking connections, answers requests in progress (up to `RESOLVER_SHUTDOWN_TIMEOUT_MS`, default 8000), waits for a running background pass, flushes the store and exits 0, tested against a real child process. The image and the Compose services start Node directly, so the signal reaches it. New `RESOLVER_DATA_PATH` chooses where the file store lives.
  - **Still open:** running the image as a non-root user. It changes who owns the file-store directory and the shared socket volume of the RPC relay, and an existing volume keeps its old owner, so it has to be built and booted to be trusted. That can be done in `F4`.

- [ ] **E4. Make stores and background passes scale** *(audit #2, `F-026`)*
  - **Problem:** The settlement pass (every 3 s by default) lists every offer, loads every resolution of each, and calls Fiber sequentially; the webhook pass loads every event of every offer. The partial indexes `fiber_resolutions_open_idx` and `fiber_webhook_deliveries_pending_idx` exist but no query uses them. No list endpoint paginates (`/offers`, `/resolutions`, `/webhook-events`, reconciliation). Nothing prunes events or stored response bodies. Deliveries are not leased, so two workers (BullMQ concurrency is 2) can send the same event; retries use a fixed 30 s delay. `node_info` is called on every invoice request.
  - **Files:** `apps/resolver/src/server.js`, `apps/resolver/src/store.js`, `apps/resolver/src/postgres-store.js`, `apps/resolver/src/queue-worker.js`, `apps/resolver/migrations/`, `docs/api-quick-reference.md`
  - **Acceptance criteria:**
    - Store API gains `listOpenResolutions(limit, cursor)` and `claimPendingDeliveries(limit)` (`FOR UPDATE SKIP LOCKED`) backed by the existing indexes; passes are bounded per run.
    - Cursor pagination on all list endpoints; retention policy for webhook events and delivery bodies; exponential backoff with a dead-letter state.
    - Node identity is cached with a short TTL.
    - A load test with 10,000 offers / 100,000 resolutions keeps a settlement pass under its interval.

- [ ] **E5. Operator identity and key management** *(audit #2, `F-027`, depends on `D-9`)*
  - **Problem:** One shared `RESOLVER_API_KEY` grants everything; the same key signs operator session cookies, which cannot be revoked. There is no operator-level way to disable an offer whose lifecycle key was lost (`DELETE /offers/:id` needs the offer's own signature). `docs/deployment.md` already lists merchant-scoped identity as missing.
  - **Files:** `apps/resolver/src/server.js`, `apps/resolver/src/postgres-store.js`, `apps/resolver/migrations/`, `docs/deployment.md`
  - **Acceptance criteria:**
    - Multiple named, rotatable API keys with scopes (read / manage / admin), stored hashed; session cookies signed with a separate secret and revocable.
    - Authenticated operator endpoint to disable an offer, distinct from signed revocation and recorded as such.
    - Per `D-9` (decided: single-merchant), the spec and docs state "one resolver, one merchant node" as a design principle: the resolver is part of the merchant's own node stack. Hosting several merchants on one resolver is an explicit non-goal, because it would concentrate RPC access to other merchants' nodes in one operator.

- [ ] **E6. Resolver independence** *(audit #2, `F-039`, per `D-10`)*
  - **Problem:** An offer signs exactly one `resolver_url`. If that host or domain goes away, every offer pointing at it becomes unpayable, and there is no fallback resolver and no way to pay `node_id` without one. That single dependency is the least decentralized part of the design.
  - **Files:** `packages/protocol/src/index.js`, `packages/protocol/src/index.d.ts`, `packages/sdk/src/index.js`, `packages/sdk/src/payment-flow.js`, `docs/spec-v1.md`, `packages/protocol/test/protocol.test.js`, `packages/sdk/test/sdk.test.js`
  - **Acceptance criteria:**
    - A signed, v1-compatible extension carries an ordered, bounded list of fallback resolver URLs, validated with the same rules as `resolver_url` (`C3`). Decoders that do not know the field ignore it and use `resolver_url`.
    - The spec states that every listed resolver MUST be operated by the offer's merchant against the same node and the same store, so single-use and per-subscription state stays consistent. Listing a resolver is a claim of equivalence.
    - The SDK tries `resolver_url` first, then the fallbacks in order, on network error, timeout or `5xx` only — never on `4xx` — and reuses the same idempotency key across attempts. The payer origin check in `A2` accepts any listed origin.
    - `D1` gains a non-normative "open questions" appendix covering (1) resolver-less payment straight to `node_id` (keysend carrying the offer ID; receiving-node behavior unverified, and it gives up the node-signed invoice as proof of payment) and (2) updatable resolver discovery, such as a record controlled by the lifecycle key.
    - Tests: failover on timeout and `5xx`; no failover on `4xx`; a tampered fallback list fails verification.

---

### Phase F — Live Fiber Validation, CI & Reproducible Evidence

> **Goal:** Prove every feature against real, pinned Fiber nodes automatically in CI and publish reproducible evidence.

- [~] **F1. Build reproducible two-node Fiber devnet/regtest fixture** — *in progress: `scripts/local-fiber.js` runs a checksum-verified merchant and payer node on testnet without Docker; funded channels and a UDT channel are still to do*
  - **Files:** `docker-compose.fiber-test.yml` (or `infra/fiber-devnet/`), `scripts/`
  - **Acceptance criteria:**
    - Pinned Fiber node image by digest (`nervos/fiber:0.9.0-rc1@sha256:...`) + CKB devnet/test fixture (or scripted two-node local harness) with funded CKB and UDT channels between payer and merchant nodes.
    - Single command brings up two Fiber nodes + Postgres + Redis + resolver and tears them down cleanly.
    - *(audit #2, `F-028`)* `docker-compose.production.yml` pins the same Fiber image by digest (it currently uses the floating `nervos/fiber:0.9.0-rc1` tag, a release candidate). Keep a compatibility matrix in `docs/live-fiber-testing.md` and run the fixture on a schedule against the newest Fiber release so upstream RPC changes are caught.

- [~] **F2. Upgrade live E2E test to run through the public SDK & cover full matrix** — *done 2026-11-22 except one thing: a token payment has been minted and verified but not settled, because the payer has no token channel*
  - **Problem:** `scripts/live-fiber-e2e-check.js` uses `/demo/offers` and raw `fetch`, bypassing `FiberOffersClient` and `FiberPaymentFlowClient`, and only tests happy-path CKB.
  - **Files:** `scripts/live-fiber-e2e-check.js` (and/or `test/e2e/live-fiber.test.js`)
  - **Acceptance criteria:**
    - Exercises `FiberOffersClient` + `FiberPaymentFlowClient` + `FiberPaymentClient` (no raw `/demo/offers` shortcut).
    - Covers:
      1. CKB reusable offer (two distinct invoices & payment hashes settled to `invoice_paid`)
      2. UDT offer (`udt_type_script` invoice minted & settled)
      3. Single-use offer (first payment succeeds; second attempt rejected; unpaid expiry release if D-2b)
      4. Recurring offer (scheduled cycle execution + cap enforcement)
      5. Invoice expiry (short TTL expires on Fiber and syncs to `invoice_expired`)
      6. Signed revocation (`DELETE /offers/:id` → `410 OFFER_REVOKED`)
      7. Payer-side tamper/substitution rejection test
      8. *(audit #2)* Two independent payers subscribed to one recurring offer (`D-5`)
      9. *(audit #2)* Idempotent retry after a forced transport failure, and confirmation of a payment that ends `Failed` (`A1`, `A7`)
      10. *(audit #2)* Concurrent single-use requests against two resolver replicas (exactly one invoice)
      11. *(audit #2)* Fiber Address resolution, signed webhook delivery end to end, and rejection of an offer whose `network` does not match the node chain
  - **Outcome:** `scripts/live-fiber-e2e-check.js` was rewritten. It starts the real resolver in its own process against the merchant node and drives it only through `FiberOffersClient`, `FiberPaymentFlowClient`, `FiberPaymentClient` and `FiberRecurringPaymentScheduler` with the payer node. Thirteen cases, all passing on Fiber `v0.10.1` testnet with PostgreSQL: `reusable-ckb`, `token-invoice`, `single-use`, `recurring-two-subscribers`, `invoice-expiry`, `revocation`, `tamper-rejection`, `idempotent-retry`, `two-replicas-single-use`, `fiber-address`, `webhook-delivery`, `access-control` (added 2026-11-23 with `G1`), `network-mismatch`. Since `G1` the resolver in this check has an API key: the merchant's client holds it and the payer's client does not. A case that cannot run is reported as skipped with its reason.
  - **Still open:** settling a token payment (needs RUSD and a token channel), and confirming a payment that ends `Failed` on the node, which this setup has no way to force.

- [x] **F3. Commit verifiable live validation evidence** — *done 2026-11-22: `docs/evidence/live-fiber-run.json`, written by `npm run fiber:e2e-check -- --evidence <path>`*
  - **Files:** `docs/evidence/` (e.g. `docs/evidence/live-fiber-run.json` + summary in release notes / `docs/live-fiber-testing.md`)
  - **Acceptance criteria:**
    - Retained JSON transcript including: git SHA, Fiber node version/image digest, network/chain, offer IDs, distinct invoice strings/hashes, payer `get_payment` results, merchant `get_invoice` results, and resolver status transitions.

- [ ] **F4. Add GitHub Actions CI workflow**
  - **Files:** `.github/workflows/ci.yml`
  - **Acceptance criteria:**
    - Runs on every PR and push to `main`:
      1. `npm ci` + `npm test` + `npm run smoke`
      2. `npm run test:infra` against real PostgreSQL 16 + Redis 7 service containers (unskipping all 4 infra tests)
      3. Browser bundle check for `@fiber-offers/sdk/browser` (`E2`)
      4. Protocol conformance vector tests (`D2`)
      5. Live two-node Fiber E2E job (on PR/main or scheduled/manual workflow if heavyweight)
      6. *(audit #2)* Declaration type test and schema validation (`D5`), Docker image build, `docker compose config` validation, `npm audit`, and the unit suite on each supported Node line (20, 22, 24)

- [ ] **F5. Update Quick Start & demo documentation**
  - **Files:** `README.md`, `docs/live-fiber-testing.md`, `docs/releases/`
  - **Acceptance criteria:**
    - Present the live Docker/Fiber path prominently beside the isolated mock quick start, clearly distinguishing mock evaluation from real Fiber RPC execution.
    - Merge the finalized critique assessment updates (including D-1 wording).

- [ ] **F6. Give the hosted testnet merchant durable liquidity** *(audit #2, `F-028`)*
  - **Problem:** `docs/releases/v0.1.0.md` states that the hosted merchant's only liquidity counterparty is a local payer node, so the public demo cannot be paid by an outside wallet once that node is offline.
  - **Files:** `deploy/fiber/config.yml`, `docs/live-fiber-testing.md`, `docs/releases/`
  - **Acceptance criteria:**
    - The hosted merchant has a channel with an always-on public peer, a UDT entry in `udt_whitelist` for the UDT flow, and a monitored inbound-liquidity threshold.
    - `F3` evidence includes at least one payment from a wallet node the project does not operate.

---

### Phase G — Resolver Access Control & Deployment Security *(audit #2)*

> **Goal:** Make the resolver safe to expose publicly: nothing sensitive readable without credentials, no server-side request forgery, no insecure defaults reaching production.

- [x] **G1. Close the unauthenticated read surface** *(`F-029`, depends on `D-6`)* — *done 2026-11-23; confirmed live by the `access-control` case of `npm run fiber:e2e-check`*
  - **Problem:** With an API key configured, these still answer without credentials (reproduced): `GET /offers/:id/resolutions`, `reconciliation.json`, `reconciliation.csv`, `recurrence-status`, `GET /diagnostics`, `GET /topology`. The offer ID is public, so anyone holding a payment link can export the merchant's full payment history; `/diagnostics` returns peer addresses and per-counterparty channel balances, and `/check` embeds a topology snapshot. Public invoice responses also include `raw_result` and `rpc_params`.
  - **Files:** `apps/resolver/src/server.js`, `apps/resolver/src/invoice-adapter.js`, `docs/deployment.md`, `docs/api-quick-reference.md`, `apps/demo/public/app.js`, `apps/resolver/test/resolver.test.js`
  - **Acceptance criteria:**
    - Endpoints follow the `D-6` decision; `/health` exposes only liveness to anonymous callers; public responses omit raw Fiber RPC payloads and liquidity detail.
    - A test enumerates every route and asserts its auth requirement, so a new route cannot ship open by accident.
  - **Outcome:** `server.js` declares every route in one table with its access (`public` or `operator`, plus `demo`), and the dispatcher enforces it before the handler runs, replacing a 440-line chain of `if`s in which each handler had to remember its own check. `apps/resolver/test/route-access.test.js` holds the expected table and fails when a route is added without a line there. Now requiring the key: the resolution list, both reconciliation exports, the recurrence summary across subscribers, `/diagnostics`, `/topology`. Anonymous `/health` returns `ok`, `service` and `invoice_mode` only, and one dependency probe answers for five seconds so health checks cannot be used to load the node. Public responses and webhook payloads carry a trimmed invoice (no `raw_result`, `rpc_params`, `rpc_method`). `/check` runs a route check on the payer node only for operators (or for everyone in demo mode). The CLI `doctor` sends the key with its health request and reports `same_node: null` when it could not compare, instead of assuming a match. Docs updated: `deployment.md` (what is public and what needs the key), `api-quick-reference.md`, `spec-v1.md`, `sdk.md`, `README.md`, the hosted `/docs/api` page.

- [x] **G2. Gate the demo surface** *(`F-030`, `F-031`, depends on `D-8`)* — *done 2026-11-23*
  - **Problem:** `/demo/webhook-receiver` accepts unauthenticated POSTs into an unbounded in-memory array (bodies and request headers) that anyone can read back. `/demo/offers` generates lifecycle keys server-side and returns the private key. `RESOLVER_PUBLIC_OPERATOR_ACCESS` issues an operator cookie to any visitor. When `PAYER_FIBER_RPC_URL` is set, anonymous `/check` calls with a caller-supplied `invoice` run `send_payment` dry-runs on the operator's payer node with caller-supplied route options.
  - **Files:** `apps/resolver/src/server.js`, `.env.example`, `docker-compose.yml`, `docs/deployment.md`
  - **Acceptance criteria:**
    - All demo routes, public operator access and server-side payer dry-runs are disabled unless `RESOLVER_DEMO_MODE=true`; startup logs a prominent warning when it is on.
    - The demo inbox is capped (count and bytes) and does not store request headers.
  - **Outcome:** `RESOLVER_DEMO_MODE` (off by default) gates `POST /demo/offers`, both `/demo/webhook-receiver` routes, `RESOLVER_PUBLIC_OPERATOR_ACCESS` (ignored with a logged warning when demo mode is off) and route checks for anonymous `/check` callers. With it off the demo routes answer `404` even to the API key. The resolver prints a warning at startup when it is on. The inbox keeps the last 50 deliveries, 64 KiB each and 512 KiB in total, stores no request headers, and reading it needs operator access. The demo page reads `demo_mode` from `/operator/session` and, when it is off, explains that offers are signed with the CLI or SDK instead of failing. `dev:mock`, `dev:fiber:local`, `dev:fiber:pair` and `stack:up` turn demo mode on, since they exist to run the demo console locally; plain `npm run dev` and production do not. **A hosted demo that sets `RESOLVER_PUBLIC_OPERATOR_ACCESS=true` must now also set `RESOLVER_DEMO_MODE=true`.**

- [x] **G3. Harden webhook delivery against SSRF** *(`F-032`)* — *done 2026-11-23; checked against real DNS (`localtest.me` refused, a public host reached over TLS) and by the `webhook-delivery` live case*
  - **Problem:** `isPrivateWebhookHost()` is a string match applied only at registration. With private targets disabled it still accepts (reproduced) `http://0.0.0.0/`, `http://[::ffff:127.0.0.1]/`, `http://[fd00::1]/`, `http://[fe80::1]/`, `http://100.64.0.1/`, and any DNS name that resolves privately (`localtest.me`, `metadata.google.internal`). Delivery follows redirects, and the first 2,000 characters of each response are stored and returned by `GET /offers/:id/webhook-events`, which turns the bypass into a read primitive for anyone with operator access (every visitor when public operator access is on).
  - **Files:** `apps/resolver/src/server.js`, `apps/resolver/src/webhook-delivery.js`, `apps/resolver/test/resolver.test.js`
  - **Acceptance criteria:**
    - At delivery time the hostname is resolved, every resolved address is checked against a complete deny list (loopback, RFC 1918, link-local, CGNAT, unspecified, IPv6 ULA/link-local, IPv4-mapped), and the connection is made to the vetted address.
    - `redirect: "manual"`; a redirect is a failed delivery. Response bodies are not stored (status code only).
    - Tests cover each bypass above plus a public URL that redirects to a private one.
  - **Outcome:** New `apps/resolver/src/webhook-target.js`. Deliveries no longer use `fetch`: they use `node:http(s)` with a lookup function that resolves the host, refuses the delivery if any returned address is not public unicast (the full IPv4 and IPv6 special-purpose ranges, with IPv4-mapped, NAT64 and 6to4 addresses judged by the IPv4 address they carry), and hands the socket only addresses that passed, so a name cannot resolve one way for the check and another for the connection. Literal addresses are checked in any spelling (`0x7f.1`, `2130706433`, `[::ffff:127.0.0.1]`). Redirects are never followed (`WEBHOOK_REDIRECT_REFUSED`). The response body is never read; only the status code is recorded, the API strips bodies stored earlier, and migration `005` clears them in PostgreSQL. Registration also refuses single-label names (`redis`) and internal suffixes early. `RESOLVER_ALLOW_PRIVATE_WEBHOOKS=true` switches the address checks off for local development; redirects stay refused.

- [x] **G4. Refuse insecure production configuration** *(`F-033`)* — *startup guards done 2026-11-22; key stretching and rotation done 2026-11-23*
  - **Problem:** `docker-compose.yml` sets `NODE_ENV=production` with fallbacks `RESOLVER_API_KEY=local-dev-api-key`, `RESOLVER_SECRET_ENCRYPTION_KEY=local-dev-encryption-key-change-me` and `POSTGRES_PASSWORD=fiber_offers_dev`, and `docker-compose.production.yml` does not override them. The server also starts in production with no API key (every operator route open) and no encryption key (webhook secrets stored in plaintext). Operator login is not rate limited (150 wrong keys → 150 × `401`).
  - **Files:** `apps/resolver/src/server.js`, `docker-compose.yml`, `docker-compose.production.yml`, `.env.example`, `docs/deployment.md`
  - **Acceptance criteria:**
    - In production the server refuses to start without an API key and encryption key, or with the known development defaults; the production compose file uses `${VAR:?}` for all three secrets.
    - The encryption key is stretched with a KDF and a documented rotation command re-encrypts stored secrets.
    - Tests cover each refusal. (Extends the `E3` database guard.)
  - **Outcome so far:** `apps/resolver/src/production-guard.js` runs in the resolver and queue-worker entrypoints. With `NODE_ENV=production` they exit with a message listing every problem when the API key or encryption key is missing, short or an example value, when `RESOLVER_PUBLIC_URL` is missing or not `https`, or when `DATABASE_URL` is missing (unless `RESOLVER_ALLOW_JSON_STORE=true`) or carries an example password. `docker-compose.production.yml` requires the three secrets and the public URL with `${VAR:?}`. `npm run stack:up` now runs the local stack in development mode. Operator login is rate limited (`B4`).
  - **Outcome (key stretching and rotation):** New `apps/resolver/src/secret-cipher.js`. Secrets are stored as `enc:v2:<salt>:<iv>:<tag>:<ciphertext>`, AES-256-GCM under a key derived with scrypt (N=2^15) and the salt beside the value; derivation is asynchronous and cached per salt, and a process uses one salt for everything it writes. `enc:v1` values are still read. `RESOLVER_SECRET_ENCRYPTION_KEY_PREVIOUS` lets replicas read under the old key while writing under the new one, and `npm run secrets:rotate` rewrites every stored secret under the current key and proves each reads back with that key alone (one transaction in PostgreSQL: a failure changes nothing). Tested on the JSON store and on PostgreSQL. The procedure is in `docs/deployment.md`. Found on the way: the JSON store took its snapshot before queueing a write, so two saves could land out of order; it now snapshots when its turn comes.

- [x] **G5. Least-privilege Fiber RPC access** *(`F-034`)* — *done 2026-11-23; verified against a token-protected Fiber `v0.10.1` node*
  - **Problem:** The adapter authenticates with HTTP Basic credentials only and uses a connection that can call every RPC method, including `send_payment` and channel management, although the resolver needs only `node_info`, `new_invoice`, `get_invoice`, `list_peers` and `list_channels`.
  - **Files:** `apps/resolver/src/fiber-rpc.js`, `apps/resolver/src/invoice-adapter.js`, `docs/deployment.md`
  - **Acceptance criteria:**
    - Confirm what RPC authorization Fiber `0.9.x` offers natively (audit #2 did not verify this; the RPC README is silent on auth) and, if method-scoped tokens exist, support bearer tokens and document a resolver-only token.
    - Otherwise document a filtering proxy that allows only the five methods above.
  - **Outcome:** Fiber has native method-scoped authorization: Biscuit bearer tokens, checked when the node is started with `rpc.biscuit_public_key` (`docs/biscuit-auth.md`, present at tags `v0.8.0`, `v0.9.0-rc1`, `v0.9.1` and `v0.10.1`), so no filtering proxy is needed. `FiberRpcClient` takes a `token`; the resolver, worker and CLI read `FIBER_RPC_TOKEN` (`PAYER_FIBER_RPC_TOKEN` for the optional payer node). **Verified live:** a third local node was started with a Biscuit public key, and a token holding `read("node")`, `read("invoices")`, `write("invoices")`, `read("peers")`, `read("channels")` let the resolver's adapter read the node's identity, create an invoice, read its status and run diagnostics, while `send_payment`, `get_payment`, `open_channel`, `shutdown_channel`, `connect_peer` and `graph_nodes` were refused; a token signed by another key, Basic credentials and no credentials were all refused. `docs/deployment.md` ("Fiber RPC Access") gives the token and the steps. Limits: `write("invoices")` also covers `cancel_invoice` and `settle_invoice` (Fiber has nothing narrower), and the token check is a one-off, not yet a case in the repeatable live run (minting a token needs a Biscuit library; see `F-046`).

- [x] **G6. Response hygiene and disclosure process** *(`F-035`)* — *done 2026-11-23; the pages were checked against the policy by test, not yet in a browser*
  - **Files:** `apps/resolver/src/server.js`, `SECURITY.md`
  - **Acceptance criteria:**
    - `/docs/system-design.png` is served as `image/png` (today `text/html; charset=utf-8`); the app sets `X-Content-Type-Options` and a content security policy itself rather than relying on the host Nginx.
    - `SECURITY.md` states how to report a vulnerability and which versions are supported.
  - **Outcome:** Every response carries `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` (resolution and receipt URLs are capability URLs), `X-Frame-Options: DENY` and a content security policy: `default-src 'none'` for API responses, and for pages only their own scripts, styles and images with nothing inline. HSTS is sent when the public URL is `https`. Static files get their real content type (`image/png` for the diagram). A test asserts the headers on pages, API responses, errors and the QR image, and that no page contains an inline script, style or event handler. `SECURITY.md` covers private reporting through GitHub security advisories, supported versions, scope, and what is deliberately not a vulnerability (demo mode, non-production runs). **Owner action:** enable "Private vulnerability reporting" in the repository's security settings, or the link in `SECURITY.md` will not accept reports. The `SIGTERM` and non-root image parts of `F-035` stay with `E3`.

---

### Phase H — Release & Maintenance *(audit #2)*

> **Goal:** Get the fixes to the people already using the published packages, and keep the project maintainable.

- [ ] **H1. Ship the fixes as a versioned release** *(`F-036`, depends on `D-7`)*
  - **Problem:** `@fiber-offers/protocol`, `@fiber-offers/sdk` and `@fiber-offers/cli` `0.1.0` are already on npm with the defects in Phases A and C. The plan had no step that gets fixes to those users, and the repo has no changelog.
  - **Files:** `CHANGELOG.md`, `packages/*/package.json`, `apps/cli/package.json`, `docs/releases/`, `.github/workflows/`
  - **Acceptance criteria:**
    - `CHANGELOG.md` with migration notes for every behavior change (`C3` stricter validation, `C4` legacy decoding, `D-2` single-use semantics, `D-5` recurrence scope).
    - Release published from CI with npm provenance, gated on the `F3` evidence run; `0.1.0` deprecated with a pointer to the fixed version.

- [ ] **H2. Repository hygiene** *(`F-037`)*
  - **Files:** `apps/resolver/src/fiber-rpc.js`, `packages/sdk/src/fiber-payment.js`, `.github/`, `CONTRIBUTING.md`
  - **Acceptance criteria:**
    - One `FiberRpcClient` implementation (the resolver and SDK each carry their own today). *Done with `A6`.*
    - Dependency update automation and a contribution guide that points at the spec, vectors and this plan.

- [ ] **H3. Observability and recovery**
  - **Problem:** `docs/deployment.md` lists metrics, alerting and backups as still needed; none of it is in Phases A–F.
  - **Files:** `apps/resolver/src/server.js`, `docs/deployment.md`
  - **Acceptance criteria:**
    - A metrics endpoint (invoice latency, RPC errors, sync lag, webhook backlog), request IDs in structured logs, and a documented, tested PostgreSQL backup and restore procedure.

---

## 4. New Findings Log

> Add any new bugs, protocol ambiguities, or Fiber RPC quirks discovered during implementation here, then link them to a Phase item above (or create a new item).

| ID | Date | Area | Finding | Severity | Mapped To | Status |
| --- | --- | --- | --- | --- | --- | --- |
| **F-001** | 2026-11-22 | CLI | `apps/cli/src/index.js` accepts `--asset-type` (`udt`/`rgbpp`) without a `--type-script-hash` option, so non-CKB offer creation always fails validation. | Medium | `A4` | Fixed |
| **F-002** | 2026-11-22 | SDK | `FiberOffersClient.getOffer()` and `resolveFiberAddress()` skip `verifyOffer()` on resolver responses (not just `resolveOffer()`). | High | `A2` | Fixed |
| **F-003** | 2026-11-22 | Adapter / Fiber `v0.9.0-rc1` | `FiberRpcInvoiceAdapter` omits `expiry` in `new_invoice` and omits `expires_at` in its return value; Fiber `v0.9.0-rc1` never marks invoices without `expiry` as `Expired`, so expiry only works in mock mode. | High | `A5` | Fixed |
| **F-004** | 2026-11-22 | Protocol | `canonicalize()` silently drops `"__proto__"` from signed bytes and reorders integer-like object keys numerically instead of lexicographically. | High | `C1` | Fixed |
| **F-005** | 2026-11-22 | Protocol | `verifyOffer()` accepts RSA-2048, P-256, and Ed448 keys under `signature.scheme: "ed25519"`. | High | `C2` | Fixed |
| **F-006** | 2026-11-22 | Resolver | Anonymous callers can permanently exhaust single-use offers (even when unpaid invoices expire) and drain all cycles/caps on recurring offers. | High | `B1`, `B2` | Fixed (`B1`, `B2`) |
| **F-007** | 2026-11-22 | SDK / Resolver | Single-use `payOffer()` fails with `blocked_after_invoice` because the second `/check` call counts the invoice that was just minted. | High | `A1` | Fixed |
| **F-008** | 2026-11-22 | SDK / Browser | `@fiber-offers/sdk/browser` re-exports `@fiber-offers/protocol`, which statically imports `node:crypto` and uses `Buffer`. | Medium | `E2` | Open |
| **F-009** | 2026-11-22 | Resolver / Docker | `Dockerfile` sets `NODE_ENV=production`, yet running without `DATABASE_URL` silently falls back to non-atomic `JsonOfferStore`. | Medium | `E3` | Fixed |
| **F-010** | 2026-11-22 | SDK / Resolver | Idempotent retry is blocked by the pre-invoice `/check` (`OFFER_ALREADY_USED` for single-use, `INVALID_RECURRENCE_CYCLE` for recurring), so a transient failure after invoice issuance strands the payment; the scheduler burns its 8 retries and marks the approval failed. *Reproduced.* | High | `A1` | Fixed |
| **F-011** | 2026-11-22 | SDK | `resolveFiberAddress("alice@other.example")` queries the configured `resolverUrl` and ignores the address domain. *Reproduced.* | Medium | `A2` | Fixed |
| **F-012** | 2026-11-22 | CLI | `create` has no recurrence flags; recurring offers cannot be created from the CLI. | Low | `A4` | Fixed |
| **F-013** | 2026-11-22 | Resolver / SDK | No timeout on any Fiber RPC or resolver HTTP call; a hung FNN holds the per-offer invoice lock indefinitely. | Medium | `A6` | Fixed |
| **F-014** | 2026-11-22 | SDK | `payOffer()` reports `payment_sent` on `send_payment` acceptance (`Created`/`Inflight`) and never calls `get_payment`; the scheduler counts the cycle as paid immediately and re-sends after a crash. | High | `A7` | Fixed |
| **F-015** | 2026-11-22 | Protocol / Resolver | Invoices are not bound to an offer or resolution (description is the offer description or ID); receipts are unsigned resolver assertions. | Medium | `A8` | Fixed |
| **F-016** | 2026-11-22 | Resolver / Protocol | Recurrence cycle counter is global per offer and enforced by a unique index; a second payer's cycle 1 gets `409 INVALID_RECURRENCE_CYCLE`. One subscriber per recurring offer. *Reproduced.* | High | `B2`, `D-5` | Fixed |
| **F-017** | 2026-11-22 | Resolver / Deploy | Rate limiter keys on the client-controlled first `X-Forwarded-For` value, also behind the bundled Nginx; rotating it bypasses the limit. In-memory buckets never evicted; operator login, revocation and QR are unlimited. *Reproduced.* | High | `B4` | Fixed |
| **F-018** | 2026-11-22 | Resolver / Deploy | Response origin trusts `X-Forwarded-Host`/`-Proto`; payment links, lookup URLs, QR payloads and stored webhook payloads can be poisoned. *Reproduced.* | High | `B4` | Fixed |
| **F-019** | 2026-11-22 | Resolver | Resolution transitions are unconstrained between non-terminal states (`invoice_received → invoice_created` accepted) and checked outside the store transaction, allowing duplicate `invoice.paid` events under concurrent sync. *Backward transition reproduced.* | Medium | `B5` | Fixed |
| **F-020** | 2026-11-22 | Resolver | Expiry is applied at read time only; stored status never becomes `invoice_expired`, so `invoice.expired` webhooks never fire outside Fiber sync. | Medium | `B5` | Fixed |
| **F-021** | 2026-11-22 | Protocol | Missing cross-field invariants and size bounds (unpayable recurrence amount, `single_use` + `recurrence`, past expiry, duplicate assets, 200 KB description, free-form symbol, plain-HTTP credentialed `resolver_url` on mainnet). *Reproduced.* | Medium | `C3` | Fixed |
| **F-022** | 2026-11-22 | Protocol | Encoding malleability: extra unsigned `signature` members, non-canonical base64url, and non-normalized `resolver_url` all verify. *Reproduced.* | Low | `C3` | Fixed |
| **F-023** | 2026-11-22 | Spec | `D1` scope omits the resolver interop API, Fiber Address, versioning/extension policy, units, recurrence semantics and privacy; no machine-readable schema; `.d.ts` files are never type-checked. | Medium | `D1`, `D5` | Fixed (`D1`, `D5`) |
| **F-024** | 2026-11-22 | Spec / Ecosystem | No standards-track submission or independent implementation, which is the substance of Critique 2's "ecosystem infrastructure" point. | Medium | `D6` | Open |
| **F-025** | 2026-11-22 | Resolver | In-memory/JSON store drops `revoked_at` and the revocation proof when a revoked offer is re-registered. *Reproduced.* | Low | `E3` | Fixed |
| **F-026** | 2026-11-22 | Resolver | Background passes are O(offers × resolutions) every 3 s; existing partial indexes are unused; no pagination, retention, delivery leasing or backoff. | Medium | `E4` | Open |
| **F-027** | 2026-11-22 | Resolver | One shared API key that also signs unrevocable session cookies; no operator-level way to disable an offer whose lifecycle key is lost. | Medium | `E5`, `D-9` | Open |
| **F-028** | 2026-11-22 | Live validation | Hosted merchant's only liquidity counterparty is a local payer node (per release notes); production compose uses a floating release-candidate Fiber tag; no version compatibility tracking. | Medium | `F1`, `F6` | Open |
| **F-029** | 2026-11-22 | Resolver | With an API key set, resolution lists, reconciliation exports, recurrence status, `/diagnostics` (channel balances) and `/topology` answer anonymously. Documented as intentional in `docs/deployment.md`. *Reproduced.* | High | `G1`, `D-6` | Fixed |
| **F-030** | 2026-11-22 | Resolver | Demo routes ship enabled: unauthenticated, unbounded, world-readable webhook inbox; server-generated private keys; public operator cookie mode. *Reproduced.* | Medium | `G2`, `D-8` | Fixed |
| **F-031** | 2026-11-22 | Resolver | With `PAYER_FIBER_RPC_URL` set, anonymous `/check` runs dry-run payments for caller-supplied invoices on the operator's payer node. | Low | `G2` | Fixed |
| **F-032** | 2026-11-22 | Resolver | Webhook SSRF filter is string-based and registration-only; accepts `0.0.0.0`, IPv4-mapped and private IPv6, CGNAT, and private-resolving DNS names; delivery follows redirects; response bodies are stored and returned. *Reproduced.* | High | `G3` | Fixed |
| **F-033** | 2026-11-22 | Deploy | Compose runs `NODE_ENV=production` with known default API key, encryption key and database password; server starts in production with neither key; operator login unlimited. *Login reproduced.* | High | `G4` | Fixed |
| **F-034** | 2026-11-22 | Resolver | Fiber RPC access is all-methods with Basic auth only. Fiber's own RPC auth is a bearer token (`fnn-cli --auth-token`, seen on `v0.10.1`), which the adapter cannot send. Whether tokens can be scoped per method is still unverified. | Low | `G5` | Fixed |
| **F-035** | 2026-11-22 | Resolver / Docker | PNG served as `text/html`; no app-level security headers; no `SIGTERM` handling; image runs as root through `npm run dev`. *Content type reproduced.* | Low | `G6`, `E3` | Headers, content type and `SECURITY.md` fixed with `G6`; `SIGTERM` handling fixed with `E3`; non-root image still open (`E3`, `F4`) |
| **F-036** | 2026-11-22 | Release | `0.1.0` packages are on npm with the Phase A/C defects; no release, deprecation or changelog step existed in the plan. | Medium | `H1`, `D-7` | Open |
| **F-037** | 2026-11-22 | Maintainability | Duplicated logic already diverging: two `FiberRpcClient`s; three recurrence validators (server counts failed cycles, stores do not). | Low | `B3`, `H2` | Fixed |
| **F-038** | 2026-11-22 | SDK | Scheduler: `monthly` drifts (`Jan 31 → Mar 3`, *reproduced*); `attempts` grows without bound; fixed idempotency key replays an expired invoice forever. | Low | `A7` | Fixed |
| **F-039** | 2026-11-22 | Spec / Protocol | An offer signs exactly one `resolver_url`. If that host or domain goes away, every offer pointing at it is unpayable; there is no fallback resolver and no way to pay `node_id` without a resolver. | Medium | `E6`, `D1`, `D-10` | Open |
| **F-040** | 2026-11-22 | Live validation | The pinned `nervos/fiber:0.9.0-rc1` is a release candidate with no downloadable binary release, and upstream has since shipped `v0.9.0`, `v0.9.1`, `v0.10.0` and `v0.10.1` (2026-11-13). Everything in Phase A was checked against `v0.10.1`; nothing has been checked against the pinned image. | Medium | `F1`, `F6` | Open |
| **F-041** | 2026-11-22 | Fiber `v0.10.1` | `new_invoice` mints an invoice for a UDT type script that is not on the node's whitelist. The resolver's hash-verified registry (`A4`) is therefore the only thing stopping an invoice for an unsupported token. Informational; no change needed. | Low | `A4` | Noted |
| **F-042** | 2026-11-22 | Scripts | `scripts/fiber-direct-channel-fixture.js` called `open_channel` straight after `connect_peer`; a live node refuses that until the peers have exchanged Init messages, so the fixture always failed on a fresh pair. Found on first live use. | Low | `F1` | Fixed |
| **F-043** | 2026-11-23 | SDK | `createOffer()` passed its `username` option, which is the Fiber Address to register the offer under, to the Fiber node as an HTTP Basic user name. Harmless against an open node; against a token-protected node it would replace the credentials with `Basic coffee:`. RPC credentials now have their own options (`fiberRpcToken`, `fiberRpcUsername`, `fiberRpcPassword`). | Low | `G5` | Fixed |
| **F-044** | 2026-11-23 | Fiber `v0.10.1` | A node with token authentication answers a missing, invalid or insufficient token with JSON-RPC error `-32999 Unauthorized` over HTTP `200`, not HTTP `401`. The resolver classified that as `FIBER_INVOICE_REJECTED`; it now reports `FIBER_RPC_UNAUTHORIZED`. | Low | `G5`, `A6` | Fixed |
| **F-045** | 2026-11-23 | CLI | The CLI had no way to authenticate to the merchant node, so `doctor` and `create` could not be used with a node whose RPC is protected; and `doctor` reported `same_node: true` when the resolver had not said which node it uses. It now reads `FIBER_RPC_TOKEN`, sends the resolver key with its health request, and reports `same_node: null` when it could not compare. | Low | `G1`, `G5` | Fixed |
| **F-046** | 2026-11-23 | Live validation | The repeatable live run does not cover a token-protected node. `scripts/local-fiber.js` cannot start a node with `rpc.biscuit_public_key`, and minting a token needs a Biscuit implementation (the check for `G5` used `@biscuit-auth/biscuit-wasm` from a scratch directory, outside the repo). Worth adding as a case once `F4` decides how CI provisions nodes. | Low | `F1`, `F2` | Open |
| **F-047** | 2026-11-23 | Resolver | The JSON store serialized its state before queueing the write, so two saves in quick succession could be written in the wrong order and the older state would win. It now takes the snapshot when the write's turn comes. Non-atomic writes (`F-009`) are still open under `E3`. | Low | `E3`, `G4` | Fixed |
| **F-048** | 2026-11-23 | Resolver | Public reads that hit the store (`GET /offers/:id`, a resolution, a receipt, a Fiber Address) are not rate limited, unlike `/check`, `/invoice` and the QR route. Not added with `G1` because the demo page polls each resolution it shows and a shared limit needs sizing first. | Low | `E4` | Open |
| **F-049** | 2026-11-23 | SDK | `getReconciliationCsv()` threw errors without a `code`, with the resolver's raw JSON as the message, because text requests did not parse the resolver's error body. Found by the first live run of the `access-control` case, which expected `401 UNAUTHORIZED` and got the raw body. Text and JSON requests now share one error shape. | Low | `G1` | Fixed |
| **F-050** | 2026-11-23 | Resolver | The resolver re-validated a stored offer whenever it built a payment link, so one stored offer that no longer verified made `GET /offers` fail for every offer, and a payer's invoice request for it got `400` as if the request were wrong. Found while checking what `C3` does to existing data. Stored offers are now listed with `valid: false` and the reason, and an invoice request for one is `409 OFFER_INVALID`. | Medium | `C3` | Fixed |
| **F-051** | 2026-11-23 | Demo | `apps/demo/public/subscription.js` carries its own copy of the canonical serializer, in the old sorted-object style. It is safe for what it signs (a fixed set of field names), and a test checks it against the protocol package, but it is a second implementation of the signed form in the repository. Replace it with the protocol package once `E2` makes that loadable in a browser. | Low | `E2` | Open |
| **F-052** | 2026-11-23 | Protocol / Spec | The canonical form of `resolver_url` was defined by the WHATWG URL serializer, which another language cannot reproduce without porting that parser (IDN mapping, percent-encode sets, IPv4 number parsing). Found while writing the Python verifier. The accepted form is now a fixed grammar: `http(s)://`, a lowercase host name or IP literal, an optional non-default port, and path segments of `A-Z a-z 0-9 . _ ~ -`. The JavaScript still normalizes loose input through the URL parser, then requires the result to fit the grammar. | Medium | `C3`, `D1`, `D2` | Fixed |
| **F-053** | 2026-11-23 | SDK | The hand-written declarations were wrong in ways the first compile found. `FiberOfferNetwork` was used and never imported, so it was an error for anyone compiling with library checks and silently `any` otherwise. They needed the DOM type library (`Storage`, global timers). `getResolutions()` was declared as a list and returns `{ offer_id, resolutions }`. A resolution's `invoice` was declared as a string and is an object; its ID was declared as `resolution_id` and is `id`. Webhook events and delivery results named members that do not exist. `revokeOffer()` could not be given the result of `createOfferRevocation()` under strict typing. The browser entry point exported 22 of the 103 types. | Medium | `D5` | Fixed |
| **F-054** | 2026-11-23 | Resolver | `GET /.well-known/fiberoffer/%E0%A4%A` (a name that is not valid percent-encoding) answered `500 INTERNAL_ERROR` to an anonymous caller and logged a stack trace. Found by exercising the address route for the OpenAPI test. Now `400 INVALID_USERNAME`. | Low | `D5` | Fixed |
| **F-055** | 2026-11-23 | Resolver | `error.details.cause_code` was a string for a network failure (`ECONNREFUSED`) and a number for a JSON-RPC error (`-32602`), while the SDK declares it a string. Found when the error schema refused a real `502`. Always a string now. | Low | `D5` | Fixed |
| **F-056** | 2026-11-23 | Spec | Things the reference resolver does that the specification did not state, each found when a schema or the OpenAPI document had to say it: the body of an accepted revocation; `enabled` in a subscription status and the answer for an offer that is not recurring; `INVALID_INTEGER` for a request amount that is not a number; `INVALID_USERNAME` for a malformed address; `503 RATE_LIMITER_UNAVAILABLE` on the revoke, status and readiness routes; that a port is at most 65535; which characters count as white space (regular expression engines disagree on `\s`); and nine error codes of the protocol package missing from section 13. A test now keeps that list complete. | Low | `D5` | Fixed |
| **F-057** | 2026-11-23 | Spec / Protocol | "Free-form content nests at most 8 levels deep" does not say where counting starts. Both implementations count `metadata` from itself and extension fields from the object that holds all of them, so `extensions` gets one level less than `metadata`, and no vector sits on the boundary. Found by the schema comparison (`extensions` nested eight deep was refused). | Low | `D2`, `D5` | Open |
| **F-058** | 2026-11-23 | Verifier | Given about 12,000 changed offers, `docs/test-vectors/verify.py` and the package agree on which to accept and which to refuse in every case, but in 142 of them the verifier raises an unhandled exception where it should refuse: a list or object where `network`, `asset_type` or `interval` should be a string, and text that is not well-formed Unicode. | Low | `D2`, `D6` | Open |

---

## 5. Progress & Change Log

| Date | Phase / Item | Commit / PR | Notes |
| --- | --- | --- | --- |
| 2026-11-22 | Plan initialized | `730f113` (baseline) | Created living remediation plan covering validated critiques, Phases A–F, open decisions D-1..D-4, and findings F-001..F-009. |
| 2026-11-22 | Audit pass #2 | `730f113` (no code changes) | Full repo re-audit. Re-verified A1–F5. Amended `A1`, `A2`, `A4`, `A6`, `B2`, `B3`, `C3`, `D1`, `E3`, `F1`, `F2`, `F4`; added `A7`, `A8`, `B4`, `B5`, `D5`, `D6`, `E4`, `E5`, `F6`, Phases G (`G1`–`G6`) and H (`H1`–`H3`); added decisions D-5..D-9 and findings F-010..F-038. Corrected the encoded-offer size figures in §1. |
| 2026-11-22 | Decisions D-6, D-7, D-8 | — | All three decided as recommended (option b). Unblocks `G1`, `H1` and `G2`. D-1..D-5 and D-9 remain open. |
| 2026-11-22 | Decision D-5 | — | Decided (b): per-subscription recurrence. Unblocks the `B2` amendment and the recurrence section of `D1`. Logged `F-039` (single signed `resolver_url`) while reviewing D-9 against the decentralization goal. D-1..D-4 and D-9 remain open. |
| 2026-11-22 | Decisions D-1, D-2, D-3, D-9, D-10 | — | D-9 decided (a) by the owner. D-10 (new, for `F-039`) decided (b) and added as `E6`; `E5` updated to the single-merchant principle. D-1..D-3 adopted as recommended under the owner's standing instruction to take the best approach. Only D-4 (v1 vs. breaking v2) remains open, deliberately deferred until Phases A–D are done. |
| 2026-11-22 | `A1` done, `B3` partly | `fix(resolver): stop readiness checks counting the invoice under check` | Fixes `F-007` and `F-010`. Suite: 117 tests, 113 pass, 4 infra tests skipped (no local Redis; PostgreSQL has no role for this user yet). |
| 2026-11-22 | `A6` done, `H2` partly | `fix(resolver): report whether a failed invoice request is retryable` | Fixes `F-013`. One shared RPC client with deadlines. Suite: 122 tests, 118 pass, 4 skipped. |
| 2026-11-22 | `A3` done | `fix(resolver): mint invoices in the currency of the offer network` | Mainnet and devnet invoices were impossible (`Fibt` was hardcoded). Network checked against the node. Suite: 129 tests, 125 pass, 4 skipped. |
| 2026-11-22 | `A4` step 1 | `feat(protocol): compute CKB script hashes for token asset verification` | Adds `ckbScriptHash()` / `parseCkbScript()`, verified against three mainnet system script hashes. New dependency `@noble/hashes` (first step of `E2`); minimum Node is now 20.19. Suite: 132 tests, 128 pass, 4 skipped. |
| 2026-11-22 | `A4` done | `feat(resolver): mint token invoices from a hash-verified script registry` | Fixes `F-001`, `F-012`. Token invoices were never valid Fiber requests before. Suite: 134 tests, 130 pass, 4 skipped. |
| 2026-11-22 | `A5` done | `fix(resolver): issue invoices that expire and record when they do` | Fixes `F-003`. Suite: 137 tests, 133 pass, 4 skipped. |
| 2026-11-22 | `A2` done | `feat(sdk): verify offers and invoices before a wallet pays` | Fixes `F-002`, `F-011`. A hostile resolver can no longer redirect a payment made through the SDK. Suite: 145 tests, 141 pass, 4 skipped. |
| 2026-11-22 | `A8` done | `feat(sdk): bind every invoice to its offer and resolution` | Fixes `F-015`. Suite: 146 tests, 142 pass, 4 skipped. |
| 2026-11-22 | `A7` done — Phase A complete | `fix(sdk): count a payment as made only after confirmation` | Fixes `F-014`, `F-038` (SDK half). Suite: 152 tests, 148 pass, 4 skipped. Phase A items A1–A8 are all done; their live-node confirmations are collected under `F2`. |
| 2026-11-22 | `B4` done | `fix(resolver): identify clients and origins from trusted configuration only` | Branch `fix/trusted-proxy-headers-and-production-startup-guards`. Fixes `F-017`, `F-018`. Suite: 157 tests, 153 pass, 4 skipped. |
| 2026-11-22 | `G4` partly, `E3` partly | `feat(resolver): refuse to start in production with unsafe settings` | Fixes the startup half of `F-033` and the guard half of `F-009`. Suite: 162 tests, 158 pass, 4 skipped. |
| 2026-11-22 | `F1` partly; live confirmation of `A2`–`A5`, `A8` | `feat(scripts): run verified local Fiber nodes without needing Docker` | Branch `feat/local-fiber-nodes-for-live-validation-without-docker`. Fiber `v0.10.1` merchant and payer nodes run on this machine (testnet). The resolver and SDK were run against them end to end up to the route check; every Phase A open point was confirmed, and one fix followed (`fix(sdk): keep invoice descriptions within the 639 bytes Fiber accepts`). Logged `F-040`, `F-041`. A real payment still needs a funded channel. |
| 2026-11-22 | First live payments; `F2` partly | `fix(scripts): wait for the peer handshake before opening a channel` | Both local nodes were funded from the testnet faucet (10,000 CKB each) and a 1,000 CKB payer→merchant channel opened. Paid through the SDK on Fiber `v0.10.1`: two reusable payments, one single-use payment (second refused), two recurring cycles; resolver sync reached `invoice_paid`. Confirms `A1` and `A7` live. Logged and fixed `F-042`. Not yet covered live: token payment (needs a UDT channel), expiry-then-pay, revocation, tamper rejection, the pinned `0.9` line. |
| 2026-11-22 | Local PostgreSQL and Redis available | — | The owner created a PostgreSQL role and installed Redis. The four infrastructure tests that had always been skipped now run locally: the suite is 162 of 162 with nothing skipped. Run them with `TEST_DATABASE_URL` and `TEST_REDIS_URL` set. |
| 2026-11-22 | `B5` done | `fix(resolver): move resolution status forward only, one change at a time` | Branch `fix/phase-b-offer-lifecycle-and-abuse-resistance`, after `feat(protocol): sign recurring cycle requests with a subscriber key`. Fixes `F-019`, `F-020`. Suite: 169 of 169. |
| 2026-11-22 | `B1`, `B3` done | `fix(resolver): use up a single-use offer on payment, not on request` | Implements decision D-2. One request no longer burns a single-use offer. Suite: 173 of 173. |
| 2026-11-22 | `B2` done — Phase B complete | `feat(resolver): count recurring cycles separately for each signed subscription` | Implements decisions D-5 and D-3. Fixes `F-006`, `F-016` and the rest of `F-038`. Suite: 178 of 178. |
| 2026-11-22 | Phase B confirmed live | `fix(resolver): refresh a subscription from the node before reporting it` | Run on Fiber `v0.10.1` testnet nodes with PostgreSQL: an abandoned single-use invoice held the offer, released it when it lapsed on the node, and a later payment used it up; two subscribers each paid two cycles of one recurring offer; a forged cycle request was refused. The run showed `recurrence-status` lagging the node by one payment, now fixed. Suite: 179 of 179. |
| 2026-11-22 | `F2` (all but a settled token payment), `F3` done | `feat(scripts): prove the full payment matrix on live Fiber nodes`, then `docs(evidence): record the live run of all twelve cases` | 12 of 12 live cases pass on Fiber `v0.10.1` testnet with PostgreSQL, through the public SDK only. The transcript in `docs/evidence/live-fiber-run.json` was produced from commit `d45be25` with a clean tree. |
| 2026-11-23 | `G1`, `G2` done | `fix(resolver): require the API key for payment history and node diagnostics` | Branch `fix/phase-g-resolver-access-control-and-deployment-security`. Implements decisions D-6 (refined, see the table) and D-8. Fixes `F-029`, `F-030`, `F-031`. Routing is now one declared table with enforced access. Suite: 189 of 189. |
| 2026-11-23 | `G3` done | `fix(resolver): vet webhook targets at delivery time against SSRF` | Fixes `F-032`. Migration `005`. Suite: 195 of 195. |
| 2026-11-23 | `G4` done | `feat(resolver): stretch the secret encryption key and add key rotation` | Finishes `F-033`. New `npm run secrets:rotate` and `RESOLVER_SECRET_ENCRYPTION_KEY_PREVIOUS`. Fixes `F-047`. Suite: 202 of 202. |
| 2026-11-23 | `G5` done | `feat(sdk): authenticate to Fiber nodes with scoped Biscuit tokens` | Fixes `F-034`, `F-043`, `F-044`, `F-045`. Verified against a token-protected Fiber `v0.10.1` node started for the purpose and removed afterwards. Suite: 204 of 204. |
| 2026-11-23 | `G6` done — Phase G complete | `fix(resolver): set security headers itself and add a security policy` | Fixes the header and content-type parts of `F-035`. Suite: 206 of 206. Logged `F-046` and `F-048` as open follow-ups. |
| 2026-11-23 | Phase G confirmed live | `fix(sdk): report a refused CSV request with the resolver's error code`, then `docs(evidence): record the live run with the access split` | 13 of 13 live cases pass on Fiber `v0.10.1` testnet with PostgreSQL, run from a clean tree at `7b44190` (`bf024fa` before the 2026-11-23 reword, see below). The resolver has an API key in this run: the payer's client is refused on nine merchant routes, reads only its own resolution and receipt, and webhook delivery goes through the guarded transport. The first run failed one case and found `F-049`. Suite: 207 of 207. |
| 2026-11-23 | `C1`–`C4` done — Phase C complete | `fix(protocol): give every offer one canonical form and one identity`, `feat(resolver): render offer QR codes in the compact uppercase form`, `fix(resolver): flag stored offers that no longer pass verification` | Branch `fix/phase-c-signing-canonical-form-and-decoding-hardening`. Fixes `F-004`, `F-005`, `F-021`, `F-022`, `F-050`. Decisions on unknown fields, `http`, unbounded amounts, numbers in metadata and limits are recorded under `C3`. Offer QR codes shrink from version 27 to 22. Suite: 226 of 226. |
| 2026-11-23 | Phase C confirmed live; `D2` done | `docs(evidence): record the live run under the stricter offer rules`, `test(protocol): publish conformance vectors with an independent verifier` | 13 of 13 live cases pass under the Phase C rules. Branch `docs/phase-d-normative-specification-and-conformance-vectors`: 92 frozen vectors, checked by the package and by an independent Python implementation (169 checks). Fixes `F-052`. Suite: 237 of 237. |
| 2026-11-23 | `D1`, `D3`, `D4` done | `docs(spec): rewrite the specification as one normative document` | Normative spec in 18 sections, operational API split into `docs/resolver-api.md`, documentation contradictions reconciled, prior art and rationale added. `D5` (schemas, type test) is the remaining code item of Phase D; `D6` needs the owner. Suite: 237 of 237. |
| 2026-11-23 | Decision D-4 | — | Decided (a) for now: stay on v1, revisit a compact v2 after outside review. All decisions D-1..D-10 are now made. `E1` reduces to what is already done (uppercase QR) plus the deferred v2. |
| 2026-11-23 | First push to GitHub | — | At the owner's instruction to push gradually rather than all at once, the eight stacked branches were pushed one at a time, oldest first, after scanning all 38 commits for secrets (none; the only private keys are the published test-vector keys). Before the push, one unpushed commit subject that was a word short of the owner's format was reworded (`…count recurring cycles separately for each signed subscription`), which changed the IDs of the 20 commits from that point on; file contents, authors and dates are identical. Live-run transcripts committed before the reword name the old IDs, so the check was run again at the end and the current transcript names a commit that exists. From here on, commits are pushed as they land. |
| 2026-11-23 | `E3` (all but the non-root image) | `fix(resolver): replace the store file atomically and stop cleanly on SIGTERM` | Branch `fix/phase-e-durable-file-store-and-clean-shutdown`, pushed as it landed. Fixes `F-009`, `F-025` and the `SIGTERM` part of `F-035`. Suite: 246 of 246. |
| 2026-11-23 | Owner's go-ahead for dev dependencies | `chore(deps): add ajv and typescript for the schema and type checks` | The owner answered the open question on `D5` with "you can go ahead". `ajv` 8.20.0 and `typescript` 7.0.2 as exact-version dev dependencies. Also removed a Python bytecode file that had been committed with the vectors by mistake (`chore(repo): stop tracking the Python bytecode cache`). Branch `feat/phase-d-published-json-schemas-and-declaration-type-checks`. |
| 2026-11-23 | `D5` schemas | `feat(schemas): publish JSON Schemas and an OpenAPI description of the wallet routes` | Thirteen schemas and an OpenAPI 3.1 document under `docs/schemas/v1/`, tested against the vectors, the package and the running resolver. Fixes `F-054`, `F-055`, `F-056`. |
| 2026-11-23 | `D5` types — `D5` done | `fix(sdk): correct the declarations and type-check them on every test run` | Fixes `F-053`. The compiler now checks the declarations against the code and against 40 real resolver responses. Suite: 264 of 264. `F-057` and `F-058` logged as open. |
