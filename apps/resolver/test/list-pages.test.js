// The list routes answer a page at a time, and the routes a payer uses never
// read an offer's whole payment history.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  createSignedOffer,
  encodeOffer,
  generateOfferKeyPair,
  signRecurrenceRequest
} from "../../../packages/protocol/src/index.js";
import { FiberOffersClient } from "../../../packages/sdk/src/index.js";
import { MockInvoiceAdapter } from "../src/invoice-adapter.js";
import { createServer, InMemoryOfferStore } from "../src/server.js";

const ckb = { asset_type: "ckb", symbol: "CKB" };
const tick = () => new Promise((resolve) => setTimeout(resolve, 2));

test("offers are listed a page at a time, newest first unless asked otherwise", async () => {
  await withResolver(async ({ store, url, client }) => {
    const ids = [];
    for (let index = 0; index < 5; index += 1) ids.push((await registerOffer(store, index === 3 ? { username: "fourth" } : {})).offer_id);
    const newestFirst = ids.slice().reverse();

    const first = await getJson(`${url}/offers?limit=2`);
    assert.deepEqual(first.offers.map((offer) => offer.offer_id), newestFirst.slice(0, 2));
    assert.equal(first.offers[1].fiber_address?.startsWith("fourth@"), true);
    const second = await getJson(`${url}/offers?limit=2&cursor=${first.next_cursor}`);
    const third = await getJson(`${url}/offers?limit=2&cursor=${second.next_cursor}`);
    assert.deepEqual([...second.offers, ...third.offers].map((offer) => offer.offer_id), newestFirst.slice(2));
    assert.equal("next_cursor" in third, false);

    const oldestFirst = await getJson(`${url}/offers?order=asc`);
    assert.deepEqual(oldestFirst.offers.map((offer) => offer.offer_id), ids);

    // The SDK reads one page, or follows the cursors to the end.
    assert.deepEqual((await client.listOffers({ limit: 2 })).offers.map((offer) => offer.offer_id), newestFirst.slice(0, 2));
    assert.deepEqual((await client.listAllOffers({ pageSize: 2 })).map((offer) => offer.offer_id), newestFirst);
    assert.deepEqual((await client.listAllOffers({ pageSize: 2, order: "asc", maxItems: 3 })).map((offer) => offer.offer_id), ids.slice(0, 3));
  });
});

test("a list without a limit returns at most 100 items and says there are more", async () => {
  await withResolver(async ({ store, url }) => {
    const offer = await registerOffer(store);
    for (let index = 0; index < 105; index += 1) await addInvoice(store, offer, index, { spaced: false });

    const page = await getJson(`${url}/offers/${offer.offer_id}/resolutions`);
    assert.equal(page.resolutions.length, 100);
    assert.equal(typeof page.next_cursor, "string");
    const rest = await getJson(`${url}/offers/${offer.offer_id}/resolutions?cursor=${page.next_cursor}`);
    assert.equal(rest.resolutions.length, 5);
    assert.equal("next_cursor" in rest, false);
    const all = [...page.resolutions, ...rest.resolutions].map((resolution) => resolution.id);
    assert.equal(new Set(all).size, 105);
  });
});

test("a list request with a bad limit, order or cursor is refused", async () => {
  await withResolver(async ({ store, url }) => {
    const offer = await registerOffer(store);
    const refused = async (path, code) => {
      const response = await fetch(`${url}${path}`);
      assert.equal(response.status, 400, path);
      assert.equal((await response.json()).error.code, code, path);
    };
    for (const limit of ["0", "501", "abc", "1.5", "-1", "", "0100"]) await refused(`/offers?limit=${limit}`, "INVALID_LIMIT");
    await refused("/offers?order=newest", "INVALID_ORDER");
    await refused("/offers?cursor=not-a-cursor", "INVALID_CURSOR");
    await refused(`/offers/${offer.offer_id}/resolutions?cursor=${Buffer.from('["yesterday","x"]').toString("base64url")}`, "INVALID_CURSOR");
    await refused(`/offers/${offer.offer_id}/webhook-events?limit=1000`, "INVALID_LIMIT");
    await refused(`/offers/${offer.offer_id}/reconciliation.json?order=up`, "INVALID_ORDER");
    assert.equal((await getJson(`${url}/offers?limit=500`)).offers.length, 1);
  });
});

