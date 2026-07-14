import { FiberOffersClient } from "@fiber-offers/sdk";

const resolverUrl = process.env.RESOLVER_URL ?? "http://127.0.0.1:8787";
const resolver = new FiberOffersClient({ resolverUrl });

const offer = await resolver.demoCreateOffer({
  username: "merchant-example",
  description: "Merchant operator example",
  amount_min: "1000",
  amount_max: "50000000"
});

const invoice = await resolver.requestInvoice(offer.offer_id, {
  amount: process.env.FIBER_PAYMENT_AMOUNT ?? "1500",
  asset: { asset_type: "ckb", symbol: "CKB" },
  order_id: `order_${Date.now()}`
});

const resolutionId = invoice.resolution_id;
if (!resolutionId) {
  throw new Error("resolver did not return resolution_id");
}

const sync = await resolver.syncResolution(offer.offer_id, resolutionId);
await resolver.updateResolutionStatus(offer.offer_id, resolutionId, {
  status: "invoice_paid",
  source: "merchant-example"
});

const receipt = await resolver.getReceipt(offer.offer_id, resolutionId);
const reconciliation = await resolver.getReconciliation(offer.offer_id);
const reconciliationCsv = await resolver.getReconciliationCsv(offer.offer_id);
const reconciliationRows = reconciliation.rows ?? [];

console.log(
  JSON.stringify(
    {
      resolver_url: resolverUrl,
      offer_id: offer.offer_id,
      resolution_id: resolutionId,
      invoice_preview: preview(invoice.invoice),
      sync: {
        changed: sync.changed,
        invoice_status: sync.invoice_source?.status,
        fiber_status: sync.invoice_source?.fiber_status
      },
      receipt_status: receipt.payment?.status,
      reconciliation_count: reconciliation.totals?.resolution_count ?? reconciliationRows.length,
      csv_preview: reconciliationCsv.split("\n").slice(0, 3)
    },
    null,
    2
  )
);

function preview(value) {
  if (typeof value !== "string" || value.length <= 48) return value;
  return `${value.slice(0, 48)}...`;
}
