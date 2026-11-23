// What the resolver costs with a large history: 10,000 offers and 100,000
// resolutions in PostgreSQL, 2,000 of them invoices still awaiting an outcome.
// The background passes and the routes a payer uses must depend on what is due
// or asked for, not on how much is stored.
//
// Needs TEST_DATABASE_URL. The data lives in a schema of its own and is
// dropped afterwards. The time limits are several times what a laptop needs,
// so that a slow machine does not fail them, and far below what reading the
// whole history costs.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "../src/server.js";
import { isolatedPostgresStore } from "./helpers/isolated-postgres.js";

const connectionString = process.env.TEST_DATABASE_URL;
const skip = connectionString ? false : "TEST_DATABASE_URL is not set";

const OFFERS = 10_000;
const RESOLUTIONS = 100_000;
const OPEN = RESOLUTIONS / 50;
const SETTLEMENT_INTERVAL_MS = 3000;
const offerId = (n) => `0x${n.toString(16).padStart(64, "0")}`;

let database;

before(async () => {
  if (skip) return;
  database = await isolatedPostgresStore(connectionString);
  await database.pool.query(
    `INSERT INTO fiber_offers (offer_id, offer, encoded_offer)
     SELECT id, jsonb_build_object('offer_id', id, 'resolver_url', 'https://resolver.example', 'single_use', false), 'fbroffer1seed'
     FROM (SELECT '0x' || lpad(to_hex(n), 64, '0') AS id FROM generate_series(1, $1) n) ids`,
    [OFFERS]
  );
  // Ten resolutions an offer. One in fifty is an invoice still open; the rest
  // were paid or ran out long ago.
  await database.pool.query(
    `INSERT INTO fiber_resolutions (resolution_id, offer_id, status, amount, asset, invoice, status_history, created_at, updated_at)
     SELECT 'res_seed_' || lpad(n::text, 6, '0'),
            '0x' || lpad(to_hex(1 + (n % $1)), 64, '0'),
            CASE WHEN n % 50 = 0 THEN 'invoice_created' WHEN n % 7 = 0 THEN 'invoice_expired' ELSE 'invoice_paid' END,
            '1000',
            '{"asset_type":"ckb","symbol":"CKB"}'::jsonb,
            jsonb_build_object(
              'invoice', 'fibt_seed_' || n,
              'payment_hash', '0x' || lpad(to_hex(n), 64, '0'),
              'mode', 'fiber-rpc',
              'expires_at', to_char((now() + interval '1 hour') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
            ),
            '[]'::jsonb,
            now() - make_interval(secs => n),
            now() - make_interval(secs => n)
     FROM generate_series(1, $2) n`,
    [OFFERS, RESOLUTIONS]
  );
  await database.pool.query("ANALYZE");
});

after(async () => {
  await database?.close();
});

test("a settlement pass over 2,000 open invoices among 100,000 resolutions ends well within its interval", { skip }, async () => {
  // A node that takes two milliseconds to answer and reports one invoice in
  // twenty as paid.
  const asked = new Set();
  const node = {
    mode: "fiber-rpc",
    async probe() {
      return { mode: "fiber-rpc", reachable: true };
    },
    async syncInvoice(paymentHash) {
      asked.add(paymentHash);
      await new Promise((resolve) => setTimeout(resolve, 2));
      const paid = Number.parseInt(paymentHash.slice(-8), 16) % 1000 === 0;
      return { mode: "fiber-rpc", payment_hash: paymentHash, fiber_status: paid ? "Paid" : "Open", status: paid ? "invoice_paid" : "invoice_created" };
    }
  };
  const server = createServer({
    store: database.store,
    invoiceAdapter: node,
    workers: { settlementSyncIntervalMs: SETTLEMENT_INTERVAL_MS },
    publicOrigin: "https://resolver.example",
    topologyClient: false,
    enforceNodeOwnership: false,
    logger: { error() {}, info() {}, warn() {} }
  });

  const startedAt = performance.now();
  const pass = await server.backgroundWorkers.runSettlementSyncPass();
  const elapsed = performance.now() - startedAt;

  // Every open invoice was asked about, none twice, and nothing else was.
  assert.equal(pass.claimed, OPEN);
  assert.equal(asked.size, OPEN);
  assert.equal(pass.checked, OPEN);
  assert.equal(pass.failed, 0);
  assert.equal(pass.has_more, false);
  assert.equal(pass.changed, OPEN / 20);
  assert.ok(pass.results.length <= 50);
  assert.ok(elapsed < SETTLEMENT_INTERVAL_MS, `the pass took ${Math.round(elapsed)}ms of a ${SETTLEMENT_INTERVAL_MS}ms interval`);

  // A pass with nothing due costs one small query, whatever is stored.
  const idleStartedAt = performance.now();
  const idle = await server.backgroundWorkers.runSettlementSyncPass();
  const idleElapsed = performance.now() - idleStartedAt;
  assert.equal(idle.claimed, 0);
  assert.ok(idleElapsed < 250, `an idle pass took ${Math.round(idleElapsed)}ms`);

  const paid = await database.pool.query("SELECT count(*)::int AS count FROM fiber_webhook_events WHERE type = 'invoice.paid'");
  assert.equal(paid.rows[0].count, OPEN / 20);
  console.log(`# settlement pass: ${OPEN} open invoices asked in ${Math.round(elapsed)}ms; idle pass ${Math.round(idleElapsed)}ms`);
});

