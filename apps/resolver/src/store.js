import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { assertInvoiceCapacity } from "./resolution-rules.js";
import { SecretCipher } from "./secret-cipher.js";

export class InMemoryOfferStore {
  // Resolution ID -> when the settlement pass last asked about it.
  #lastSynced = new Map();

  constructor(initialState = undefined) {
    this.state = clone(
      initialState ?? {
        offers: {},
        usernames: {},
        resolutions: {},
        webhooks: {},
        webhook_events: {}
      }
    );
  }

  async load() {}

  async save() {}

  async healthCheck() {
    return { ok: true, backend: "memory" };
  }

  async upsertOffer(offer, encodedOffer, options = {}) {
    await this.load();
    const now = new Date().toISOString();
    const previous = this.state.offers[offer.offer_id];
    const entry = {
      offer,
      encoded_offer: encodedOffer,
      created_at: previous?.created_at ?? now,
      updated_at: now,
      disabled: previous?.disabled ?? false,
      // Registering a revoked offer again does not un-revoke it, and keeps the
      // proof of when and by whom it was revoked.
      ...(previous?.revoked_at !== undefined ? { revoked_at: previous.revoked_at } : {}),
      ...(previous?.revocation !== undefined ? { revocation: previous.revocation } : {}),
      ownership: options.ownership ?? previous?.ownership
    };

    this.state.offers[offer.offer_id] = entry;
    if (!this.state.resolutions[offer.offer_id]) this.state.resolutions[offer.offer_id] = [];
    if (!this.state.webhooks[offer.offer_id]) this.state.webhooks[offer.offer_id] = [];
    if (!this.state.webhook_events[offer.offer_id]) this.state.webhook_events[offer.offer_id] = [];

    if (options.username) {
      await this.bindUsername(options.username, offer.offer_id, { skipSave: true });
    }

    await this.save();
    return clone(entry);
  }

  async getOffer(offerId) {
    await this.load();
    const entry = this.state.offers[offerId];
    return entry ? clone(entry) : undefined;
  }

  async listOffers() {
    await this.load();
    return clone(Object.values(this.state.offers));
  }

  // One page of offers in order of creation: { items, next_cursor }. Options:
  // `limit`, `cursor` (the next_cursor of the page before) and `order`
  // ("asc" or "desc"). next_cursor is absent on the last page.
  async listOffersPage(options = {}) {
    await this.load();
    return pageOf(Object.values(this.state.offers), (entry) => [entry.created_at, entry.offer.offer_id], options);
  }

  // The Fiber Address name of each of the given offers that has one.
  async getUsernamesForOffers(offerIds) {
    await this.load();
    const wanted = new Set(offerIds);
    const names = new Map();
    for (const [username, binding] of Object.entries(this.state.usernames)) {
      if (wanted.has(binding.offer_id) && !names.has(binding.offer_id)) names.set(binding.offer_id, username);
    }
    return names;
  }

  async getUsernameForOffer(offerId) {
    await this.load();
    const entry = Object.entries(this.state.usernames).find(([, binding]) => binding.offer_id === offerId);
    return entry?.[0];
  }

  async bindUsername(username, offerId, options = {}) {
    await this.load();
    const normalized = normalizeUsername(username);
    if (!this.state.offers[offerId]) {
      throw storeError("offer_id does not exist", "OFFER_NOT_FOUND", 404);
    }

    const existing = this.state.usernames[normalized];
    if (existing && existing.offer_id !== offerId) {
      throw storeError("username is already bound to another offer", "USERNAME_ALREADY_CLAIMED", 409);
    }

    this.state.usernames[normalized] = {
      offer_id: offerId,
      created_at: this.state.usernames[normalized]?.created_at ?? new Date().toISOString()
    };

    if (!options.skipSave) await this.save();
    return {
      username: normalized,
      offer_id: offerId
    };
  }

