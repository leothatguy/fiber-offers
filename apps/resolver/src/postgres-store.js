import { randomUUID } from "node:crypto";
import pg from "pg";
import { assertInvoiceCapacity } from "./resolution-rules.js";
import { SecretCipher } from "./secret-cipher.js";
import { normalizeUsername } from "./store.js";

export class PostgresOfferStore {
  constructor(options = {}) {
    this.pool = options.pool ?? new pg.Pool({
      connectionString: options.connectionString ?? process.env.DATABASE_URL,
      max: Number(options.maxConnections ?? process.env.DATABASE_POOL_MAX ?? 10)
    });
    this.ownsPool = !options.pool;
    this.cipher = new SecretCipher({
      key: options.encryptionKey,
      previousKeys: [options.previousEncryptionKey]
    });
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

      // Only single-use and recurring offers are limited by what was issued
      // before; a plain reusable offer needs no history at all. Resolutions
      // that ended unpaid never count, so they are not even read.
      // A recurring offer that is not single-use is limited per subscription,
      // so only that subscription's rows matter, however many payers it has.
      const limited = entry.offer.single_use || entry.offer.recurrence;
      const onlySubscription =
        entry.offer.recurrence && !entry.offer.single_use ? input.request.approval_id ?? "" : null;
      const prior = limited
        ? (
            await client.query(
              `SELECT * FROM fiber_resolutions
               WHERE offer_id = $1
                 AND status NOT IN ('invoice_expired', 'invoice_failed', 'invoice_cancelled')
                 AND ($2::text IS NULL OR recurrence ->> 'approval_id' = $2)
               ORDER BY created_at`,
              [offerId, onlySubscription]
            )
          ).rows.map(resolutionRow)
        : [];
      const recurrence = assertInvoiceCapacity(entry.offer, input.request, prior);
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

  // An offer's invoices that still await an outcome, optionally those of one
  // subscription only.
  async getOpenResolutions(offerId, options = {}) {
    const result = await this.pool.query(
      `SELECT * FROM fiber_resolutions
       WHERE offer_id = $1
         AND status IN ('invoice_created', 'invoice_received')
         AND ($2::text IS NULL OR recurrence ->> 'approval_id' = $2)
       ORDER BY created_at`,
      [offerId, options.approvalId ?? null]
    );
    return result.rows.map(resolutionRow);
  }

  // Up to `limit` invoices that await an outcome, across all offers, the one
  // asked about longest ago first. Each is marked as asked now, and rows another
  // worker is taking at the same moment are passed over, so two workers get
  // different batches. `staleMs` leaves out those asked about more recently
  // than that. Reads fiber_resolutions_sync_queue_idx, never the whole table.
  async claimOpenResolutions(limit, options = {}) {
    const result = await this.pool.query(
      `WITH due AS (
         SELECT resolution_id FROM fiber_resolutions
         WHERE status IN ('invoice_created', 'invoice_received')
           AND (last_synced_at IS NULL OR last_synced_at <= now() - make_interval(secs => $2))
         ORDER BY last_synced_at NULLS FIRST, created_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE fiber_resolutions r SET last_synced_at = now()
       FROM due WHERE r.resolution_id = due.resolution_id
       RETURNING r.*`,
      [limit, (options.staleMs ?? 0) / 1000]
    );
    return result.rows.map(resolutionRow).sort((left, right) => left.created_at.localeCompare(right.created_at));
  }

  // Removes reservations whose invoice was never issued. Returns how many.
  async pruneStaleReservations() {
    const result = await this.pool.query(
      "DELETE FROM fiber_resolutions WHERE status = 'invoice_pending' AND reservation_expires_at < now()"
    );
    return result.rowCount;
  }

  async updateResolutionStatus(offerId, resolutionId, update) {
    return (await this.#writeStatus(offerId, resolutionId, update, undefined)).record;
  }

  // Moves a resolution to `update.status` only if it is still in `update.from`.
  // The row is locked for the check and the write, so of two replicas or
  // workers racing on one resolution exactly one gets applied: true.
  async transitionResolution(offerId, resolutionId, update) {
    return this.#writeStatus(offerId, resolutionId, update, update.from);
  }

  async #writeStatus(offerId, resolutionId, update, expectedStatus) {
    return this.#transaction(async (client) => {
      const currentResult = await client.query(
        "SELECT * FROM fiber_resolutions WHERE offer_id = $1 AND resolution_id = $2 FOR UPDATE",
        [offerId, resolutionId]
      );
      if (!currentResult.rows[0]) throw storeError("resolution_id does not exist", "RESOLUTION_NOT_FOUND", 404);
      const current = resolutionRow(currentResult.rows[0]);
      if (expectedStatus !== undefined && current.status !== expectedStatus) {
        return { applied: false, record: current };
      }
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
      return { applied: true, record: resolutionRow(result.rows[0]) };
    });
  }

  async addWebhook(offerId, webhook) {
    const id = `wh_${randomUUID()}`;
    const result = await this.pool.query(
      `INSERT INTO fiber_webhooks (webhook_id, offer_id, url, events, secret, secret_hint)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [id, offerId, webhook.url, json(webhook.events), await this.cipher.encrypt(webhook.secret), webhookSecretHint(webhook.secret)]
    );
    return webhookRow(result.rows[0], this.cipher);
  }

  async listWebhooks(offerId) {
    const result = await this.pool.query(
      "SELECT * FROM fiber_webhooks WHERE offer_id = $1 ORDER BY created_at",
      [offerId]
    );
    return Promise.all(result.rows.map((row) => webhookRow(row, this.cipher)));
  }

  async getWebhook(offerId, webhookId) {
    const result = await this.pool.query(
      "SELECT * FROM fiber_webhooks WHERE offer_id = $1 AND webhook_id = $2",
      [offerId, webhookId]
    );
    return result.rows[0] ? webhookRow(result.rows[0], this.cipher) : undefined;
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
        update.disabled ?? current.disabled, await this.cipher.encrypt(nextSecret), webhookSecretHint(nextSecret)
      ]
    );
    return webhookRow(result.rows[0], this.cipher);
  }

  // Rewrites every stored secret under the current encryption key, in one
  // transaction, after proving each new value can be read with that key alone.
  // Used by `npm run secrets:rotate`.
  async reencryptSecrets() {
    if (!this.cipher.enabled) {
      throw storeError("RESOLVER_SECRET_ENCRYPTION_KEY is required to re-encrypt secrets", "ENCRYPTION_KEY_REQUIRED", 500);
    }
    const currentOnly = this.cipher.currentKeyOnly();
    const before = { plaintext: 0, v1: 0, v2: 0 };
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const rows = (await client.query("SELECT webhook_id, secret FROM fiber_webhooks ORDER BY webhook_id FOR UPDATE")).rows;
      for (const row of rows) {
        if (row.secret === null) continue;
        before[SecretCipher.formatOf(row.secret)] += 1;
        const plaintext = await this.cipher.decrypt(row.secret);
        const rewritten = await this.cipher.encrypt(plaintext);
        if ((await currentOnly.decrypt(rewritten)) !== plaintext) {
          throw storeError("a re-encrypted secret did not read back", "SECRET_REENCRYPTION_FAILED", 500);
        }
        await client.query("UPDATE fiber_webhooks SET secret=$2 WHERE webhook_id=$1", [row.webhook_id, rewritten]);
      }
      await client.query("COMMIT");
      const secrets = before.plaintext + before.v1 + before.v2;
      return { backend: "postgresql", secrets, reencrypted: secrets, stored_as_before: before };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async deleteWebhook(offerId, webhookId) {
    const result = await this.pool.query(
      "DELETE FROM fiber_webhooks WHERE offer_id=$1 AND webhook_id=$2 RETURNING *",
      [offerId, webhookId]
    );
    if (!result.rows[0]) throw storeError("webhook subscription does not exist", "WEBHOOK_NOT_FOUND", 404);
    return webhookRow(result.rows[0], this.cipher);
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

  // Up to `limit` deliveries to attempt now, the one due longest first, each
  // held for `leaseMs`. Rows another worker is taking are passed over, and a
  // held row is not offered again until its lease runs out, so two workers
  // never send the same delivery. By default: every offer, deliveries that are
  // pending or waiting for a retry, and only those whose time has come (read
  // from fiber_webhook_deliveries_due_idx). An operator's request narrows it
  // to one offer or event and may take failed and dead ones regardless of
  // their schedule. Returns { offer_id, event, delivery, webhook } each;
  // webhook is undefined when the subscription was deleted.
  async claimPendingDeliveries(limit, options = {}) {
    const lease = (options.leaseMs ?? 60000) / 1000;
    const narrowed =
      options.offerId !== undefined || options.eventId !== undefined || options.statuses !== undefined || options.ignoreSchedule;
    const claimed = narrowed
      ? await this.pool.query(
          `WITH due AS (
             SELECT d.event_id, d.webhook_id
             FROM fiber_webhook_deliveries d
             JOIN fiber_webhook_events e ON e.event_id = d.event_id
             WHERE d.status = ANY($3::text[])
               AND ($4::text IS NULL OR e.offer_id = $4)
               AND ($5::text IS NULL OR d.event_id = $5)
               AND ($6::boolean OR d.next_attempt_at IS NULL OR d.next_attempt_at <= now())
               AND (d.locked_until IS NULL OR d.locked_until <= now())
             ORDER BY d.next_attempt_at NULLS FIRST, d.created_at
             LIMIT $1
             FOR UPDATE OF d SKIP LOCKED
           )
           UPDATE fiber_webhook_deliveries d SET locked_until = now() + make_interval(secs => $2)
           FROM due WHERE d.event_id = due.event_id AND d.webhook_id = due.webhook_id
           RETURNING d.*`,
          [
            limit,
            lease,
            options.statuses ?? ["pending", "failed"],
            options.offerId ?? null,
            options.eventId ?? null,
            Boolean(options.ignoreSchedule)
          ]
        )
      : await this.pool.query(
          `WITH due AS (
             SELECT event_id, webhook_id
             FROM fiber_webhook_deliveries
             WHERE status IN ('pending', 'failed')
               AND (next_attempt_at IS NULL OR next_attempt_at <= now())
               AND (locked_until IS NULL OR locked_until <= now())
             ORDER BY next_attempt_at NULLS FIRST, created_at
             LIMIT $1
             FOR UPDATE SKIP LOCKED
           )
           UPDATE fiber_webhook_deliveries d SET locked_until = now() + make_interval(secs => $2)
           FROM due WHERE d.event_id = due.event_id AND d.webhook_id = due.webhook_id
           RETURNING d.*`,
          [limit, lease]
        );
    if (claimed.rows.length === 0) return [];

    const [events, webhooks] = await Promise.all([
      this.pool.query("SELECT * FROM fiber_webhook_events WHERE event_id = ANY($1::text[])", [
        [...new Set(claimed.rows.map((row) => row.event_id))]
      ]),
      this.pool.query("SELECT * FROM fiber_webhooks WHERE webhook_id = ANY($1::text[])", [
        [...new Set(claimed.rows.map((row) => row.webhook_id))]
      ])
    ]);
    const eventById = new Map(events.rows.map((row) => [row.event_id, row]));
    const webhookById = new Map(
      await Promise.all(webhooks.rows.map(async (row) => [row.webhook_id, await webhookRow(row, this.cipher)]))
    );
    return claimed.rows
      .sort((left, right) => left.created_at - right.created_at)
      .map((row) => {
        const event = eventById.get(row.event_id);
        const { deliveries: _deliveries, ...eventFields } = eventRow(event, []);
        return {
          offer_id: event.offer_id,
          event: eventFields,
          delivery: deliveryRow(row),
          webhook: webhookById.get(row.webhook_id)
        };
      });
  }

  // Removes events created before `before` (an ISO time) that have nothing
  // left to deliver, oldest first, at most `limit`. Their delivery rows go
  // with them. Returns how many.
  async pruneWebhookEvents(options = {}) {
    const result = await this.pool.query(
      `DELETE FROM fiber_webhook_events
       WHERE event_id IN (
         SELECT e.event_id FROM fiber_webhook_events e
         WHERE e.created_at < $1::timestamptz
           AND NOT EXISTS (
             SELECT 1 FROM fiber_webhook_deliveries d
             WHERE d.event_id = e.event_id AND d.status IN ('pending', 'failed')
           )
         ORDER BY e.created_at
         LIMIT $2
       )`,
      [options.before, options.limit ?? 1000]
    );
    return result.rowCount;
  }

  // Records one attempt and releases the delivery. `update.next_attempt_at`
  // says when a failed delivery is due again.
  async updateWebhookDelivery(offerId, eventId, webhookId, update) {
    const result = await this.pool.query(
      `UPDATE fiber_webhook_deliveries d SET
         status=$4, attempts=attempts+1, response_status=$5, response_body=NULL,
         error=$6, next_attempt_at=$7::timestamptz, locked_until=NULL,
         last_attempt_at=now(), updated_at=now()
       FROM fiber_webhook_events e
       WHERE d.event_id=$2 AND d.webhook_id=$3 AND e.event_id=d.event_id AND e.offer_id=$1
       RETURNING d.*`,
      [
        offerId, eventId, webhookId, update.status, update.response_status ?? null, update.error ?? null,
        update.next_attempt_at ?? null
      ]
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

async function webhookRow(row, cipher) {
  return {
    id: row.webhook_id,
    offer_id: row.offer_id,
    url: row.url,
    events: row.events,
    secret: await cipher.decrypt(row.secret),
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
    error: row.error,
    last_attempt_at: iso(row.last_attempt_at),
    next_attempt_at: iso(row.next_attempt_at),
    locked_until: iso(row.locked_until),
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
