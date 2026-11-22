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
  assert.equal(rejected[0].reason.code, "OFFER_INVOICE_OUTSTANDING");

  const reservation = fulfilled[0].value.record;
  const finalized = await primary.finalizeInvoiceReservation(offer.offer_id, reservation.id, {
    invoice: "fibt1postgres",
    payment_hash: "0x01",
    mode: "mock"
  });
  assert.equal(finalized.status, "invoice_created");
  assert.equal(finalized.reservation_expires_at, undefined);

  // The unpaid invoice lapses: the offer is free for the next payer.
  await primary.transitionResolution(offer.offer_id, finalized.id, { from: "invoice_created", status: "invoice_expired" });
  const next = await replica.reserveInvoiceAttempt(offer.offer_id, input("request-c"));
  const paid = await replica.finalizeInvoiceReservation(offer.offer_id, next.record.id, {
    invoice: "fibt1postgres2",
    payment_hash: "0x03",
    mode: "mock"
  });
  // Paid: used up for good, on every replica.
  await replica.transitionResolution(offer.offer_id, paid.id, { from: "invoice_created", status: "invoice_paid" });
  await assert.rejects(
    () => primary.reserveInvoiceAttempt(offer.offer_id, input("request-d")),
    (error) => error.code === "OFFER_ALREADY_USED" && error.status === 409
  );
});

test("PostgreSQL lets a recurring cycle be issued again after its invoice lapsed", { skip: !enabled }, async () => {
  const offer = signedOffer({ recurrence: { interval: "daily", amount: "1000", cap_cycles: 2 } });
  await primary.upsertOffer(offer, encodeOffer(offer));
  const cycle = (number, approvalId = "sub_alice") => ({
    request: { amount: "1000", asset: offer.assets[0], recurrence_cycle: number, approval_id: approvalId }
  });
  const issue = async (store, number, hash, approvalId) => {
    const reservation = await store.reserveInvoiceAttempt(offer.offer_id, cycle(number, approvalId));
    return store.finalizeInvoiceReservation(offer.offer_id, reservation.record.id, {
      invoice: `fibt1cycle${hash}`,
      payment_hash: hash,
      mode: "mock"
    });
  };

  const lapsed = await issue(primary, 1, "0x10");
  await primary.transitionResolution(offer.offer_id, lapsed.id, { from: "invoice_created", status: "invoice_expired" });
  // Cycle 1 again, on the other replica: the lapsed one no longer counts.
  const again = await issue(replica, 1, "0x11");

  assert.equal(again.recurrence.cycle, 1);
  // The same subscription cannot hold two invoices for one cycle.
  await assert.rejects(
    () => primary.reserveInvoiceAttempt(offer.offer_id, cycle(1)),
    (error) => error.code === "RECURRENCE_CYCLE_OUTSTANDING"
  );
  // A second subscriber starts their own cycle 1 on the same offer.
  const other = await issue(primary, 1, "0x12", "sub_bob");
  assert.deepEqual([other.recurrence.cycle, other.recurrence.approval_id], [1, "sub_bob"]);
  // Paying advances only the subscription that paid.
  await replica.transitionResolution(offer.offer_id, again.id, { from: "invoice_created", status: "invoice_paid" });
  const aliceTwo = await issue(replica, 2, "0x13", "sub_alice");
  assert.equal(aliceTwo.recurrence.cycle, 2);
  await assert.rejects(
    () => primary.reserveInvoiceAttempt(offer.offer_id, cycle(2, "sub_bob")),
    (error) => error.code === "INVALID_RECURRENCE_CYCLE"
  );
});

test("PostgreSQL applies a racing status change exactly once", { skip: !enabled }, async () => {
  const offer = signedOffer();
  await primary.upsertOffer(offer, encodeOffer(offer));
  const reservation = await primary.reserveInvoiceAttempt(offer.offer_id, {
    request: { amount: "1000", asset: offer.assets[0] }
  });
  const created = await primary.finalizeInvoiceReservation(offer.offer_id, reservation.record.id, {
    invoice: "fibt1race",
    payment_hash: "0x02",
    mode: "mock"
  });
  const markPaid = (store) =>
    store.transitionResolution(offer.offer_id, created.id, {
      from: "invoice_created",
      status: "invoice_paid",
      source: "test"
    });

  // Two replicas see invoice_created and both try to record the payment.
  const outcomes = await Promise.all([markPaid(primary), markPaid(replica), markPaid(primary), markPaid(replica)]);
  const stored = await replica.getResolution(offer.offer_id, created.id);

  assert.equal(outcomes.filter((outcome) => outcome.applied).length, 1);
  assert.equal(outcomes.every((outcome) => outcome.record.status === "invoice_paid"), true);
  assert.equal(stored.status_history.filter((entry) => entry.status === "invoice_paid").length, 1);
  // A status outside the state machine cannot be stored at all.
  await assert.rejects(
    () => primary.updateResolutionStatus(offer.offer_id, created.id, { status: "invoice_refunded" }),
    (error) => error.code === "23514"
  );
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
