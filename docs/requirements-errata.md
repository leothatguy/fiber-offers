# Requirements Errata

This document is the implementation-time addendum to the original PRD, FRD, and
TRD PDFs. It records decisions made after validating the current Fiber Network
Node RPC surface. Where this document conflicts with the draft PDFs, this
document and [spec-v1.md](spec-v1.md) define the implemented v1 behavior.

## Offer Identity And Signatures

The draft documents assumed FNN could sign arbitrary application payloads with
its node identity key. The available RPC exposes `node_info`, invoices, and
payments, but no arbitrary signing method.

Fiber Offers therefore uses two linked identities:

- `node_id` is read from the merchant FNN and is re-verified by the live resolver
  before registration and invoice creation.
- A per-offer Ed25519 lifecycle key signs the canonical offer and revocation
  proofs. Its private key remains with the merchant.

This is resolver-attested node binding, not a claim that the FNN node key signed
the offer. It preserves tamper detection and portable revocation without
requiring a Fiber protocol or node modification.

## Offline Capability

"Offline-capable" applies to the static offer descriptor: an encoded
`fbroffer1...` payload can be stored, printed, shared, and verified without
regenerating it. The HTTP resolver can also serve registered metadata while the
merchant FNN is temporarily unavailable.

A fresh Fiber invoice still requires the merchant FNN. If it is unavailable,
the resolver returns the structured `503 RECIPIENT_UNAVAILABLE` state. Fiber
Offers does not claim that a payer can complete a new payment while the payee
node cannot mint an invoice.

## Recurrence Trust Boundary

Automatic payment execution is payer-owned. The merchant resolver stores and
enforces signed recurrence constraints but never receives payer keys or payment
authority. `FiberRecurringPaymentScheduler` runs beside the payer wallet/node,
uses durable browser or Node storage, schedules due cycles, retries failures,
enforces caps, and supports immediate revocation.

Redis/BullMQ in the merchant resolver schedules settlement reconciliation and
webhook delivery. It intentionally does not execute payer payments because that
would violate FR-SEC-3.

## Accepted Stack Difference

The framework-specific NestJS, Next.js, Expo, Rust, and second-demo-app choices
in the draft documents are not v1 acceptance blockers. The shipped reference
uses a plain Node.js HTTP resolver, static browser workspace, ESM SDK with
TypeScript declarations, and React/React Native exports. Functional API and
protocol requirements remain applicable.

## Acceptance Evidence

- The live E2E harness resolves one static offer into two distinct invoices and
  settles them through separately constructed payer client sessions. The
  2026-07-14 verification settled both 1 CKB testnet payments successfully with
  distinct payment hashes and zero fees.
- Settlement polling defaults to three seconds and is covered by an integration
  test asserting propagation inside the FRD five-second target.
- Multi-asset resolution is covered through resolver-to-FNN UDT currency mapping;
  external live UDT/RGB++ settlement still depends on funded compatible channels.
- The merchant dashboard exchanges the deployment API key for a signed,
  short-lived, `HttpOnly`, same-site operator session. The raw API key is not
  persisted in browser storage.
