// The settlement pass and the webhook delivery pass: each takes a bounded batch
// of what is due, two workers never do the same work, a failing webhook is
// retried with growing waits and then given up on, and old events are removed.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import test from "node:test";
import { createSignedOffer, encodeOffer, generateOfferKeyPair } from "../../../packages/protocol/src/index.js";
import { createServer, InMemoryOfferStore, webhookRetryDelayMs } from "../src/server.js";

const ckb = { asset_type: "ckb", symbol: "CKB" };
const quiet = { error() {}, info() {}, warn() {} };

test("a settlement pass asks about a bounded batch and works round the open invoices", async () => {
  const node = fakeNode();
  await withResolver({ node, workers: { settlementBatchSize: 2 } }, async ({ store, workers }) => {
    const offer = await registerOffer(store);
    const hashes = [];
    for (let index = 0; index < 5; index += 1) hashes.push((await invoice(store, offer, `open-${index}`)).invoice.payment_hash);

    const first = await workers.runSettlementSyncPass();
    assert.equal(first.claimed, 2);
    assert.equal(first.checked, 2);
    assert.equal(first.has_more, true);
    assert.deepEqual(node.asked, hashes.slice(0, 2));

    await workers.runSettlementSyncPass();
    const third = await workers.runSettlementSyncPass();
    // Five invoices in batches of two: all asked once after three passes, and
    // the third pass starts round again with the one asked about longest ago.
    assert.deepEqual(node.asked.slice(0, 5), hashes);
    assert.equal(node.asked[5], hashes[0]);
    assert.equal(third.claimed, 2);
  });
});

test("a pass with time left goes on to the next batch, and does not ask twice within its interval", async () => {
  const node = fakeNode();
  await withResolver({ node, workers: { settlementSyncIntervalMs: 5000, settlementBatchSize: 2 } }, async ({ store, workers }) => {
    const offer = await registerOffer(store);
    const hashes = [];
    for (let index = 0; index < 5; index += 1) hashes.push((await invoice(store, offer, `open-${index}`)).invoice.payment_hash);

    const pass = await workers.runSettlementSyncPass();
    assert.equal(pass.claimed, 5);
    assert.equal(pass.has_more, false);
    assert.deepEqual(node.asked, hashes);

    // A second worker's pass a moment later finds nothing due.
    assert.equal((await workers.runSettlementSyncPass()).claimed, 0);
    assert.equal(node.asked.length, 5);
  });
});

test("a pass stops taking batches when its time is up and says more is waiting", async () => {
  await withReceiver(async (receiver) => {
    receiver.delayMs = 60;
    const slow = { webhookDeliveryIntervalMs: 100, webhookBatchSize: 1, webhookConcurrency: 1 };
    await withResolver({ workers: slow }, async ({ store, workers }) => {
      const offer = await registerOffer(store);
      await store.addWebhook(offer.offer_id, { url: receiver.url, events: ["invoice.created"], secret: "whsec_test" });
      for (let index = 0; index < 6; index += 1) await store.addWebhookEvent(offer.offer_id, { type: "invoice.created", payload: { index } });

      // 80ms of a 100ms interval, at 60ms a delivery: two fit, not six.
      const pass = await workers.runWebhookDeliveryPass();
      assert.ok(pass.delivered >= 1 && pass.delivered < 6, `${pass.delivered} were delivered`);
      assert.equal(pass.has_more, true);
    });
  });
});

test("a settlement pass never asks about an invoice that already has an outcome", async () => {
  const node = fakeNode();
  await withResolver({ node }, async ({ store, workers }) => {
    const offer = await registerOffer(store);
    const open = await invoice(store, offer, "still-open");
    const paid = await invoice(store, offer, "paid-earlier");
    const expired = await invoice(store, offer, "expired-earlier");
    await store.updateResolutionStatus(offer.offer_id, paid.id, { status: "invoice_paid" });
    await store.updateResolutionStatus(offer.offer_id, expired.id, { status: "invoice_expired" });

    node.statuses.set(open.invoice.payment_hash, "Paid");
    const pass = await workers.runSettlementSyncPass();

    assert.deepEqual(node.asked, [open.invoice.payment_hash]);
    assert.equal(pass.claimed, 1);
    assert.equal(pass.changed, 1);
    assert.equal(pass.results[0].next_status, "invoice_paid");
    // Results are for diagnostics and stay small: no copy of the resolution.
    assert.equal(pass.results[0].resolution, undefined);
    assert.equal((await store.getResolution(offer.offer_id, open.id)).status, "invoice_paid");

    // Nothing is open any more, so the next pass has nothing to do.
    const idle = await workers.runSettlementSyncPass();
    assert.equal(idle.claimed, 0);
    assert.equal(node.asked.length, 1);
  });
});