  async revokeOffer(offerId, revocation) {
    await this.load();
    const entry = this.state.offers[offerId];
    if (!entry) throw storeError("offer_id does not exist", "OFFER_NOT_FOUND", 404);
    if (entry.disabled) throw storeError("offer is already revoked", "OFFER_REVOKED", 409);

    entry.disabled = true;
    entry.revoked_at = new Date(revocation.revoked_at * 1000).toISOString();
    entry.revocation = revocation;
    entry.updated_at = new Date().toISOString();
    await this.save();
    return clone(entry);
  }

  async getByUsername(username) {
    await this.load();
    const normalized = normalizeUsername(username);
    const binding = this.state.usernames[normalized];
    if (!binding) return undefined;

    const entry = this.state.offers[binding.offer_id];
    if (!entry) return undefined;

    return {
      username: normalized,
      binding: clone(binding),
      entry: clone(entry)
    };
  }

  async reserveInvoiceAttempt(offerId, input) {
    await this.load();
    const entry = this.state.offers[offerId];
    if (!entry) throw storeError("offer_id does not exist", "OFFER_NOT_FOUND", 404);
    if (entry.disabled) throw storeError("offer has been revoked", "OFFER_REVOKED", 410);

    const now = Date.now();
    this.state.resolutions[offerId] ??= [];
    this.state.resolutions[offerId] = this.state.resolutions[offerId].filter((resolution) => {
      return resolution.status !== "invoice_pending" || Date.parse(resolution.reservation_expires_at) >= now;
    });
    const records = this.state.resolutions[offerId];

    if (input.idempotencyKey) {
      const existing = records.find((resolution) => resolution.idempotency_key === input.idempotencyKey);
      if (existing) {
        if (existing.idempotency_fingerprint !== input.idempotencyFingerprint) {
          throw storeError("idempotency key was already used for a different invoice request", "IDEMPOTENCY_KEY_REUSED", 409);
        }
        if (existing.status === "invoice_pending") {
          throw storeError("invoice creation for this idempotency key is still in progress", "INVOICE_REQUEST_IN_PROGRESS", 409);
        }
        return { replay: true, record: clone(existing) };
      }
    }

    const recurrence = assertInvoiceCapacity(entry.offer, input.request, records);

    const createdAt = new Date().toISOString();
    const record = {
      id: `res_${randomUUID()}`,
      offer_id: offerId,
      status: "invoice_pending",
      amount: input.request.amount,
      asset: input.request.asset,
      recurrence,
      idempotency_key: input.idempotencyKey,
      idempotency_fingerprint: input.idempotencyFingerprint,
      reservation_expires_at: new Date(now + 120000).toISOString(),
      created_at: createdAt,
      updated_at: createdAt,
      status_history: [{ status: "invoice_pending", at: createdAt, source: "resolver" }]
    };
    records.push(record);
    await this.save();
    return { replay: false, record: clone(record) };
  }

  async finalizeInvoiceReservation(offerId, resolutionId, invoice) {
    await this.load();
    const record = this.state.resolutions[offerId]?.find((resolution) => resolution.id === resolutionId);
    if (!record || record.status !== "invoice_pending") {
      throw storeError("invoice reservation is not pending", "INVOICE_RESERVATION_NOT_PENDING", 409);
    }
    const now = new Date().toISOString();
    record.status = "invoice_created";
    record.invoice = invoice;
    record.reservation_expires_at = undefined;
    record.updated_at = now;
    record.status_history.push({ status: "invoice_created", at: now, source: "resolver" });
    await this.save();
    return clone(record);
  }

  async abandonInvoiceReservation(offerId, resolutionId) {
    await this.load();
    const records = this.state.resolutions[offerId] ?? [];
    const index = records.findIndex((resolution) => resolution.id === resolutionId && resolution.status === "invoice_pending");
    if (index !== -1) records.splice(index, 1);
    await this.save();
  }

