// End-to-end checks of the public SDK payment flow against a real resolver
// process (mock invoice mode). These catch disagreements between what the SDK
// sends and what the resolver accepts, which unit tests on either side miss.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, InMemoryOfferStore } from "../src/server.js";
import { MockInvoiceAdapter } from "../src/invoice-adapter.js";
import { FiberOffersClient, FiberPaymentFlowClient } from "../../../packages/sdk/src/index.js";

const asset = { asset_type: "ckb", symbol: "CKB" };

test("SDK payOffer completes a payment on a single-use offer", async () => {
  await withResolver(async ({ client }) => {
    const created = await client.demoCreateOffer({ single_use: true, amount: "1000" });
    const payer = fakePayerNode();
    const flow = new FiberPaymentFlowClient({ resolverClient: client, paymentClient: payer });

    const paid = await flow.payOffer(created.offer_id, { amount: "1000", asset }, { execute: true });
    const secondAttempt = await flow.payOffer(created.offer_id, { amount: "1000", asset }, { execute: true });

    assert.equal(paid.status, "payment_sent");
    assert.equal(paid.ok, true);
    assert.equal(payer.sent.length, 1);
    assert.equal(payer.sent[0], paid.invoice.invoice);
    assert.equal(secondAttempt.status, "blocked_before_invoice");
    assert.equal(secondAttempt.failure.code, "OFFER_ALREADY_USED");
    assert.equal(payer.sent.length, 1);
  });
});

test("SDK payOffer retries a single-use payment after a transport failure", async () => {
  await withResolver(async ({ client }) => {
    const created = await client.demoCreateOffer({ single_use: true, amount: "1000" });
    const payer = fakePayerNode({ failFirstSend: true });
    const flow = new FiberPaymentFlowClient({ resolverClient: client, paymentClient: payer });
    const options = { execute: true, idempotencyKey: "order-42" };

    const failed = await flow.payOffer(created.offer_id, { amount: "1000", asset }, options);
    const retried = await flow.payOffer(created.offer_id, { amount: "1000", asset }, options);
    const resolutions = await client.getResolutions(created.offer_id);

    assert.equal(failed.status, "payment_failed");
    assert.equal(retried.status, "payment_sent");
    assert.equal(retried.invoice.idempotent_replay, true);
    assert.equal(retried.invoice.invoice, failed.invoice.invoice);
    assert.deepEqual(payer.sent, [failed.invoice.invoice]);
    assert.equal(resolutions.resolutions.length, 1);
  });
});

test("SDK payOffer retries a recurring cycle after a transport failure", async () => {
  await withResolver(async ({ client }) => {
    const created = await client.demoCreateOffer({
      amount: "1000",
      recurrence: { interval: "daily", amount: "1000", cap_cycles: 3 }
    });
    const payer = fakePayerNode({ failFirstSend: true });
    const flow = new FiberPaymentFlowClient({ resolverClient: client, paymentClient: payer });
    const cycleOne = { amount: "1000", asset, recurrence_cycle: 1, approval_id: "approval-7" };
    const options = { execute: true, idempotencyKey: "approval-7:1" };

    const failed = await flow.payOffer(created.offer_id, cycleOne, options);
    const retried = await flow.payOffer(created.offer_id, cycleOne, options);
    const nextCycle = await flow.payOffer(
      created.offer_id,
      { ...cycleOne, recurrence_cycle: 2 },
      { execute: true, idempotencyKey: "approval-7:2" }
    );
    const status = await client.getRecurrenceStatus(created.offer_id);

    assert.equal(failed.status, "payment_failed");
    assert.equal(retried.status, "payment_sent");
    assert.equal(retried.invoice.recurrence.cycle, 1);
    assert.equal(nextCycle.status, "payment_sent");
    assert.equal(nextCycle.invoice.recurrence.cycle, 2);
    assert.equal(status.cycles_created, 2);
    assert.equal(payer.sent.length, 2);
  });
});

// Stands in for the payer's Fiber node: accepts dry-runs and records payments.
function fakePayerNode(options = {}) {
  let failNextSend = Boolean(options.failFirstSend);
  const node = {
    sent: [],
    async checkPaymentRoute(invoice) {
      return { ok: true, payable: true, payment_hash: `0xroute-${invoice.length}` };
    },
    async sendPayment(invoice) {
      if (failNextSend) {
        failNextSend = false;
        throw new Error("socket hang up");
      }
      node.sent.push(invoice);
      return { payment_hash: `0xsent-${node.sent.length}`, status: "Created" };
    }
  };
  return node;
}

async function withResolver(callback, options = {}) {
  const server = createServer({
    store: new InMemoryOfferStore(),
    invoiceAdapter: options.invoiceAdapter ?? new MockInvoiceAdapter(),
    topologyClient: false,
    workers: false,
    logger: { error() {}, info() {} }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { address, port } = server.address();
  const baseUrl = `http://${address}:${port}`;
  try {
    await callback({ baseUrl, server, client: new FiberOffersClient({ resolverUrl: baseUrl }) });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