test("a node failure on one invoice is reported and does not stop the batch", async () => {
  const node = fakeNode();
  await withResolver({ node }, async ({ store, workers }) => {
    const offer = await registerOffer(store);
    const broken = await invoice(store, offer, "node-refuses");
    const fine = await invoice(store, offer, "node-answers");
    node.statuses.set(broken.invoice.payment_hash, new Error("node went away"));
    node.statuses.set(fine.invoice.payment_hash, "Paid");

    const pass = await workers.runSettlementSyncPass();
    assert.equal(pass.checked, 2);
    assert.equal(pass.failed, 1);
    assert.equal(pass.changed, 1);
    assert.equal(pass.results.find((result) => result.failed).error.message, "node went away");
    assert.equal((await store.getResolution(offer.offer_id, broken.id)).status, "invoice_created");
  });
});

test("the settlement pass clears reservations whose invoice never came", async () => {
  await withResolver({ node: fakeNode() }, async ({ store, workers }) => {
    const offer = await registerOffer(store);
    const { record } = await store.reserveInvoiceAttempt(offer.offer_id, { request: { amount: "1000", asset: ckb } });
    store.state.resolutions[offer.offer_id].find((entry) => entry.id === record.id).reservation_expires_at = new Date(Date.now() - 1000).toISOString();

    assert.equal((await workers.runSettlementSyncPass()).pruned_reservations, 1);
    assert.deepEqual(await store.getResolutions(offer.offer_id), []);
  });
});

test("the wait before a webhook retry doubles up to a ceiling", () => {
  const policy = { webhookRetryMinAgeMs: 30_000, webhookRetryMaxDelayMs: 3_600_000 };
  const exactly = (attempts) => webhookRetryDelayMs(attempts, policy, () => 0);
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8].map(exactly), [30_000, 60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000]);
  assert.equal(exactly(200), 3_600_000);
  // Up to a quarter is added, never taken away.
  assert.equal(webhookRetryDelayMs(1, policy, () => 0.999), Math.round(30_000 * (1 + 0.999 * 0.25)));
});

test("a failing webhook is retried later, given up on after the last attempt, and can be sent again by an operator", async () => {
  await withReceiver(async (receiver) => {
    await withResolver({ workers: { webhookMaxAttempts: 2, webhookRetryMinAgeMs: 150, webhookRetryMaxDelayMs: 150 } }, async ({ store, workers, url }) => {
      const offer = await registerOffer(store);
      const webhook = await store.addWebhook(offer.offer_id, { url: receiver.url, events: ["invoice.created"], secret: "whsec_test" });
      const event = await store.addWebhookEvent(offer.offer_id, { type: "invoice.created", payload: {} });
      const delivery = async () => (await store.listWebhookEvents(offer.offer_id))[0].deliveries[0];
      receiver.answer = 500;

      const first = await workers.runWebhookDeliveryPass();
      assert.deepEqual([first.attempted, first.delivered, first.failed, first.dead], [1, 0, 1, 0]);
      let recorded = await delivery();
      assert.equal(recorded.status, "failed");
      assert.equal(recorded.attempts, 1);
      assert.equal(recorded.response_status, 500);
      const wait = Date.parse(recorded.next_attempt_at) - Date.now();
      assert.ok(wait > 0 && wait <= 150 * 1.25, `the next attempt is ${wait}ms away`);

      // Not due yet: a pass in the meantime leaves it alone.
      assert.equal((await workers.runWebhookDeliveryPass()).attempted, 0);
      assert.equal(receiver.requests.length, 1);

      await new Promise((resolve) => setTimeout(resolve, 220));
      const second = await workers.runWebhookDeliveryPass();
      assert.deepEqual([second.attempted, second.failed, second.dead], [1, 1, 1]);
      recorded = await delivery();
      assert.equal(recorded.status, "dead");
      assert.equal(recorded.attempts, 2);
      assert.equal(recorded.next_attempt_at, undefined);

      // Given up on: no pass touches it again.
      await new Promise((resolve) => setTimeout(resolve, 220));
      assert.equal((await workers.runWebhookDeliveryPass()).attempted, 0);
      assert.equal(receiver.requests.length, 2);

      // The merchant fixes the endpoint and asks for it again.
      receiver.answer = 204;
      const withoutRetry = await postJson(`${url}/offers/${offer.offer_id}/webhook-events/deliver`, {});
      assert.equal(withoutRetry.attempted, 0);
      const retried = await postJson(`${url}/offers/${offer.offer_id}/webhook-events/${event.id}/deliver`, { retry_failed: true });
      assert.deepEqual([retried.attempted, retried.delivered, retried.failed], [1, 1, 0]);
      assert.equal((await delivery()).status, "delivered");
      assert.equal((await delivery()).attempts, 3);

      // What an operator sees has the schedule and not the worker's hold.
      const listed = await (await fetch(`${url}/offers/${offer.offer_id}/webhook-events`)).json();
      assert.equal(listed.events[0].deliveries[0].webhook_id, webhook.id);
      assert.equal("locked_until" in listed.events[0].deliveries[0], false);
    });
  });
});