  async addResolution(offerId, resolution) {
    await this.load();
    if (!this.state.offers[offerId]) {
      throw storeError("offer_id does not exist", "OFFER_NOT_FOUND", 404);
    }

    const now = new Date().toISOString();
    const status = resolution.status ?? "invoice_created";
    const record = {
      id: `res_${randomUUID()}`,
      ...resolution,
      status,
      created_at: now,
      updated_at: now,
      status_history: resolution.status_history ?? [
        {
          status,
          at: now,
          source: resolution.source ?? "resolver"
        }
      ]
    };
    this.state.resolutions[offerId] ??= [];
    this.state.resolutions[offerId].push(record);
    await this.save();
    return clone(record);
  }

  async getResolutions(offerId) {
    await this.load();
    return clone(this.state.resolutions[offerId] ?? []);
  }

  async getResolution(offerId, resolutionId) {
    await this.load();
    const record = this.state.resolutions[offerId]?.find((resolution) => resolution.id === resolutionId);
    return record ? clone(record) : undefined;
  }

  async findResolutionByIdempotencyKey(offerId, idempotencyKey) {
    await this.load();
    const record = this.state.resolutions[offerId]?.find((resolution) => resolution.idempotency_key === idempotencyKey);
    return record ? clone(record) : undefined;
  }

  // One page of an offer's resolutions in order of creation; see listOffersPage.
  async listResolutionsPage(offerId, options = {}) {
    await this.load();
    return pageOf(this.state.resolutions[offerId] ?? [], (record) => [record.created_at, record.id], options);
  }

  // The resolution that issued this invoice string for this offer, if any.
  async findResolutionByInvoice(offerId, invoice) {
    await this.load();
    const record = this.state.resolutions[offerId]?.find(
      (resolution) => resolution.invoice && (resolution.invoice.invoice === invoice || resolution.invoice.payment_request === invoice)
    );
    return record ? clone(record) : undefined;
  }

  // The resolutions that still count against an offer: all that did not end
  // unpaid. With `approvalId`, those of that subscription only.
  async getCountedResolutions(offerId, options = {}) {
    await this.load();
    const records = (this.state.resolutions[offerId] ?? []).filter(
      (record) =>
        !RELEASED_RESOLUTION_STATUSES.has(record.status) &&
        (options.approvalId === undefined || record.recurrence?.approval_id === options.approvalId)
    );
    return clone(records);
  }

  // What reconciliation totals are made of: one row per status and asset, with
  // the number of resolutions and the sum of their amounts.
  async resolutionTotals(offerId) {
    await this.load();
    const groups = new Map();
    for (const record of this.state.resolutions[offerId] ?? []) {
      const key = JSON.stringify([record.status, record.asset?.asset_type, record.asset?.symbol]);
      const group = groups.get(key) ?? {
        status: record.status,
        asset_type: record.asset?.asset_type,
        asset_symbol: record.asset?.symbol,
        count: 0,
        amount_total: 0n
      };
      group.count += 1;
      group.amount_total += BigInt(record.amount ?? "0");
      groups.set(key, group);
    }
    return [...groups.values()].map((group) => ({ ...group, amount_total: group.amount_total.toString() }));
  }

  // An offer's invoices that still await an outcome, optionally those of one
  // subscription only.
  async getOpenResolutions(offerId, options = {}) {
    await this.load();
    const records = (this.state.resolutions[offerId] ?? []).filter(
      (record) =>
        OPEN_RESOLUTION_STATUSES.has(record.status) &&
        (options.approvalId === undefined || record.recurrence?.approval_id === options.approvalId)
    );
    return clone(records);
  }

