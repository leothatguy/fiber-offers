// Reading lists a page at a time, and the lookups that replace reading an
// offer's whole history. Every case runs against the in-memory store and, when
// TEST_DATABASE_URL is set, against PostgreSQL in a schema of its own.
import assert from "node:assert/strict";
import test from "node:test";
import { ckb, connectionString, eachBackend as each, invoice, postgresSkip, registerOffer, tick } from "./helpers/store-backends.js";
import { isolatedPostgresStore } from "./helpers/isolated-postgres.js";

// Follows next_cursor to the end and returns the pages.
async function allPages(readPage, options) {
  const pages = [];
  let cursor;
  do {
    const page = await readPage({ ...options, cursor });
    pages.push(page.items);
    cursor = page.next_cursor;
    assert.ok(pages.length <= 50, "the pages never end");
  } while (cursor);
  return pages;
}

each("offers come a page at a time, in either order, each exactly once", async ({ store }) => {
  const offers = [];
  for (let index = 0; index < 7; index += 1) offers.push(await registerOffer(store));
  const ids = offers.map((offer) => offer.offer_id);
  const idsOf = (pages) => pages.map((page) => page.map((entry) => entry.offer.offer_id));

  const oldestFirst = await allPages((options) => store.listOffersPage(options), { limit: 3 });
  assert.deepEqual(idsOf(oldestFirst), [ids.slice(0, 3), ids.slice(3, 6), ids.slice(6)]);

  const newestFirst = await allPages((options) => store.listOffersPage(options), { limit: 3, order: "desc" });
  const reversed = ids.slice().reverse();
  assert.deepEqual(idsOf(newestFirst), [reversed.slice(0, 3), reversed.slice(3, 6), reversed.slice(6)]);

  // A page that ends exactly at the last item says there is no more.
  const exact = await store.listOffersPage({ limit: 7 });
  assert.equal(exact.items.length, 7);
  assert.equal(exact.next_cursor, undefined);
  assert.equal(exact.items[0].encoded_offer.startsWith("fbroffer1"), true);
});

each("an offer registered while a list is being read does not shift the pages", async ({ store }) => {
  const offers = [];
  for (let index = 0; index < 4; index += 1) offers.push(await registerOffer(store));

  const first = await store.listOffersPage({ limit: 2, order: "desc" });
  const late = await registerOffer(store);
  const second = await store.listOffersPage({ limit: 2, order: "desc", cursor: first.next_cursor });

  const seen = [...first.items, ...second.items].map((entry) => entry.offer.offer_id);
  assert.deepEqual(seen, offers.map((offer) => offer.offer_id).reverse());
  assert.equal(seen.includes(late.offer_id), false);
  assert.equal(second.next_cursor, undefined);
});

each("a cursor this store did not issue is refused", async ({ store }) => {
  await registerOffer(store);
  const madeUp = ["not-a-cursor", Buffer.from("[1,2]").toString("base64url"), Buffer.from('["yesterday","x"]').toString("base64url")];
  for (const cursor of madeUp) {
    await assert.rejects(() => store.listOffersPage({ cursor }), { code: "INVALID_CURSOR", status: 400 }, cursor);
  }
});

