import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  FiberOffersClient,
  FiberNodeDiagnosticsClient,
  FiberPaymentFlowClient,
  FiberPaymentClient,
  FiberRecurringPaymentScheduler,
  FiberRpcClient,
  FiberTopologyClient,
  analyzeFiberTopology,
  analyzePaymentReadiness,
  createOffer,
  fiberSendPaymentParams,
  normalizeFiberPaymentFailure,
  offerQrUrl,
  parseFiberAddress,
  planDirectChannelFixture,
  summarizeFiberChannels,
  toFiberDecimalQuantity,
  toFiberHexQuantity
} from "../src/index.js";
import {
  createSignedOffer,
  encodeOffer,
  generateOfferKeyPair
} from "../../protocol/src/index.js";

test("packages advertise TypeScript declarations for SDK adopters", async () => {
  const sdkPackage = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const protocolPackage = JSON.parse(await readFile(new URL("../../protocol/package.json", import.meta.url), "utf8"));
  const sdkTypes = await readFile(new URL("../src/index.d.ts", import.meta.url), "utf8");
  const browserTypes = await readFile(new URL("../src/browser.d.ts", import.meta.url), "utf8");
  const protocolTypes = await readFile(new URL("../../protocol/src/index.d.ts", import.meta.url), "utf8");

  assert.equal(sdkPackage.types, "src/index.d.ts");
  assert.equal(sdkPackage.exports["."].types, "./src/index.d.ts");
  assert.equal(sdkPackage.exports["./browser"].types, "./src/browser.d.ts");
  assert.equal(sdkPackage.exports["./react"].types, "./src/react.d.ts");
  assert.equal(sdkPackage.exports["./react-native"].types, "./src/react-native.d.ts");
  assert.equal(protocolPackage.types, "src/index.d.ts");
  assert.equal(protocolPackage.exports["."].types, "./src/index.d.ts");
  assert.match(sdkTypes, /class FiberPaymentFlowClient/);
  assert.match(sdkTypes, /interface PaymentReadiness/);
  assert.match(browserTypes, /FiberPaymentFlowClient/);
  assert.match(sdkTypes, /class FiberRecurringPaymentScheduler/);
  assert.match(protocolTypes, /interface SignedFiberOffer/);
});

test("parses Fiber Address values", () => {
  assert.deepEqual(parseFiberAddress("Coffee@Example.com"), {
    username: "coffee",
    domain: "example.com"
  });
});

test("creates an offer from the configured Fiber node identity", async () => {
  const nodeId = "02" + "a".repeat(64);
  const created = await createOffer(
    {
      resolver_url: "https://resolver.example",
      description: "Node-backed offer",
      assets: [{ asset_type: "ckb", symbol: "CKB" }]
    },
    { rpcClient: { async call(method) { assert.equal(method, "node_info"); return { pubkey: nodeId }; } } }
  );
  assert.equal(created.offer.node_id, nodeId);
  assert.match(created.encoded_offer, /^fbroffer1/);
  assert.match(created.offer_private_key_pem, /PRIVATE KEY/);
});

test("resolves a scanned encoded offer before requesting an invoice", async () => {
  const keys = generateOfferKeyPair();
  const offer = createSignedOffer(
    {
      node_id: "03" + "b".repeat(64),
      public_key: keys.publicKeyPem,
      resolver_url: "https://resolver.example",
      assets: [{ asset_type: "ckb", symbol: "CKB" }]
    },
    keys.privateKeyPem
  );
  const calls = [];
  const client = new FiberOffersClient({
    resolverUrl: "https://resolver.example",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (init.method === "GET") return new Response(JSON.stringify({ offer_id: offer.offer_id, offer }), { status: 200 });
      return new Response(JSON.stringify({ resolution_id: "res_scan", invoice: "fibt1scan" }), { status: 201 });
    }
  });
  const result = await client.resolveAndRequestInvoice(encodeOffer(offer), {
    amount: "1000",
    asset: { asset_type: "ckb", symbol: "CKB" }
  });
  assert.equal(result.offer.offer_id, offer.offer_id);
  assert.equal(result.invoice.invoice, "fibt1scan");
  assert.match(calls[0].url, new RegExp(`/offers/${offer.offer_id}$`));
});

test("runs capped recurring payments and supports one-tap revocation", async () => {
  const keys = generateOfferKeyPair();
  const offer = createSignedOffer(
    {
      node_id: "02" + "c".repeat(64),
      public_key: keys.publicKeyPem,
      resolver_url: "https://resolver.example",
      assets: [{ asset_type: "ckb", symbol: "CKB" }],
      recurrence: { interval: "custom_seconds", custom_seconds: 1, amount: "1000", cap_cycles: 2 }
    },
    keys.privateKeyPem
  );
  let current = new Date("2026-01-01T00:00:00.000Z");
  const calls = [];
  const scheduler = new FiberRecurringPaymentScheduler({
    paymentFlow: {
      async payOffer(offerId, request, options) {
        calls.push({ offerId, request, options });
        return { ok: true, status: "payment_sent", payment_hash: `hash-${request.recurrence_cycle}` };
      }
    },
    now: () => current
  });
  const approval = await scheduler.approve(offer);
  await scheduler.runDue();
  current = new Date("2026-01-01T00:00:01.000Z");
  await scheduler.runDue();
  current = new Date("2026-01-01T00:00:02.000Z");
  const capped = await scheduler.runDue();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].request.recurrence_cycle, 2);
  assert.equal(capped[0].failure.code, "RECURRENCE_CYCLE_CAP_REACHED");

  const second = await scheduler.approve(offer, { id: "approval_revoke" });
  const revoked = await scheduler.revoke(second.id);
  assert.equal(revoked.status, "revoked");
  assert.ok(revoked.revoked_at);
  assert.match(approval.id, /^approval_/);
});

test("registers an encoded offer through the configured resolver", async () => {
  const calls = [];
  const client = new FiberOffersClient({
    resolverUrl: "http://resolver.test/",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ offer_id: "0x" + "1".repeat(64) }), { status: 201 });
    }
  });

  const response = await client.registerOffer("fbroffer1abc", { username: "coffee" });

  assert.equal(response.offer_id, "0x" + "1".repeat(64));
  assert.equal(calls[0].url, "http://resolver.test/offers");
  assert.equal(JSON.parse(calls[0].init.body).username, "coffee");
});