  // Up to `limit` invoices that await an outcome, across all offers, the one
  // asked about longest ago first. Each is marked as asked now, so the next
  // call returns others; `staleMs` leaves out those asked about more recently
  // than that. Each record carries its offer_id.
  async claimOpenResolutions(limit, options = {}) {
    await this.load();
    const now = Date.now();
    const askedBefore = now - (options.staleMs ?? 0);
    const open = [];
    for (const [offerId, records] of Object.entries(this.state.resolutions)) {
      for (const record of records) {
        if (!OPEN_RESOLUTION_STATUSES.has(record.status)) continue;
        const asked = this.#lastSynced.get(record.id) ?? -Infinity;
        if (asked > askedBefore) continue;
        open.push({ offerId, record, asked });
      }
    }
    open.sort((left, right) => left.asked - right.asked || left.record.created_at.localeCompare(right.record.created_at));
    const claimed = open.slice(0, limit);
    // When each was asked about is not part of the record and is not written
    // to disk: after a restart every open invoice is simply due.
    for (const { record } of claimed) this.#lastSynced.set(record.id, now);
    return claimed.map(({ offerId, record }) => ({ ...clone(record), offer_id: offerId }));
  }

  // Removes reservations whose invoice was never issued. Returns how many.
  async pruneStaleReservations() {
    await this.load();
    const now = Date.now();
    let removed = 0;
    for (const [offerId, records] of Object.entries(this.state.resolutions)) {
      const kept = records.filter(
        (record) => record.status !== "invoice_pending" || Date.parse(record.reservation_expires_at) >= now
      );
      removed += records.length - kept.length;
      this.state.resolutions[offerId] = kept;
    }
    if (removed > 0) await this.save();
    return removed;
  }

  async updateResolutionStatus(offerId, resolutionId, update) {
    return (await this.#writeStatus(offerId, resolutionId, update, undefined)).record;
  }

  // Moves a resolution to `update.status` only if it is still in `update.from`.
  // Returns { applied, record }: applied is false when something else changed
  // the status first, so a caller never acts twice on one transition.
  async transitionResolution(offerId, resolutionId, update) {
    return this.#writeStatus(offerId, resolutionId, update, update.from);
  }

  async #writeStatus(offerId, resolutionId, update, expectedStatus) {
    await this.load();
    const resolutions = this.state.resolutions[offerId];
    if (!resolutions) {
      throw storeError("offer_id does not exist", "OFFER_NOT_FOUND", 404);
    }

    const record = resolutions.find((resolution) => resolution.id === resolutionId);
    if (!record) {
      throw storeError("resolution_id does not exist", "RESOLUTION_NOT_FOUND", 404);
    }
    if (expectedStatus !== undefined && (record.status ?? "invoice_created") !== expectedStatus) {
      return { applied: false, record: clone(record) };
    }

    const now = new Date().toISOString();
    const statusEvent = {
      status: update.status,
      at: now,
      source: update.source ?? "manual"
    };
    if (update.note) statusEvent.note = update.note;
    if (update.details) statusEvent.details = update.details;

    record.status = update.status;
    record.updated_at = now;
    record.status_history ??= [];
    record.status_history.push(statusEvent);
    if (!OPEN_RESOLUTION_STATUSES.has(update.status)) this.#lastSynced.delete(record.id);

    if (update.status === "invoice_paid") {
      record.settled_at = update.settled_at ?? now;
    }

    if (update.status === "invoice_received") {
      record.received_at = update.received_at ?? now;
    }

    if (update.status === "invoice_expired") {
      record.expired_at = update.expired_at ?? now;
    }

    if (update.status === "invoice_failed") {
      record.failed_at = update.failed_at ?? now;
    }

    if (update.status === "invoice_cancelled") {
      record.cancelled_at = update.cancelled_at ?? now;
    }

    record.settlement = {
      ...(record.settlement ?? {}),
      ...(update.settlement ?? {})
    };

    await this.save();
    return { applied: true, record: clone(record) };
  }

  async addWebhook(offerId, webhook) {
    await this.load();
    if (!this.state.offers[offerId]) {
      throw storeError("offer_id does not exist", "OFFER_NOT_FOUND", 404);
    }

    const now = new Date().toISOString();
    const record = {
      id: `wh_${randomUUID()}`,
      offer_id: offerId,
      url: webhook.url,
      events: webhook.events,
      secret: webhook.secret,
      secret_hint: webhookSecretHint(webhook.secret),
      disabled: false,
      created_at: now,
      updated_at: now
    };

    this.state.webhooks[offerId] ??= [];
    this.state.webhooks[offerId].push(record);
    await this.save();
    return clone(record);
  }

