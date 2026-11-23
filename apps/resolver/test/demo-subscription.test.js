// The demo page signs recurring cycle requests in the browser with Web Crypto.
// Its helper must agree byte for byte with @fiber-offers/protocol, or every
// cycle the page requests would be refused. Node has the same Web Crypto API,
// so the browser file is loaded here as-is.
import test from "node:test";
import assert from "node:assert/strict";
import "../../demo/public/subscription.js";
import {
  createSignedOffer,
  generateOfferKeyPair,
  subscriptionId,
  verifyRecurrenceRequest
} from "../../../packages/protocol/src/index.js";
import { createServer, InMemoryOfferStore } from "../src/server.js";
import { MockInvoiceAdapter } from "../src/invoice-adapter.js";

const { createSubscription, signCycle } = globalThis.FiberOfferSubscription;

function recurringOffer(asset = { asset_type: "ckb", symbol: "CKB" }) {
  const keys = generateOfferKeyPair();
  return createSignedOffer(
    {
      node_id: "02" + "a".repeat(64),
      public_key: keys.publicKeyPem,
      resolver_url: "https://resolver.example",
      amount_min: "1000",
      amount_max: "1000",
      assets: [asset],
      recurrence: { interval: "monthly", amount: "1000", cap_cycles: 12 }
    },
    keys.privateKeyPem
  );
}

test("the browser's subscription ID and signature are accepted by the protocol", async () => {
  const token = { asset_type: "udt", symbol: "USDI", type_script_hash: "0x" + "ab".repeat(32) };
  for (const asset of [{ asset_type: "ckb", symbol: "CKB" }, token]) {
    const offer = recurringOffer(asset);
    const subscription = await createSubscription();
    const request = await signCycle(subscription, offer, {
      amount: "1000",
      // As a page might hold them: not yet in canonical case.
      asset: { ...asset, symbol: asset.symbol.toLowerCase() },
      recurrence_cycle: 3,
      scheduled_for: "2026-03-31T00:00:00.000Z"
    });

    assert.equal(subscription.approval_id, subscriptionId(subscription.publicKeyPem));
    assert.equal(request.approval_id, subscription.approval_id);
    assert.deepEqual(verifyRecurrenceRequest(offer, request), { ok: true });
    // Signed for cycle 3 only.
    assert.equal(verifyRecurrenceRequest(offer, { ...request, recurrence_cycle: 4 }).code, "INVALID_SUBSCRIPTION_SIGNATURE");
  }
});

test("a resolver accepts a cycle signed in the browser and serves the helper", async () => {
  const server = createServer({
    store: new InMemoryOfferStore(),
    invoiceAdapter: new MockInvoiceAdapter(),
    demoMode: true,
    topologyClient: false,
    workers: false,
    logger: { error() {}, info() {} }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const json = async (path, body) => {
    const response = await fetch(`${base}${path}`, {
      method: body ? "POST" : "GET",
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: response.status, body: await response.json() };
  };

  try {
    const created = await json("/demo/offers", {
      amount: "1000",
      recurrence: { interval: "monthly", amount: "1000", cap_cycles: 12 }
    });
    const offer = created.body.offer;
    const subscription = await createSubscription();
    // What the page does: ask which cycle is next, then sign it.
    const status = await json(`/offers/${offer.offer_id}/recurrence-status?approval_id=${subscription.approval_id}`);
    const request = await signCycle(subscription, offer, {
      amount: "1000",
      asset: offer.assets[0],
      recurrence_cycle: status.body.next_cycle
    });
    const invoice = await json(`/offers/${offer.offer_id}/invoice`, request);
    const script = await fetch(`${base}/subscription.js`);

    assert.equal(status.body.next_cycle, 1);
    assert.equal(invoice.status, 201);
    assert.equal(invoice.body.recurrence.approval_id, subscription.approval_id);
    assert.equal(script.status, 200);
    assert.match(script.headers.get("content-type"), /^text\/javascript/);
    assert.match(await script.text(), /FiberOfferSubscription/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
