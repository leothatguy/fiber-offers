# Requirements Traceability

This matrix reconciles the original PRD, FRD, and TRD with the implemented reference system. The original documents assumed that FNN exposed arbitrary message signing. The current [official Fiber RPC surface](https://github.com/nervosnetwork/fiber/blob/develop/crates/fiber-lib/src/rpc/README.md) exposes node identity and invoice/payment methods but no arbitrary signing method.

Fiber Offers therefore uses an Ed25519 offer lifecycle key for portable integrity and revocation. In live mode, the resolver independently calls `node_info` and rejects registration or invoice minting unless the signed `node_id` matches the configured Fiber node. This is a resolver-attested identity binding, not a Fiber-node signature.

| Requirement | Status | Implementation evidence |
| --- | --- | --- |
| FR-OC-1 node-backed creation | Complete | SDK `createOffer()` fetches `node_info`; live resolver verifies the returned node identity |
| FR-OC-2 amount bounds | Complete | Protocol and resolver validation, fixed/open/range demo controls |
| FR-OC-3 multi-asset declaration | Complete; external asset liquidity dependent | CKB, UDT, and RGB++ schema plus resolver-level UDT invoice selection coverage |
| FR-OC-4 signature integrity | Complete with clarified key model | Canonical offer-key signature plus resolver-attested Fiber node binding |
| FR-OC-5 idempotent registration | Complete | Deterministic IDs and store upsert |
| FR-OR-1 public metadata | Complete | `GET /offers/:id` |
| FR-OR-2 fresh invoice minting | Complete | Live `new_invoice` adapter and distinct-invoice tests |
| FR-OR-3 reusable sessions | Complete | Repeated resolution plus a live E2E harness that settles two distinct invoices through separate payer client sessions |
| FR-OR-4 unreachable recipient | Complete | Stable `503 RECIPIENT_UNAVAILABLE` response |
| FR-OR-5 signed revocation | Complete | `DELETE /offers/:id` with an Ed25519 lifecycle-key revocation proof |
| FR-PY-1 unmodified settlement | Complete | Standard Fiber invoice and `send_payment` path |
| FR-PY-2 confirmation propagation | Complete | Three-second background `get_invoice` polling and an integration test enforcing the five-second target |
| FR-RC-1 recurrence declaration | Complete | Interval, amount, cycle cap, spending cap, and custom seconds |
| FR-RC-2 automatic triggering | Complete | Self-running payer scheduler, durable browser/Node stores, overlap protection, retry backoff, and runnable worker example |
| FR-RC-3 cap enforcement | Complete | Resolver and payer scheduler both block cycle/spending-cap overflow |
| FR-RC-4 user revocation | Complete | Scheduler `revoke()` and reusable web/native approval controls |
| FR-FA-1 well-known lookup | Complete | `/.well-known/fiberoffer/:username` |
| FR-FA-2 username registration | Complete | Collision-safe binding; existing claims cannot be overwritten |
| FR-SDK-1 QR/link components | Complete | `@fiber-offers/sdk/react` and `/react-native` `OfferQR` exports |
| FR-SDK-2 resolve/pay helper | Complete | Scanned encoded offers are verified, resolved, invoiced, dry-run, and optionally paid |
| FR-SDK-3 recurrence approval UI | Complete | Web and native controls always render caps and disable uncapped approval |
| FR-SEC-1 registration verification | Complete | Invalid payloads return HTTP 400; node mismatch returns HTTP 403 |
| FR-SEC-2 authenticated minting | Complete for single-merchant resolver | Server-controlled RPC profile, optional Basic Auth, API-key admin boundary, and node identity match |
| FR-SEC-3 non-custodial settlement | Complete | Resolver creates invoices but never receives payer signing authority or funds |

## Non-Functional Status

- The wire format is canonical JSON encoded with bech32m under the `fbroffer` HRP. Legacy base64url offers remain decodable.
- Unknown signed `extensions` and `x_*` fields are preserved in IDs and signatures.
- Webhook secrets support AES-256-GCM encryption at rest through `RESOLVER_SECRET_ENCRYPTION_KEY`.
- Private-network webhook targets are disabled by default in production and can be explicitly enabled for local fixtures.
- Public readiness and invoice creation use Redis-backed distributed limits when configured, and every invoice attempt emits a structured resolution event.
- PostgreSQL is the authoritative horizontal store. Row-locked invoice reservations protect single-use, recurrence-cycle, and idempotency invariants across API replicas.
- Redis/BullMQ coordinates settlement and webhook maintenance workers. Payer-owned recurring execution stays outside the merchant resolver because moving payer payment authority into it would violate FR-SEC-3.
- The original PDF assumptions and the accepted framework difference are recorded in [requirements-errata.md](requirements-errata.md).
- The JSON store and interval workers remain single-process development fallbacks.
- Live payment proof requires funded and connected external Fiber nodes. On 2026-07-14 the harness settled two distinct 1 CKB invoices from one offer through separate payer client sessions; both reached `invoice_paid` with zero fees.