test("an offer's resolutions and webhook events are paged, oldest first unless asked otherwise", async () => {
  await withResolver(async ({ store, url, client }) => {
    const offer = await registerOffer(store);
    await store.addWebhook(offer.offer_id, { url: "https://merchant.example/hook", events: ["invoice.created"], secret: "whsec_test" });
    const resolutions = [];
    const events = [];
    for (let index = 0; index < 5; index += 1) {
      resolutions.push((await addInvoice(store, offer, index)).id);
      events.push((await store.addWebhookEvent(offer.offer_id, { type: "invoice.created", payload: { index } })).id);
    }

    const page = await getJson(`${url}/offers/${offer.offer_id}/resolutions?limit=3`);
    assert.deepEqual(page.resolutions.map((resolution) => resolution.id), resolutions.slice(0, 3));
    assert.equal(page.offer_id, offer.offer_id);
    const newest = await client.getResolutions(offer.offer_id, { limit: 2, order: "desc" });
    assert.deepEqual(newest.resolutions.map((resolution) => resolution.id), [resolutions[4], resolutions[3]]);
    assert.deepEqual((await client.getAllResolutions(offer.offer_id, { pageSize: 2 })).map((resolution) => resolution.id), resolutions);

    const eventPage = await getJson(`${url}/offers/${offer.offer_id}/webhook-events?limit=2&order=desc`);
    assert.deepEqual(eventPage.events.map((event) => event.id), [events[4], events[3]]);
    assert.equal(eventPage.events[0].deliveries[0].status, "pending");
    assert.deepEqual((await client.getAllWebhookEvents(offer.offer_id, { pageSize: 2 })).map((event) => event.id), events);
  });
});

test("reconciliation totals cover the whole history while the rows come a page at a time", async () => {
  await withResolver(async ({ store, url, client }) => {
    const offer = await registerOffer(store);
    const ids = [];
    for (let index = 0; index < 7; index += 1) ids.push((await addInvoice(store, offer, index)).id);
    await store.updateResolutionStatus(offer.offer_id, ids[0], { status: "invoice_paid" });
    await store.updateResolutionStatus(offer.offer_id, ids[1], { status: "invoice_expired" });

    const report = await client.getReconciliation(offer.offer_id, { limit: 3 });
    assert.deepEqual(report.rows.map((row) => row.resolution_id), ids.slice(0, 3));
    assert.equal(report.totals.resolution_count, 7);
    assert.deepEqual(report.totals.by_status, { invoice_paid: 1, invoice_expired: 1, invoice_created: 5 });
    assert.deepEqual(report.totals.by_asset["ckb:CKB"], {
      asset_type: "ckb",
      asset_symbol: "CKB",
      resolution_count: 7,
      amount_total: "7000",
      statuses: { invoice_paid: 1, invoice_expired: 1, invoice_created: 5 }
    });
    const next = await client.getReconciliation(offer.offer_id, { limit: 10, cursor: report.next_cursor });
    assert.deepEqual(next.rows.map((row) => row.resolution_id), ids.slice(3));
    assert.equal(next.totals.resolution_count, 7);
    assert.equal("next_cursor" in next, false);
  });
});

test("the CSV export has every row, however many pages that takes", async () => {
  await withResolver(async ({ store, url }) => {
    const offer = await registerOffer(store);
    // More than two of the pages the export reads internally (500 rows each).
    for (let index = 0; index < 1203; index += 1) await addInvoice(store, offer, index, { spaced: false });

    const response = await fetch(`${url}/offers/${offer.offer_id}/reconciliation.csv`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^text\/csv/);
    assert.match(response.headers.get("content-disposition"), /attachment; filename="fiber-offers-[0-9a-f]{8}\.csv"/);
    const lines = (await response.text()).trimEnd().split("\n");
    assert.equal(lines.length, 1204);
    assert.equal(lines[0].split(",")[0], "resolution_id");
    assert.equal(new Set(lines.slice(1).map((line) => line.split(",")[0])).size, 1203);

    // An offer with no payments is a header and nothing else.
    const empty = await registerOffer(store);
    assert.equal((await (await fetch(`${url}/offers/${empty.offer_id}/reconciliation.csv`)).text()).trimEnd().split("\n").length, 1);
  });
});

