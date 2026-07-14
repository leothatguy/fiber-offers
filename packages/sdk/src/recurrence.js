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

export class WebStorageRecurringApprovalStore {
  constructor(options = {}) {
    this.storage = options.storage ?? globalThis.localStorage;
    this.key = options.key ?? "fiber-offers:recurring-approvals";
    if (!this.storage) throw new Error("WebStorageRecurringApprovalStore requires a storage implementation");
  }

  async list() {
    const value = this.storage.getItem(this.key);
    if (!value) return [];
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) throw new Error("recurring approval storage is invalid");
    return structuredClone(parsed);
  }

  async get(id) {
    const approval = (await this.list()).find((item) => item.id === id);
    return approval ? structuredClone(approval) : undefined;
  }

  async put(approval) {
    const approvals = await this.list();
    const index = approvals.findIndex((item) => item.id === approval.id);
    if (index < 0) approvals.push(structuredClone(approval));
    else approvals[index] = structuredClone(approval);
    this.storage.setItem(this.key, JSON.stringify(approvals));
    return structuredClone(approval);
  }
}

export class FiberRecurringPaymentScheduler {
  constructor(options = {}) {
    if (!options.paymentFlow) throw new Error("FiberRecurringPaymentScheduler requires paymentFlow");
    this.paymentFlow = options.paymentFlow;
    this.resolver = options.resolverClient ?? options.resolver ?? options.paymentFlow.resolver;
    this.store = options.store ?? defaultApprovalStore(options);
    this.now = options.now ?? (() => new Date());
    this.intervalMs = positiveInteger(options.intervalMs, 1000);
    this.retryDelayMs = positiveInteger(options.retryDelayMs, 30000);
    this.maxConsecutiveFailures = positiveInteger(options.maxConsecutiveFailures, 8);
    this.onEvent = options.onEvent ?? (() => {});
    this.setInterval = options.setInterval ?? globalThis.setInterval;
    this.clearInterval = options.clearInterval ?? globalThis.clearInterval;
    this.timer = undefined;
    this.runInFlight = undefined;
    this.lastRunAt = undefined;
    this.lastError = undefined;
    if (options.autoStart) this.start({ runOnStart: options.runOnStart !== false });
  }

  start(options = {}) {
    if (this.timer) return this.status();
    this.timer = this.setInterval(() => this.#runScheduledPass(), this.intervalMs);
    if (options.runOnStart !== false) queueMicrotask(() => this.#runScheduledPass());
    this.#emit({ type: "scheduler.started", interval_ms: this.intervalMs });
    return this.status();
  }

  stop() {
    if (this.timer) this.clearInterval(this.timer);
    this.timer = undefined;
    this.#emit({ type: "scheduler.stopped" });
    return this.status();
  }

  status() {
    return {
      running: Boolean(this.timer),
      interval_ms: this.intervalMs,
      retry_delay_ms: this.retryDelayMs,
      last_run_at: this.lastRunAt,
      last_error: this.lastError
    };
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
    const saved = await this.store.put(approval);
    this.#emit({ type: "approval.revoked", approval: saved });
    return saved;
  }

  async runDue(now = this.now()) {
    const current = new Date(now);
    const results = [];
    for (const approval of await this.store.list()) {
      if (approval.status !== "active" || new Date(approval.next_due_at) > current) continue;
      if (approval.next_retry_at && new Date(approval.next_retry_at) > current) continue;
      results.push(await this.#runApproval(approval, current));
    }
    this.lastRunAt = current.toISOString();
    return results;
  }

  async #runScheduledPass() {
    if (this.runInFlight) return this.runInFlight;
    this.runInFlight = this.runDue().catch((error) => {
      this.lastError = publicError(error);
      this.#emit({ type: "scheduler.failed", error: this.lastError });
      return [];
    }).finally(() => {
      this.runInFlight = undefined;
    });
    return this.runInFlight;
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
      approval.consecutive_failures = 0;
      delete approval.next_retry_at;
      delete approval.last_error;
      this.#emit({ type: "cycle.payment_sent", approval_id: approval.id, cycle: nextCycle, result });
    } else {
      approval.last_error = result.failure;
      approval.consecutive_failures = (approval.consecutive_failures ?? 0) + 1;
      if (approval.consecutive_failures >= this.maxConsecutiveFailures) {
        approval.status = "failed";
        delete approval.next_retry_at;
        this.#emit({
          type: "approval.failed",
          approval_id: approval.id,
          cycle: nextCycle,
          error: approval.last_error
        });
      } else {
        approval.next_retry_at = new Date(now.getTime() + this.retryDelayMs).toISOString();
        this.#emit({
          type: "cycle.retry_scheduled",
          approval_id: approval.id,
          cycle: nextCycle,
          retry_at: approval.next_retry_at,
          error: approval.last_error
        });
      }
    }
    await this.store.put(approval);
    return { approval_id: approval.id, cycle: nextCycle, result };
  }

  async #block(approval, code, summary) {
    approval.status = "cap_reached";
    approval.last_error = { code, summary };
    await this.store.put(approval);
    this.#emit({ type: "approval.cap_reached", approval_id: approval.id, error: approval.last_error });
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

  #emit(event) {
    try {
      this.onEvent({ ...event, at: this.now().toISOString() });
    } catch {
      // Scheduler state must not depend on an observer callback.
    }
  }
}

function defaultApprovalStore(options) {
  const storage = options.storage ?? globalThis.localStorage;
  return storage
    ? new WebStorageRecurringApprovalStore({ storage, key: options.storageKey })
    : new InMemoryRecurringApprovalStore();
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

function positiveInteger(value, fallback) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) throw new Error("scheduler timing options must be positive integers");
  return resolved;
}

function publicError(error) {
  return {
    code: error?.code ?? "RECURRENCE_SCHEDULER_FAILED",
    message: error?.message ?? String(error)
  };
}