each("an offer's resolutions and events are paged within that offer only", async ({ store }) => {
  const offer = await registerOffer(store);
  const other = await registerOffer(store);
  const mine = [];
  for (let index = 0; index < 5; index += 1) mine.push((await invoice(store, offer, `mine-${index}`)).id);
  await invoice(store, other, "theirs");

  const pages = await allPages((options) => store.listResolutionsPage(offer.offer_id, options), { limit: 2 });
  assert.deepEqual(pages.map((page) => page.map((record) => record.id)), [mine.slice(0, 2), mine.slice(2, 4), mine.slice(4)]);
  const newest = await store.listResolutionsPage(offer.offer_id, { limit: 2, order: "desc" });
  assert.deepEqual(newest.items.map((record) => record.id), [mine[4], mine[3]]);
  assert.deepEqual((await store.listResolutionsPage(`0x${"0".repeat(64)}`, {})).items, []);

  const webhook = await store.addWebhook(offer.offer_id, { url: "https://merchant.example/hook", events: ["invoice.created"], secret: "whsec_test" });
  const events = [];
  for (let index = 0; index < 3; index += 1) {
    await tick();
    events.push((await store.addWebhookEvent(offer.offer_id, { type: "invoice.created", payload: { index } })).id);
  }
  await store.addWebhookEvent(other.offer_id, { type: "invoice.created", payload: {} });
  await store.updateWebhookDelivery(offer.offer_id, events[0], webhook.id, { status: "delivered", response_status: 200 });

  const eventPages = await allPages((options) => store.listWebhookEventsPage(offer.offer_id, options), { limit: 2 });
  assert.deepEqual(eventPages.map((page) => page.map((event) => event.id)), [events.slice(0, 2), events.slice(2)]);
  // Each event comes with its deliveries, as the unpaged list gives them.
  assert.deepEqual(eventPages.flat(), await store.listWebhookEvents(offer.offer_id));
  assert.equal(eventPages[0][0].deliveries[0].status, "delivered");

  assert.deepEqual(await store.getWebhookEvent(offer.offer_id, events[1]), eventPages[0][1]);
  assert.equal(await store.getWebhookEvent(other.offer_id, events[1]), undefined);
  assert.equal(await store.getWebhookEvent(offer.offer_id, "evt_missing"), undefined);
});

each("the names of many offers are read in one go", async ({ store }) => {
  const named = await registerOffer(store);
  const unnamed = await registerOffer(store);
  await store.bindUsername("coffee", named.offer_id);

  const names = await store.getUsernamesForOffers([named.offer_id, unnamed.offer_id, `0x${"1".repeat(64)}`]);
  assert.deepEqual([...names], [[named.offer_id, "coffee"]]);
  assert.deepEqual([...(await store.getUsernamesForOffers([]))], []);
});

each("an invoice is traced to the resolution that issued it, for its own offer only", async ({ store }) => {
  const offer = await registerOffer(store);
  const other = await registerOffer(store);
  const issued = await invoice(store, offer, "issued-here");
  await invoice(store, other, "issued-elsewhere");

  assert.equal((await store.findResolutionByInvoice(offer.offer_id, "fibt_issued-here")).id, issued.id);
  assert.equal(await store.findResolutionByInvoice(offer.offer_id, "fibt_issued-elsewhere"), undefined);
  assert.equal(await store.findResolutionByInvoice(offer.offer_id, "fibt_never-issued"), undefined);
});

each("the resolutions that count against an offer leave out those that ended unpaid", async ({ store }) => {
  const offer = await registerOffer(store);
  const open = await invoice(store, offer, "open", { recurrence: { cycle: 1, approval_id: "sub_a" } });
  const paid = await invoice(store, offer, "paid", { recurrence: { cycle: 2, approval_id: "sub_a" } });
  const other = await invoice(store, offer, "other", { recurrence: { cycle: 3, approval_id: "sub_b" } });
  for (const [label, status, cycle] of [["expired", "invoice_expired", 4], ["failed", "invoice_failed", 5], ["cancelled", "invoice_cancelled", 6]]) {
    const record = await invoice(store, offer, label, { recurrence: { cycle, approval_id: "sub_a" } });
    await store.updateResolutionStatus(offer.offer_id, record.id, { status });
  }
  await store.updateResolutionStatus(offer.offer_id, paid.id, { status: "invoice_paid" });

  const ids = (records) => records.map((record) => record.id);
  assert.deepEqual(ids(await store.getCountedResolutions(offer.offer_id)), [open.id, paid.id, other.id]);
  assert.deepEqual(ids(await store.getCountedResolutions(offer.offer_id, { approvalId: "sub_a" })), [open.id, paid.id]);
  assert.deepEqual(await store.getCountedResolutions(offer.offer_id, { approvalId: "sub_none" }), []);
});

