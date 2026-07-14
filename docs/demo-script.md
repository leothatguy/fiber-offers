# Demo Script

## One-Minute Pitch

Fiber invoices are payment-attempt specific. Fiber Offers adds a signed static
offer and resolver that turns the same stable link, QR, or Fiber Address into a
fresh standard Fiber invoice for every payer session.

## Walkthrough

1. Start the stack and verify that the resolver is bound to the merchant FNN:

   ```bash
   docker compose up -d --build
   npm run cli -- doctor
   ```

2. Keep the terminal and `http://localhost:8787` open side by side.

3. Create the offer from the independent merchant CLI:

   ```bash
   npm run cli -- create \
     --description "Coffee checkout" \
     --amount 100000000 \
     --username coffee
   ```

4. Point out the stable offer ID, payment link, `coffee@localhost:8787` Fiber
   Address, and locally protected lifecycle key.

5. Unlock the operator workspace with `RESOLVER_API_KEY`. Show that the
   CLI-created offer is already present, proving the CLI and browser use the same
   resolver and PostgreSQL state.

6. Open the returned `/pay/:offer_id` link and show the customer-facing amount,
   readiness check, invoice action, and QR.

7. Run the two-session live proof:

   ```bash
   RESOLVER_URL=http://127.0.0.1:8787 \
   MERCHANT_FIBER_RPC_URL=http://127.0.0.1:8227 \
   PAYER_FIBER_RPC_URL=http://127.0.0.1:8229 \
   FIBER_E2E_PAYMENT_COUNT=2 \
   npm run fiber:e2e-check
   ```

8. Show that both payer client sessions used the same offer ID but received
   different invoices and payment hashes, and that both merchant invoices and
   resolver records reached `Paid` / `invoice_paid`.

9. Refresh the dashboard and open reconciliation JSON/CSV, receipts, and the
   webhook outbox.

10. Revoke the offer from the CLI and refresh the payment page to show the
    explicit revoked state.

## What Is Real

- Node-backed offer creation and resolver-attested FNN identity.
- Canonical IDs, Ed25519 lifecycle signatures, and signed revocation.
- Bech32m `fbroffer1...` encoding.
- Fiber Address lookup and stable QR/payment links.
- Live FNN invoice creation, route dry-run, payment, and status reconciliation.
- Two independent payer client sessions paying one static offer.
- Three-second settlement polling, receipts, reconciliation, and webhooks.
- Signed `HttpOnly` operator dashboard sessions.
- Durable payer-owned recurrence scheduling, cap enforcement, retries, and
  revocation.

## Explicit Boundaries

- Mock invoices are used only by automated tests or `npm run dev:mock`.
- The current resolver deployment maps to one merchant FNN.
- A fresh invoice cannot be minted while that FNN is unavailable; the payer gets
  `503 RECIPIENT_UNAVAILABLE`.
- Live UDT/RGB++ settlement requires separately funded compatible channels.
- Merchant accounts, multi-tenancy, managed secrets, and production TLS remain
  deployment/product follow-up work.
