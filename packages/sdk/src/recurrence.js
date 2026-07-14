import { decodeOffer, verifyOffer } from "@fiber-offers/protocol";

export class InMemoryRecurringApprovalStore {
  constructor(initial = []) {
    this.approvals = new Map(initial.map((approval) => [approval.id, structuredClone(approval)]));
  }

  async list() {
    return [...this.approvals.values()].map((approval) => structuredClone(approval));
  }

  async get(id) {
    const approval = this.approvals.get(id);
    return approval ? structuredClone(approval) : undefined;
  }

  async put(approval) {
    this.approvals.set(approval.id, structuredClone(approval));
    return structuredClone(approval);
  }
}

export class FiberRecurringPaymentScheduler {
  constructor(options = {}) {
    if (!options.paymentFlow) throw new Error("FiberRecurringPaymentScheduler requires paymentFlow");
    this.paymentFlow = options.paymentFlow;
    this.resolver = options.resolverClient ?? options.resolver ?? options.paymentFlow.resolver;
    this.store = options.store ?? new InMemoryRecurringApprovalStore();
    this.now = options.now ?? (() => new Date());
  }

  async approve(offerOrEncoded, options = {}) {
    const offer = await this.#resolveOffer(offerOrEncoded);
    if (!offer.recurrence) throw schedulerError("offer does not define recurrence terms", "RECURRENCE_NOT_CONFIGURED");
    if (offer.recurrence.cap_cycles === undefined && offer.recurrence.spending_cap_total === undefined) {
      throw schedulerError("recurring approval requires a visible spending cap", "RECURRENCE_CAP_REQUIRED");
    }
    const start = new Date(options.startAt ?? this.now());
    const approval = {
      id: options.id ?? `approval_${globalThis.crypto.randomUUID()}`,
      offer_id: offer.offer_id,
      offer,
      asset: options.asset ?? offer.assets[0],
      status: "active",
      approved_at: this.now().toISOString(),
      next_due_at: start.toISOString(),
      cycles_paid: 0,
      spending_total: "0",
      attempts: []
    };
    return this.store.put(approval);
  }

  async revoke(approvalId) {
    const approval = await this.store.get(approvalId);
    if (!approval) throw schedulerError("recurring approval was not found", "APPROVAL_NOT_FOUND");
    approval.status = "revoked";
    approval.revoked_at = this.now().toISOString();
    return this.store.put(approval);
  }

  async runDue(now = this.now()) {
    const current = new Date(now);
    const results = [];
    for (const approval of await this.store.list()) {
      if (approval.status !== "active" || new Date(approval.next_due_at) > current) continue;
      results.push(await this.#runApproval(approval, current));
    }
    return results;
  }

  async #runApproval(approval, now) {
    const terms = approval.offer.recurrence;
    const nextCycle = approval.cycles_paid + 1;
    if (terms.cap_cycles !== undefined && nextCycle > terms.cap_cycles) {
      return this.#block(approval, "RECURRENCE_CYCLE_CAP_REACHED", "cycle cap reached");
    }
    if (
      terms.spending_cap_total !== undefined &&
      BigInt(approval.spending_total) + BigInt(terms.amount) > BigInt(terms.spending_cap_total)
    ) {
      return this.#block(approval, "RECURRENCE_SPENDING_CAP_REACHED", "spending cap reached");
    }

    const scheduledFor = approval.next_due_at;
    const result = await this.paymentFlow.payOffer(
      approval.offer_id,
      {
        amount: terms.amount,
        asset: approval.asset,
        recurrence_cycle: nextCycle,
        approval_id: approval.id,
        scheduled_for: scheduledFor
      },
      { execute: true, idempotencyKey: `${approval.id}:${nextCycle}` }
    );
    approval.attempts.push({ cycle: nextCycle, scheduled_for: scheduledFor, attempted_at: now.toISOString(), result });
    if (result.ok && result.status === "payment_sent") {
      approval.cycles_paid = nextCycle;
      approval.spending_total = (BigInt(approval.spending_total) + BigInt(terms.amount)).toString();
      approval.next_due_at = nextOccurrence(new Date(scheduledFor), terms).toISOString();
    } else {
      approval.last_error = result.failure;
    }
    await this.store.put(approval);
    return { approval_id: approval.id, cycle: nextCycle, result };
  }

  async #block(approval, code, summary) {
    approval.status = "cap_reached";
    approval.last_error = { code, summary };
    await this.store.put(approval);
    return { approval_id: approval.id, blocked: true, failure: approval.last_error };
  }

  async #resolveOffer(offerOrEncoded) {
    if (typeof offerOrEncoded === "object") return assertOffer(offerOrEncoded.offer ?? offerOrEncoded);
    if (typeof offerOrEncoded === "string" && offerOrEncoded.startsWith("fbroffer1")) {
      return assertOffer(decodeOffer(offerOrEncoded));
    }
    if (!this.resolver) throw new Error("resolverClient is required when approving by offer_id");
    const resolved = await this.resolver.getOffer(offerOrEncoded);
    return assertOffer(resolved.offer);
  }
}

function assertOffer(offer) {
  const verification = verifyOffer(offer);
  if (!verification.ok) throw schedulerError(verification.message, verification.code);
  return offer;
}

function nextOccurrence(date, terms) {
  const next = new Date(date);
  if (terms.interval === "daily") next.setUTCDate(next.getUTCDate() + 1);
  if (terms.interval === "weekly") next.setUTCDate(next.getUTCDate() + 7);
  if (terms.interval === "monthly") next.setUTCMonth(next.getUTCMonth() + 1);
  if (terms.interval === "custom_seconds") next.setUTCSeconds(next.getUTCSeconds() + terms.custom_seconds);
  return next;
}

function schedulerError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}