test("lists offers through the configured resolver", async () => {
  const calls = [];
  const client = new FiberOffersClient({
    resolverUrl: "http://resolver.test/",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ offers: [{ offer_id: "0x" + "1".repeat(64) }] }), { status: 200 });
    }
  });

  const response = await client.listOffers();

  assert.equal(response.offers.length, 1);
  assert.equal(calls[0].url, "http://resolver.test/offers");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.headers.accept, "application/json");
});

test("builds resolver QR URLs", () => {
  const offerId = "0x" + "2".repeat(64);
  const client = new FiberOffersClient({
    resolverUrl: "http://resolver.test/",
    fetchImpl: async () => new Response("{}")
  });

  assert.equal(
    offerQrUrl(offerId, "http://resolver.test", "offer"),
    `http://resolver.test/offers/${offerId}/qr.svg?payload=offer`
  );
  assert.equal(client.offerQrUrl(offerId), `http://resolver.test/offers/${offerId}/qr.svg?payload=link`);
});

test("checks payment readiness through the configured resolver", async () => {
  const offerId = "0x" + "3".repeat(64);
  const calls = [];
  const client = new FiberOffersClient({
    resolverUrl: "http://resolver.test",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ready: true, next_action: "request_invoice" }), { status: 200 });
    }
  });

  const response = await client.checkPayment(offerId, {
    amount: "1200",
    asset: { asset_type: "ckb", symbol: "CKB" }
  });

  assert.equal(response.ready, true);
  assert.equal(calls[0].url, `http://resolver.test/offers/${offerId}/check`);
  assert.equal(JSON.parse(calls[0].init.body).amount, "1200");
});

test("sends invoice idempotency keys through the resolver client", async () => {
  const offerId = "0x" + "8".repeat(64);
  const calls = [];
  const client = new FiberOffersClient({
    resolverUrl: "http://resolver.test",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ resolution_id: "res_1", invoice: "fibt1example" }), { status: 201 });
    }
  });

  const response = await client.requestInvoice(
    offerId,
    {
      amount: "1200",
      asset: { asset_type: "ckb", symbol: "CKB" }
    },
    { idempotencyKey: "checkout-order-42" }
  );

  assert.equal(response.resolution_id, "res_1");
  assert.equal(calls[0].url, `http://resolver.test/offers/${offerId}/invoice`);
  assert.equal(calls[0].init.headers["idempotency-key"], "checkout-order-42");
});

test("passes an idempotency key through the payment-flow client", async () => {
  const invoiceOptions = [];
  const resolver = {
    async checkPayment(_id, request) {
      return request.invoice
        ? { ready: true, payable: true, route_check: { ok: true, payable: true } }
        : { ready: true, payable: true };
    },
    async requestInvoice(_id, _request, options) {
      invoiceOptions.push(options);
      return { invoice: "fibt1example", resolution_id: "res_1" };
    }
  };
  const client = new FiberPaymentFlowClient({ resolverClient: resolver });

  const result = await client.preparePayment(
    "0x" + "9".repeat(64),
    { amount: "1200", asset: { asset_type: "ckb", symbol: "CKB" } },
    { idempotencyKey: "wallet-attempt-42" }
  );

  assert.equal(result.status, "ready_to_send");
  assert.deepEqual(invoiceOptions, [{ idempotencyKey: "wallet-attempt-42" }]);
});

test("fetches resolver diagnostics", async () => {
  const client = new FiberOffersClient({
    resolverUrl: "http://resolver.test",
    fetchImpl: async (url) => {
      assert.equal(url, "http://resolver.test/diagnostics");
      return new Response(JSON.stringify({ invoice_mode: "mock", store: { offers: 0 } }), { status: 200 });
    }
  });

  const diagnostics = await client.diagnostics();

  assert.equal(diagnostics.invoice_mode, "mock");
  assert.equal(diagnostics.store.offers, 0);
});

test("updates resolution status through the configured resolver", async () => {
  const offerId = "0x" + "4".repeat(64);
  const calls = [];
  const client = new FiberOffersClient({
    resolverUrl: "http://resolver.test",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ status: "invoice_paid" }), { status: 200 });
    }
  });

  const response = await client.updateResolutionStatus(offerId, "res_123", {
    status: "invoice_paid",
    source: "test"
  });

  assert.equal(response.status, "invoice_paid");
  assert.equal(calls[0].url, `http://resolver.test/offers/${offerId}/resolutions/res_123/status`);
  assert.equal(JSON.parse(calls[0].init.body).source, "test");
});

test("syncs a single resolution through the configured resolver", async () => {
  const offerId = "0x" + "4".repeat(64);
  const calls = [];
  const client = new FiberOffersClient({
    resolverUrl: "http://resolver.test",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ changed: true, next_status: "invoice_paid" }), { status: 200 });
    }
  });

  const response = await client.syncResolution(offerId, "res_123");

  assert.equal(response.changed, true);
  assert.equal(calls[0].url, `http://resolver.test/offers/${offerId}/resolutions/res_123/sync`);
  assert.equal(calls[0].init.method, "POST");
});

test("batch syncs resolutions through the configured resolver", async () => {
  const offerId = "0x" + "4".repeat(64);
  const calls = [];
  const client = new FiberOffersClient({
    resolverUrl: "http://resolver.test",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ checked: 2, changed: 1 }), { status: 200 });
    }
  });

  const response = await client.syncResolutions(offerId, { includeTerminal: true });

  assert.equal(response.changed, 1);
  assert.equal(calls[0].url, `http://resolver.test/offers/${offerId}/resolutions/sync`);
  assert.deepEqual(JSON.parse(calls[0].init.body), { include_terminal: true });
});

test("fetches reconciliation CSV through the configured resolver", async () => {
  const offerId = "0x" + "5".repeat(64);
  const client = new FiberOffersClient({
    resolverUrl: "http://resolver.test",
    fetchImpl: async (url) => {
      assert.equal(url, `http://resolver.test/offers/${offerId}/reconciliation.csv`);
      return new Response("resolution_id,status\nres_1,invoice_paid\n", { status: 200 });
    }
  });

  const csv = await client.getReconciliationCsv(offerId);

  assert.match(csv, /invoice_paid/);
  assert.equal(client.reconciliationCsvUrl(offerId), `http://resolver.test/offers/${offerId}/reconciliation.csv`);
});

