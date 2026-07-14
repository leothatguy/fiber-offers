import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { createSignedOffer, encodeOffer, generateOfferKeyPair } from "../../../packages/protocol/src/index.js";
import { PostgresOfferStore } from "../src/postgres-store.js";

const connectionString = process.env.TEST_DATABASE_URL;
const enabled = Boolean(connectionString);
let primary;
let replica;

before(async () => {
  if (!enabled) return;
  primary = new PostgresOfferStore({ connectionString, encryptionKey: "test-encryption-key" });
  replica = new PostgresOfferStore({ connectionString, encryptionKey: "test-encryption-key" });
  await primary.pool.query(
    "TRUNCATE fiber_webhook_deliveries, fiber_webhook_events, fiber_webhooks, fiber_resolutions, fiber_addresses, fiber_offers CASCADE"
  );
});

after(async () => {
  if (primary) {
    await primary.pool.query(
      "TRUNCATE fiber_webhook_deliveries, fiber_webhook_events, fiber_webhooks, fiber_resolutions, fiber_addresses, fiber_offers CASCADE"
    );
  }
  await Promise.all([primary?.close(), replica?.close()]);
});

test("PostgreSQL store serializes single-use reservations across pools", { skip: !enabled }, async () => {
  const offer = signedOffer({ single_use: true });
  await primary.upsertOffer(offer, encodeOffer(offer));
  const input = (key) => ({
    request: { amount: "1000", asset: offer.assets[0] },
    idempotencyKey: key,
    idempotencyFingerprint: key
  });

  const attempts = await Promise.allSettled([
    primary.reserveInvoiceAttempt(offer.offer_id, input("request-a")),
    replica.reserveInvoiceAttempt(offer.offer_id, input("request-b"))
  ]);
  const fulfilled = attempts.filter((attempt) => attempt.status === "fulfilled");
  const rejected = attempts.filter((attempt) => attempt.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, "OFFER_ALREADY_USED");

  const reservation = fulfilled[0].value.record;
  const finalized = await primary.finalizeInvoiceReservation(offer.offer_id, reservation.id, {
    invoice: "fibt1postgres",
    payment_hash: "0x01",
    mode: "mock"
  });
  assert.equal(finalized.status, "invoice_created");
  assert.equal(finalized.reservation_expires_at, undefined);
});

test("PostgreSQL store provides durable idempotent replays", { skip: !enabled }, async () => {
  const offer = signedOffer();
  await primary.upsertOffer(offer, encodeOffer(offer));
  const input = {
    request: { amount: "1000", asset: offer.assets[0] },
    idempotencyKey: "stable-key",
    idempotencyFingerprint: "same-request"
  };
  const reservation = await primary.reserveInvoiceAttempt(offer.offer_id, input);
  await primary.finalizeInvoiceReservation(offer.offer_id, reservation.record.id, {
    invoice: "fibt1idempotent",
    payment_hash: "0x02",
    mode: "mock"
  });

  const replay = await replica.reserveInvoiceAttempt(offer.offer_id, input);
  assert.equal(replay.replay, true);
  assert.equal(replay.record.id, reservation.record.id);
  await assert.rejects(
    replica.reserveInvoiceAttempt(offer.offer_id, { ...input, idempotencyFingerprint: "changed-request" }),
    { code: "IDEMPOTENCY_KEY_REUSED" }
  );
});

test("PostgreSQL webhook outbox honors subscriptions and explicit targets", { skip: !enabled }, async () => {
  const offer = signedOffer();
  await primary.upsertOffer(offer, encodeOffer(offer));
  const paid = await primary.addWebhook(offer.offer_id, {
    url: "https://merchant.example/paid",
    events: ["invoice.paid"],
    secret: "postgres-webhook-secret"
  });
  const created = await primary.addWebhook(offer.offer_id, {
    url: "https://merchant.example/created",
    events: ["invoice.created"],
    secret: "postgres-webhook-secret-two"
  });

  const event = await primary.addWebhookEvent(offer.offer_id, { type: "invoice.paid", payload: { ok: true } });
  assert.deepEqual(event.deliveries.map((delivery) => delivery.webhook_id), [paid.id]);
  const targeted = await primary.addWebhookEvent(
    offer.offer_id,
    { type: "webhook.test", payload: { ok: true } },
    { webhookIds: [created.id] }
  );
  assert.deepEqual(targeted.deliveries.map((delivery) => delivery.webhook_id), [created.id]);
  const stored = await replica.listWebhookEvents(offer.offer_id);
  assert.equal(stored.length, 2);
  assert.equal((await replica.getWebhook(offer.offer_id, paid.id)).secret, "postgres-webhook-secret");
});

function signedOffer(extra = {}) {
  const keys = generateOfferKeyPair();
  return createSignedOffer(
    {
      node_id: `02${randomUUID().replaceAll("-", "").padEnd(64, "0")}`,
      public_key: keys.publicKeyPem,
      resolver_url: "https://resolver.example",
      assets: [{ asset_type: "ckb", symbol: "CKB" }],
      amount_min: "1000",
      amount_max: "1000",
      ...extra
    },
    keys.privateKeyPem
  );
}
