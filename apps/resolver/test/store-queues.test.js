// The store methods the background passes are built on: taking a bounded batch
// of open invoices, taking deliveries that are due under a lease, and removing
// what is no longer needed. Every case runs against the in-memory store and,
// when TEST_DATABASE_URL is set, against PostgreSQL in a schema of its own.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createSignedOffer, encodeOffer, generateOfferKeyPair } from "../../../packages/protocol/src/index.js";
import { InMemoryOfferStore } from "../src/store.js";
import { isolatedPostgresStore } from "./helpers/isolated-postgres.js";

const connectionString = process.env.TEST_DATABASE_URL;
const ckb = { asset_type: "ckb", symbol: "CKB" };

const backends = [
  {
    name: "memory",
    async open() {
      const store = new InMemoryOfferStore();
      return {
        store,
        another: () => store,
        async expireReservation(offerId, resolutionId) {
          store.state.resolutions[offerId].find((record) => record.id === resolutionId).reservation_expires_at =
            new Date(Date.now() - 1000).toISOString();
        },
        async close() {}
      };
    }
  },
  {
    name: "postgresql",
    skip: connectionString ? false : "TEST_DATABASE_URL is not set",
    async open() {
      const database = await isolatedPostgresStore(connectionString);
      return {
        ...database,
        async expireReservation(_offerId, resolutionId) {
          await database.pool.query(
            "UPDATE fiber_resolutions SET reservation_expires_at = now() - interval '1 second' WHERE resolution_id = $1",
            [resolutionId]
          );
        }
      };
    }
  }
];

