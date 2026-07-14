# Fiber Offers Examples

These examples are intentionally small integration scripts. They show how another wallet, merchant tool, or operator service would consume the reusable SDK instead of coupling directly to the demo UI.

Start the resolver first:

```bash
npm run dev
```

Then run:

```bash
npm run example:wallet
npm run example:merchant
RESOLVER_URL=http://127.0.0.1:8787 PAYER_FIBER_RPC_URL=http://127.0.0.1:8229 FIBER_RECURRING_OFFER=0x... npm run example:recurrence
MERCHANT_FIBER_RPC_URL=http://127.0.0.1:8227 PAYER_FIBER_RPC_URL=http://127.0.0.1:8229 npm run example:topology
```

`example:wallet` prepares a payer-side flow through readiness, invoice creation, and route confidence. It only sends a real Fiber payment if you edit the script to pass `execute: true`.

`example:merchant` exercises merchant/operator APIs: invoice resolution, status update, sync, receipt, and reconciliation export.

`example:recurrence` runs a durable payer-owned scheduler. It keeps payment
authority beside the payer Fiber RPC, stores approvals in a private local file,
and retries failed cycles without giving the merchant resolver payer credentials.

`example:topology` is read-only. It inspects merchant and payer Fiber nodes and prints the direct-channel fixture plan.
