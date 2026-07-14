import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { normalizeUsername } from "./store.js";

export class PostgresOfferStore {
  constructor(options = {}) {
    this.pool = options.pool ?? new pg.Pool({
      connectionString: options.connectionString ?? process.env.DATABASE_URL,
      max: Number(options.maxConnections ?? process.env.DATABASE_POOL_MAX ?? 10)
    });
    this.ownsPool = !options.pool;
    this.encryptionKey = options.encryptionKey
      ? createHash("sha256").update(options.encryptionKey).digest()
      : undefined;
  }

  async close() {
    if (this.ownsPool) await this.pool.end();
  }

  async healthCheck() {
    await this.pool.query("SELECT 1");
    return { ok: true, backend: "postgresql" };
  }

  async load() {}

  async save() {}

  async upsertOffer(offer, encodedOffer, options = {}) {
    return this.#transaction(async (client) => {
      const result = await client.query(
        `INSERT INTO fiber_offers (offer_id, offer, encoded_offer, ownership)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (offer_id) DO UPDATE SET
           offer = EXCLUDED.offer,
           encoded_offer = EXCLUDED.encoded_offer,
           ownership = COALESCE(EXCLUDED.ownership, fiber_offers.ownership),
           updated_at = now()
         RETURNING *`,
        [offer.offer_id, json(offer), encodedOffer, json(options.ownership)]
      );
      if (options.username) await this.#bindUsername(client, options.username, offer.offer_id);
      return offerRow(result.rows[0]);
    });
  }

  async getOffer(offerId) {
    const result = await this.pool.query("SELECT * FROM fiber_offers WHERE offer_id = $1", [offerId]);
    return result.rows[0] ? offerRow(result.rows[0]) : undefined;
  }

  async listOffers() {
    const result = await this.pool.query("SELECT * FROM fiber_offers ORDER BY updated_at DESC");
    return result.rows.map(offerRow);
  }

  async getUsernameForOffer(offerId) {
    const result = await this.pool.query(
      "SELECT username FROM fiber_addresses WHERE offer_id = $1 ORDER BY created_at LIMIT 1",
      [offerId]
    );
    return result.rows[0]?.username;
  }

  async bindUsername(username, offerId) {
    return this.#transaction((client) => this.#bindUsername(client, username, offerId));
  }

  async #bindUsername(client, username, offerId) {
    const normalized = normalizeUsername(username);
    const result = await client.query(
      `INSERT INTO fiber_addresses (username, offer_id)
       VALUES ($1, $2)
       ON CONFLICT (username) DO UPDATE SET offer_id = EXCLUDED.offer_id
       WHERE fiber_addresses.offer_id = EXCLUDED.offer_id
       RETURNING username, offer_id`,
      [normalized, offerId]
    );
    if (result.rowCount === 0) {
      throw storeError("username is already bound to another offer", "USERNAME_ALREADY_CLAIMED", 409);
    }
    return result.rows[0];
  }

  async getByUsername(username) {
    const normalized = normalizeUsername(username);
    const result = await this.pool.query(
      `SELECT a.username, a.created_at AS binding_created_at, o.*
       FROM fiber_addresses a
       JOIN fiber_offers o ON o.offer_id = a.offer_id
       WHERE a.username = $1`,
      [normalized]
    );
    if (!result.rows[0]) return undefined;
    return {
      username: normalized,
      binding: {
        offer_id: result.rows[0].offer_id,
        created_at: iso(result.rows[0].binding_created_at)
      },
      entry: offerRow(result.rows[0])
    };
  }

  async revokeOffer(offerId, revocation) {
    const result = await this.pool.query(
      `UPDATE fiber_offers SET
         disabled = true,
         revocation = $2,
         revoked_at = to_timestamp($3),
         updated_at = now()
       WHERE offer_id = $1 AND disabled = false
       RETURNING *`,
      [offerId, json(revocation), revocation.revoked_at]
    );
    if (result.rows[0]) return offerRow(result.rows[0]);
    const existing = await this.getOffer(offerId);
    if (!existing) throw storeError("offer_id does not exist", "OFFER_NOT_FOUND", 404);
    throw storeError("offer is already revoked", "OFFER_REVOKED", 409);
  }

  async reserveInvoiceAttempt(offerId, input) {
    return this.#transaction(async (client) => {
      const offerResult = await client.query("SELECT * FROM fiber_offers WHERE offer_id = $1 FOR UPDATE", [offerId]);
      const entry = offerResult.rows[0] ? offerRow(offerResult.rows[0]) : undefined;
      if (!entry) throw storeError("offer_id does not exist", "OFFER_NOT_FOUND", 404);
      if (entry.disabled) throw storeError("offer has been revoked", "OFFER_REVOKED", 410);

      await client.query(
        "DELETE FROM fiber_resolutions WHERE offer_id = $1 AND status = 'invoice_pending' AND reservation_expires_at < now()",
        [offerId]
      );

      if (input.idempotencyKey) {
        const existing = await client.query(
          "SELECT * FROM fiber_resolutions WHERE offer_id = $1 AND idempotency_key = $2",
          [offerId, input.idempotencyKey]
        );
        if (existing.rows[0]) {
          const record = resolutionRow(existing.rows[0]);
          if (record.idempotency_fingerprint !== input.idempotencyFingerprint) {
            throw storeError("idempotency key was already used for a different invoice request", "IDEMPOTENCY_KEY_REUSED", 409);
          }
          if (record.status === "invoice_pending") {
            throw storeError("invoice creation for this idempotency key is still in progress", "INVOICE_REQUEST_IN_PROGRESS", 409);
          }
          return { replay: true, record };
        }
      }

      const priorResult = await client.query(
        "SELECT * FROM fiber_resolutions WHERE offer_id = $1 AND status <> 'invoice_failed' ORDER BY created_at",
        [offerId]
      );
      const prior = priorResult.rows.map(resolutionRow);
      if (entry.offer.single_use && prior.length > 0) {
        throw storeError("single-use offer already produced an invoice", "OFFER_ALREADY_USED", 409);
      }
      const recurrence = recurrenceReservation(entry.offer, input.request, prior);
      const now = new Date().toISOString();
      const id = `res_${randomUUID()}`;
      const history = [{ status: "invoice_pending", at: now, source: "resolver" }];
      const inserted = await client.query(
         `INSERT INTO fiber_resolutions (
           resolution_id, offer_id, status, amount, asset, recurrence,
           idempotency_key, idempotency_fingerprint, status_history, reservation_expires_at
         ) VALUES ($1, $2, 'invoice_pending', $3, $4, $5, $6, $7, $8, now() + interval '2 minutes')
         RETURNING *`,
        [
          id,
          offerId,
          input.request.amount,
          json(input.request.asset),
          json(recurrence),
          input.idempotencyKey ?? null,
          input.idempotencyFingerprint ?? null,
          json(history)
        ]
      );
      return { replay: false, record: resolutionRow(inserted.rows[0]) };
    });
  }

  async finalizeInvoiceReservation(offerId, resolutionId, invoice) {
    const now = new Date().toISOString();
    const event = { status: "invoice_created", at: now, source: "resolver" };
    const result = await this.pool.query(
      `UPDATE fiber_resolutions SET
         status = 'invoice_created',
         invoice = $3,
         status_history = status_history || $4::jsonb,
         reservation_expires_at = NULL,
         updated_at = now()
       WHERE offer_id = $1 AND resolution_id = $2 AND status = 'invoice_pending'
       RETURNING *`,
      [offerId, resolutionId, json(invoice), json([event])]
    );
    if (!result.rows[0]) throw storeError("invoice reservation is not pending", "INVOICE_RESERVATION_NOT_PENDING", 409);
    return resolutionRow(result.rows[0]);
  }

  async abandonInvoiceReservation(offerId, resolutionId) {
    await this.pool.query(
      "DELETE FROM fiber_resolutions WHERE offer_id = $1 AND resolution_id = $2 AND status = 'invoice_pending'",
      [offerId, resolutionId]
    );
  }

  async addResolution(offerId, resolution) {
    const now = new Date().toISOString();
    const status = resolution.status ?? "invoice_created";
    const id = resolution.id ?? `res_${randomUUID()}`;
    const history = resolution.status_history ?? [{ status, at: now, source: resolution.source ?? "resolver" }];
    const result = await this.pool.query(
      `INSERT INTO fiber_resolutions (
         resolution_id, offer_id, status, amount, asset, invoice, recurrence,
         idempotency_key, idempotency_fingerprint, settlement, status_history
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        id, offerId, status, resolution.amount, json(resolution.asset), json(resolution.invoice),
        json(resolution.recurrence), resolution.idempotency_key ?? null,
        resolution.idempotency_fingerprint ?? null, json(resolution.settlement ?? {}), json(history)
      ]
    );
    return resolutionRow(result.rows[0]);
  }

  async getResolutions(offerId) {
    const result = await this.pool.query(
      "SELECT * FROM fiber_resolutions WHERE offer_id = $1 ORDER BY created_at",
      [offerId]
    );
    return result.rows.map(resolutionRow);
  }

  async getResolution(offerId, resolutionId) {
    const result = await this.pool.query(
      "SELECT * FROM fiber_resolutions WHERE offer_id = $1 AND resolution_id = $2",
      [offerId, resolutionId]
    );
    return result.rows[0] ? resolutionRow(result.rows[0]) : undefined;
  }

  async findResolutionByIdempotencyKey(offerId, idempotencyKey) {
    const result = await this.pool.query(
      "SELECT * FROM fiber_resolutions WHERE offer_id = $1 AND idempotency_key = $2",
      [offerId, idempotencyKey]
    );
    return result.rows[0] ? resolutionRow(result.rows[0]) : undefined;
  }

  async updateResolutionStatus(offerId, resolutionId, update) {
    return this.#transaction(async (client) => {
      const currentResult = await client.query(
        "SELECT * FROM fiber_resolutions WHERE offer_id = $1 AND resolution_id = $2 FOR UPDATE",
        [offerId, resolutionId]
      );
      if (!currentResult.rows[0]) throw storeError("resolution_id does not exist", "RESOLUTION_NOT_FOUND", 404);
      const current = resolutionRow(currentResult.rows[0]);
      const now = new Date().toISOString();
      const history = [
        ...(current.status_history ?? []),
        clean({ status: update.status, at: now, source: update.source ?? "manual", note: update.note, details: update.details })
      ];
      const timestamps = statusTimestamps(update.status, update, now);
      const result = await client.query(
        `UPDATE fiber_resolutions SET
           status = $3,
           status_history = $4,
           settlement = settlement || $5::jsonb,
           received_at = COALESCE($6::timestamptz, received_at),
           settled_at = COALESCE($7::timestamptz, settled_at),
           expired_at = COALESCE($8::timestamptz, expired_at),
           failed_at = COALESCE($9::timestamptz, failed_at),
           cancelled_at = COALESCE($10::timestamptz, cancelled_at),
           updated_at = now()
         WHERE offer_id = $1 AND resolution_id = $2
         RETURNING *`,
        [
          offerId, resolutionId, update.status, json(history), json(update.settlement ?? {}),
          timestamps.received_at, timestamps.settled_at, timestamps.expired_at,
          timestamps.failed_at, timestamps.cancelled_at
        ]
      );
      return resolutionRow(result.rows[0]);
    });
  }

  async addWebhook(offerId, webhook) {
    const id = `wh_${randomUUID()}`;
    const result = await this.pool.query(
      `INSERT INTO fiber_webhooks (webhook_id, offer_id, url, events, secret, secret_hint)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [id, offerId, webhook.url, json(webhook.events), encryptSecret(webhook.secret, this.encryptionKey), webhookSecretHint(webhook.secret)]
    );
    return webhookRow(result.rows[0], this.encryptionKey);
  }

  async listWebhooks(offerId) {
    const result = await this.pool.query(
      "SELECT * FROM fiber_webhooks WHERE offer_id = $1 ORDER BY created_at",
      [offerId]
    );
    return result.rows.map((row) => webhookRow(row, this.encryptionKey));
  }

  async getWebhook(offerId, webhookId) {
    const result = await this.pool.query(
      "SELECT * FROM fiber_webhooks WHERE offer_id = $1 AND webhook_id = $2",
      [offerId, webhookId]
    );
    return result.rows[0] ? webhookRow(result.rows[0], this.encryptionKey) : undefined;
  }

  async updateWebhook(offerId, webhookId, update) {
    const current = await this.getWebhook(offerId, webhookId);
    if (!current) throw storeError("webhook subscription does not exist", "WEBHOOK_NOT_FOUND", 404);
    const nextSecret = update.secret ?? current.secret;
    const result = await this.pool.query(
      `UPDATE fiber_webhooks SET url=$3, events=$4, disabled=$5, secret=$6, secret_hint=$7, updated_at=now()
       WHERE offer_id=$1 AND webhook_id=$2 RETURNING *`,
      [
        offerId, webhookId, update.url ?? current.url, json(update.events ?? current.events),
        update.disabled ?? current.disabled, encryptSecret(nextSecret, this.encryptionKey), webhookSecretHint(nextSecret)
      ]
    );
    return webhookRow(result.rows[0], this.encryptionKey);
  }

  async deleteWebhook(offerId, webhookId) {
    const result = await this.pool.query(
      "DELETE FROM fiber_webhooks WHERE offer_id=$1 AND webhook_id=$2 RETURNING *",
      [offerId, webhookId]
    );
    if (!result.rows[0]) throw storeError("webhook subscription does not exist", "WEBHOOK_NOT_FOUND", 404);
    return webhookRow(result.rows[0], this.encryptionKey);
  }

  async addWebhookEvent(offerId, event, options = {}) {
    return this.#transaction(async (client) => {
      const eventId = `evt_${randomUUID()}`;
      const inserted = await client.query(
        `INSERT INTO fiber_webhook_events (event_id, offer_id, type, payload)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [eventId, offerId, event.type, json(event.payload)]
      );
      const targetIds = options.webhookIds ?? null;
      const subscriptions = await client.query(
        `SELECT * FROM fiber_webhooks
         WHERE offer_id=$1 AND disabled=false
           AND (($3::text[] IS NULL AND events @> jsonb_build_array($2::text))
             OR ($3::text[] IS NOT NULL AND webhook_id = ANY($3::text[])))`,
        [offerId, event.type, targetIds]
      );
      for (const webhook of subscriptions.rows) {
        await client.query(
          `INSERT INTO fiber_webhook_deliveries (event_id, webhook_id, url)
           VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
          [eventId, webhook.webhook_id, webhook.url]
        );
      }
      return eventRow(inserted.rows[0], subscriptions.rows.map((row) => pendingDelivery(eventId, row)));
    });
  }

  async listWebhookEvents(offerId) {
    const [events, deliveries] = await Promise.all([
      this.pool.query("SELECT * FROM fiber_webhook_events WHERE offer_id=$1 ORDER BY created_at", [offerId]),
      this.pool.query(
        `SELECT d.* FROM fiber_webhook_deliveries d
         JOIN fiber_webhook_events e ON e.event_id=d.event_id
         WHERE e.offer_id=$1 ORDER BY d.created_at`,
        [offerId]
      )
    ]);
    const byEvent = new Map();
    for (const delivery of deliveries.rows.map(deliveryRow)) {
      const group = byEvent.get(delivery.event_id) ?? [];
      group.push(delivery);
      byEvent.set(delivery.event_id, group);
    }
    return events.rows.map((row) => eventRow(row, byEvent.get(row.event_id) ?? []));
  }

  async updateWebhookDelivery(offerId, eventId, webhookId, update) {
    const result = await this.pool.query(
      `UPDATE fiber_webhook_deliveries d SET
         status=$4, attempts=attempts+1, response_status=$5, response_body=$6,
         error=$7, last_attempt_at=now(), updated_at=now()
       FROM fiber_webhook_events e
       WHERE d.event_id=$2 AND d.webhook_id=$3 AND e.event_id=d.event_id AND e.offer_id=$1
       RETURNING d.*`,
      [offerId, eventId, webhookId, update.status, update.response_status ?? null, update.response_body ?? null, update.error ?? null]
    );
    if (!result.rows[0]) throw storeError("webhook delivery does not exist", "WEBHOOK_DELIVERY_NOT_FOUND", 404);
    return deliveryRow(result.rows[0]);
  }

  async summary() {
    const result = await this.pool.query(`
      SELECT
        (SELECT count(*)::int FROM fiber_offers) AS offers,
        (SELECT count(*)::int FROM fiber_addresses) AS fiber_addresses,
        (SELECT count(*)::int FROM fiber_resolutions) AS resolution_count,
        (SELECT count(*)::int FROM fiber_webhooks) AS webhook_count,
        (SELECT count(*)::int FROM fiber_webhook_events) AS webhook_event_count,
        COALESCE((SELECT jsonb_object_agg(status, count) FROM (
          SELECT status, count(*)::int AS count FROM fiber_resolutions GROUP BY status
        ) counts), '{}'::jsonb) AS resolution_statuses
    `);
    return result.rows[0];
  }

  async #transaction(operation) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw normalizePostgresError(error);
    } finally {
      client.release();
    }
  }
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
  return clean({
    cycle: expected,
    interval: terms.interval,
    scheduled_for: request.scheduled_for,
    approval_id: request.approval_id
  });
}