  async listWebhooks(offerId) {
    await this.load();
    return clone(this.state.webhooks[offerId] ?? []);
  }

  async getWebhook(offerId, webhookId) {
    await this.load();
    const webhook = this.state.webhooks[offerId]?.find((candidate) => candidate.id === webhookId);
    return webhook ? clone(webhook) : undefined;
  }

  async updateWebhook(offerId, webhookId, update) {
    await this.load();
    const webhook = this.state.webhooks[offerId]?.find((candidate) => candidate.id === webhookId);
    if (!webhook) {
      throw storeError("webhook subscription does not exist", "WEBHOOK_NOT_FOUND", 404);
    }

    if (update.url !== undefined) webhook.url = update.url;
    if (update.events !== undefined) webhook.events = update.events;
    if (update.disabled !== undefined) webhook.disabled = update.disabled;
    if (update.secret !== undefined) {
      webhook.secret = update.secret;
      webhook.secret_hint = webhookSecretHint(update.secret);
    }
    webhook.updated_at = new Date().toISOString();

    await this.save();
    return clone(webhook);
  }

  async deleteWebhook(offerId, webhookId) {
    await this.load();
    const webhooks = this.state.webhooks[offerId] ?? [];
    const index = webhooks.findIndex((candidate) => candidate.id === webhookId);
    if (index === -1) {
      throw storeError("webhook subscription does not exist", "WEBHOOK_NOT_FOUND", 404);
    }

    const [deleted] = webhooks.splice(index, 1);
    await this.save();
    return clone(deleted);
  }

  async addWebhookEvent(offerId, event, options = {}) {
    await this.load();
    if (!this.state.offers[offerId]) {
      throw storeError("offer_id does not exist", "OFFER_NOT_FOUND", 404);
    }

    const targetWebhookIds = options.webhookIds ? new Set(options.webhookIds) : undefined;
    const subscriptions = (this.state.webhooks[offerId] ?? []).filter((webhook) => {
      if (webhook.disabled) return false;
      return targetWebhookIds ? targetWebhookIds.has(webhook.id) : webhook.events.includes(event.type);
    });
    const now = new Date().toISOString();
    const record = {
      id: `evt_${randomUUID()}`,
      offer_id: offerId,
      type: event.type,
      payload: event.payload,
      created_at: now,
      deliveries: subscriptions.map((webhook) => ({
        webhook_id: webhook.id,
        url: webhook.url,
        status: "pending",
        attempts: 0,
        created_at: now,
        updated_at: now
      }))
    };

    this.state.webhook_events[offerId] ??= [];
    this.state.webhook_events[offerId].push(record);
    await this.save();
    return clone(record);
  }

  async listWebhookEvents(offerId) {
    await this.load();
    return clone(this.state.webhook_events[offerId] ?? []);
  }

  // One page of an offer's events, each with its deliveries, in order of
  // creation; see listOffersPage.
  async listWebhookEventsPage(offerId, options = {}) {
    await this.load();
    return pageOf(this.state.webhook_events[offerId] ?? [], (event) => [event.created_at, event.id], options);
  }

  async getWebhookEvent(offerId, eventId) {
    await this.load();
    const event = this.state.webhook_events[offerId]?.find((candidate) => candidate.id === eventId);
    return event ? clone(event) : undefined;
  }