for (const backend of backends) {
  const each = (name, run) =>
    test(`${backend.name}: ${name}`, { skip: backend.skip }, async () => {
      const harness = await backend.open();
      try {
        await run(harness);
      } finally {
        await harness.close();
      }
    });

  each("a claim returns open invoices only, the longest unasked first, and each once", async ({ store }) => {
    const first = await registerOffer(store);
    const second = await registerOffer(store);
    const a = await invoice(store, first, "a");
    const paid = await invoice(store, first, "paid");
    const b = await invoice(store, second, "b");
    const expired = await invoice(store, second, "expired");
    const received = await invoice(store, first, "received");
    await store.updateResolutionStatus(first.offer_id, paid.id, { status: "invoice_paid" });
    await store.updateResolutionStatus(second.offer_id, expired.id, { status: "invoice_expired" });
    await store.updateResolutionStatus(first.offer_id, received.id, { status: "invoice_received" });
    // A reservation is not an invoice yet.
    await store.reserveInvoiceAttempt(first.offer_id, { request: { amount: "1000", asset: ckb } });

    // Which invoices a batch holds is defined; their order within it is not.
    const ids = (records) => records.map((record) => record.id).sort();
    const firstBatch = await store.claimOpenResolutions(2);
    assert.deepEqual(ids(firstBatch), ids([a, b]));
    const claimedA = firstBatch.find((record) => record.id === a.id);
    assert.equal(claimedA.offer_id, first.offer_id);
    assert.equal(claimedA.invoice.payment_hash, a.invoice.payment_hash);
    assert.equal(firstBatch.find((record) => record.id === b.id).offer_id, second.offer_id);

    // The rest, then round again from the one asked about longest ago.
    assert.deepEqual(ids(await store.claimOpenResolutions(2)), ids([received, a]));
    assert.deepEqual(ids(await store.claimOpenResolutions(10)), ids([a, b, received]));

    // Asked a moment ago: nothing is due for a caller that waits a minute between asks.
    assert.deepEqual(await store.claimOpenResolutions(10, { staleMs: 60_000 }), []);

    // Once an invoice has an outcome it is never offered again.
    await store.updateResolutionStatus(first.offer_id, a.id, { status: "invoice_paid" });
    assert.deepEqual(ids(await store.claimOpenResolutions(10)), ids([b, received]));
  });

  each("two workers claiming at once get different invoices", async ({ store, another }) => {
    const offer = await registerOffer(store);
    const ids = [];
    for (let index = 0; index < 12; index += 1) ids.push((await invoice(store, offer, `n${index}`)).id);

    const [left, right] = await Promise.all([store.claimOpenResolutions(6), another().claimOpenResolutions(6)]);
    const claimed = [...left, ...right].map((record) => record.id);
    assert.equal(new Set(claimed).size, claimed.length, "an invoice was handed to both workers");
    // Whatever one worker passed over while the other held it is still there
    // for the next round, so nothing is lost either.
    const rest = await store.claimOpenResolutions(12, { staleMs: 60_000 });
    assert.deepEqual([...claimed, ...rest.map((record) => record.id)].sort(), ids.sort());
  });

  each("the open invoices of one offer can be read alone, and by subscription", async ({ store }) => {
    const offer = await registerOffer(store);
    const other = await registerOffer(store);
    const mine = await invoice(store, offer, "mine", { recurrence: { cycle: 1, approval_id: "sub_a" } });
    const theirs = await invoice(store, offer, "theirs", { recurrence: { cycle: 2, approval_id: "sub_b" } });
    const settled = await invoice(store, offer, "settled", { recurrence: { cycle: 3, approval_id: "sub_a" } });
    await invoice(store, other, "elsewhere");
    await store.updateResolutionStatus(offer.offer_id, settled.id, { status: "invoice_paid" });

    assert.deepEqual((await store.getOpenResolutions(offer.offer_id)).map((record) => record.id), [mine.id, theirs.id]);
    assert.deepEqual((await store.getOpenResolutions(offer.offer_id, { approvalId: "sub_a" })).map((record) => record.id), [mine.id]);
    assert.deepEqual(await store.getOpenResolutions(offer.offer_id, { approvalId: "sub_c" }), []);
  });

  each("a reservation whose invoice never came is removed, a fresh one is kept", async ({ store, expireReservation }) => {
    const offer = await registerOffer(store);
    const stale = await store.reserveInvoiceAttempt(offer.offer_id, { request: { amount: "1000", asset: ckb } });
    const fresh = await store.reserveInvoiceAttempt(offer.offer_id, { request: { amount: "1000", asset: ckb } });
    await expireReservation(offer.offer_id, stale.record.id);

    assert.equal(await store.pruneStaleReservations(), 1);
    assert.equal(await store.pruneStaleReservations(), 0);
    assert.deepEqual((await store.getResolutions(offer.offer_id)).map((record) => record.id), [fresh.record.id]);
  });

  each("a claimed delivery is held until it is answered or its lease runs out", async ({ store, another }) => {
    const offer = await registerOffer(store);
    const webhook = await store.addWebhook(offer.offer_id, { url: "https://merchant.example/hook", events: ["invoice.created"], secret: "whsec_test" });
    const event = await store.addWebhookEvent(offer.offer_id, { type: "invoice.created", payload: { n: 1 } });

    const [claim] = await store.claimPendingDeliveries(10, { leaseMs: 200 });
    assert.equal(claim.offer_id, offer.offer_id);
    assert.equal(claim.event.id, event.id);
    assert.equal(claim.event.type, "invoice.created");
    assert.deepEqual(claim.event.payload, { n: 1 });
    assert.equal(claim.delivery.webhook_id, webhook.id);
    assert.equal(claim.delivery.status, "pending");
    assert.equal(claim.delivery.attempts, 0);
    // The secret comes with it, decrypted, so the caller can sign the request.
    assert.equal(claim.webhook.secret, "whsec_test");
    assert.equal(claim.webhook.url, "https://merchant.example/hook");

    // Held: neither this worker nor another gets it again, by any route.
    assert.deepEqual(await another().claimPendingDeliveries(10), []);
    assert.deepEqual(await store.claimPendingDeliveries(10, { offerId: offer.offer_id, ignoreSchedule: true }), []);

    // A worker that died leaves it held only for the lease.
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal((await another().claimPendingDeliveries(10)).length, 1);
  });

  each("a failed delivery waits for its next attempt, and a dead one for an operator", async ({ store }) => {
    const offer = await registerOffer(store);
    const webhook = await store.addWebhook(offer.offer_id, { url: "https://merchant.example/hook", events: ["invoice.created"], secret: "whsec_test" });
    const event = await store.addWebhookEvent(offer.offer_id, { type: "invoice.created", payload: {} });
    await store.claimPendingDeliveries(10);

    const later = new Date(Date.now() + 60_000).toISOString();
    const failed = await store.updateWebhookDelivery(offer.offer_id, event.id, webhook.id, {
      status: "failed",
      response_status: 500,
      error: { message: "HTTP 500" },
      next_attempt_at: later
    });
    assert.equal(failed.status, "failed");
    assert.equal(failed.attempts, 1);
    assert.equal(Date.parse(failed.next_attempt_at), Date.parse(later));
    assert.equal(failed.locked_until, undefined);

    // Not due yet for the pass. An operator may send it now all the same.
    assert.deepEqual(await store.claimPendingDeliveries(10), []);
    const forced = await store.claimPendingDeliveries(10, { offerId: offer.offer_id, statuses: ["pending", "failed", "dead"], ignoreSchedule: true });
    assert.equal(forced.length, 1);

    // Given up on: out of the pass for good, still within an operator's reach.
    const dead = await store.updateWebhookDelivery(offer.offer_id, event.id, webhook.id, { status: "dead", error: { message: "gave up" } });
    assert.equal(dead.status, "dead");
    assert.equal(dead.attempts, 2);
    assert.equal(dead.next_attempt_at, undefined);
    assert.deepEqual(await store.claimPendingDeliveries(10, { ignoreSchedule: true }), []);
    assert.equal((await store.claimPendingDeliveries(10, { eventId: event.id, statuses: ["dead"], ignoreSchedule: true })).length, 1);
  });

  each("deliveries are claimed oldest first, within the limit, across offers or for one", async ({ store }) => {
    const first = await registerOffer(store);
    const second = await registerOffer(store);
    for (const offer of [first, second]) {
      await store.addWebhook(offer.offer_id, { url: "https://merchant.example/hook", events: ["invoice.created"], secret: "whsec_test" });
    }
    const events = [];
    for (const offer of [first, second, first, second, first]) {
      await tick();
      events.push(await store.addWebhookEvent(offer.offer_id, { type: "invoice.created", payload: {} }));
    }

    const batch = await store.claimPendingDeliveries(3);
    assert.deepEqual(batch.map((claim) => claim.event.id), events.slice(0, 3).map((event) => event.id));
    const onlySecond = await store.claimPendingDeliveries(10, { offerId: second.offer_id });
    assert.deepEqual(onlySecond.map((claim) => claim.event.id), [events[3].id]);
    assert.deepEqual((await store.claimPendingDeliveries(10)).map((claim) => claim.event.id), [events[4].id]);
  });

  each("a delivery whose webhook was deleted is still handed out, without a webhook", async ({ store }) => {
    const offer = await registerOffer(store);
    const webhook = await store.addWebhook(offer.offer_id, { url: "https://merchant.example/hook", events: ["invoice.created"], secret: "whsec_test" });
    await store.addWebhookEvent(offer.offer_id, { type: "invoice.created", payload: {} });
    await store.deleteWebhook(offer.offer_id, webhook.id);

    const [claim] = await store.claimPendingDeliveries(10);
    assert.equal(claim.delivery.webhook_id, webhook.id);
    assert.equal(claim.webhook, undefined);
  });

  each("old events with nothing left to deliver are removed, oldest first and within the limit", async ({ store }) => {
    const offer = await registerOffer(store);
    const webhook = await store.addWebhook(offer.offer_id, { url: "https://merchant.example/hook", events: ["invoice.created"], secret: "whsec_test" });
    const delivered = await store.addWebhookEvent(offer.offer_id, { type: "invoice.created", payload: { n: 1 } });
    const dead = await store.addWebhookEvent(offer.offer_id, { type: "invoice.created", payload: { n: 2 } });
    const waiting = await store.addWebhookEvent(offer.offer_id, { type: "invoice.created", payload: { n: 3 } });
    const unsubscribed = await store.addWebhookEvent(offer.offer_id, { type: "invoice.paid", payload: { n: 4 } });
    await store.updateWebhookDelivery(offer.offer_id, delivered.id, webhook.id, { status: "delivered", response_status: 200 });
    await store.updateWebhookDelivery(offer.offer_id, dead.id, webhook.id, { status: "dead" });
    await store.updateWebhookDelivery(offer.offer_id, waiting.id, webhook.id, { status: "failed", next_attempt_at: new Date(Date.now() + 60_000).toISOString() });
    const remaining = async () => (await store.listWebhookEvents(offer.offer_id)).map((event) => event.id);

    // Nothing is old enough yet.
    assert.equal(await store.pruneWebhookEvents({ before: new Date(Date.now() - 60_000).toISOString() }), 0);
    const everythingSoFar = new Date(Date.now() + 1000).toISOString();
    assert.equal(await store.pruneWebhookEvents({ before: everythingSoFar, limit: 1 }), 1);
    assert.deepEqual(await remaining(), [dead.id, waiting.id, unsubscribed.id]);
    assert.equal(await store.pruneWebhookEvents({ before: everythingSoFar }), 2);
    // The one still waiting for a retry stays, however old.
    assert.deepEqual(await remaining(), [waiting.id]);
    assert.equal((await store.listWebhookEvents(offer.offer_id))[0].deliveries.length, 1);
  });
}