function offerRow(row) {
  return clean({
    offer: row.offer,
    encoded_offer: row.encoded_offer,
    disabled: row.disabled,
    ownership: row.ownership,
    revocation: row.revocation,
    revoked_at: iso(row.revoked_at),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at)
  });
}

function resolutionRow(row) {
  return clean({
    id: row.resolution_id,
    offer_id: row.offer_id,
    status: row.status,
    amount: row.amount,
    asset: row.asset,
    invoice: row.invoice,
    recurrence: row.recurrence,
    idempotency_key: row.idempotency_key,
    idempotency_fingerprint: row.idempotency_fingerprint,
    reservation_expires_at: iso(row.reservation_expires_at),
    settlement: row.settlement,
    status_history: row.status_history,
    received_at: iso(row.received_at),
    settled_at: iso(row.settled_at),
    expired_at: iso(row.expired_at),
    failed_at: iso(row.failed_at),
    cancelled_at: iso(row.cancelled_at),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at)
  });
}

function webhookRow(row, key) {
  return {
    id: row.webhook_id,
    offer_id: row.offer_id,
    url: row.url,
    events: row.events,
    secret: decryptSecret(row.secret, key),
    secret_hint: row.secret_hint,
    disabled: row.disabled,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at)
  };
}

function eventRow(row, deliveries) {
  return {
    id: row.event_id,
    offer_id: row.offer_id,
    type: row.type,
    payload: row.payload,
    created_at: iso(row.created_at),
    deliveries
  };
}