  // Up to `limit` deliveries to attempt now, the one due longest first, each
  // held for `leaseMs` so that nobody else takes it meanwhile. By default:
  // every offer, deliveries that are pending or waiting for a retry, and only
  // those whose time has come. An operator's request narrows it to one offer
  // or event and may take failed and dead ones regardless of their schedule.
  // Returns { offer_id, event, delivery, webhook } each; webhook is undefined
  // when the subscription was deleted.
  async claimPendingDeliveries(limit, options = {}) {
    await this.load();
    const now = Date.now();
    const statuses = new Set(options.statuses ?? ["pending", "failed"]);
    const due = [];
    for (const [offerId, events] of Object.entries(this.state.webhook_events ?? {})) {
      if (options.offerId !== undefined && offerId !== options.offerId) continue;
      for (const event of events) {
        if (options.eventId !== undefined && event.id !== options.eventId) continue;
        for (const delivery of event.deliveries) {
          if (!statuses.has(delivery.status)) continue;
          if (delivery.locked_until && Date.parse(delivery.locked_until) > now) continue;
          const dueAt = delivery.next_attempt_at ? Date.parse(delivery.next_attempt_at) : -Infinity;
          if (!options.ignoreSchedule && dueAt > now) continue;
          due.push({ offerId, event, delivery, dueAt });
        }
      }
    }
    due.sort((left, right) => left.dueAt - right.dueAt || left.delivery.created_at.localeCompare(right.delivery.created_at));
    const claimed = due.slice(0, limit);
    const lockedUntil = new Date(now + (options.leaseMs ?? 60000)).toISOString();
    for (const { delivery } of claimed) delivery.locked_until = lockedUntil;
    return claimed.map(({ offerId, event, delivery }) => {
      const { deliveries: _deliveries, ...eventFields } = event;
      return clone({
        offer_id: offerId,
        event: { ...eventFields, offer_id: offerId },
        delivery: { ...delivery, event_id: event.id },
        webhook: (this.state.webhooks[offerId] ?? []).find((webhook) => webhook.id === delivery.webhook_id)
      });
    });
  }

  // Removes events created before `before` (an ISO time) that have nothing
  // left to deliver, oldest first, at most `limit`. Returns how many.
  async pruneWebhookEvents(options = {}) {
    await this.load();
    const before = Date.parse(options.before);
    const limit = options.limit ?? 1000;
    let removed = 0;
    for (const [offerId, events] of Object.entries(this.state.webhook_events ?? {})) {
      const kept = events.filter((event) => {
        if (removed >= limit) return true;
        const finished = event.deliveries.every((delivery) => !["pending", "failed"].includes(delivery.status));
        if (!finished || !(Date.parse(event.created_at) < before)) return true;
        removed += 1;
        return false;
      });
      this.state.webhook_events[offerId] = kept;
    }
    if (removed > 0) await this.save();
    return removed;
  }

  // Records one attempt and releases the delivery. `update.next_attempt_at`
  // says when a failed delivery is due again.
  async updateWebhookDelivery(offerId, eventId, webhookId, update) {
    await this.load();
    const event = this.state.webhook_events[offerId]?.find((candidate) => candidate.id === eventId);
    if (!event) {
      throw storeError("webhook event does not exist", "WEBHOOK_EVENT_NOT_FOUND", 404);
    }

    const delivery = event.deliveries.find((candidate) => candidate.webhook_id === webhookId);
    if (!delivery) {
      throw storeError("webhook delivery does not exist", "WEBHOOK_DELIVERY_NOT_FOUND", 404);
    }

    const now = new Date().toISOString();
    delivery.status = update.status;
    delivery.attempts = (delivery.attempts ?? 0) + 1;
    delivery.updated_at = now;
    delivery.last_attempt_at = now;
    delivery.response_status = update.response_status;
    // Only the status code of a delivery's answer is kept.
    delete delivery.response_body;
    delivery.error = update.error;
    delivery.next_attempt_at = update.next_attempt_at;
    delete delivery.locked_until;

    await this.save();
    return clone(delivery);
  }