test("creates webhook subscriptions through the configured resolver", async () => {
  const offerId = "0x" + "6".repeat(64);
  const calls = [];
  const client = new FiberOffersClient({
    resolverUrl: "http://resolver.test",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: "wh_1", url: "https://merchant.test/webhook" }), { status: 201 });
    }
  });

  const webhook = await client.createWebhook(offerId, {
    url: "https://merchant.test/webhook",
    events: ["invoice.paid"]
  });

  assert.equal(webhook.id, "wh_1");
  assert.equal(calls[0].url, `http://resolver.test/offers/${offerId}/webhooks`);
  assert.deepEqual(JSON.parse(calls[0].init.body).events, ["invoice.paid"]);
});

test("manages webhook state, secret rotation, testing, and deletion", async () => {
  const offerId = "0x" + "8".repeat(64);
  const webhookId = "wh_manage";
  const calls = [];
  const client = new FiberOffersClient({
    resolverUrl: "http://resolver.test",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: webhookId, disabled: false, delivered: 1, deleted: true }), { status: 200 });
    }
  });

  await client.updateWebhook(offerId, webhookId, { disabled: true });
  await client.rotateWebhookSecret(offerId, webhookId);
  await client.testWebhook(offerId, webhookId);
  await client.deleteWebhook(offerId, webhookId);

  assert.equal(calls[0].url, `http://resolver.test/offers/${offerId}/webhooks/${webhookId}`);
  assert.equal(calls[0].init.method, "PATCH");
  assert.deepEqual(JSON.parse(calls[0].init.body), { disabled: true });
  assert.match(calls[1].url, /rotate-secret$/);
  assert.match(calls[2].url, /\/test$/);
  assert.equal(calls[3].init.method, "DELETE");
});

test("drains webhook events through the configured resolver", async () => {
  const offerId = "0x" + "7".repeat(64);
  const calls = [];
  const client = new FiberOffersClient({
    resolverUrl: "http://resolver.test",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ attempted: 1, delivered: 1, failed: 0 }), { status: 200 });
    }
  });

  const result = await client.deliverWebhookEvents(offerId, { retryFailed: true });

  assert.equal(result.delivered, 1);
  assert.equal(calls[0].url, `http://resolver.test/offers/${offerId}/webhook-events/deliver`);
  assert.equal(JSON.parse(calls[0].init.body).retry_failed, true);
});

test("sends API key authorization headers when configured", async () => {
  const client = new FiberOffersClient({
    resolverUrl: "http://resolver.test",
    apiKey: "secret-key",
    fetchImpl: async (_url, init) => {
      assert.equal(init.headers.authorization, "Bearer secret-key");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
  });

  const response = await client.diagnostics();

  assert.equal(response.ok, true);
});

test("normalizes Fiber route liquidity failures with raw node error details", () => {
  const error = new Error(
    "Send payment error: Failed to build route, Insufficient balance: max outbound liquidity 0 is insufficient"
  );
  error.code = -32000;
  error.details = {
    method: "send_payment",
    url: "http://127.0.0.1:8229",
    error: {
      code: -32000,
      message:
        "Send payment error: Failed to build route, Insufficient balance: max outbound liquidity 0 is insufficient",
      data: {
        dry_run: true
      }
    }
  };

  const failure = normalizeFiberPaymentFailure(error, {
    stage: "dry_run_payment",
    diagnostics: {
      payer: {
        peers: ["03merchant"],
        channels: {
          usable_outbound: 9,
          pending_tlc_count: 1,
          offline_counterparties: ["02route"]
        }
      },
      merchant: {
        channels: {
          offline_counterparties: ["02route"]
        }
      },
      direct_channel: {
        payer_to_merchant: false,
        merchant_to_payer: false
      },
      common_channel_counterparties: ["02route"]
    }
  });

  assert.equal(failure.code, "ROUTE_OUTBOUND_LIQUIDITY_UNUSABLE");
  assert.equal(failure.fiber_error.method, "send_payment");
  assert.equal(failure.fiber_error.code, -32000);
  assert.deepEqual(failure.fiber_error.data, { dry_run: true });
  assert.equal(failure.route_context.stage, "dry_run_payment");
  assert.deepEqual(failure.route_context.offline_common_counterparties, ["02route"]);
  assert.equal(
    failure.likely_causes.includes("The payer and merchant do not have a direct ready channel."),
    true
  );
  assert.equal(failure.likely_causes.some((cause) => cause.includes("pending TLCs")), true);
});

test("normalizes generic Fiber payment failures", () => {
  const error = new Error("temporary route failure");
  error.code = -32000;
  error.details = {
    method: "send_payment",
    error: {
      code: -32000,
      message: "temporary route failure"
    }
  };

  const failure = normalizeFiberPaymentFailure(error);

  assert.equal(failure.code, "ROUTE_OR_PAYMENT_FAILED");
  assert.equal(failure.summary, "Fiber rejected the route or payment attempt.");
  assert.equal(failure.fiber_error.message, "temporary route failure");
  assert.deepEqual(failure.likely_causes, []);
  assert.equal(failure.next_actions.length, 1);
});

test("does not infer direct-channel failures from payer-only diagnostics", () => {
  const error = new Error(
    "Send payment error: Failed to build route, Insufficient balance: max outbound liquidity 0 is insufficient"
  );
  error.details = {
    method: "send_payment",
    error: {
      code: -32000,
      message:
        "Send payment error: Failed to build route, Insufficient balance: max outbound liquidity 0 is insufficient"
    }
  };

  const failure = normalizeFiberPaymentFailure(error, {
    diagnostics: {
      payer: {
        peers: [],
        channels: {
          usable_outbound: 3,
          pending_tlc_count: 0
        }
      }
    }
  });

  assert.equal(failure.code, "ROUTE_OUTBOUND_LIQUIDITY_UNUSABLE");
  assert.equal(
    failure.likely_causes.includes("The payer and merchant do not have a direct ready channel."),
    false
  );
});

test("builds Fiber send_payment params with hex quantities", () => {
  assert.equal(toFiberHexQuantity("60"), "0x3c");
  assert.equal(toFiberHexQuantity("0x3c"), "0x3c");
  assert.equal(toFiberDecimalQuantity("0x2540be400"), "10000000000");
  assert.equal(toFiberDecimalQuantity("10000000000"), "10000000000");

  const params = fiberSendPaymentParams("fibt1invoice", {
    timeoutSeconds: 60,
    maxFeeAmount: "100000",
    maxFeeRate: 1000,
    trampolineHops: "02route, 03route",
    dryRun: true
  });

  assert.deepEqual(params, {
    invoice: "fibt1invoice",
    timeout: "0x3c",
    max_fee_amount: "0x186a0",
    max_fee_rate: "0x3e8",
    trampoline_hops: ["02route", "03route"],
    dry_run: true
  });
});

test("FiberRpcClient sends JSON-RPC requests with auth", async () => {
  const calls = [];
  const rpc = new FiberRpcClient({
    url: "http://fiber.test/",
    username: "alice",
    password: "secret",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", result: { ok: true } }), { status: 200 });
    }
  });

  const result = await rpc.call("node_info", []);

  assert.deepEqual(result, { ok: true });
  assert.equal(calls[0].url, "http://fiber.test");
  assert.equal(calls[0].init.headers.authorization, "Basic YWxpY2U6c2VjcmV0");
  assert.equal(JSON.parse(calls[0].init.body).method, "node_info");
});

