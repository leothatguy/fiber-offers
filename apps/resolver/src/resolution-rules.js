// Shared rules for how resolutions count against an offer. The readiness check
// and every store apply the same predicates so `/check` and `/invoice` cannot
// disagree about whether an offer can produce another invoice.

// --- The resolution state machine -------------------------------------------
//
//   invoice_pending ─► invoice_created ─► invoice_received ─► invoice_paid
//                            │                   │
//                            └───────┬───────────┘
//                                    ▼
//                 invoice_expired | invoice_failed | invoice_cancelled
//
// Statuses only move forward. The four on the right and bottom are final.
// `invoice_pending` is the resolver's own reservation while the node is asked
// for an invoice; it is never set from outside.
export const PUBLIC_RESOLUTION_STATUSES = Object.freeze([
  "invoice_created",
  "invoice_received",
  "invoice_paid",
  "invoice_expired",
  "invoice_failed",
  "invoice_cancelled"
]);
export const TERMINAL_RESOLUTION_STATUSES = Object.freeze([
  "invoice_paid",
  "invoice_expired",
  "invoice_failed",
  "invoice_cancelled"
]);
// Open: an invoice exists (or is being created) and has not reached an outcome.
export const OPEN_RESOLUTION_STATUSES = Object.freeze(["invoice_pending", "invoice_created", "invoice_received"]);

const ALLOWED_TRANSITIONS = Object.freeze({
  invoice_pending: ["invoice_created"],
  invoice_created: ["invoice_received", "invoice_paid", "invoice_expired", "invoice_failed", "invoice_cancelled"],
  invoice_received: ["invoice_paid", "invoice_expired", "invoice_failed", "invoice_cancelled"],
  invoice_paid: [],
  invoice_expired: [],
  invoice_failed: [],
  invoice_cancelled: []
});

export function canTransition(from, to) {
  return (ALLOWED_TRANSITIONS[from ?? "invoice_created"] ?? []).includes(to);
}

// --- What a resolution means for the offer's capacity -----------------------
//
//   released  expired, failed or cancelled: it never took anything.
//   holding   an invoice is being created or is waiting to be paid. It reserves
//             capacity so two payers cannot both be issued "the" invoice, and
//             gives it back if it ends unpaid.
//   consumed  paid. This is the only thing that uses an offer up.
const RELEASED_STATUSES = new Set(["invoice_expired", "invoice_failed", "invoice_cancelled"]);

export function isReleased(resolution) {
  return RELEASED_STATUSES.has(resolution?.status);
}

export function isConsumed(resolution) {
  return resolution?.status === "invoice_paid";
}

export function isHolding(resolution) {
  return OPEN_RESOLUTION_STATUSES.includes(resolution?.status ?? "invoice_created");
}

// The resolutions that still count against an offer.
export function countedResolutions(resolutions, options = {}) {
  return (resolutions ?? []).filter((resolution) => !isReleased(resolution) && resolution.id !== options.excludeId);
}

// Throws when a single-use offer cannot issue another invoice: because it has
// been paid (OFFER_ALREADY_USED, permanent), or because an unpaid invoice is
// still outstanding (OFFER_INVOICE_OUTSTANDING, clears when that invoice is
// paid, expires or is cancelled).
export function assertSingleUseCapacity(offer, resolutions, options = {}) {
  if (!offer.single_use) return;
  const counted = countedResolutions(resolutions, options);
  if (counted.some(isConsumed)) {
    throw ruleError("single-use offer has already been paid", "OFFER_ALREADY_USED", 409);
  }
  const outstanding = counted.find(isHolding);
  if (outstanding) {
    throw ruleError(
      "single-use offer has an unpaid invoice outstanding; it becomes available again if that invoice is not paid",
      "OFFER_INVOICE_OUTSTANDING",
      409,
      { outstanding_until: outstanding.invoice?.expires_at ?? outstanding.reservation_expires_at, retryable: true }
    );
  }
}

// Validates a request against the offer's recurrence terms and what has
// already been issued, and returns the recurrence record to store with the
// new resolution (undefined for an offer without recurrence).
export function recurrenceReservation(offer, request, resolutions, options = {}) {
  if (!offer.recurrence) {
    if (request.recurrence_cycle !== undefined && request.recurrence_cycle !== null) {
      throw ruleError("offer does not define recurring payment terms", "RECURRENCE_NOT_CONFIGURED", 400);
    }
    return undefined;
  }
  const terms = offer.recurrence;
  if (!/^[1-9][0-9]*$/.test(String(request.amount ?? "")) || BigInt(request.amount) !== BigInt(terms.amount)) {
    throw ruleError(`recurring cycle amount must equal ${terms.amount}`, "RECURRENCE_AMOUNT_MISMATCH", 400);
  }
  const cycles = countedResolutions(resolutions, options).filter((resolution) => resolution.recurrence);
  const expected = cycles.length + 1;
  const requested =
    request.recurrence_cycle === undefined || request.recurrence_cycle === null
      ? expected
      : Number(request.recurrence_cycle);
  if (!Number.isSafeInteger(requested) || requested !== expected) {
    throw ruleError(`next recurrence cycle must be ${expected}`, "INVALID_RECURRENCE_CYCLE", 409);
  }
  if (terms.cap_cycles !== undefined && expected > terms.cap_cycles) {
    throw ruleError("recurring payment cycle cap has been reached", "RECURRENCE_CYCLE_CAP_REACHED", 409);
  }
  const reserved = cycles.reduce((total, resolution) => total + BigInt(resolution.amount), 0n);
  if (terms.spending_cap_total !== undefined && reserved + BigInt(terms.amount) > BigInt(terms.spending_cap_total)) {
    throw ruleError("recurring payment spending cap has been reached", "RECURRENCE_SPENDING_CAP_REACHED", 409);
  }
  return {
    cycle: expected,
    interval: terms.interval,
    ...(request.scheduled_for ? { scheduled_for: request.scheduled_for } : {}),
    ...(request.approval_id ? { approval_id: request.approval_id } : {})
  };
}

// Everything a store checks before reserving a new invoice for an offer.
export function assertInvoiceCapacity(offer, request, resolutions) {
  assertSingleUseCapacity(offer, resolutions);
  return recurrenceReservation(offer, request, resolutions);
}

function ruleError(message, code, status, details = undefined) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  if (details) error.details = details;
  return error;
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