test("two workers running at once deliver each event once", async () => {
  await withReceiver(async (receiver) => {
    receiver.delayMs = 40;
    const store = new InMemoryOfferStore();
    await withResolver({ store, workers: { webhookBatchSize: 20 } }, async (first) => {
      await withResolver({ store, workers: { webhookBatchSize: 20 } }, async (second) => {
        const offer = await registerOffer(store);
        await store.addWebhook(offer.offer_id, { url: receiver.url, events: ["invoice.created"], secret: "whsec_test" });
        const events = [];
        for (let index = 0; index < 12; index += 1) {
          events.push(await store.addWebhookEvent(offer.offer_id, { type: "invoice.created", payload: { index } }));
        }

        const passes = await Promise.all([first.workers.runWebhookDeliveryPass(), second.workers.runWebhookDeliveryPass()]);
        assert.equal(passes[0].delivered + passes[1].delivered, 12);
        const delivered = receiver.requests.map((request) => request.headers["x-fiber-offers-event-id"]).sort();
        assert.deepEqual(delivered, events.map((event) => event.id).sort());
      });
    });
  });
});

test("a delivery pass takes no more than its batch and says when more is waiting", async () => {
  await withReceiver(async (receiver) => {
    await withResolver({ workers: { webhookBatchSize: 3, webhookConcurrency: 2 } }, async ({ store, workers }) => {
      const offer = await registerOffer(store);
      await store.addWebhook(offer.offer_id, { url: receiver.url, events: ["invoice.created"], secret: "whsec_test" });
      for (let index = 0; index < 7; index += 1) await store.addWebhookEvent(offer.offer_id, { type: "invoice.created", payload: { index } });

      const passes = [await workers.runWebhookDeliveryPass(), await workers.runWebhookDeliveryPass(), await workers.runWebhookDeliveryPass()];
      assert.deepEqual(passes.map((pass) => pass.delivered), [3, 3, 1]);
      assert.deepEqual(passes.map((pass) => pass.has_more), [true, true, false]);
      // Oldest first.
      assert.deepEqual(receiver.requests.slice(0, 3).map((request) => JSON.parse(request.body).payload.index).sort(), [0, 1, 2]);
    });
  });
});

test("a delivery to a deleted webhook is given up on without a request", async () => {
  await withReceiver(async (receiver) => {
    await withResolver({}, async ({ store, workers }) => {
      const offer = await registerOffer(store);
      const webhook = await store.addWebhook(offer.offer_id, { url: receiver.url, events: ["invoice.created"], secret: "whsec_test" });
      await store.addWebhookEvent(offer.offer_id, { type: "invoice.created", payload: {} });
      await store.deleteWebhook(offer.offer_id, webhook.id);

      const pass = await workers.runWebhookDeliveryPass();
      assert.deepEqual([pass.attempted, pass.dead], [1, 1]);
      assert.equal(receiver.requests.length, 0);
      const [delivery] = (await store.listWebhookEvents(offer.offer_id))[0].deliveries;
      assert.equal(delivery.status, "dead");
      assert.match(delivery.error.message, /missing or disabled/);
    });
  });
});