test("FiberPaymentClient checks payable route with dry-run send_payment", async () => {
  const calls = [];
  const client = new FiberPaymentClient({
    rpc: {
      async call(method, params) {
        calls.push({ method, params });
        return {
          status: "Created",
          payment_hash: "0xabc",
          fee: "0x10",
          routers: ["02route"]
        };
      }
    }
  });

  const result = await client.checkPaymentRoute("fibt1invoice", {
    timeoutSeconds: 60,
    maxFeeAmount: 1000
  });

  assert.equal(result.ok, true);
  assert.equal(result.payable, true);
  assert.equal(result.payment_hash, "0xabc");
  assert.deepEqual(result.routers, ["02route"]);
  assert.equal(calls[0].method, "send_payment");
  assert.deepEqual(calls[0].params[0], {
    invoice: "fibt1invoice",
    timeout: "0x3c",
    max_fee_amount: "0x3e8",
    dry_run: true
  });
});

test("FiberPaymentClient normalizes dry-run route failures", async () => {
  const client = new FiberPaymentClient({
    rpc: {
      async call() {
        const error = new Error(
          "Send payment error: Failed to build route, Insufficient balance: max outbound liquidity 0 is insufficient"
        );
        error.code = -32000;
        error.details = {
          method: "send_payment",
          url: "http://fiber.test",
          error: {
            code: -32000,
            message:
              "Send payment error: Failed to build route, Insufficient balance: max outbound liquidity 0 is insufficient"
          }
        };
        throw error;
      }
    }
  });

  const result = await client.checkPaymentRoute("fibt1invoice", {
    diagnostics: {
      payer: {
        peers: [],
        channels: {
          usable_outbound: 0
        }
      },
      direct_channel: {
        payer_to_merchant: false
      }
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.payable, false);
  assert.equal(result.failure.code, "ROUTE_OUTBOUND_LIQUIDITY_UNUSABLE");
  assert.equal(result.failure.fiber_error.method, "send_payment");
  assert.equal(result.failure.likely_causes.includes("The payer has no enabled channel with local balance."), true);
});

test("FiberPaymentFlowClient prepares an invoice using resolver route confidence", async () => {
  const offerId = "0x" + "8".repeat(64);
  const calls = [];
  const resolverClient = {
    async checkPayment(id, request) {
      calls.push({ method: "checkPayment", id, request });
      if (request.invoice) {
        return {
          ready: true,
          payable: true,
          confidence: "high",
          next_action: "send_payment",
          checks: [],
          route_check: {
            ok: true,
            payable: true,
            payment_hash: "0xpayment"
          }
        };
      }

      return {
        ready: true,
        payable: true,
        confidence: "medium",
        next_action: "request_invoice",
        checks: []
      };
    },
    async requestInvoice(id, request) {
      calls.push({ method: "requestInvoice", id, request });
      return {
        resolution_id: "res_1",
        invoice: "fibt1invoice",
        payment_hash: "0xpayment"
      };
    }
  };
  const flow = new FiberPaymentFlowClient({ resolverClient });

  const result = await flow.preparePayment(offerId, {
    amount: "1200",
    asset: { asset_type: "ckb", symbol: "CKB" }
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "ready_to_send");
  assert.equal(result.readiness.confidence, "high");
  assert.equal(result.route_check.payment_hash, "0xpayment");
  assert.equal(result.failure, undefined);
  assert.deepEqual(
    calls.map((call) => call.method),
    ["checkPayment", "requestInvoice", "checkPayment"]
  );
  assert.equal(calls[2].request.invoice, "fibt1invoice");
});

test("FiberPaymentFlowClient falls back to local payer dry-run when resolver has no route check", async () => {
  let dryRunInvoice;
  const resolverClient = {
    async checkPayment(_id, request) {
      return {
        ready: true,
        payable: !request.invoice,
        confidence: "medium",
        next_action: request.invoice ? "run_route_dry_run" : "request_invoice",
        checks: [
          {
            id: "route_dry_run",
            status: "warn",
            message: "No route check"
          }
        ]
      };
    },
    async requestInvoice() {
      return {
        resolution_id: "res_2",
        invoice: "fibt1invoice"
      };
    }
  };
  const paymentClient = {
    async checkPaymentRoute(invoice) {
      dryRunInvoice = invoice;
      return {
        ok: true,
        payable: true,
        payment_hash: "0xroute"
      };
    }
  };
  const flow = new FiberPaymentFlowClient({ resolverClient, paymentClient });

  const result = await flow.preparePayment("0x" + "9".repeat(64), {
    amount: "1200",
    asset: { asset_type: "ckb", symbol: "CKB" }
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "ready_to_send");
  assert.equal(result.readiness.confidence, "high");
  assert.equal(result.readiness.next_action, "send_payment");
  assert.equal(result.failure, undefined);
  assert.equal(result.readiness.checks.find((check) => check.id === "route_dry_run").status, "pass");
  assert.equal(dryRunInvoice, "fibt1invoice");
});

test("FiberPaymentFlowClient requires explicit execute before sending payment", async () => {
  let sendCount = 0;
  const resolverClient = {
    async checkPayment(_id, request) {
      return {
        ready: true,
        payable: Boolean(request.invoice),
        confidence: request.invoice ? "high" : "medium",
        next_action: request.invoice ? "send_payment" : "request_invoice",
        checks: [],
        route_check: request.invoice ? { ok: true, payable: true, payment_hash: "0xpayment" } : undefined
      };
    },
    async requestInvoice() {
      return {
        resolution_id: "res_3",
        invoice: "fibt1invoice"
      };
    }
  };
  const paymentClient = {
    async sendPayment(invoice) {
      sendCount += 1;
      return {
        payment_hash: "0xsent",
        invoice
      };
    }
  };
  const flow = new FiberPaymentFlowClient({ resolverClient, paymentClient });

  const preparedOnly = await flow.payOffer("0x" + "a".repeat(64), {
    amount: "1200",
    asset: { asset_type: "ckb", symbol: "CKB" }
  });
  const sent = await flow.payOffer(
    "0x" + "a".repeat(64),
    {
      amount: "1200",
      asset: { asset_type: "ckb", symbol: "CKB" }
    },
    { execute: true }
  );

  assert.equal(preparedOnly.ok, true);
  assert.equal(preparedOnly.execute_required, true);
  assert.equal(preparedOnly.next_action, "call_pay_offer_with_execute_true");
  assert.equal(sent.status, "payment_sent");
  assert.equal(sent.payment_hash, "0xsent");
  assert.equal(sendCount, 1);
});

test("summarizes Fiber channels for diagnostics", () => {
  const channels = summarizeFiberChannels(
    {
      channels: [
        {
          pubkey: "02peer1",
          is_public: true,
          funding_udt_type_script: null,
          state: { state_name: "ChannelReady" },
          enabled: true,
          local_balance: "0x64",
          remote_balance: "0xc8",
          pending_tlcs: [{}]
        },
        {
          pubkey: "02peer2",
          is_public: false,
          funding_udt_type_script: { code_hash: "0xabc" },
          state: { state_name: "ChannelReady" },
          enabled: true,
          local_balance: "0x0",
          remote_balance: "0x32",
          pending_tlcs: []
        }
      ]
    },
    ["02peer1"]
  );

  assert.equal(channels.total, 2);
  assert.equal(channels.public, 1);
  assert.equal(channels.private, 1);
  assert.equal(channels.ckb, 1);
  assert.equal(channels.udt, 1);
  assert.equal(channels.usable_outbound, 1);
  assert.equal(channels.local_balance_total, "100");
  assert.equal(channels.remote_balance_total, "250");
  assert.equal(channels.pending_tlc_count, 1);
  assert.deepEqual(channels.offline_counterparties, ["02peer2"]);
});

test("FiberNodeDiagnosticsClient inspects node, peers, and channels", async () => {
  const calls = [];
  const client = new FiberNodeDiagnosticsClient({
    rpc: {
      async call(method) {
        calls.push(method);
        if (method === "node_info") {
          return {
            pubkey: "02payer",
            version: "0.9.0",
            peers_count: "0x1",
            channel_count: "0x1"
          };
        }
        if (method === "list_peers") {
          return {
            peers: [{ pubkey: "02peer", address: "/ip4/127.0.0.1/tcp/8228" }]
          };
        }
        if (method === "list_channels") {
          return {
            channels: [
              {
                pubkey: "02peer",
                is_public: true,
                funding_udt_type_script: null,
                state: { state_name: "ChannelReady" },
                enabled: true,
                local_balance: "0xa",
                remote_balance: "0x14",
                pending_tlcs: []
              }
            ]
          };
        }
        throw new Error(`unexpected method ${method}`);
      }
    }
  });

  const inspected = await client.inspectNode();
  const payerDiagnostics = await client.payerDiagnostics();

  assert.deepEqual(calls.slice(0, 4).sort(), ["list_channels", "list_channels", "list_peers", "node_info"]);
  assert.equal(inspected.node.pubkey, "02payer");
  assert.equal(inspected.node.peers_count, "1");
  assert.equal(inspected.peers.count, 1);
  assert.equal(inspected.channels.local_balance_total, "10");
  assert.equal(payerDiagnostics.payer.pubkey, "02payer");
  assert.deepEqual(payerDiagnostics.payer.peers, ["02peer"]);
});

test("analyzes a usable direct payer-to-merchant topology", () => {
  const report = analyzeFiberTopology({
    merchantRpcUrl: "http://merchant.test",
    payerRpcUrl: "http://payer.test",
    merchant: inspectedNode({
      pubkey: "03merchant",
      peers: ["02payer"],
      channels: {
        enabled: 1,
        usable_inbound: 1,
        counterparties: [
          {
            pubkey: "02payer",
            connected: true,
            channels: 1,
            local_balance_total: "0",
            local_balance_total_hex: "0x0",
            remote_balance_total: "100",
            remote_balance_total_hex: "0x64"
          }
        ]
      }
    }),
    payer: inspectedNode({
      pubkey: "02payer",
      peers: ["03merchant"],
      channels: {
        enabled: 1,
        usable_outbound: 1,
        counterparties: [
          {
            pubkey: "03merchant",
            connected: true,
            channels: 1,
            local_balance_total: "100",
            local_balance_total_hex: "0x64",
            remote_balance_total: "0",
            remote_balance_total_hex: "0x0"
          }
        ]
      }
    })
  });

  assert.equal(report.status, "ready");
  assert.equal(report.ok, true);
  assert.equal(report.readiness.deterministic_local_payment, true);
  assert.equal(report.direct_channel.usable_for_payer_to_merchant, true);
  assert.equal(report.fixture_recommendation.direct_payer_to_merchant_channel.needed, false);
  assert.deepEqual(report.blockers, []);
});

test("analyzes an offline shared-counterparty topology", () => {
  const report = analyzeFiberTopology({
    merchant: inspectedNode({
      pubkey: "03merchant",
      peers: [],
      channels: {
        enabled: 1,
        usable_inbound: 1,
        offline_counterparties: ["02route"],
        counterparties: [{ pubkey: "02route", connected: false, channels: 1 }]
      }
    }),
    payer: inspectedNode({
      pubkey: "02payer",
      peers: [],
      channels: {
        enabled: 1,
        usable_outbound: 1,
        offline_counterparties: ["02route"],
        counterparties: [
          {
            pubkey: "02route",
            connected: false,
            channels: 1,
            local_balance_total: "100",
            local_balance_total_hex: "0x64"
          }
        ]
      }
    })
  });

  assert.equal(report.status, "blocked");
  assert.equal(report.ok, false);
  assert.deepEqual(report.common_channel_counterparties, ["02route"]);
  assert.deepEqual(report.online_common_channel_counterparties, []);
  assert.equal(report.blockers.some((blocker) => blocker.code === "SHARED_COUNTERPARTY_OFFLINE"), true);
  assert.equal(report.warnings.some((warning) => warning.code === "NO_DIRECT_CHANNEL"), true);
  assert.equal(report.fixture_recommendation.direct_payer_to_merchant_channel.needed, true);
});

test("analyzes a direct channel opening in progress", () => {
  const report = analyzeFiberTopology({
    merchantRpcUrl: "http://merchant.test",
    payerRpcUrl: "http://payer.test",
    merchant: inspectedNode({
      pubkey: "03merchant",
      peers: ["02payer"],
      channels: {
        enabled: 1,
        usable_inbound: 1
      },
      pending_channels: {
        total: 1,
        opening: 1,
        counterparties: [
          {
            pubkey: "02payer",
            opening: 1,
            channels: 1,
            states: ["NegotiatingFunding"],
            channel_ids: ["0xtemp"]
          }
        ]
      }
    }),
    payer: inspectedNode({
      pubkey: "02payer",
      peers: ["03merchant"],
      channels: {
        enabled: 1,
        usable_outbound: 1
      },
      pending_channels: {
        total: 1,
        opening: 1,
        counterparties: [
          {
            pubkey: "03merchant",
            opening: 1,
            channels: 1,
            states: ["NegotiatingFunding"],
            channel_ids: ["0xtemp"]
          }
        ]
      }
    })
  });

  assert.equal(report.status, "opening");
  assert.equal(report.ok, true);
  assert.equal(report.direct_channel.opening, true);
  assert.equal(report.readiness.direct_channel_opening, true);
  assert.equal(report.warnings.some((warning) => warning.code === "DIRECT_CHANNEL_OPENING"), true);
  assert.equal(report.fixture_recommendation.direct_payer_to_merchant_channel.needed, false);
  assert.equal(report.fixture_recommendation.direct_payer_to_merchant_channel.opening, true);
  assert.deepEqual(report.blockers, []);
});

test("analyzes a stalled one-sided direct channel opening", () => {
  const report = analyzeFiberTopology({
    merchantRpcUrl: "http://merchant.test",
    payerRpcUrl: "http://payer.test",
    merchant: inspectedNode({
      pubkey: "03merchant",
      peers: ["02payer"],
      channels: {
        enabled: 1,
        usable_inbound: 1
      }
    }),
    payer: inspectedNode({
      pubkey: "02payer",
      peers: ["03merchant"],
      channels: {
        enabled: 1,
        usable_outbound: 1
      },
      pending_channels: {
        total: 1,
        opening: 1,
        counterparties: [
          {
            pubkey: "03merchant",
            opening: 1,
            channels: 1,
            states: ["NegotiatingFunding"],
            channel_ids: ["0xtemp"]
          }
        ]
      }
    })
  });

  assert.equal(report.status, "blocked");
  assert.equal(report.ok, false);
  assert.equal(report.direct_channel.opening, false);
  assert.equal(report.direct_channel.partial_opening, true);
  assert.equal(report.readiness.direct_channel_opening, false);
  assert.equal(report.blockers.some((blocker) => blocker.code === "DIRECT_CHANNEL_HANDSHAKE_STALLED"), true);
  assert.equal(report.warnings.some((warning) => warning.code === "DIRECT_CHANNEL_OPENING"), false);
  assert.equal(report.fixture_recommendation.direct_payer_to_merchant_channel.needed, false);
  assert.equal(report.fixture_recommendation.direct_payer_to_merchant_channel.stalled_opening, true);
});

test("FiberTopologyClient passes topology diagnostics into route checks", async () => {
  let receivedDiagnostics;
  const client = new FiberTopologyClient({
    merchantClient: {
      async inspectNode() {
        return inspectedNode({
          pubkey: "03merchant",
          peers: ["02payer"],
          channels: {
            enabled: 1,
            usable_inbound: 1,
            counterparties: [{ pubkey: "02payer", connected: true, channels: 1, remote_balance_total: "100" }]
          }
        });
      }
    },
    payerClient: {
      async inspectNode() {
        return inspectedNode({
          pubkey: "02payer",
          peers: ["03merchant"],
          channels: {
            enabled: 1,
            usable_outbound: 1,
            counterparties: [{ pubkey: "03merchant", connected: true, channels: 1, local_balance_total: "100" }]
          }
        });
      }
    },
    paymentClient: {
      async checkPaymentRoute(invoice, options) {
        receivedDiagnostics = options.diagnostics;
        return {
          ok: true,
          payable: true,
          invoice
        };
      }
    }
  });

  const report = await client.checkInvoiceRoute("fibt1invoice");

  assert.equal(report.route_check.ok, true);
  assert.equal(receivedDiagnostics.direct_channel.payer_to_merchant, true);
  assert.equal(receivedDiagnostics.merchant.pubkey, "03merchant");
  assert.equal(report.readiness.direct_channel_ready, true);
});

test("analyzes payment readiness from direct channel liquidity", () => {
  const topology = analyzeFiberTopology({
    merchant: inspectedNode({
      pubkey: "03merchant",
      peers: ["02payer"],
      channels: {
        enabled: 1,
        usable_inbound: 1,
        ckb: 1,
        counterparties: [{ pubkey: "02payer", connected: true, channels: 1, remote_balance_total: "5000" }]
      }
    }),
    payer: inspectedNode({
      pubkey: "02payer",
      peers: ["03merchant"],
      channels: {
        enabled: 1,
        usable_outbound: 1,
        ckb: 1,
        counterparties: [{ pubkey: "03merchant", connected: true, channels: 1, local_balance_total: "5000" }]
      }
    })
  });

  const readiness = analyzePaymentReadiness({
    amount: "1200",
    asset: { asset_type: "ckb", symbol: "CKB" },
    topology,
    checks: [{ id: "request", status: "pass", message: "Amount and asset are accepted" }]
  });

  assert.equal(readiness.ready, true);
  assert.equal(readiness.payable, true);
  assert.equal(readiness.confidence, "medium");
  assert.equal(readiness.next_action, "request_invoice");
  assert.equal(readiness.checks.some((check) => check.id === "amount_liquidity" && check.status === "pass"), true);
});

test("keeps unknown payer route separate from merchant request readiness", () => {
  const readiness = analyzePaymentReadiness({
    amount: "11",
    asset: { asset_type: "ckb", symbol: "CKB" },
    invoice_mode: "fiber-rpc",
    checks: [
      { id: "signature", status: "pass", message: "Offer signature is valid" },
      { id: "request", status: "pass", message: "Amount and asset are accepted" },
      { id: "invoice_source", status: "pass", message: "Merchant Fiber RPC is available" }
    ]
  });

  assert.equal(readiness.ready, true);
  assert.equal(readiness.payable, undefined);
  assert.equal(readiness.confidence, "medium");
  assert.equal(readiness.summary, "Request is valid; a fresh Fiber invoice can be created.");
  assert.equal(readiness.next_action, "request_invoice");
  assert.equal(readiness.checks.some((check) => check.id === "topology"), false);
  assert.equal(readiness.checks.some((check) => check.id === "route_dry_run"), false);
  assert.deepEqual(readiness.warnings, []);
});

test("blocks payment readiness when direct channel liquidity is too low", () => {
  const topology = analyzeFiberTopology({
    merchant: inspectedNode({
      pubkey: "03merchant",
      peers: ["02payer"],
      channels: {
        enabled: 1,
        usable_inbound: 1,
        ckb: 1,
        counterparties: [{ pubkey: "02payer", connected: true, channels: 1, remote_balance_total: "5000" }]
      }
    }),
    payer: inspectedNode({
      pubkey: "02payer",
      peers: ["03merchant"],
      channels: {
        enabled: 1,
        usable_outbound: 1,
        ckb: 1,
        counterparties: [{ pubkey: "03merchant", connected: true, channels: 1, local_balance_total: "5000" }]
      }
    })
  });

  const readiness = analyzePaymentReadiness({
    amount: "6000",
    asset: { asset_type: "ckb", symbol: "CKB" },
    topology,
    checks: [{ id: "request", status: "pass", message: "Amount and asset are accepted" }]
  });

  assert.equal(readiness.ready, false);
  assert.equal(readiness.confidence, "low");
  assert.equal(readiness.next_action, "fix_request");
  assert.equal(readiness.code, "DIRECT_OUTBOUND_LIQUIDITY_TOO_LOW");
  assert.equal(readiness.blockers.some((blocker) => blocker.code === "DIRECT_OUTBOUND_LIQUIDITY_TOO_LOW"), true);
});

test("surfaces route dry-run failures with raw Fiber error context", () => {
  const readiness = analyzePaymentReadiness({
    amount: "1200",
    asset: { asset_type: "ckb", symbol: "CKB" },
    invoice: "fibt1invoice",
    checks: [{ id: "request", status: "pass", message: "Amount and asset are accepted" }],
    route_check: {
      ok: false,
      payable: false,
      failure: {
        code: "ROUTE_OUTBOUND_LIQUIDITY_UNUSABLE",
        summary: "Fiber could not find a route with usable outbound liquidity from the payer to this invoice.",
        fiber_error: {
          method: "send_payment",
          code: -32000,
          message: "max outbound liquidity 0"
        },
        likely_causes: ["The payer has no enabled channel with local balance."],
        next_actions: ["Open or rebalance a channel."]
      }
    }
  });

  assert.equal(readiness.ready, false);
  assert.equal(readiness.route_check.failure.fiber_error.message, "max outbound liquidity 0");
  assert.equal(readiness.failure.code, "ROUTE_OUTBOUND_LIQUIDITY_UNUSABLE");
  assert.equal(readiness.checks.some((check) => check.id === "route_dry_run" && check.status === "fail"), true);
});

test("plans a direct-channel fixture from blocked topology", () => {
  const topology = analyzeFiberTopology({
    merchantRpcUrl: "http://merchant.test",
    payerRpcUrl: "http://payer.test",
    merchant: inspectedNode({
      pubkey: "03merchant",
      peers: ["02route"],
      channels: {
        enabled: 1,
        usable_inbound: 1,
        counterparties: [{ pubkey: "02route", connected: true, channels: 1 }]
      }
    }),
    payer: inspectedNode({
      pubkey: "02payer",
      peers: ["02route"],
      channels: {
        enabled: 1,
        usable_outbound: 1,
        counterparties: [{ pubkey: "02route", connected: true, channels: 1 }]
      }
    })
  });

  const plan = planDirectChannelFixture(topology, {
    fundingAmount: "10000000000",
    merchantPeerAddress: "/ip4/127.0.0.1/tcp/8228/p2p/QmMerchant"
  });

  assert.equal(plan.status, "ready_to_execute");
  assert.equal(plan.connect_needed, true);
  assert.equal(plan.open_needed, true);
  assert.equal(plan.funding_amount, "10000000000");
  assert.equal(plan.funding_amount_hex, "0x2540be400");
  assert.deepEqual(plan.steps.map((step) => step.rpc_method), ["connect_peer", "open_channel"]);
  assert.deepEqual(plan.steps[0].rpc_params, {
    address: "/ip4/127.0.0.1/tcp/8228/p2p/QmMerchant",
    save: true
  });
	  assert.deepEqual(plan.steps[1].rpc_params, {
	    pubkey: "03merchant",
	    funding_amount: "0x2540be400",
	    public: false,
	    one_way: false
	  });
  assert.match(plan.steps[1].command, /open_channel/);
});

test("plans direct-channel fixture as already ready", () => {
  const topology = analyzeFiberTopology({
    merchantRpcUrl: "http://merchant.test",
    payerRpcUrl: "http://payer.test",
    merchant: inspectedNode({
      pubkey: "03merchant",
      peers: ["02payer"],
      channels: {
        enabled: 1,
        usable_inbound: 1,
        counterparties: [{ pubkey: "02payer", connected: true, channels: 1, remote_balance_total: "100" }]
      }
    }),
    payer: inspectedNode({
      pubkey: "02payer",
      peers: ["03merchant"],
      channels: {
        enabled: 1,
        usable_outbound: 1,
        counterparties: [{ pubkey: "03merchant", connected: true, channels: 1, local_balance_total: "100" }]
      }
    })
  });

  const plan = planDirectChannelFixture(topology, { fundingAmount: "10000000000" });

  assert.equal(plan.status, "already_ready");
  assert.equal(plan.open_needed, false);
  assert.deepEqual(plan.steps, []);
});

test("plans direct-channel fixture as already opening", () => {
  const topology = analyzeFiberTopology({
    merchantRpcUrl: "http://merchant.test",
    payerRpcUrl: "http://payer.test",
    merchant: inspectedNode({
      pubkey: "03merchant",
      peers: ["02payer"],
      channels: {
        enabled: 1,
        usable_inbound: 1
      },
      pending_channels: {
        total: 1,
        opening: 1,
        counterparties: [{ pubkey: "02payer", opening: 1, channels: 1 }]
      }
    }),
    payer: inspectedNode({
      pubkey: "02payer",
      peers: ["03merchant"],
      channels: {
        enabled: 1,
        usable_outbound: 1
      },
      pending_channels: {
        total: 1,
        opening: 1,
        counterparties: [{ pubkey: "03merchant", opening: 1, channels: 1 }]
      }
    })
  });

  const plan = planDirectChannelFixture(topology, { fundingAmount: "10000000000" });

  assert.equal(plan.status, "already_opening");
  assert.equal(plan.open_needed, false);
  assert.deepEqual(plan.steps, []);
});

test("plans direct-channel fixture merchant acceptance", () => {
  const topology = analyzeFiberTopology({
    merchantRpcUrl: "http://merchant.test",
    payerRpcUrl: "http://payer.test",
    merchant: inspectedNode({
      pubkey: "03merchant",
      peers: ["02payer"],
      channels: {
        enabled: 1,
        usable_inbound: 1
      },
      pending_channels: {
        total: 1,
        opening: 1,
        counterparties: [
          {
            pubkey: "02payer",
            opening: 1,
            channels: 1,
            states: ["NegotiatingFunding"],
            opening_states: ["NegotiatingFunding"],
            channel_ids: ["0xtemp"],
            opening_channel_ids: ["0xtemp"]
          }
        ]
      }
    }),
    payer: inspectedNode({
      pubkey: "02payer",
      peers: ["03merchant"],
      channels: {
        enabled: 1,
        usable_outbound: 1
      },
      pending_channels: {
        total: 1,
        opening: 1,
        counterparties: [{ pubkey: "03merchant", opening: 1, channels: 1 }]
      }
    })
  });

  const plan = planDirectChannelFixture(topology, {
    acceptFundingAmount: "9900000000"
  });

  assert.equal(plan.status, "ready_to_accept");
  assert.equal(plan.accept_needed, true);
  assert.equal(plan.open_needed, false);
  assert.equal(plan.accept_temporary_channel_id, "0xtemp");
  assert.equal(plan.accept_funding_amount, "9900000000");
  assert.equal(plan.accept_funding_amount_hex, "0x24e160300");
  assert.deepEqual(plan.steps.map((step) => step.rpc_method), ["accept_channel"]);
  assert.deepEqual(plan.steps[0].rpc_params, {
    temporary_channel_id: "0xtemp",
    funding_amount: "0x24e160300"
  });
  assert.match(plan.steps[0].command, /accept_channel/);
});

test("plans direct-channel fixture as stalled opening", () => {
  const topology = analyzeFiberTopology({
    merchantRpcUrl: "http://merchant.test",
    payerRpcUrl: "http://payer.test",
    merchant: inspectedNode({
      pubkey: "03merchant",
      peers: ["02payer"],
      channels: {
        enabled: 1,
        usable_inbound: 1
      }
    }),
    payer: inspectedNode({
      pubkey: "02payer",
      peers: ["03merchant"],
      channels: {
        enabled: 1,
        usable_outbound: 1
      },
      pending_channels: {
        total: 1,
        opening: 1,
        counterparties: [{ pubkey: "03merchant", opening: 1, channels: 1 }]
      }
    })
  });

  const plan = planDirectChannelFixture(topology, { fundingAmount: "10000000000" });

  assert.equal(plan.status, "stalled_opening");
  assert.equal(plan.stalled_opening, true);
  assert.equal(plan.open_needed, false);
  assert.deepEqual(plan.steps, []);
});

test("plans direct-channel fixture missing required inputs", () => {
  const topology = analyzeFiberTopology({
    payerRpcUrl: "http://payer.test",
    merchant: inspectedNode({
      pubkey: "03merchant",
      channels: {
        enabled: 1,
        usable_inbound: 1
      }
    }),
    payer: inspectedNode({
      pubkey: "02payer",
      channels: {
        enabled: 1,
        usable_outbound: 1
      }
    })
  });

  const plan = planDirectChannelFixture(topology);

  assert.equal(plan.status, "missing_input");
  assert.equal(plan.ok, false);
  assert.equal(plan.missing.includes("merchant_rpc_url"), true);
  assert.equal(plan.missing.includes("merchant_peer_address"), true);
  assert.equal(plan.missing.includes("funding_amount"), true);
});

function inspectedNode({ pubkey, peers = [], channels = {}, pending_channels = {} }) {
  return {
    node: {
      pubkey,
      peers_count: String(peers.length),
      channel_count: String(channels.total ?? channels.enabled ?? 0)
    },
    peers: {
      count: peers.length,
      pubkeys: peers,
      peers: peers.map((peer) => ({ pubkey: peer }))
    },
    channels: {
      total: channels.total ?? channels.enabled ?? 0,
      ready: channels.ready ?? channels.enabled ?? 0,
      enabled: channels.enabled ?? 0,
      public: channels.public ?? channels.enabled ?? 0,
      private: channels.private ?? 0,
      ckb: channels.ckb ?? channels.enabled ?? 0,
      udt: channels.udt ?? 0,
      usable_outbound: channels.usable_outbound ?? 0,
      usable_inbound: channels.usable_inbound ?? 0,
      local_balance_total: channels.local_balance_total ?? "0",
      local_balance_total_hex: channels.local_balance_total_hex ?? "0x0",
      remote_balance_total: channels.remote_balance_total ?? "0",
      remote_balance_total_hex: channels.remote_balance_total_hex ?? "0x0",
      pending_tlc_count: channels.pending_tlc_count ?? 0,
      counterparties: channels.counterparties ?? [],
      offline_counterparties: channels.offline_counterparties ?? []
    },
    pending_channels: {
      total: pending_channels.total ?? 0,
      opening: pending_channels.opening ?? 0,
      failed: pending_channels.failed ?? 0,
      counterparties: pending_channels.counterparties ?? []
    }
  };
}