  async summary() {
    await this.load();
    const resolutionCounts = Object.values(this.state.resolutions).map((records) => records.length);
    const resolution_statuses = Object.values(this.state.resolutions)
      .flat()
      .reduce((counts, record) => {
        const status = record.status ?? "unknown";
        counts[status] = (counts[status] ?? 0) + 1;
        return counts;
      }, {});
    return {
      offers: Object.keys(this.state.offers).length,
      fiber_addresses: Object.keys(this.state.usernames).length,
      resolution_count: resolutionCounts.reduce((total, count) => total + count, 0),
      resolution_statuses,
      webhook_count: Object.values(this.state.webhooks ?? {}).flat().length,
      webhook_event_count: Object.values(this.state.webhook_events ?? {}).flat().length
    };
  }
}

export class JsonOfferStore extends InMemoryOfferStore {
  constructor(filePath, options = {}) {
    super();
    this.filePath = filePath;
    this.cipher = new SecretCipher({
      key: options.encryptionKey,
      previousKeys: [options.previousEncryptionKey]
    });
    this.loaded = false;
    this.writeQueue = Promise.resolve();
  }

  async load() {
    if (this.loaded) return;

    try {
      const raw = await readFile(this.filePath, "utf8");
      let stored;
      try {
        stored = JSON.parse(raw);
      } catch (error) {
        // Refuse to carry on: the next save would replace the file with an
        // empty store. `loaded` stays false, so nothing is written.
        throw storeError(
          `the store file ${this.filePath} is not valid JSON (${error.message}); restore it from a backup`,
          "STORE_FILE_CORRUPT",
          500
        );
      }
      this.state = await decryptStoredSecrets(stored, this.cipher);
      this.state.offers ??= {};
      this.state.usernames ??= {};
      this.state.resolutions ??= {};
      this.state.webhooks ??= {};
      this.state.webhook_events ??= {};
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    await this.#removeLeftoverTemporaryFiles();
    this.loaded = true;
  }

  async save() {
    await this.load();
    // The snapshot is taken when its turn to write comes, so writes land in
    // the order they were asked for and each one carries the latest state.
    this.writeQueue = this.writeQueue
      .catch(() => {})
      .then(async () => {
        const snapshot = JSON.stringify(await encryptStoredSecrets(this.state, this.cipher), null, 2);
        await this.#replaceFile(`${snapshot}\n`);
      });
    return this.writeQueue;
  }

  // Waits for writes already asked for. Called when the resolver shuts down.
  async close() {
    await this.writeQueue.catch(() => {});
  }

  // Replaces the store file in one step. The new contents go to a temporary
  // file beside it, are flushed to disk, and only then take the file's name,
  // so a crash or a full disk leaves the previous file whole instead of a
  // half-written one. The file is private to the resolver's user: it holds
  // payment records and encrypted webhook secrets.
  async #replaceFile(contents) {
    const directory = dirname(this.filePath);
    await mkdir(directory, { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(contents);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, this.filePath);
    } catch (error) {
      await handle?.close().catch(() => {});
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
    // Flush the directory so the rename itself survives a power loss. Not
    // every platform allows a directory to be opened; the rename has still
    // happened.
    try {
      const directoryHandle = await open(directory, "r");
      await directoryHandle.sync().finally(() => directoryHandle.close());
    } catch {
      // Best effort.
    }
  }

  // A crash between writing a temporary file and renaming it leaves that file
  // behind. It was never the store, so it is removed.
  async #removeLeftoverTemporaryFiles() {
    const directory = dirname(this.filePath);
    const prefix = `${basename(this.filePath)}.`;
    const names = await readdir(directory).catch(() => []);
    await Promise.all(
      names
        .filter((name) => name.startsWith(prefix) && name.endsWith(".tmp"))
        .map((name) => rm(join(directory, name), { force: true }).catch(() => {}))
    );
  }