test("the routes a payer uses never read an offer's whole history", async () => {
  await withResolver(async ({ store, url }) => {
    // Any attempt to load every resolution or every event fails the request.
    const whole = [];
    store.getResolutions = async () => {
      whole.push("getResolutions");
      throw new Error("the whole history was read");
    };
    store.listWebhookEvents = async () => {
      whole.push("listWebhookEvents");
      throw new Error("every event was read");
    };
    store.listOffers = async () => {
      whole.push("listOffers");
      throw new Error("every offer was read");
    };

    const reusable = await registerOffer(store);
    const single = await registerOffer(store, { single_use: true });
    const plan = await registerOffer(store, {
      amount_min: "2000",
      amount_max: "2000",
      recurrence: { interval: "monthly", amount: "2000", cap_cycles: 3 }
    });
    const subscriber = generateOfferKeyPair();
    const cycle = signRecurrenceRequest(plan, { amount: "2000", asset: ckb, recurrence_cycle: 1 }, subscriber.privateKeyPem);
    const ok = async (path, init) => {
      const response = await fetch(`${url}${path}`, init);
      const body = await response.json();
      assert.ok(response.status < 300, `${path}: ${response.status} ${JSON.stringify(body.error ?? {})}`);
      return body;
    };
    const post = (body, key) => ({
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
      body: JSON.stringify(body)
    });

    // Reusable offer: invoice, retry, readiness before and after, resolution, receipt.
    const first = await ok(`/offers/${reusable.offer_id}/invoice`, post({ amount: "1200", asset: ckb }, "retry-1"));
    await ok(`/offers/${reusable.offer_id}/invoice`, post({ amount: "1200", asset: ckb }, "retry-1"));
    await ok(`/offers/${reusable.offer_id}/check`, post({ amount: "1200", asset: ckb }));
    const postInvoice = await ok(`/offers/${reusable.offer_id}/check`, post({ amount: "1200", asset: ckb, invoice: first.invoice }));
    assert.equal(postInvoice.checks.find((check) => check.id === "invoice_match").status, "pass");
    const foreign = await ok(`/offers/${reusable.offer_id}/check`, post({ amount: "1200", asset: ckb, invoice: "fibt_someone_elses" }));
    assert.equal(foreign.checks.find((check) => check.id === "invoice_match").status, "warn");
    await ok(`/offers/${reusable.offer_id}/resolutions/${first.resolution_id}`);
    await ok(`/offers/${reusable.offer_id}/resolutions/${first.resolution_id}/receipt.json`);

    // Single-use offer: one invoice, then a second request is refused for the right reason.
    await ok(`/offers/${single.offer_id}/invoice`, post({ amount: "1000", asset: ckb }));
    const second = await fetch(`${url}/offers/${single.offer_id}/invoice`, post({ amount: "1000", asset: ckb }));
    assert.equal(second.status, 409);
    assert.equal((await second.json()).error.code, "OFFER_INVOICE_OUTSTANDING");
    const blocked = await ok(`/offers/${single.offer_id}/check`, post({ amount: "1000", asset: ckb }));
    assert.equal(blocked.checks.find((check) => check.id === "single_use").status, "fail");

    // Recurring offer: a cycle, its readiness check and the subscription's status.
    await ok(`/offers/${plan.offer_id}/check`, post(cycle));
    await ok(`/offers/${plan.offer_id}/invoice`, post(cycle));
    const status = await ok(`/offers/${plan.offer_id}/recurrence-status?approval_id=${cycle.approval_id}`);
    assert.equal(status.outstanding.cycle, 1);
    assert.equal(status.cycles_paid, 0);

    // The merchant's own lists and summary do not either.
    await ok("/offers");
    await ok(`/offers/${reusable.offer_id}/resolutions`);
    await ok(`/offers/${reusable.offer_id}/webhook-events`);
    await ok(`/offers/${reusable.offer_id}/reconciliation.json`);
    await ok(`/offers/${plan.offer_id}/recurrence-status`);
    await ok(`/offers/${reusable.offer_id}/webhook-events/deliver`, post({}));

    assert.deepEqual(whole, []);
  });
});

async function withResolver(run) {
  const store = new InMemoryOfferStore();
  const server = createServer({
    store,
    invoiceAdapter: new MockInvoiceAdapter(),
    workers: false,
    topologyClient: false,
    rateLimitMax: 0,
    logger: { error() {}, info() {}, warn() {} }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run({ store, server, url, client: new FiberOffersClient({ resolverUrl: url }) });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function registerOffer(store, { username, ...terms } = {}) {
  await tick();
  const keys = generateOfferKeyPair();
  const offer = createSignedOffer(
    {
      node_id: `02${randomUUID().replaceAll("-", "").padEnd(64, "0")}`,
      public_key: keys.publicKeyPem,
      resolver_url: "https://resolver.example",
      assets: [ckb],
      amount_min: "1000",
      amount_max: "5000",
      ...terms
    },
    keys.privateKeyPem
  );
  await store.upsertOffer(offer, encodeOffer(offer), { username });
  return offer;
}

// An issued invoice, as the resolver stores one. Spaced apart by default so
// that the order of creation is unambiguous to the millisecond.
async function addInvoice(store, offer, index, { spaced = true } = {}) {
  if (spaced) await tick();
  return store.addResolution(offer.offer_id, {
    amount: "1000",
    asset: ckb,
    invoice: { invoice: `fibt_${index}`, payment_hash: `0x${String(index).padStart(64, "0")}`, mode: "mock", mocked: true }
  });
}

async function getJson(url) {
  const response = await fetch(url);
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}
