import {
  decodeOffer,
  generateOfferKeyPair,
  isEncodedOffer,
  signRecurrenceRequest,
  subscriptionId,
  verifyOffer
} from "@fiber-offers/protocol";

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
    // A cycle counts as paid only once the payer node reports the payment
    // settled. `confirm: false` restores the old behaviour of trusting
    // "payment sent", for a payment flow that cannot report status.
    this.confirm = options.confirm !== false;
    this.confirmTimeoutMs = options.confirmTimeoutMs;
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
    // The subscription's own key. Every cycle request is signed with it, and
    // the resolver counts cycles and caps against the ID derived from it, so
    // nobody else can request or exhaust this subscription's cycles. It never
    // leaves the approval store and controls no funds.
    const subscriber = generateOfferKeyPair();
    const approval = {
      id: options.id ?? `approval_${globalThis.crypto.randomUUID()}`,
      subscription_id: subscriptionId(subscriber.publicKeyPem),
      subscriber_public_key: subscriber.publicKeyPem,
      subscriber_private_key_pem: subscriber.privateKeyPem,
      offer_id: offer.offer_id,
      offer,
      asset: options.asset ?? offer.assets[0],
      status: "active",
      approved_at: this.now().toISOString(),
      // Every due date is computed from this fixed anchor, so the schedule
      // cannot drift (a monthly plan started on the 31st stays month-end).
      schedule_anchor: start.toISOString(),
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
    // A payment already sent for this approval is settled first. Nothing new
    // is sent while its outcome is unknown.
    if (approval.in_flight) {
      const settled = await this.#reconcile(approval, now);
      if (settled) return settled;
    }

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
    ensureSubscriberKey(approval);
    const request = signRecurrenceRequest(
      approval.offer,
      { amount: terms.amount, asset: approval.asset, recurrence_cycle: nextCycle, scheduled_for: scheduledFor },
      approval.subscriber_private_key_pem
    );
    const idempotencyKey = cycleIdempotencyKey(approval, nextCycle);
    const sendOptions = {
      execute: true,
      confirm: this.confirm,
      confirmTimeoutMs: this.confirmTimeoutMs,
      idempotencyKey
    };

    // The stored signed offer is passed, so each cycle's invoice is verified
    // against the terms the payer approved.
    let result;
    if (typeof this.paymentFlow.preparePayment === "function" && typeof this.paymentFlow.executePrepared === "function") {
      const prepared = await this.paymentFlow.preparePayment(approval.offer, request, { idempotencyKey });
      if (prepared.ok) {
        // Written before anything is sent: after a crash the next run finds
        // this and asks the node what happened instead of paying again.
        approval.in_flight = {
          cycle: nextCycle,
          scheduled_for: scheduledFor,
          payment_hash: prepared.invoice?.payment_hash ?? prepared.route_check?.payment_hash,
          idempotency_key: idempotencyKey,
          started_at: now.toISOString()
        };
        await this.store.put(approval);
      }
      result = await this.paymentFlow.executePrepared(prepared, sendOptions);
    } else {
      result = await this.paymentFlow.payOffer(approval.offer, request, sendOptions);
    }

    return this.#applyResult(approval, nextCycle, scheduledFor, result, now);
  }

  // Asks the payer node what became of a payment recorded as in flight.
  // Returns the cycle result when that settles the matter for this run, or
  // undefined when the cycle should simply be attempted again.
  async #reconcile(approval, now) {
    const pending = approval.in_flight;
    if (typeof this.paymentFlow.confirmPayment !== "function" || !pending.payment_hash) {
      // Nothing to ask with. The retry replays the same invoice, which a node
      // will not pay twice.
      delete approval.in_flight;
      return undefined;
    }
    const outcome = await this.paymentFlow.confirmPayment(pending.payment_hash, { confirmTimeoutMs: 0 });
    if (outcome.status === "payment_unknown") {
      // The node has no record: the crash came before the send.
      delete approval.in_flight;
      return undefined;
    }
    return this.#applyResult(approval, pending.cycle, pending.scheduled_for, outcome, now);
  }

  async #applyResult(approval, cycle, scheduledFor, result, now) {
    const terms = approval.offer.recurrence;
    const paymentHash = result.payment_hash ?? approval.in_flight?.payment_hash;
    approval.attempts = [
      ...(approval.attempts ?? []),
      {
        cycle,
        scheduled_for: scheduledFor,
        attempted_at: now.toISOString(),
        status: result.status,
        payment_hash: paymentHash,
        failure_code: result.failure?.code
      }
    ].slice(-MAX_STORED_ATTEMPTS);

    const paid =
      result.status === "payment_succeeded" || (!this.confirm && result.ok && result.status === "payment_sent");
    const pending = !paid && result.ok && ["payment_sent", "payment_pending"].includes(result.status);

    if (paid) {
      approval.cycles_paid = cycle;
      approval.spending_total = (BigInt(approval.spending_total) + BigInt(terms.amount)).toString();
      approval.next_due_at = dueDate(approval, terms, cycle, scheduledFor).toISOString();
      approval.consecutive_failures = 0;
      delete approval.in_flight;
      delete approval.invoice_attempt;
      delete approval.next_retry_at;
      delete approval.last_error;
      this.#emit({ type: "cycle.paid", approval_id: approval.id, cycle, payment_hash: paymentHash, result });
    } else if (pending) {
      // Sent and not yet settled. Not a failure; the next run checks again.
      approval.in_flight = {
        ...(approval.in_flight ?? { cycle, scheduled_for: scheduledFor, started_at: now.toISOString() }),
        payment_hash: paymentHash
      };
      this.#emit({ type: "cycle.payment_pending", approval_id: approval.id, cycle, payment_hash: paymentHash });
    } else {
      delete approval.in_flight;
      approval.last_error = result.failure;
      approval.consecutive_failures = (approval.consecutive_failures ?? 0) + 1;
      // An expired invoice can never be paid; the next attempt asks for a new one.
      if (result.failure?.code === "INVOICE_EXPIRED") {
        approval.invoice_attempt = (approval.invoice_attempt ?? 0) + 1;
      }
      if (approval.consecutive_failures >= this.maxConsecutiveFailures) {
        approval.status = "failed";
        delete approval.next_retry_at;
        this.#emit({
          type: "approval.failed",
          approval_id: approval.id,
          cycle,
          error: approval.last_error
        });
      } else {
        approval.next_retry_at = new Date(now.getTime() + this.retryDelayMs).toISOString();
        this.#emit({
          type: "cycle.retry_scheduled",
          approval_id: approval.id,
          cycle,
          retry_at: approval.next_retry_at,
          error: approval.last_error
        });
      }
    }
    await this.store.put(approval);
    return { approval_id: approval.id, cycle, result };
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
    if (isEncodedOffer(offerOrEncoded)) {
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

const MAX_STORED_ATTEMPTS = 20;

// A retried cycle replays the same invoice. Only after that invoice has expired
// does the key change, so the resolver is asked for a new one.
function cycleIdempotencyKey(approval, cycle) {
  const base = `${approval.subscription_id ?? approval.id}:${cycle}`;
  return approval.invoice_attempt ? `${base}:${approval.invoice_attempt}` : base;
}

// An approval stored before subscriptions had keys gets one on its next run.
function ensureSubscriberKey(approval) {
  if (approval.subscriber_private_key_pem) return;
  const subscriber = generateOfferKeyPair();
  approval.subscription_id = subscriptionId(subscriber.publicKeyPem);
  approval.subscriber_public_key = subscriber.publicKeyPem;
  approval.subscriber_private_key_pem = subscriber.privateKeyPem;
}

// When the cycle after `cyclesPaid` paid cycles falls due.
function dueDate(approval, terms, cyclesPaid, scheduledFor) {
  if (approval.schedule_anchor) return occurrence(new Date(approval.schedule_anchor), terms, cyclesPaid);
  // An approval stored before anchors existed: step from the last due date.
  return occurrence(new Date(scheduledFor), terms, 1);
}

// The date `count` intervals after `anchor`.
function occurrence(anchor, terms, count) {
  const next = new Date(anchor);
  if (terms.interval === "daily") next.setUTCDate(next.getUTCDate() + count);
  if (terms.interval === "weekly") next.setUTCDate(next.getUTCDate() + 7 * count);
  if (terms.interval === "monthly") return addMonthsClamped(anchor, count);
  if (terms.interval === "custom_seconds") return new Date(anchor.getTime() + terms.custom_seconds * count * 1000);
  return next;
}

// Adds whole months, keeping the day of month where the target month has it
// and using its last day otherwise (31 January + 1 month = 28 or 29 February).
function addMonthsClamped(date, months) {
  const target = new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth() + months,
      1,
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds()
    )
  );
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(date.getUTCDate(), lastDay));
  return target;
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
