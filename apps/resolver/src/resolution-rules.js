// Shared rules for how resolutions count against an offer. The readiness check
// and every store apply the same predicates so `/check` and `/invoice` cannot
// disagree about whether an offer can produce another invoice.

// A resolution "consumes" an offer when it holds or has used the offer's
// capacity. A failed invoice attempt never reached the payer and does not count.
export function isConsumingResolution(resolution) {
  return resolution?.status !== "invoice_failed";
}

export function consumingResolutions(resolutions, options = {}) {
  return (resolutions ?? []).filter(
    (resolution) => isConsumingResolution(resolution) && resolution.id !== options.excludeId
  );
}

// The resolution a readiness check is about: the one that issued the invoice
// being checked, or the one an idempotent retry would replay.
export function resolutionUnderCheck(resolutions, { invoice, idempotencyKey } = {}) {
  const records = resolutions ?? [];
  if (invoice) {
    const byInvoice = records.find((resolution) => {
      const issued = resolution.invoice;
      return issued && (issued.invoice === invoice || issued.payment_request === invoice);
    });
    if (byInvoice) return { resolution: byInvoice, matched_by: "invoice" };
  }
  if (idempotencyKey) {
    const byKey = records.find((resolution) => resolution.idempotency_key === idempotencyKey);
    if (byKey) return { resolution: byKey, matched_by: "idempotency_key" };
  }
  return undefined;
}
