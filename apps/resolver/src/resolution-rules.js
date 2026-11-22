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

// Validates a cycle request against the offer's recurrence terms and what its
// subscription has already been issued, and returns the recurrence record to
// store with the new resolution (undefined for an offer without recurrence).
//
// Cycles and caps are counted per subscription (`approval_id`), so any number
// of payers can subscribe to one offer and none can advance or exhaust
// another's. Within a subscription a cycle is used up when it is paid; an
// invoice that ends unpaid releases its cycle, and only one cycle can be
// outstanding at a time. The caller has already verified that the request was
// signed by the subscription's key.
export function recurrenceReservation(offer, request, resolutions, options = {}) {
  if (!offer.recurrence) {
    if (request.recurrence_cycle !== undefined && request.recurrence_cycle !== null) {
      throw ruleError("offer does not define recurring payment terms", "RECURRENCE_NOT_CONFIGURED", 400);
    }
    return undefined;
  }
  const terms = offer.recurrence;
  const approvalId = request.approval_id;
  if (typeof approvalId !== "string" || approvalId.length === 0) {
    throw ruleError("a recurring cycle request must name its subscription", "SUBSCRIPTION_PROOF_REQUIRED", 400);
  }
  if (!/^[1-9][0-9]*$/.test(String(request.amount ?? "")) || BigInt(request.amount) !== BigInt(terms.amount)) {
    throw ruleError(`recurring cycle amount must equal ${terms.amount}`, "RECURRENCE_AMOUNT_MISMATCH", 400);
  }

  const mine = subscriptionResolutions(resolutions, approvalId, options);
  const paid = mine.filter(isConsumed);
  const expected = paid.length + 1;
  const requested =
    request.recurrence_cycle === undefined || request.recurrence_cycle === null
      ? expected
      : Number(request.recurrence_cycle);
  if (terms.cap_cycles !== undefined && expected > terms.cap_cycles) {
    throw ruleError("recurring payment cycle cap has been reached", "RECURRENCE_CYCLE_CAP_REACHED", 409);
  }
  const paidTotal = paid.reduce((total, resolution) => total + BigInt(resolution.amount), 0n);
  if (terms.spending_cap_total !== undefined && paidTotal + BigInt(terms.amount) > BigInt(terms.spending_cap_total)) {
    throw ruleError("recurring payment spending cap has been reached", "RECURRENCE_SPENDING_CAP_REACHED", 409);
  }
  if (!Number.isSafeInteger(requested) || requested !== expected) {
    throw ruleError(`the next cycle of this subscription is ${expected}`, "INVALID_RECURRENCE_CYCLE", 409, {
      next_cycle: expected
    });
  }
  const outstanding = mine.find(isHolding);
  if (outstanding) {
    throw ruleError(
      "this subscription has an unpaid invoice outstanding for its current cycle",
      "RECURRENCE_CYCLE_OUTSTANDING",
      409,
      { outstanding_until: outstanding.invoice?.expires_at ?? outstanding.reservation_expires_at, retryable: true }
    );
  }
  return {
    cycle: expected,
    interval: terms.interval,
    approval_id: approvalId,
    ...(request.scheduled_for ? { scheduled_for: request.scheduled_for } : {})
  };
}

// The resolutions of one subscription that still count.
export function subscriptionResolutions(resolutions, approvalId, options = {}) {
  return countedResolutions(resolutions, options).filter(
    (resolution) => resolution.recurrence?.approval_id === approvalId
  );
}

// Where one subscription stands, for its payer.
export function subscriptionStatus(offer, resolutions, approvalId) {
  const terms = offer.recurrence;
  const mine = subscriptionResolutions(resolutions, approvalId);
  const paid = mine.filter(isConsumed);
  const outstanding = mine.find(isHolding);
  const paidTotal = paid.reduce((total, resolution) => total + BigInt(resolution.amount), 0n);
  const capReached =
    (terms.cap_cycles !== undefined && paid.length >= terms.cap_cycles) ||
    (terms.spending_cap_total !== undefined && paidTotal + BigInt(terms.amount) > BigInt(terms.spending_cap_total));
  return {
    approval_id: approvalId,
    cycles_paid: paid.length,
    paid_total: paidTotal.toString(),
    next_cycle: capReached ? undefined : paid.length + 1,
    cap_reached: capReached,
    ...(outstanding
      ? {
          outstanding: {
            cycle: outstanding.recurrence.cycle,
            resolution_id: outstanding.id,
            expires_at: outstanding.invoice?.expires_at
          }
        }
      : {}),
    cycle_cap_remaining: terms.cap_cycles === undefined ? undefined : Math.max(0, terms.cap_cycles - paid.length),
    spending_cap_remaining:
      terms.spending_cap_total === undefined
        ? undefined
        : (BigInt(terms.spending_cap_total) - paidTotal < 0n ? 0n : BigInt(terms.spending_cap_total) - paidTotal).toString()
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