function pendingDelivery(eventId, webhook) {
  const now = new Date().toISOString();
  return {
    event_id: eventId,
    webhook_id: webhook.webhook_id,
    url: webhook.url,
    status: "pending",
    attempts: 0,
    created_at: now,
    updated_at: now
  };
}

function deliveryRow(row) {
  return clean({
    event_id: row.event_id,
    webhook_id: row.webhook_id,
    url: row.url,
    status: row.status,
    attempts: row.attempts,
    response_status: row.response_status,
    response_body: row.response_body,
    error: row.error,
    last_attempt_at: iso(row.last_attempt_at),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at)
  });
}

function statusTimestamps(status, update, now) {
  return {
    received_at: status === "invoice_received" ? update.received_at ?? now : null,
    settled_at: status === "invoice_paid" ? update.settled_at ?? now : null,
    expired_at: status === "invoice_expired" ? update.expired_at ?? now : null,
    failed_at: status === "invoice_failed" ? update.failed_at ?? now : null,
    cancelled_at: status === "invoice_cancelled" ? update.cancelled_at ?? now : null
  };
}

function encryptSecret(value, key) {
  if (!key || value.startsWith("enc:v1:")) return value;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `enc:v1:${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${ciphertext.toString("base64url")}`;
}

function decryptSecret(value, key) {
  if (!value?.startsWith("enc:v1:")) return value;
  if (!key) throw storeError("encrypted webhook secrets require RESOLVER_SECRET_ENCRYPTION_KEY", "ENCRYPTION_KEY_REQUIRED", 500);
  const [, version, iv, tag, ciphertext] = value.split(":");
  if (version !== "v1") throw storeError("unsupported encrypted webhook secret", "INVALID_ENCRYPTED_SECRET", 500);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
}

function webhookSecretHint(secret) {
  return secret ? `${secret.slice(0, 6)}...${secret.slice(-4)}` : undefined;
}

function normalizePostgresError(error) {
  if (error.code === "23505" && error.constraint === "fiber_resolutions_idempotency_idx") {
    return storeError("idempotency key already exists", "IDEMPOTENCY_KEY_REUSED", 409);
  }
  if (error.code === "23505" && error.constraint === "fiber_resolutions_recurrence_cycle_idx") {
    return storeError("recurrence cycle already exists", "INVALID_RECURRENCE_CYCLE", 409);
  }
  return error;
}

function storeError(message, code, status) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function iso(value) {
  return value instanceof Date ? value.toISOString() : value ?? undefined;
}

function clean(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function json(value) {
  return value === undefined ? null : JSON.stringify(value);
}