test("postgresql: both claims read their queue index and need no sort", { skip: backends[1].skip }, async () => {
  const database = await isolatedPostgresStore(connectionString);
  try {
    const plan = async (sql, params) => {
      const client = await database.pool.connect();
      try {
        // The tables are empty here, where a sequential scan is cheapest. Rule
        // it out, to see whether the index can serve the query at all.
        await client.query("SET enable_seqscan = off");
        await client.query("SET enable_bitmapscan = off");
        return (await client.query(`EXPLAIN ${sql}`, params)).rows.map((row) => row["QUERY PLAN"]).join("\n");
      } finally {
        client.release();
      }
    };

    const resolutions = await plan(
      `SELECT resolution_id FROM fiber_resolutions
       WHERE status IN ('invoice_created', 'invoice_received')
         AND (last_synced_at IS NULL OR last_synced_at <= now() - make_interval(secs => 3))
       ORDER BY last_synced_at NULLS FIRST, created_at
       LIMIT 200
       FOR UPDATE SKIP LOCKED`
    );
    assert.match(resolutions, /fiber_resolutions_sync_queue_idx/);
    assert.doesNotMatch(resolutions, /Sort/);

    const deliveries = await plan(
      `SELECT event_id, webhook_id FROM fiber_webhook_deliveries
       WHERE status IN ('pending', 'failed')
         AND (next_attempt_at IS NULL OR next_attempt_at <= now())
         AND (locked_until IS NULL OR locked_until <= now())
       ORDER BY next_attempt_at NULLS FIRST, created_at
       LIMIT 100
       FOR UPDATE SKIP LOCKED`
    );
    assert.match(deliveries, /fiber_webhook_deliveries_due_idx/);
    assert.doesNotMatch(deliveries, /Sort/);
  } finally {
    await database.close();
  }
});

async function registerOffer(store) {
  const keys = generateOfferKeyPair();
  const offer = createSignedOffer(
    {
      node_id: `02${randomUUID().replaceAll("-", "").padEnd(64, "0")}`,
      public_key: keys.publicKeyPem,
      resolver_url: "https://resolver.example",
      assets: [ckb],
      amount_min: "1000",
      amount_max: "5000"
    },
    keys.privateKeyPem
  );
  await store.upsertOffer(offer, encodeOffer(offer));
  return offer;
}

// The stores order by creation time, which the in-memory one keeps to the
// millisecond. Where a test depends on the order, creations are spaced apart.
const tick = () => new Promise((resolve) => setTimeout(resolve, 2));

// An issued invoice, as the resolver stores one.
async function invoice(store, offer, label, extra = {}) {
  await tick();
  return store.addResolution(offer.offer_id, {
    amount: "1000",
    asset: ckb,
    invoice: { invoice: `fibt_${label}`, payment_hash: `0x${Buffer.from(label).toString("hex").padEnd(64, "0")}`, mode: "fiber-rpc" },
    ...extra
  });
}