test("events past their retention are removed once nothing is left to deliver", async () => {
  await withReceiver(async (receiver) => {
    await withResolver({ workers: { webhookEventRetentionMs: 60 } }, async ({ store, workers }) => {
      const offer = await registerOffer(store);
      await store.addWebhook(offer.offer_id, { url: receiver.url, events: ["invoice.created"], secret: "whsec_test" });
      await store.addWebhookEvent(offer.offer_id, { type: "invoice.created", payload: { n: 1 } });

      // Delivered, but not old enough to go.
      const delivering = await workers.runWebhookDeliveryPass();
      assert.deepEqual([delivering.delivered, delivering.pruned_events], [1, 0]);

      await new Promise((resolve) => setTimeout(resolve, 100));
      // A second event that keeps failing stays, however old it gets.
      receiver.answer = 500;
      await store.addWebhookEvent(offer.offer_id, { type: "invoice.created", payload: { n: 2 } });
      const pruning = await workers.runWebhookDeliveryPass();
      assert.equal(pruning.pruned_events, 1);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal((await workers.runWebhookDeliveryPass()).pruned_events, 0);
      const left = await store.listWebhookEvents(offer.offer_id);
      assert.deepEqual(left.map((event) => event.payload.n), [2]);
    });
  });
});

test("retention can be switched off", async () => {
  await withReceiver(async (receiver) => {
    await withResolver({ workers: { webhookEventRetentionMs: 0 } }, async ({ store, workers }) => {
      const offer = await registerOffer(store);
      await store.addWebhook(offer.offer_id, { url: receiver.url, events: ["invoice.created"], secret: "whsec_test" });
      await store.addWebhookEvent(offer.offer_id, { type: "invoice.created", payload: {} });
      await workers.runWebhookDeliveryPass();
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal((await workers.runWebhookDeliveryPass()).pruned_events, 0);
      assert.equal((await store.listWebhookEvents(offer.offer_id)).length, 1);
    });
  });
});

// A stand-in for the Fiber node: remembers which invoices it was asked about
// and answers with the status set for each, "Open" otherwise.
function fakeNode() {
  const node = {
    mode: "fiber-rpc",
    asked: [],
    statuses: new Map(),
    async probe() {
      return { mode: "fiber-rpc", configured: true, reachable: true, status: "ok" };
    },
    async syncInvoice(paymentHash) {
      node.asked.push(paymentHash);
      const status = node.statuses.get(paymentHash) ?? "Open";
      if (status instanceof Error) throw status;
      return {
        mode: "fiber-rpc",
        payment_hash: paymentHash,
        fiber_status: status,
        status: { Open: "invoice_created", Received: "invoice_received", Paid: "invoice_paid", Expired: "invoice_expired", Cancelled: "invoice_cancelled" }[status]
      };
    }
  };
  return node;
}

async function withResolver({ store = new InMemoryOfferStore(), node, workers = {} }, run) {
  const server = createServer({
    store,
    invoiceAdapter: node ?? { mode: "mock", async probe() { return { mode: "mock", reachable: true }; } },
    // No timers: each test runs the passes itself. An interval of 0 also means
    // a pass may ask again about what the previous pass just asked.
    workers: { settlementSyncIntervalMs: 0, webhookDeliveryIntervalMs: 0, ...workers },
    topologyClient: false,
    enforceNodeOwnership: false,
    allowPrivateWebhookTargets: true,
    publicOrigin: "https://resolver.example",
    logger: quiet
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await run({ store, server, workers: server.backgroundWorkers, url: `http://127.0.0.1:${server.address().port}` });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// A merchant's webhook endpoint. `answer` is the status it replies with.
async function withReceiver(run) {
  const receiver = { requests: [], answer: 204, delayMs: 0 };
  const server = createHttpServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    receiver.requests.push({ headers: request.headers, body: Buffer.concat(chunks).toString("utf8") });
    if (receiver.delayMs) await new Promise((resolve) => setTimeout(resolve, receiver.delayMs));
    response.writeHead(receiver.answer);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  receiver.url = `http://127.0.0.1:${server.address().port}/hook`;
  try {
    return await run(receiver);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

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

// An issued invoice, as the resolver stores one. Spaced apart so that the
// order of creation is unambiguous to the millisecond.
async function invoice(store, offer, label) {
  await new Promise((resolve) => setTimeout(resolve, 2));
  return store.addResolution(offer.offer_id, {
    amount: "1000",
    asset: ckb,
    invoice: { invoice: `fibt_${label}`, payment_hash: `0x${Buffer.from(label).toString("hex").padEnd(64, "0")}`, mode: "fiber-rpc" }
  });
}

async function postJson(url, body) {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
