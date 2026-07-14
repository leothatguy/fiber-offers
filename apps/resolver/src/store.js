import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export class InMemoryOfferStore {
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

    const prior = records.filter((resolution) => resolution.status !== "invoice_failed");
    if (entry.offer.single_use && prior.length > 0) {
      throw storeError("single-use offer already produced an invoice", "OFFER_ALREADY_USED", 409);
    }

    const createdAt = new Date().toISOString();
    const record = {
      id: `res_${randomUUID()}`,
      offer_id: offerId,
      status: "invoice_pending",
      amount: input.request.amount,
      asset: input.request.asset,
      recurrence: recurrenceReservation(entry.offer, input.request, prior),
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

  async updateResolutionStatus(offerId, resolutionId, update) {
    await this.load();
    const resolutions = this.state.resolutions[offerId];
    if (!resolutions) {
      throw storeError("offer_id does not exist", "OFFER_NOT_FOUND", 404);
    }

    const record = resolutions.find((resolution) => resolution.id === resolutionId);
    if (!record) {
      throw storeError("resolution_id does not exist", "RESOLUTION_NOT_FOUND", 404);
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
    return clone(record);
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
    delivery.response_body = update.response_body;
    delivery.error = update.error;

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
    this.encryptionKey = options.encryptionKey ? createHash("sha256").update(options.encryptionKey).digest() : undefined;
    this.loaded = false;
    this.writeQueue = Promise.resolve();
  }

  async load() {
    if (this.loaded) return;

    try {
      const raw = await readFile(this.filePath, "utf8");
      this.state = decryptStoredSecrets(JSON.parse(raw), this.encryptionKey);
      this.state.offers ??= {};
      this.state.usernames ??= {};
      this.state.resolutions ??= {};
      this.state.webhooks ??= {};
      this.state.webhook_events ??= {};
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    this.loaded = true;
  }

  async save() {
    await this.load();
    const snapshot = JSON.stringify(encryptStoredSecrets(this.state, this.encryptionKey), null, 2);
    this.writeQueue = this.writeQueue
      .catch(() => {})
      .then(async () => {
        await mkdir(dirname(this.filePath), { recursive: true });
        await writeFile(this.filePath, `${snapshot}\n`);
      });
    return this.writeQueue;
  }

  async healthCheck() {
    await this.load();
    return { ok: true, backend: "json" };
  }
}

function encryptStoredSecrets(state, key) {
  const snapshot = clone(state);
  if (!key) return snapshot;
  for (const webhook of Object.values(snapshot.webhooks ?? {}).flat()) {
    if (typeof webhook.secret !== "string" || webhook.secret.startsWith("enc:v1:")) continue;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(webhook.secret, "utf8"), cipher.final()]);
    webhook.secret = `enc:v1:${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${ciphertext.toString("base64url")}`;
  }
  return snapshot;
}

function decryptStoredSecrets(state, key) {
  for (const webhook of Object.values(state.webhooks ?? {}).flat()) {
    if (typeof webhook.secret !== "string" || !webhook.secret.startsWith("enc:v1:")) continue;
    if (!key) throw storeError("encrypted webhook secrets require RESOLVER_SECRET_ENCRYPTION_KEY", "ENCRYPTION_KEY_REQUIRED", 500);
    const [, version, ivValue, tagValue, ciphertextValue] = webhook.secret.split(":");
    if (version !== "v1" || !ivValue || !tagValue || !ciphertextValue) {
      throw storeError("stored webhook secret has an invalid encrypted format", "INVALID_ENCRYPTED_SECRET", 500);
    }
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivValue, "base64url"));
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    webhook.secret = Buffer.concat([
      decipher.update(Buffer.from(ciphertextValue, "base64url")),
      decipher.final()
    ]).toString("utf8");
  }
  return state;
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

function recurrenceReservation(offer, request, prior) {
  if (!offer.recurrence) {
    if (request.recurrence_cycle !== undefined) {
      throw storeError("offer does not define recurring payment terms", "RECURRENCE_NOT_CONFIGURED", 400);
    }
    return undefined;
  }
  const terms = offer.recurrence;
  if (BigInt(request.amount) !== BigInt(terms.amount)) {
    throw storeError(`recurring cycle amount must equal ${terms.amount}`, "RECURRENCE_AMOUNT_MISMATCH", 400);
  }
  const cycles = prior.filter((resolution) => resolution.recurrence);
  const expected = cycles.length + 1;
  const requested = request.recurrence_cycle === undefined ? expected : Number(request.recurrence_cycle);
  if (!Number.isSafeInteger(requested) || requested !== expected) {
    throw storeError(`next recurrence cycle must be ${expected}`, "INVALID_RECURRENCE_CYCLE", 409);
  }
  if (terms.cap_cycles !== undefined && expected > terms.cap_cycles) {
    throw storeError("recurring payment cycle cap has been reached", "RECURRENCE_CYCLE_CAP_REACHED", 409);
  }
  const reserved = cycles.reduce((total, resolution) => total + BigInt(resolution.amount), 0n);
  if (terms.spending_cap_total !== undefined && reserved + BigInt(terms.amount) > BigInt(terms.spending_cap_total)) {
    throw storeError("recurring payment spending cap has been reached", "RECURRENCE_SPENDING_CAP_REACHED", 409);
  }
  return {
    cycle: expected,
    interval: terms.interval,
    ...(request.scheduled_for ? { scheduled_for: request.scheduled_for } : {}),
    ...(request.approval_id ? { approval_id: request.approval_id } : {})
  };
}