each("totals are counted and summed by status and asset, beyond what a number can hold", async ({ store }) => {
  const offer = await registerOffer(store);
  const token = { asset_type: "udt", symbol: "RUSD", type_script_hash: `0x${"a".repeat(64)}` };
  const huge = "340282366920938463463374607431768211455"; // 2^128 - 1
  const first = await invoice(store, offer, "one", { amount: "1500" });
  await invoice(store, offer, "two", { amount: "2500" });
  await invoice(store, offer, "three", { amount: huge, asset: token });
  await invoice(store, offer, "four", { amount: huge, asset: token });
  await store.updateResolutionStatus(offer.offer_id, first.id, { status: "invoice_paid" });

  const totals = (await store.resolutionTotals(offer.offer_id)).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  assert.deepEqual(totals, [
    { status: "invoice_created", asset_type: "ckb", asset_symbol: "CKB", count: 1, amount_total: "2500" },
    { status: "invoice_created", asset_type: "udt", asset_symbol: "RUSD", count: 2, amount_total: (2n * BigInt(huge)).toString() },
    { status: "invoice_paid", asset_type: "ckb", asset_symbol: "CKB", count: 1, amount_total: "1500" }
  ].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))));
  assert.deepEqual(await store.resolutionTotals(`0x${"0".repeat(64)}`), []);
});

test("postgresql: pages and lookups read their indexes", { skip: postgresSkip }, async () => {
  const database = await isolatedPostgresStore(connectionString);
  try {
    const offerId = `0x${"a".repeat(64)}`;
    const plan = async (sql, params) => {
      const client = await database.pool.connect();
      try {
        // The tables are empty here, where a sequential scan is cheapest. Rule
        // it out, to see whether an index can serve the query at all.
        await client.query("SET enable_seqscan = off");
        await client.query("SET enable_bitmapscan = off");
        return (await client.query(`EXPLAIN ${sql}`, params)).rows.map((row) => row["QUERY PLAN"]).join("\n");
      } finally {
        client.release();
      }
    };
    const expectIndex = (text, index) => {
      assert.match(text, new RegExp(index), text);
      assert.doesNotMatch(text, /Sort|Seq Scan/, text);
    };

    expectIndex(
      await plan(
        `SELECT * FROM fiber_offers WHERE true AND (created_at, offer_id) < ($1::timestamptz, $2)
         ORDER BY created_at DESC, offer_id DESC LIMIT 101`,
        ["2026-11-23 10:00:00+00", offerId]
      ),
      "fiber_offers_page_idx"
    );
    expectIndex(
      await plan(
        `SELECT * FROM fiber_resolutions WHERE offer_id = $1 AND (created_at, resolution_id) > ($2::timestamptz, $3)
         ORDER BY created_at ASC, resolution_id ASC LIMIT 101`,
        [offerId, "2026-11-23 10:00:00+00", "res_x"]
      ),
      "fiber_resolutions_page_idx"
    );
    expectIndex(
      await plan(
        `SELECT * FROM fiber_webhook_events WHERE offer_id = $1 ORDER BY created_at DESC, event_id DESC LIMIT 101`,
        [offerId]
      ),
      "fiber_webhook_events_page_idx"
    );
    expectIndex(
      await plan(
        `SELECT * FROM fiber_resolutions WHERE offer_id = $1 AND invoice IS NOT NULL
           AND md5(invoice ->> 'invoice') = md5($2) AND invoice ->> 'invoice' = $2 LIMIT 1`,
        [offerId, "fibt_x"]
      ),
      "fiber_resolutions_invoice_idx"
    );
    expectIndex(
      await plan(
        `SELECT * FROM fiber_resolutions WHERE offer_id = $1
           AND status NOT IN ('invoice_expired', 'invoice_failed', 'invoice_cancelled')
           AND ($2::text IS NULL OR recurrence ->> 'approval_id' = $2)
         ORDER BY created_at`,
        [offerId, null]
      ),
      "fiber_resolutions_counted_idx"
    );
  } finally {
    await database.close();
  }
});
