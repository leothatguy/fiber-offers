# Demo Script

## One-Minute Pitch

Fiber has invoices, but external apps also need reusable payment intents. Fiber Offers is a signed static offer format plus a resolver that turns the same stable offer into fresh Fiber invoices. This gives wallets, merchants, and developer tools a Fiber-native version of reusable payment links, addresses, and invoice resolution.

## Walkthrough

1. Start the resolver:

   ```bash
   npm run dev
   ```

2. Open `http://localhost:8787`.

3. Point out the diagnostics band: it reports live Fiber RPC reachability, channel capacity, and automatic worker state.

4. In the Merchant panel, create an offer for `coffee`.

5. Point out:

   - `offer_id` is stable.
   - `encoded_offer` starts with `fbroffer1`.
   - `coffee@localhost:8787` resolves through the well-known endpoint.
   - The payment link stays the same.
   - The QR code points to the stable payment link.

6. Register the sample webhook URL in the Merchant panel.

7. In the Payer panel, click `Check Readiness`.

8. Request an invoice.

9. Click `Request Twice`.

10. Click `Mark Latest Paid`.

11. Click `Deliver`, then open the `JSON`, `CSV`, or `Events` link in the Resolution Log header.

12. Compare the log, report, and webhook event outbox:

   - Same offer ID.
   - Same amount and asset.
   - Different invoice strings.
   - Different payment hashes.
   - Latest invoice status changes to paid.
   - Reconciliation export includes the paid row.
   - Webhook outbox includes invoice lifecycle events and delivery attempts.

## What Is Real

- Offer creation.
- Canonical offer IDs.
- Ed25519 signatures.
- Offer encoding/decoding.
- Resolver registration.
- Fiber Address lookup.
- QR generation for payment links and encoded offers.
- Payment readiness diagnostics before invoice creation.
- Resolver diagnostics and Fiber RPC probe path.
- Request validation.
- Fresh invoice generation boundary.
- Settlement status records and paid-state simulation.
- Merchant reconciliation JSON/CSV exports.
- Webhook subscriptions, signed delivery, and event outbox records.
- Tests covering protocol and resolver behavior.

## What Is Mocked

- The standard demo uses real Fiber testnet invoices through the local merchant node.
- The mock adapter is used only by automated tests or an explicit `npm run dev:mock` session.
- Settlement polling and webhook retries run automatically; manual controls remain for operator demonstrations.
- Direct-channel opening and merchant acceptance are guarded because they can mutate Fiber/on-chain state.