  // Rewrites every stored secret under the current encryption key, then proves
  // the file can be read with that key alone. Used by `npm run secrets:rotate`.
  async reencryptSecrets() {
    if (!this.cipher.enabled) {
      throw storeError("RESOLVER_SECRET_ENCRYPTION_KEY is required to re-encrypt secrets", "ENCRYPTION_KEY_REQUIRED", 500);
    }
    const before = { plaintext: 0, v1: 0, v2: 0 };
    try {
      const stored = JSON.parse(await readFile(this.filePath, "utf8"));
      for (const webhook of Object.values(stored.webhooks ?? {}).flat()) before[SecretCipher.formatOf(webhook.secret)] += 1;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    await this.save();
    const secrets = Object.values(this.state.webhooks ?? {}).flat().length;
    if (secrets > 0) {
      const rewritten = JSON.parse(await readFile(this.filePath, "utf8"));
      await decryptStoredSecrets(rewritten, this.cipher.currentKeyOnly());
    }
    return { backend: "json", secrets, reencrypted: secrets, stored_as_before: before };
  }

  async healthCheck() {
    await this.load();
    return { ok: true, backend: "json" };
  }
}

async function encryptStoredSecrets(state, cipher) {
  const snapshot = clone(state);
  for (const webhook of Object.values(snapshot.webhooks ?? {}).flat()) {
    webhook.secret = await cipher.encrypt(webhook.secret);
  }
  return snapshot;
}

async function decryptStoredSecrets(state, cipher) {
  for (const webhook of Object.values(state.webhooks ?? {}).flat()) {
    webhook.secret = await cipher.decrypt(webhook.secret);
  }
  return state;
}

// An invoice that was issued and whose outcome is not known yet.
const OPEN_RESOLUTION_STATUSES = new Set(["invoice_created", "invoice_received"]);
// An invoice that ended unpaid. It never took anything from the offer.
const RELEASED_RESOLUTION_STATUSES = new Set(["invoice_expired", "invoice_failed", "invoice_cancelled"]);

// A cursor names the last item of a page by its creation time and ID. It is
// opaque to callers: base64url of a small JSON array.
// The creation time in a cursor, as either store writes it. Anything else,
// such as a word PostgreSQL would read as a date, was not issued here.
const CURSOR_TIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}(:?\d{2})?)$/;

export function encodeCursor(key) {
  return Buffer.from(JSON.stringify(key)).toString("base64url");
}

export function decodeCursor(cursor) {
  if (cursor === undefined || cursor === null || cursor === "") return undefined;
  try {
    const key = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    if (Array.isArray(key) && key.length === 2 && key.every((part) => typeof part === "string") && CURSOR_TIME.test(key[0])) {
      return key;
    }
  } catch {
    // Reported below.
  }
  throw storeError("cursor is not one this resolver issued", "INVALID_CURSOR", 400);
}

// One page of `items` ordered by `keyOf(item)`, a [created_at, id] pair.
function pageOf(items, keyOf, options = {}) {
  const descending = options.order === "desc";
  const limit = options.limit ?? 100;
  const after = decodeCursor(options.cursor);
  const compare = (left, right) => left[0].localeCompare(right[0]) || left[1].localeCompare(right[1]);
  const ordered = items
    .map((item) => ({ item, key: keyOf(item) }))
    .sort((left, right) => (descending ? compare(right.key, left.key) : compare(left.key, right.key)));
  const rest = after
    ? ordered.filter(({ key }) => (descending ? compare(key, after) < 0 : compare(key, after) > 0))
    : ordered;
  const page = rest.slice(0, limit);
  return {
    items: clone(page.map(({ item }) => item)),
    ...(rest.length > limit ? { next_cursor: encodeCursor(page[page.length - 1].key) } : {})
  };
}

export function normalizeUsername(username) {
  if (typeof username !== "string" || username.trim() === "") {
    throw storeError("username is required", "INVALID_USERNAME", 400);
  }

  const normalized = username.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(normalized)) {
    throw storeError("username must be 1-64 characters using letters, numbers, dot, underscore, or dash", "INVALID_USERNAME", 400);
  }

  return normalized;
}

function storeError(message, code, status) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function webhookSecretHint(secret) {
  if (!secret) return undefined;
  return `${secret.slice(0, 6)}...${secret.slice(-4)}`;
}