test("the planner reads the queue and page indexes at this size, unprompted", { skip }, async () => {
  const plan = async (sql, params = []) =>
    (await database.pool.query(`EXPLAIN ${sql}`, params)).rows.map((row) => row["QUERY PLAN"]).join("\n");

  const queue = await plan(
    `SELECT resolution_id FROM fiber_resolutions
     WHERE status IN ('invoice_created', 'invoice_received')
       AND (last_synced_at IS NULL OR last_synced_at <= now() - make_interval(secs => 2.7))
     ORDER BY last_synced_at NULLS FIRST, created_at
     LIMIT 200
     FOR UPDATE SKIP LOCKED`
  );
  assert.match(queue, /fiber_resolutions_sync_queue_idx/, queue);
  assert.doesNotMatch(queue, /Seq Scan|Sort/, queue);

  const page = await plan(
    `SELECT * FROM fiber_resolutions WHERE offer_id = $1 ORDER BY created_at DESC, resolution_id DESC LIMIT 101`,
    [offerId(42)]
  );
  assert.match(page, /fiber_resolutions_page_idx/, page);
  assert.doesNotMatch(page, /Seq Scan/, page);

  const offers = await plan(`SELECT * FROM fiber_offers WHERE true ORDER BY created_at DESC, offer_id DESC LIMIT 101`);
  assert.match(offers, /fiber_offers_page_idx/, offers);
  assert.doesNotMatch(offers, /Seq Scan|Sort/, offers);
});

test("lists and lookups answer quickly from a large history", { skip }, async () => {
  const { store } = database;
  const timed = async (label, limitMs, run) => {
    await run(); // once to warm the connection and the plan
    const startedAt = performance.now();
    const result = await run();
    const elapsed = performance.now() - startedAt;
    assert.ok(elapsed < limitMs, `${label} took ${Math.round(elapsed)}ms`);
    return result;
  };

  const offers = await timed("a page of offers", 150, () => store.listOffersPage({ limit: 100, order: "desc" }));
  assert.equal(offers.items.length, 100);
  assert.ok(offers.next_cursor);
  const deeper = await timed("a page far into the list", 150, async () => {
    // Keyset paging costs the same at any depth: jump to the middle by cursor.
    let cursor = offers.next_cursor;
    for (let index = 0; index < 5; index += 1) cursor = (await store.listOffersPage({ limit: 500, order: "desc", cursor })).next_cursor;
    return store.listOffersPage({ limit: 100, order: "desc", cursor });
  });
  assert.equal(deeper.items.length, 100);

  const history = await timed("a page of one offer's resolutions", 100, () => store.listResolutionsPage(offerId(42), { limit: 100 }));
  assert.equal(history.items.length, 10);
  const counted = await timed("the resolutions that count against an offer", 100, () => store.getCountedResolutions(offerId(42)));
  assert.ok(counted.length > 0 && counted.every((record) => record.status !== "invoice_expired"));
  const totals = await timed("an offer's totals", 100, () => store.resolutionTotals(offerId(42)));
  assert.equal(totals.reduce((sum, group) => sum + group.count, 0), 10);
  const traced = await timed("tracing an invoice to its resolution", 100, () => store.findResolutionByInvoice(offerId(43), "fibt_seed_42"));
  assert.equal(traced.id, "res_seed_000042");
  const names = await timed("the names of a page of offers", 100, () => store.getUsernamesForOffers(offers.items.map((entry) => entry.offer.offer_id)));
  assert.equal(names.size, 0);
});

test("a delivery pass takes its batch from thousands of waiting deliveries without reading them all", { skip }, async () => {
  await database.pool.query(
    `INSERT INTO fiber_webhook_events (event_id, offer_id, type, payload, created_at)
     SELECT 'evt_seed_' || lpad(n::text, 6, '0'), '0x' || lpad(to_hex(1 + (n % $1)), 64, '0'), 'invoice.created', '{}'::jsonb, now() - make_interval(secs => 5000 - n)
     FROM generate_series(1, 5000) n`,
    [OFFERS]
  );
  await database.pool.query(
    `INSERT INTO fiber_webhook_deliveries (event_id, webhook_id, url, created_at, updated_at)
     SELECT event_id, 'wh_gone', 'https://merchant.example/hook', created_at, created_at FROM fiber_webhook_events WHERE event_id LIKE 'evt_seed_%'`
  );
  await database.pool.query("ANALYZE fiber_webhook_deliveries");

  const startedAt = performance.now();
  const claims = await database.store.claimPendingDeliveries(50, { leaseMs: 60_000 });
  const elapsed = performance.now() - startedAt;
  assert.equal(claims.length, 50);
  // Oldest first.
  assert.deepEqual(claims.map((claim) => claim.event.id), Array.from({ length: 50 }, (_, index) => `evt_seed_${String(index + 1).padStart(6, "0")}`));
  assert.ok(elapsed < 250, `claiming a batch took ${Math.round(elapsed)}ms`);
  // What another worker gets is the next fifty, not these.
  const next = await database.store.claimPendingDeliveries(50, { leaseMs: 60_000 });
  assert.equal(next[0].event.id, "evt_seed_000051");
});
