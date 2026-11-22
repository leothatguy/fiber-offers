import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryRateLimiter, createServer, InMemoryOfferStore, JsonOfferStore } from "../src/server.js";
import { FiberRpcInvoiceAdapter, MockInvoiceAdapter } from "../src/invoice-adapter.js";
import { deliverWebhookEvent, signWebhookPayload } from "../src/webhook-delivery.js";
import {
  ckbScriptHash,
  createOfferRevocation,
  createSignedOffer,
  encodeOffer,
  generateOfferKeyPair,
  signRecurrenceRequest,
  subscriptionId
} from "../../../packages/protocol/src/index.js";

test("creates a demo offer and resolves fresh invoices from it", async () => {
  await withServer(async (baseUrl) => {
    const created = await postJson(`${baseUrl}/demo/offers`, {
      username: "coffee",
      description: "Coffee checkout",
      amount_min: "1000",
      amount_max: "5000"
    });

    assert.equal(created.status, 201);
    assert.match(created.body.offer_id, /^0x[0-9a-f]{64}$/);
    assert.match(created.body.encoded_offer, /^fbroffer1/);
    assert.equal(created.body.fiber_address, `coffee@${new URL(baseUrl).host}`);

    const request = {
      amount: "1200",
      asset: { asset_type: "ckb", symbol: "CKB" }
    };
    const first = await postJson(`${baseUrl}/offers/${created.body.offer_id}/invoice`, request);
    const second = await postJson(`${baseUrl}/offers/${created.body.offer_id}/invoice`, request);

    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(first.body.mocked, true);
    assert.notEqual(first.body.invoice, second.body.invoice);
    assert.notEqual(first.body.payment_hash, second.body.payment_hash);
  });
});

test("lists offer inventory with compact operator summaries", async () => {
  await withServer(async (baseUrl) => {
    const first = await postJson(`${baseUrl}/demo/offers`, {
      username: "coffee",
      description: "Coffee checkout",
      amount_min: "1000",
      amount_max: "1000"
    });
    await postJson(`${baseUrl}/demo/offers`, {
      username: "tips",
      description: "Tips jar",
      amount_min: "100"
    });

    const listed = await getJson(`${baseUrl}/offers`);
    const fetched = await getJson(`${baseUrl}/offers/${first.body.offer_id}`);

    assert.equal(listed.status, 200);
    assert.equal(listed.body.offers.length, 2);
    assert.equal(listed.body.offers[0].encoded_offer, undefined);
    assert.equal(listed.body.offers.find((offer) => offer.fiber_address?.startsWith("tips@")).fiber_address, `tips@${new URL(baseUrl).host}`);
    assert.ok(listed.body.offers.some((offer) => offer.offer_id === first.body.offer_id));
    assert.equal(fetched.body.fiber_address, `coffee@${new URL(baseUrl).host}`);
  });
});

test("serves the self-hosting guide from the documentation route", async () => {
  await withServer(async (baseUrl) => {
    const guide = await getText(`${baseUrl}/docs/self-hosting`);

    assert.equal(guide.status, 200);
    assert.match(guide.contentType, /^text\/html/);
    assert.match(guide.body, /<h1>Self-host Fiber Offers<\/h1>/);
    assert.match(guide.body, /aria-current="page">Self-hosting<\/a>/);
  });
});

test("creates fixed pricing from one amount and rejects non-exact invoice requests", async () => {
  await withServer(async (baseUrl) => {
    const created = await postJson(`${baseUrl}/demo/offers`, {
      pricing_type: "fixed",
      amount: "1000"
    });

    const rejected = await postJson(`${baseUrl}/offers/${created.body.offer_id}/invoice`, {
      amount: "1001",
      asset: { asset_type: "ckb", symbol: "CKB" }
    });

    assert.equal(created.status, 201);
    assert.equal(created.body.offer.amount_min, "1000");
    assert.equal(created.body.offer.amount_max, "1000");
    assert.equal(created.body.offer.metadata.pricing_type, "fixed");
    assert.equal(rejected.status, 422);
    assert.equal(rejected.body.error.code, "AMOUNT_MUST_MATCH_FIXED_AMOUNT");
  });
});

test("mints token invoices with the token's type script and refuses unconfigured tokens", async () => {
  const nodeId = "02" + "f".repeat(64);
  // One token configured by the operator, one listed by the node itself.
  const usdiScript = { code_hash: "0x" + "aa".repeat(32), hash_type: "type", args: "0x" + "01".repeat(32) };
  const rusdScript = { code_hash: "0x" + "bb".repeat(32), hash_type: "data1", args: "0x" + "02".repeat(20) };
  const usdi = { asset_type: "udt", symbol: "USDI", type_script_hash: ckbScriptHash(usdiScript) };
  const rusd = { asset_type: "udt", symbol: "RUSD", type_script_hash: ckbScriptHash(rusdScript) };
  const unknown = { asset_type: "udt", symbol: "NOPE", type_script_hash: "0x" + "1".repeat(64) };
  const calls = [];
  const invoiceAdapter = new FiberRpcInvoiceAdapter({
    udtScripts: [{ name: "USDI", ...usdiScript }],
    client: {
      async call(method, params) {
        calls.push({ method, params });
        if (method === "node_info") {
          return {
            pubkey: nodeId,
            udt_cfg_infos: [
              { name: "RUSD", script: rusdScript },
              // A whitelist pattern covers many tokens and cannot be hashed.
              { name: "ANY", script: { ...rusdScript, args: "0x.*" } }
            ]
          };
        }
        if (method === "new_invoice") {
          return {
            invoice_address: `fibt1invoice${calls.length}`,
            invoice: { data: { payment_hash: "0x" + String(calls.length).padStart(64, "0") } }
          };
        }
        throw new Error(`unexpected Fiber method: ${method}`);
      }
    }
  });

  await withServer(
    async (baseUrl) => {
      const created = await postJson(`${baseUrl}/demo/offers`, {
        amount: "1000",
        assets: [{ asset_type: "ckb", symbol: "CKB" }, usdi, rusd]
      });
      const invoiceUrl = `${baseUrl}/offers/${created.body.offer_id}/invoice`;
      const usdiInvoice = await postJson(invoiceUrl, { amount: "1000", asset: usdi });
      const rusdInvoice = await postJson(invoiceUrl, { amount: "1000", asset: rusd });
      const ckbInvoice = await postJson(invoiceUrl, { amount: "1000", asset: { asset_type: "ckb", symbol: "CKB" } });
      const minted = calls.filter((call) => call.method === "new_invoice").map((call) => call.params[0]);

      assert.equal(created.status, 201);
      assert.deepEqual([usdiInvoice.status, rusdInvoice.status, ckbInvoice.status], [201, 201, 201]);
      // Every asset uses the network currency; a token is named by its script.
      assert.deepEqual(minted.map((params) => params.currency), ["Fibt", "Fibt", "Fibt"]);
      assert.deepEqual(minted[0].udt_type_script, usdiScript);
      assert.deepEqual(minted[1].udt_type_script, rusdScript);
      assert.equal("udt_type_script" in minted[2], false);

      // An offer listing a token the resolver cannot mint is refused up front.
      const refused = await postJson(`${baseUrl}/demo/offers`, {
        amount: "1000",
        assets: [{ asset_type: "ckb", symbol: "CKB" }, unknown]
      });
      assert.equal(refused.status, 422);
      assert.equal(refused.body.error.code, "ASSET_SCRIPT_NOT_CONFIGURED");
      assert.deepEqual(refused.body.error.details.assets, [unknown]);

      // If the operator later removes a token, payers are told before and at
      // invoice time, and told that retrying will not help.
      invoiceAdapter.udtScripts.clear();
      const readiness = await postJson(`${baseUrl}/offers/${created.body.offer_id}/check`, {
        amount: "1000",
        asset: usdi
      });
      const removed = await postJson(invoiceUrl, { amount: "1000", asset: usdi });
      assert.equal(readiness.body.ready, false);
      assert.equal(
        readiness.body.checks.find((check) => check.id === "asset_source").code,
        "ASSET_SCRIPT_NOT_CONFIGURED"
      );
      assert.equal(removed.status, 422);
      assert.equal(removed.body.error.code, "ASSET_SCRIPT_NOT_CONFIGURED");
      assert.equal(removed.body.error.details.retryable, false);
      assert.equal(calls.filter((call) => call.method === "new_invoice").length, 3);
    },
    { invoiceAdapter }
  );
});

test("live invoices carry an expiry and read as expired once it has passed", async () => {
  const nodeId = "02" + "8".repeat(64);
  const requests = [];
  let clock = () => Date.now();
  const invoiceAdapter = new FiberRpcInvoiceAdapter({
    invoiceTtlSeconds: 60,
    now: () => clock(),
    client: {
      async call(method, params) {
        if (method === "node_info") return { pubkey: nodeId };
        requests.push(params[0]);
        return {
          invoice_address: `fibt1expiring${requests.length}`,
          invoice: { data: { payment_hash: "0x" + String(requests.length).padStart(64, "0") } }
        };
      }
    }
  });

  await withServer(
    async (baseUrl) => {
      const created = await postJson(`${baseUrl}/demo/offers`, { amount: "1000" });
      const invoiceUrl = `${baseUrl}/offers/${created.body.offer_id}/invoice`;
      const request = { amount: "1000", asset: { asset_type: "ckb", symbol: "CKB" } };

      const fresh = await postJson(invoiceUrl, request);
      // Issue a second invoice as if an hour ago, so its minute has run out.
      clock = () => Date.now() - 3600_000;
      const stale = await postJson(invoiceUrl, request);
      const resolutionUrl = (invoice) => `${baseUrl}/offers/${created.body.offer_id}/resolutions/${invoice.body.resolution_id}`;
      const freshRead = await getJson(resolutionUrl(fresh));
      const staleRead = await getJson(resolutionUrl(stale));

      assert.deepEqual(requests.map((params) => params.expiry), ["0x3c", "0x3c"]);
      assert.ok(Date.parse(fresh.body.expires_at) > Date.now());
      assert.ok(Date.parse(fresh.body.expires_at) <= Date.now() + 60_000);
      assert.equal(freshRead.body.status, "invoice_created");
      assert.ok(Date.parse(stale.body.expires_at) < Date.now());
      assert.equal(staleRead.body.status, "invoice_expired");
      assert.equal(staleRead.body.expired_at, stale.body.expires_at);
    },
    { invoiceAdapter }
  );
});

test("mints invoices in the currency of the node's network and refuses offers for another", async () => {
  const nodeId = "02" + "9".repeat(64);
  const mainnetGenesis = "0x92b197aa1fba0f63633922c61c92375c9c074a93e85963554f5499fe1450d0e5";
  const calls = [];
  const invoiceAdapter = new FiberRpcInvoiceAdapter({
    client: {
      async call(method, params) {
        calls.push({ method, params });
        if (method === "node_info") return { pubkey: nodeId, chain_hash: mainnetGenesis };
        if (method === "new_invoice") {
          return { invoice_address: "fibb1mainnetinvoice", invoice: { data: { payment_hash: "0x" + "4".repeat(64) } } };
        }
        throw new Error(`unexpected Fiber method: ${method}`);
      }
    }
  });

  await withServer(
    async (baseUrl) => {
      // A demo offer takes the node's network when none is given.
      const created = await postJson(`${baseUrl}/demo/offers`, { amount: "1000" });
      const invoice = await postJson(`${baseUrl}/offers/${created.body.offer_id}/invoice`, {
        amount: "1000",
        asset: { asset_type: "ckb", symbol: "CKB" }
      });

      const keys = generateOfferKeyPair();
      const testnetOffer = createSignedOffer(
        {
          node_id: nodeId,
          network: "testnet",
          public_key: keys.publicKeyPem,
          resolver_url: baseUrl,
          assets: [{ asset_type: "ckb", symbol: "CKB" }]
        },
        keys.privateKeyPem
      );
      const rejected = await postJson(`${baseUrl}/offers`, { encoded_offer: encodeOffer(testnetOffer) });

      assert.equal(created.body.offer.network, "mainnet");
      assert.equal(created.body.ownership.network, "mainnet");
      assert.equal(invoice.status, 201);
      assert.equal(calls.find((call) => call.method === "new_invoice").params[0].currency, "Fibb");
      assert.equal(rejected.status, 422);
      assert.equal(rejected.body.error.code, "OFFER_NETWORK_MISMATCH");
      assert.deepEqual(rejected.body.error.details, {
        offer_network: "testnet",
        node_network: "mainnet",
        node_network_source: "chain_hash"
      });
    },
    { invoiceAdapter }
  );
});

test("replays an idempotent invoice request without creating another invoice or event", async () => {
  await withServer(async (baseUrl) => {
    const created = await postJson(`${baseUrl}/demo/offers`, {
      amount_min: "1000",
      amount_max: "3000"
    });
    const request = {
      amount: "1500",
      asset: { asset_type: "ckb", symbol: "CKB" }
    };
    const headers = { "idempotency-key": "checkout-order-42" };

    const first = await postJson(`${baseUrl}/offers/${created.body.offer_id}/invoice`, request, headers);
    const replay = await postJson(`${baseUrl}/offers/${created.body.offer_id}/invoice`, request, headers);
    const conflict = await postJson(
      `${baseUrl}/offers/${created.body.offer_id}/invoice`,
      { ...request, amount: "1600" },
      headers
    );
    const resolutions = await getJson(`${baseUrl}/offers/${created.body.offer_id}/resolutions`);
    const events = await getJson(`${baseUrl}/offers/${created.body.offer_id}/webhook-events`);

    assert.equal(first.status, 201);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.idempotent_replay, true);
    assert.equal(replay.body.resolution_id, first.body.resolution_id);
    assert.equal(replay.body.invoice, first.body.invoice);
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, "IDEMPOTENCY_KEY_REUSED");
    assert.equal(resolutions.body.resolutions.length, 1);
    assert.equal(events.body.events.length, 1);
  });
});

test("serializes concurrent single-use invoice requests", async () => {
  await withServer(async (baseUrl) => {
    const created = await postJson(`${baseUrl}/demo/offers`, {
      single_use: true,
      amount_min: "1000",
      amount_max: "3000"
    });
    const request = {
      amount: "1500",
      asset: { asset_type: "ckb", symbol: "CKB" }
    };

    const results = await Promise.all([
      postJson(`${baseUrl}/offers/${created.body.offer_id}/invoice`, request),
      postJson(`${baseUrl}/offers/${created.body.offer_id}/invoice`, request)
    ]);
    const successes = results.filter((result) => result.status === 201);
    const rejections = results.filter((result) => result.status === 409);
    const resolutions = await getJson(`${baseUrl}/offers/${created.body.offer_id}/resolutions`);

    assert.equal(successes.length, 1);
    assert.equal(rejections.length, 1);
    // The loser is told an unpaid invoice is outstanding, and until when.
    assert.equal(rejections[0].body.error.code, "OFFER_INVOICE_OUTSTANDING");
    assert.equal(rejections[0].body.error.details.outstanding_until, successes[0].body.expires_at);
    assert.equal(resolutions.body.resolutions.length, 1);
  });
});

test("post-invoice readiness check does not count the checked invoice against a single-use offer", async () => {
  await withServer(async (baseUrl) => {
    const created = await postJson(`${baseUrl}/demo/offers`, { single_use: true, amount: "1000" });
    const offerId = created.body.offer_id;
    const request = { amount: "1000", asset: { asset_type: "ckb", symbol: "CKB" } };

    const before = await postJson(`${baseUrl}/offers/${offerId}/check`, request);
    const invoice = await postJson(`${baseUrl}/offers/${offerId}/invoice`, request);
    const sameInvoice = await postJson(`${baseUrl}/offers/${offerId}/check`, {
      ...request,
      invoice: invoice.body.invoice
    });
    const newRequest = await postJson(`${baseUrl}/offers/${offerId}/check`, request);
    const foreignInvoice = await postJson(`${baseUrl}/offers/${offerId}/check`, {
      ...request,
      invoice: "fibt1issuedelsewhere"
    });
    const checkOf = (result, id) => result.body.checks.find((check) => check.id === id);

    assert.equal(before.body.ready, true);
    assert.equal(invoice.status, 201);
    assert.equal(sameInvoice.body.ready, true);
    assert.equal(checkOf(sameInvoice, "single_use").status, "pass");
    assert.equal(checkOf(sameInvoice, "invoice_match").status, "pass");
    assert.equal(newRequest.body.ready, false);
    assert.equal(checkOf(newRequest, "single_use").code, "OFFER_INVOICE_OUTSTANDING");
    assert.equal(foreignInvoice.body.ready, false);
    assert.equal(checkOf(foreignInvoice, "single_use").code, "OFFER_INVOICE_OUTSTANDING");
    assert.equal(checkOf(foreignInvoice, "invoice_match").code, "INVOICE_NOT_ISSUED_FOR_OFFER");
  });
});

test("readiness treats an idempotent retry as a replay instead of a new use", async () => {
  await withServer(async (baseUrl) => {
    const asset = { asset_type: "ckb", symbol: "CKB" };
    const checkOf = (result, id) => result.body.checks.find((check) => check.id === id);

    const single = await postJson(`${baseUrl}/demo/offers`, {
      single_use: true,
      amount_min: "1000",
      amount_max: "3000"
    });
    const singleUrl = `${baseUrl}/offers/${single.body.offer_id}`;
    const orderKey = { "idempotency-key": "order-1" };
    await postJson(`${singleUrl}/invoice`, { amount: "1500", asset }, orderKey);
    const singleRetry = await postJson(`${singleUrl}/check`, { amount: "1500", asset }, orderKey);
    const singleNoKey = await postJson(`${singleUrl}/check`, { amount: "1500", asset });
    const singleOtherRequest = await postJson(`${singleUrl}/check`, { amount: "1600", asset }, orderKey);

    assert.equal(singleRetry.body.ready, true);
    assert.equal(checkOf(singleRetry, "idempotency").status, "pass");
    assert.equal(singleNoKey.body.ready, false);
    assert.equal(checkOf(singleNoKey, "single_use").code, "OFFER_INVOICE_OUTSTANDING");
    assert.equal(singleOtherRequest.body.ready, false);
    assert.equal(checkOf(singleOtherRequest, "idempotency").code, "IDEMPOTENCY_KEY_REUSED");
    assert.equal(checkOf(singleOtherRequest, "single_use").code, "OFFER_INVOICE_OUTSTANDING");

    const recurring = await postJson(`${baseUrl}/demo/offers`, {
      amount: "1000",
      recurrence: { interval: "daily", amount: "1000", cap_cycles: 3 }
    });
    const recurringUrl = `${baseUrl}/offers/${recurring.body.offer_id}`;
    const subscriber = generateOfferKeyPair();
    const cycleKey = { "idempotency-key": "subscription-1:1" };
    const cycleOne = signRecurrenceRequest(recurring.body.offer, { amount: "1000", asset, recurrence_cycle: 1 }, subscriber.privateKeyPem);
    await postJson(`${recurringUrl}/invoice`, cycleOne, cycleKey);
    const cycleRetry = await postJson(`${recurringUrl}/check`, cycleOne, cycleKey);
    const cycleNoKey = await postJson(`${recurringUrl}/check`, cycleOne);

    assert.equal(cycleRetry.body.ready, true);
    assert.equal(checkOf(cycleRetry, "recurrence").status, "pass");
    assert.equal(checkOf(cycleRetry, "subscription").status, "pass");
    // Without the key it is a second request for a cycle that is still unpaid.
    assert.equal(cycleNoKey.body.ready, false);
    assert.equal(checkOf(cycleNoKey, "recurrence").code, "RECURRENCE_CYCLE_OUTSTANDING");
  });
});

test("a single-use offer is used up by payment and comes back when an invoice lapses unpaid", async () => {
  let clock = () => Date.now();
  const invoiceAdapter = new MockInvoiceAdapter({ invoiceTtlSeconds: 60, now: () => clock() });
  await withServer(async (baseUrl) => {
    const created = await postJson(`${baseUrl}/demo/offers`, { single_use: true, amount: "1000" });
    const offerUrl = `${baseUrl}/offers/${created.body.offer_id}`;
    const request = { amount: "1000", asset: { asset_type: "ckb", symbol: "CKB" } };
    const invoice = () => postJson(`${offerUrl}/invoice`, request);
    const check = async () => (await postJson(`${offerUrl}/check`, request)).body;
    const eventTypes = async () => (await getJson(`${offerUrl}/webhook-events`)).body.events.map((event) => event.type);

    // Someone requests an invoice and never pays. Issue it as if an hour ago.
    clock = () => Date.now() - 3600_000;
    const abandoned = await invoice();
    clock = () => Date.now();

    // Its minute has passed, so the offer is available again.
    assert.equal((await check()).ready, true);
    const second = await invoice();
    assert.deepEqual([abandoned.status, second.status], [201, 201]);
    assert.notEqual(second.body.invoice, abandoned.body.invoice);
    assert.deepEqual(await eventTypes(), ["invoice.created", "invoice.expired", "invoice.created"]);

    // While that one is unpaid, nobody else gets an invoice.
    const blocked = await invoice();
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error.code, "OFFER_INVOICE_OUTSTANDING");
    assert.equal(blocked.body.error.details.outstanding_until, second.body.expires_at);

    // Payment is what uses the offer up, for good.
    await postJson(`${offerUrl}/resolutions/${second.body.resolution_id}/status`, { status: "invoice_paid" });
    const used = await invoice();
    const usedCheck = await check();
    assert.equal(used.status, 409);
    assert.equal(used.body.error.code, "OFFER_ALREADY_USED");
    assert.equal(usedCheck.ready, false);
    assert.equal(usedCheck.checks.find((item) => item.id === "single_use").code, "OFFER_ALREADY_USED");
  }, { invoiceAdapter });
});

test("the readiness check and the invoice endpoint agree after every outcome", async () => {
  const outcomes = [
    { status: "invoice_failed", available: true },
    { status: "invoice_expired", available: true },
    { status: "invoice_cancelled", available: true },
    { status: "invoice_paid", available: false, code: "OFFER_ALREADY_USED" },
    { status: undefined, available: false, code: "OFFER_INVOICE_OUTSTANDING" }
  ];
  for (const outcome of outcomes) {
    await withServer(async (baseUrl) => {
      const created = await postJson(`${baseUrl}/demo/offers`, { single_use: true, amount: "1000" });
      const offerUrl = `${baseUrl}/offers/${created.body.offer_id}`;
      const request = { amount: "1000", asset: { asset_type: "ckb", symbol: "CKB" } };
      const first = await postJson(`${offerUrl}/invoice`, request);
      if (outcome.status) {
        await postJson(`${offerUrl}/resolutions/${first.body.resolution_id}/status`, { status: outcome.status });
      }

      const readiness = await postJson(`${offerUrl}/check`, request);
      const next = await postJson(`${offerUrl}/invoice`, request);
      const label = outcome.status ?? "still unpaid";

      assert.equal(readiness.body.ready, outcome.available, label);
      assert.equal(next.status, outcome.available ? 201 : 409, label);
      if (!outcome.available) {
        assert.equal(next.body.error.code, outcome.code, label);
        assert.equal(readiness.body.checks.find((item) => item.id === "single_use").code, outcome.code, label);
      }
    });
  }
});

test("for a live invoice the node decides whether a single-use offer is free again", async () => {
  const nodeId = "02" + "6".repeat(64);
  let nodeStatus = "Open";
  let minted = 0;
  const invoiceAdapter = new FiberRpcInvoiceAdapter({
    invoiceTtlSeconds: 60,
    // The resolver's clock is an hour ahead: by its reckoning every invoice has lapsed.
    now: () => Date.now() - 3600_000,
    client: {
      async call(method) {
        if (method === "node_info") return { pubkey: nodeId };
        if (method === "new_invoice") {
          minted += 1;
          return { invoice_address: `fibt1live${minted}`, invoice: { data: { payment_hash: "0x" + String(minted).padStart(64, "0") } } };
        }
        return { invoice_address: "fibt1live", invoice: { amount: "0x3e8", currency: "Fibt" }, status: nodeStatus };
      }
    }
  });

  await withServer(async (baseUrl) => {
    const created = await postJson(`${baseUrl}/demo/offers`, { single_use: true, amount: "1000" });
    const invoiceUrl = `${baseUrl}/offers/${created.body.offer_id}/invoice`;
    const request = { amount: "1000", asset: { asset_type: "ckb", symbol: "CKB" } };
    const first = await postJson(invoiceUrl, request);

    // The node still has it open, so it could yet be paid: no second invoice.
    const whileOpen = await postJson(invoiceUrl, request);
    // The node says it expired: released.
    nodeStatus = "Expired";
    const afterExpiry = await postJson(invoiceUrl, request);
    // The node says the replacement was paid, before any sync ran: used up.
    nodeStatus = "Paid";
    const afterPayment = await postJson(invoiceUrl, request);

    assert.equal(first.status, 201);
    assert.equal(whileOpen.body.error.code, "OFFER_INVOICE_OUTSTANDING");
    assert.equal(afterExpiry.status, 201);
    assert.equal(afterPayment.body.error.code, "OFFER_ALREADY_USED");
    assert.equal(minted, 2);
  }, { invoiceAdapter });
});

test("resolves a Fiber Address to its encoded offer", async () => {
  await withServer(async (baseUrl) => {
    const created = await postJson(`${baseUrl}/demo/offers`, {
      username: "tips",
      description: "Tips jar"
    });
    const resolved = await getJson(`${baseUrl}/.well-known/fiberoffer/tips`);

    assert.equal(resolved.status, 200);
    assert.equal(resolved.body.offer_id, created.body.offer_id);
    assert.equal(resolved.body.encoded_offer, created.body.encoded_offer);
  });
});

test("serves QR SVGs for payment links and encoded offers", async () => {
  await withServer(async (baseUrl) => {
    const created = await postJson(`${baseUrl}/demo/offers`, {
      username: "qr",
      description: "QR checkout"
    });

    const linkQr = await getText(`${baseUrl}/offers/${created.body.offer_id}/qr.svg?payload=link`);
    const offerQr = await getText(`${baseUrl}/offers/${created.body.offer_id}/qr.svg?payload=offer`);

    assert.equal(linkQr.status, 200);
    assert.equal(linkQr.contentType, "image/svg+xml; charset=utf-8");
    assert.match(linkQr.body, /^<svg/);
    assert.equal(offerQr.status, 200);
    assert.match(offerQr.body, /^<svg/);
  });
});

test("checks payment readiness without creating an invoice", async () => {
  await withServer(async (baseUrl) => {
    const created = await postJson(`${baseUrl}/demo/offers`, {
      amount_min: "1000",
      amount_max: "2000"
    });
    const request = {
      amount: "1500",
      asset: { asset_type: "ckb", symbol: "CKB" }
    };

    const readiness = await postJson(`${baseUrl}/offers/${created.body.offer_id}/check`, request);
    const resolutions = await getJson(`${baseUrl}/offers/${created.body.offer_id}/resolutions`);

    assert.equal(readiness.status, 200);
    assert.equal(readiness.body.ready, true);
    assert.equal(readiness.body.next_action, "request_invoice");
    assert.equal(readiness.body.checks.some((check) => check.id === "signature" && check.status === "pass"), true);
    assert.equal(resolutions.body.resolutions.length, 0);
  });
});

test("reports readiness failures as diagnostics", async () => {
  await withServer(async (baseUrl) => {
    const created = await postJson(`${baseUrl}/demo/offers`, {
      amount_min: "1000",
      amount_max: "2000"
    });
    const readiness = await postJson(`${baseUrl}/offers/${created.body.offer_id}/check`, {
      amount: "2500",
      asset: { asset_type: "ckb", symbol: "CKB" }
    });

    assert.equal(readiness.status, 200);
    assert.equal(readiness.body.ready, false);
    assert.equal(readiness.body.next_action, "fix_request");
    assert.equal(readiness.body.checks.some((check) => check.code === "AMOUNT_TOO_HIGH"), true);
  });
});

test("adds Fiber topology confidence to payment readiness", async () => {
  const topologyClient = {
    async inspectPair() {
      return readyDirectTopology();
    }
  };

  await withServer(
    async (baseUrl) => {
      const created = await postJson(`${baseUrl}/demo/offers`, {
        amount_min: "1000",
        amount_max: "2000"
      });
      const readiness = await postJson(`${baseUrl}/offers/${created.body.offer_id}/check`, {
        amount: "1500",
        asset: { asset_type: "ckb", symbol: "CKB" }
      });

      assert.equal(readiness.status, 200);
      assert.equal(readiness.body.ready, true);
      assert.equal(readiness.body.confidence, "medium");
      assert.equal(readiness.body.topology.status, "ready");
      assert.equal(
        readiness.body.checks.some((check) => check.id === "amount_liquidity" && check.status === "pass"),
        true
      );
    },
    { topologyClient }
  );
});

test("runs invoice dry-run during payment readiness when invoice is supplied", async () => {
  let receivedInvoice;
  let receivedOptions;
  const topologyClient = {
    async checkInvoiceRoute(invoice, options) {
      receivedInvoice = invoice;
      receivedOptions = options;
      return {
        ...readyDirectTopology(),
        route_check: {
          ok: true,
          payable: true,
          dry_run: {
            payment_hash: "0xabc",
            fee: "0x0"
          }
        }
      };
    }
  };

  await withServer(
    async (baseUrl) => {
      const created = await postJson(`${baseUrl}/demo/offers`, {
        amount_min: "1000",
        amount_max: "2000"
      });
      const readiness = await postJson(`${baseUrl}/offers/${created.body.offer_id}/check`, {
        amount: "1500",
        asset: { asset_type: "ckb", symbol: "CKB" },
        invoice: "fibt1invoice",
        timeout_seconds: 5
      });

      assert.equal(readiness.status, 200);
      assert.equal(readiness.body.ready, true);
      assert.equal(readiness.body.confidence, "high");
      assert.equal(readiness.body.next_action, "send_payment");
      assert.equal(readiness.body.route_check.ok, true);
      assert.equal(receivedInvoice, "fibt1invoice");
      assert.equal(receivedOptions.timeoutSeconds, 5);
    },
    { topologyClient }
  );
});

test("reports resolver diagnostics in mock mode", async () => {
  await withServer(async (baseUrl) => {
    await postJson(`${baseUrl}/demo/offers`, {
      username: "diag",
      description: "Diagnostics checkout"
    });

    const diagnostics = await getJson(`${baseUrl}/diagnostics`);

    assert.equal(diagnostics.status, 200);
    assert.equal(diagnostics.body.invoice_mode, "mock");
    assert.equal(diagnostics.body.invoice_source.status, "mock");
    assert.equal(diagnostics.body.store.offers, 1);
    assert.equal(diagnostics.body.store.fiber_addresses, 1);
  });
});

test("reports unhealthy when the live Fiber invoice source is unreachable", async () => {
  const invoiceAdapter = {
    mode: "fiber-rpc",
    async probe() {
      return {
        mode: "fiber-rpc",
        configured: true,
        reachable: false,
        status: "error",
        error: { code: "FIBER_RPC_PROBE_FAILED" }
      };
    }
  };

  await withServer(async (baseUrl) => {
    const health = await getJson(`${baseUrl}/health`);
    assert.equal(health.status, 503);
    assert.equal(health.body.ok, false);
    assert.equal(health.body.dependencies.invoice_source.ok, false);
    assert.equal(health.body.dependencies.invoice_source.error, "FIBER_RPC_PROBE_FAILED");
  }, { invoiceAdapter, enforceNodeOwnership: false });
});

test("reports unconfigured Fiber topology when payer RPC is missing", async () => {
  await withServer(async (baseUrl) => {
    const topology = await getJson(`${baseUrl}/topology`);

    assert.equal(topology.status, 200);
    assert.equal(topology.body.ok, false);
    assert.equal(topology.body.configured, false);
    assert.equal(topology.body.status, "unconfigured");
  });
});

test("reports configured Fiber topology", async () => {
  const topologyClient = {
    async inspectPair() {
      return {
        ok: true,
        status: "ready",
        summary: "direct channel ready",
        direct_channel: {
          usable_for_payer_to_merchant: true
        }
      };
    }
  };

  await withServer(
    async (baseUrl) => {
      const topology = await getJson(`${baseUrl}/topology`);

      assert.equal(topology.status, 200);
      assert.equal(topology.body.configured, true);
      assert.equal(topology.body.ok, true);
      assert.equal(topology.body.status, "ready");
      assert.equal(topology.body.direct_channel.usable_for_payer_to_merchant, true);
    },
    { topologyClient }
  );
});

test("enforces API key when configured", async () => {
  await withServer(
    async (baseUrl) => {
      const health = await getJson(`${baseUrl}/health`);
      const rejected = await postJson(`${baseUrl}/demo/offers`, {
        username: "auth"
      });
      const listRejected = await getJson(`${baseUrl}/offers`);
      const accepted = await postJson(
        `${baseUrl}/demo/offers`,
        {
          username: "auth"
        },
        { "x-api-key": "test-key" }
      );

      assert.equal(health.body.auth_required, true);
      assert.equal(rejected.status, 401);
      assert.equal(rejected.body.error.code, "UNAUTHORIZED");
      assert.equal(listRejected.status, 401);
      assert.equal(accepted.status, 201);
      assert.match(accepted.body.offer_id, /^0x[0-9a-f]{64}$/);
    },
    { apiKey: "test-key" }
  );
});

test("exchanges the API key for a signed cross-replica operator session", async () => {
  await withServer(
    async (baseUrl) => {
      const anonymous = await getJson(`${baseUrl}/operator/session`);
      const rejected = await postJson(`${baseUrl}/operator/session`, { api_key: "wrong-key" });
      const login = await fetch(`${baseUrl}/operator/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: "test-key" })
      });
      const cookie = login.headers.get("set-cookie");
      const cookiePair = cookie.split(";")[0];
      const session = await fetch(`${baseUrl}/operator/session`, { headers: { cookie: cookiePair } });
      const offers = await fetch(`${baseUrl}/offers`, { headers: { cookie: cookiePair } });
      const token = cookiePair.slice(cookiePair.indexOf("=") + 1);
      const tampered = await fetch(`${baseUrl}/offers`, {
        headers: { cookie: `fiber_offers_operator=${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}` }
      });

      assert.equal(anonymous.body.authenticated, false);
      assert.equal(rejected.status, 401);
      assert.equal(login.status, 204);
      assert.match(cookie, /^fiber_offers_operator=/);
      assert.match(cookie, /HttpOnly/);
      assert.match(cookie, /SameSite=Strict/);
      assert.equal((await session.json()).authenticated, true);
      assert.equal(offers.status, 200);
      assert.equal(tampered.status, 401);
    },
    { apiKey: "test-key" }
  );
});

test("public demo access establishes an operator session without exposing the API key", async () => {
  await withServer(
    async (baseUrl) => {
      const login = await fetch(`${baseUrl}/operator/session`);
      const body = await login.json();
      const cookie = login.headers.get("set-cookie");
      const cookiePair = cookie.split(";")[0];
      const offers = await fetch(`${baseUrl}/offers`, { headers: { cookie: cookiePair } });

      assert.equal(body.auth_required, true);
      assert.equal(body.authenticated, true);
      assert.equal(body.public_operator_access, true);
      assert.match(cookie, /^fiber_offers_operator=/);
      assert.doesNotMatch(cookie, /test-key/);
      assert.equal(offers.status, 200);
    },
    { apiKey: "test-key", publicOperatorAccess: true }
  );
});

test("reports reachable Fiber RPC diagnostics from the invoice adapter", async () => {
  const invoiceAdapter = {
    mode: "fiber-rpc",
    async probe() {
      return {
        mode: "fiber-rpc",
        configured: true,
        reachable: true,
        status: "ok",
        method: "node_info",
        result_summary: { node_id: "02abc" }
      };
    },
    async createInvoice() {
      throw new Error("not used");
    }
  };

  await withServer(
    async (baseUrl) => {
      const diagnostics = await getJson(`${baseUrl}/diagnostics`);

      assert.equal(diagnostics.status, 200);
      assert.equal(diagnostics.body.ok, true);
      assert.equal(diagnostics.body.invoice_mode, "fiber-rpc");
      assert.equal(diagnostics.body.invoice_source.reachable, true);
      assert.equal(diagnostics.body.invoice_source.result_summary.node_id, "02abc");
    },
    { invoiceAdapter }
  );
});

test("tracks and updates invoice resolution status", async () => {
  await withServer(async (baseUrl) => {
    const created = await postJson(`${baseUrl}/demo/offers`, {
      amount_min: "1000",
      amount_max: "2000"
    });
    const invoice = await postJson(`${baseUrl}/offers/${created.body.offer_id}/invoice`, {
      amount: "1500",
      asset: { asset_type: "ckb", symbol: "CKB" }
    });

    const statusBefore = await getJson(
      `${baseUrl}/offers/${created.body.offer_id}/resolutions/${invoice.body.resolution_id}`
    );
    const paid = await postJson(
      `${baseUrl}/offers/${created.body.offer_id}/resolutions/${invoice.body.resolution_id}/status`,
      {
        status: "invoice_paid",
        source: "test",
        settlement_reference: "mock-settlement-1"
      }
    );
    const listed = await getJson(`${baseUrl}/offers/${created.body.offer_id}/resolutions`);

    assert.equal(statusBefore.status, 200);
    assert.equal(statusBefore.body.status, "invoice_created");
    assert.equal(paid.status, 200);
    assert.equal(paid.body.status, "invoice_paid");
    assert.equal(paid.body.settlement.settlement_reference, "mock-settlement-1");
    assert.equal(listed.body.resolutions[0].status, "invoice_paid");
  });
});

test("syncs invoice resolution status from the invoice source", async () => {
  const invoiceAdapter = {
    mode: "fiber-rpc",
    async probe() {
      return {
        mode: "fiber-rpc",
        configured: true,
        reachable: true,
        status: "ok",
        method: "node_info"
      };
    },
    async createInvoice() {
      return {
        mode: "fiber-rpc",
        invoice: "fibt1000000001sync",
        payment_request: "fibt1000000001sync",
        payment_hash: "0x" + "a".repeat(64),
        mocked: false
      };
    },
    async syncInvoice(paymentHash) {
      return {
        mode: "fiber-rpc",
        payment_hash: paymentHash,
        status: "invoice_paid",
        fiber_status: "Paid",
        get_invoice_method: "get_invoice",
        amount: "0x5dc",
        currency: "Fibt",
        invoice: "fibt1000000001sync",
        raw_result: {
          status: "Paid"
        }
      };
    }
  };

  await withServer(
    async (baseUrl) => {
      const created = await postJson(`${baseUrl}/demo/offers`, {
        amount_min: "1000",
        amount_max: "2000"
      });
      await postJson(`${baseUrl}/offers/${created.body.offer_id}/webhooks`, {
        url: "https://merchant.example/hooks/fiber",
        events: ["invoice.paid"]
      });
      const invoice = await postJson(`${baseUrl}/offers/${created.body.offer_id}/invoice`, {
        amount: "1500",
        asset: { asset_type: "ckb", symbol: "CKB" }
      });
      const synced = await postJson(
        `${baseUrl}/offers/${created.body.offer_id}/resolutions/${invoice.body.resolution_id}/sync`,
        {}
      );
      const events = await getJson(`${baseUrl}/offers/${created.body.offer_id}/webhook-events`);

      assert.equal(synced.status, 200);
      assert.equal(synced.body.changed, true);
      assert.equal(synced.body.previous_status, "invoice_created");
      assert.equal(synced.body.next_status, "invoice_paid");
      assert.equal(synced.body.invoice_source.fiber_status, "Paid");
      assert.equal(synced.body.resolution.status, "invoice_paid");
      assert.equal(synced.body.resolution.settlement.settlement_reference, "0x" + "a".repeat(64));
      assert.equal(synced.body.resolution.status_history.at(-1).source, "fiber-rpc");
      assert.deepEqual(
        events.body.events.map((event) => event.type),
        ["invoice.created", "invoice.paid"]
      );
      assert.equal(events.body.events[1].deliveries.length, 1);
      assert.equal(events.body.events[1].payload.invoice_source.fiber_status, "Paid");
    },
    { invoiceAdapter }
  );
});

test("background worker propagates paid invoices within the five-second target", async () => {
  const invoiceAdapter = {
    mode: "fiber-rpc",
    async probe() {
      return { mode: "fiber-rpc", configured: true, reachable: true, status: "ok" };
    },
    async createInvoice() {
      return {
        mode: "fiber-rpc",
        invoice: "fibt1worker",
        payment_request: "fibt1worker",
        payment_hash: "0x" + "c".repeat(64),
        mocked: false
      };
    },
    async syncInvoice(paymentHash) {
      return {
        mode: "fiber-rpc",
        payment_hash: paymentHash,
        status: "invoice_paid",
        fiber_status: "Paid",
        get_invoice_method: "get_invoice",
        amount: "0x5dc",
        currency: "Fibt",
        invoice: "fibt1worker",
        raw_result: { status: "Paid" }
      };
    }
  };

  await withServer(
    async (baseUrl) => {
      const created = await postJson(`${baseUrl}/demo/offers`, {
        amount_min: "1000",
        amount_max: "2000"
      });
      const invoice = await postJson(`${baseUrl}/offers/${created.body.offer_id}/invoice`, {
        amount: "1500",
        asset: { asset_type: "ckb", symbol: "CKB" }
      });
      const startedAt = Date.now();
      let resolution;
      do {
        resolution = await getJson(
          `${baseUrl}/offers/${created.body.offer_id}/resolutions/${invoice.body.resolution_id}`
        );
        if (resolution.body.status === "invoice_paid") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      } while (Date.now() - startedAt < 1000);
      const events = await getJson(`${baseUrl}/offers/${created.body.offer_id}/webhook-events`);

      assert.equal(resolution.body.status, "invoice_paid");
      assert.ok(Date.now() - startedAt < 5000);
      assert.deepEqual(
        events.body.events.map((event) => event.type),
        ["invoice.created", "invoice.paid"]
      );
    },
    {
      invoiceAdapter,
      publicOrigin: "http://resolver.worker.test",
      workers: {
        enabled: true,
        runOnStart: false,
        settlementSyncIntervalMs: 20,
        webhookDeliveryIntervalMs: 0
      }
    }
  );
});

test("background worker skips historical mock invoices in live mode", async () => {
  let syncCalls = 0;
  const invoiceAdapter = {
    mode: "fiber-rpc",
    async probe() {
      return { mode: "fiber-rpc", configured: true, reachable: true, status: "ok" };
    },
    async createInvoice() {
      return {
        mode: "mock",
        invoice: "fibermock_historical",
        payment_hash: "0x" + "d".repeat(64),
        mocked: true
      };
    },
    async syncInvoice() {
      syncCalls += 1;
      throw new Error("historical mock invoice must not reach Fiber RPC");
    }
  };

  await withServer(
    async (baseUrl, server) => {
      const created = await postJson(`${baseUrl}/demo/offers`, {
        amount_min: "1000",
        amount_max: "2000"
      });
      await postJson(`${baseUrl}/offers/${created.body.offer_id}/invoice`, {
        amount: "1500",
        asset: { asset_type: "ckb", symbol: "CKB" }
      });

      const pass = await server.backgroundWorkers.runSettlementSyncPass();

      assert.equal(pass.failed, 0);
      assert.equal(pass.skipped, 1);
      assert.equal(pass.results[0].results[0].reason, "invoice_source_mismatch");
      assert.equal(syncCalls, 0);
    },
    { invoiceAdapter }
  );
});

test("batch sync skips terminal and missing-hash resolutions", async () => {
  let syncCalls = 0;
  const invoiceAdapter = {
    mode: "fiber-rpc",
    async probe() {
      return { mode: "fiber-rpc", configured: true, reachable: true, status: "ok" };
    },
    async createInvoice() {
      return {
        mode: "fiber-rpc",
        invoice: `fibt_${syncCalls}`,
        payment_hash: `0x${String(syncCalls).padStart(64, "b")}`,
        mocked: false
      };
    },
    async syncInvoice(paymentHash) {
      syncCalls += 1;
      return {
        mode: "fiber-rpc",
        payment_hash: paymentHash,
        status: "invoice_received",
        fiber_status: "Received",
        get_invoice_method: "get_invoice"
      };
    }
  };

  await withServer(
    async (baseUrl) => {
      const created = await postJson(`${baseUrl}/demo/offers`, {
        amount_min: "1000",
        amount_max: "3000"
      });
      const first = await postJson(`${baseUrl}/offers/${created.body.offer_id}/invoice`, {
        amount: "1500",
        asset: { asset_type: "ckb", symbol: "CKB" }
      });
      const second = await postJson(`${baseUrl}/offers/${created.body.offer_id}/invoice`, {
        amount: "1600",
        asset: { asset_type: "ckb", symbol: "CKB" }
      });
      await postJson(`${baseUrl}/offers/${created.body.offer_id}/resolutions/${second.body.resolution_id}/status`, {
        status: "invoice_cancelled"
      });

      const synced = await postJson(`${baseUrl}/offers/${created.body.offer_id}/resolutions/sync`, {});

      assert.equal(synced.status, 200);
      assert.equal(synced.body.checked, 2);
      assert.equal(synced.body.changed, 1);
      assert.equal(synced.body.skipped, 1);
      assert.equal(synced.body.results[0].resolution_id, first.body.resolution_id);
      assert.equal(synced.body.results[0].next_status, "invoice_received");
      assert.equal(synced.body.results[1].reason, "terminal_status");
    },
    { invoiceAdapter }
  );
});

test("exports reconciliation reports and receipts", async () => {
  await withServer(async (baseUrl) => {
    const created = await postJson(`${baseUrl}/demo/offers`, {
      username: "books",
      amount_min: "1000",
      amount_max: "3000"
    });
    const invoice = await postJson(`${baseUrl}/offers/${created.body.offer_id}/invoice`, {
      amount: "2500",
      asset: { asset_type: "ckb", symbol: "CKB" }
    });
    await postJson(`${baseUrl}/offers/${created.body.offer_id}/resolutions/${invoice.body.resolution_id}/status`, {
      status: "invoice_paid",
      source: "test",
      settlement_reference: "settlement-2500"
    });

    const report = await getJson(`${baseUrl}/offers/${created.body.offer_id}/reconciliation.json`);
    const csv = await getText(`${baseUrl}/offers/${created.body.offer_id}/reconciliation.csv`);
    const receipt = await getJson(
      `${baseUrl}/offers/${created.body.offer_id}/resolutions/${invoice.body.resolution_id}/receipt.json`
    );

    assert.equal(report.status, 200);
    assert.equal(report.body.totals.resolution_count, 1);
    assert.equal(report.body.totals.by_status.invoice_paid, 1);
    assert.equal(report.body.rows[0].settlement_reference, "settlement-2500");
    assert.equal(csv.status, 200);
    assert.equal(csv.contentType, "text/csv; charset=utf-8");
    assert.match(csv.body, /invoice_paid/);
    assert.match(csv.body, /settlement-2500/);
    assert.equal(receipt.status, 200);
    assert.equal(receipt.body.payment.status, "invoice_paid");
    assert.equal(receipt.body.payment.settlement.settlement_reference, "settlement-2500");
  });
});

test("records webhook subscriptions and lifecycle outbox events", async () => {
  await withServer(async (baseUrl) => {
    const created = await postJson(`${baseUrl}/demo/offers`, {
      username: "hooks",
      amount_min: "1000",
      amount_max: "3000"
    });
    const webhook = await postJson(`${baseUrl}/offers/${created.body.offer_id}/webhooks`, {
      url: "https://merchant.example/hooks/fiber",
      events: ["invoice.created", "invoice.paid"]
    });
    const invoice = await postJson(`${baseUrl}/offers/${created.body.offer_id}/invoice`, {
      amount: "1500",
      asset: { asset_type: "ckb", symbol: "CKB" }
    });
    await postJson(`${baseUrl}/offers/${created.body.offer_id}/resolutions/${invoice.body.resolution_id}/status`, {
      status: "invoice_paid",
      source: "test"
    });
    const webhooks = await getJson(`${baseUrl}/offers/${created.body.offer_id}/webhooks`);
    const events = await getJson(`${baseUrl}/offers/${created.body.offer_id}/webhook-events`);

    assert.equal(webhook.status, 201);
    assert.match(webhook.body.id, /^wh_/);
    assert.equal(invoice.body.webhook_delivery_count, 1);
    assert.equal(webhooks.body.webhooks.length, 1);
    assert.deepEqual(
      events.body.events.map((event) => event.type),
      ["invoice.created", "invoice.paid"]
    );
    assert.equal(events.body.events[0].deliveries[0].status, "pending");
    assert.equal(events.body.events[0].payload.resolution.status, "invoice_created");
    assert.equal(events.body.events[1].payload.resolution.status, "invoice_paid");
  });
});

test("manages webhook lifecycle, signing secrets, and test deliveries", async () => {
  await withWebhookReceiver(async (receiver) => {
    await withServer(async (baseUrl) => {
      const created = await postJson(`${baseUrl}/demo/offers`, { amount_min: "1000", amount_max: "3000" });
      const webhook = await postJson(`${baseUrl}/offers/${created.body.offer_id}/webhooks`, {
        url: receiver.url,
        events: ["invoice.created", "invoice.paid"]
      });

      assert.equal(webhook.status, 201);
      assert.match(webhook.body.signing_secret, /^whsec_/);
      assert.match(webhook.body.secret_hint, /^whsec_/);

      const listed = await getJson(`${baseUrl}/offers/${created.body.offer_id}/webhooks`);
      assert.equal(listed.body.webhooks.length, 1);
      assert.equal(listed.body.webhooks[0].signing_secret, undefined);

      const paused = await patchJson(`${baseUrl}/offers/${created.body.offer_id}/webhooks/${webhook.body.id}`, {
        disabled: true
      });
      const rejectedTest = await postJson(
        `${baseUrl}/offers/${created.body.offer_id}/webhooks/${webhook.body.id}/test`,
        {}
      );
      assert.equal(paused.body.disabled, true);
      assert.equal(rejectedTest.status, 409);
      assert.equal(rejectedTest.body.error.code, "WEBHOOK_DISABLED");

      await patchJson(`${baseUrl}/offers/${created.body.offer_id}/webhooks/${webhook.body.id}`, { disabled: false });
      const rotated = await postJson(
        `${baseUrl}/offers/${created.body.offer_id}/webhooks/${webhook.body.id}/rotate-secret`,
        {}
      );
      assert.match(rotated.body.signing_secret, /^whsec_/);
      assert.notEqual(rotated.body.signing_secret, webhook.body.signing_secret);

      const delivered = await postJson(`${baseUrl}/offers/${created.body.offer_id}/webhooks/${webhook.body.id}/test`, {});
      assert.equal(delivered.status, 200);
      assert.equal(delivered.body.delivered, 1);
      assert.equal(receiver.requests.length, 1);
      assert.equal(receiver.requests[0].headers["x-fiber-offers-event-type"], "webhook.test");
      assert.equal(
        receiver.requests[0].headers["x-fiber-offers-signature"],
        signWebhookPayload(
          rotated.body.signing_secret,
          receiver.requests[0].headers["x-fiber-offers-timestamp"],
          receiver.requests[0].body
        )
      );

      const deleted = await deleteJson(`${baseUrl}/offers/${created.body.offer_id}/webhooks/${webhook.body.id}`);
      const afterDelete = await getJson(`${baseUrl}/offers/${created.body.offer_id}/webhooks`);
      assert.equal(deleted.body.deleted, true);
      assert.equal(afterDelete.body.webhooks.length, 0);
    });
  });
});

test("delivers webhook outbox events with signed HTTP posts", async () => {
  await withWebhookReceiver(async (receiver) => {
    await withServer(async (baseUrl) => {
      const created = await postJson(`${baseUrl}/demo/offers`, {
        username: "delivery",
        amount_min: "1000",
        amount_max: "3000"
      });
      await postJson(`${baseUrl}/offers/${created.body.offer_id}/webhooks`, {
        url: receiver.url,
        events: ["invoice.created"],
        secret: "test-secret"
      });
      const invoice = await postJson(`${baseUrl}/offers/${created.body.offer_id}/invoice`, {
        amount: "1500",
        asset: { asset_type: "ckb", symbol: "CKB" }
      });
      const delivery = await postJson(`${baseUrl}/offers/${created.body.offer_id}/webhook-events/deliver`, {});
      const events = await getJson(`${baseUrl}/offers/${created.body.offer_id}/webhook-events`);

      assert.equal(invoice.body.webhook_delivery_count, 1);
      assert.equal(delivery.status, 200);
      assert.equal(delivery.body.attempted, 1);
      assert.equal(delivery.body.delivered, 1);
      assert.equal(receiver.requests.length, 1);
      assert.equal(receiver.requests[0].headers["x-fiber-offers-event-type"], "invoice.created");
      assert.equal(
        receiver.requests[0].headers["x-fiber-offers-signature"],
        signWebhookPayload("test-secret", receiver.requests[0].headers["x-fiber-offers-timestamp"], receiver.requests[0].body)
      );
      assert.equal(JSON.parse(receiver.requests[0].body).payload.resolution.id, invoice.body.resolution_id);
      assert.equal(events.body.events[0].deliveries[0].status, "delivered");
      assert.equal(events.body.events[0].deliveries[0].attempts, 1);
    });
  });
});

test("fails a webhook delivery after the configured timeout", async () => {
  const result = await deliverWebhookEvent(
    {
      id: "evt_timeout",
      offer_id: "0x" + "b".repeat(64),
      type: "invoice.created",
      created_at: new Date().toISOString(),
      payload: { resolution: { id: "res_timeout" } }
    },
    {
      secret: "timeout-secret"
    },
    {
      webhook_id: "wh_timeout",
      url: "https://merchant.example/hooks/fiber"
    },
    {
      timeoutMs: 10,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener(
            "abort",
            () => {
              const error = new Error("request aborted");
              error.name = "AbortError";
              reject(error);
            },
            { once: true }
          );
        })
    }
  );

  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "WEBHOOK_DELIVERY_TIMEOUT");
  assert.match(result.error.message, /timed out after 10ms/);
});

test("background worker delivers pending webhook events", async () => {
  await withWebhookReceiver(async (receiver) => {
    await withServer(async (baseUrl, server) => {
      const created = await postJson(`${baseUrl}/demo/offers`, {
        username: "worker-delivery",
        amount_min: "1000",
        amount_max: "3000"
      });
      await postJson(`${baseUrl}/offers/${created.body.offer_id}/webhooks`, {
        url: receiver.url,
        events: ["invoice.created"],
        secret: "worker-secret"
      });
      await postJson(`${baseUrl}/offers/${created.body.offer_id}/invoice`, {
        amount: "1500",
        asset: { asset_type: "ckb", symbol: "CKB" }
      });

      const pass = await server.backgroundWorkers.runWebhookDeliveryPass();
      const events = await getJson(`${baseUrl}/offers/${created.body.offer_id}/webhook-events`);

      assert.equal(pass.offers, 1);
      assert.equal(pass.attempted, 1);
      assert.equal(pass.delivered, 1);
      assert.equal(receiver.requests.length, 1);
      assert.equal(receiver.requests[0].headers["x-fiber-offers-event-type"], "invoice.created");
      assert.equal(events.body.events[0].deliveries[0].status, "delivered");
      assert.equal(events.body.events[0].deliveries[0].attempts, 1);
    });
  });
});

test("rejects invalid terminal status transitions", async () => {
  await withServer(async (baseUrl) => {
    const created = await postJson(`${baseUrl}/demo/offers`);
    const invoice = await postJson(`${baseUrl}/offers/${created.body.offer_id}/invoice`, {
      amount: "1000",
      asset: { asset_type: "ckb", symbol: "CKB" }
    });
    await postJson(`${baseUrl}/offers/${created.body.offer_id}/resolutions/${invoice.body.resolution_id}/status`, {
      status: "invoice_paid"
    });
    const rejected = await postJson(
      `${baseUrl}/offers/${created.body.offer_id}/resolutions/${invoice.body.resolution_id}/status`,
      {
        status: "invoice_failed"
      }
    );

    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.error.code, "INVALID_STATUS_TRANSITION");
  });
});

test("a resolution's status only moves forward, and repeating it announces nothing", async () => {
  await withServer(async (baseUrl) => {
    const created = await postJson(`${baseUrl}/demo/offers`);
    const invoice = await postJson(`${baseUrl}/offers/${created.body.offer_id}/invoice`, {
      amount: "1000",
      asset: { asset_type: "ckb", symbol: "CKB" }
    });
    const statusUrl = `${baseUrl}/offers/${created.body.offer_id}/resolutions/${invoice.body.resolution_id}/status`;
    const set = (status) => postJson(statusUrl, { status });
    const eventTypes = async () =>
      (await getJson(`${baseUrl}/offers/${created.body.offer_id}/webhook-events`)).body.events.map((event) => event.type);

    const received = await set("invoice_received");
    const backwards = await set("invoice_created");
    const repeated = await set("invoice_received");
    const paid = await set("invoice_paid");
    const afterPaid = await set("invoice_expired");

    assert.equal(received.status, 200);
    assert.equal(backwards.status, 409);
    assert.equal(backwards.body.error.code, "INVALID_STATUS_TRANSITION");
    assert.deepEqual(backwards.body.error.details, { current_status: "invoice_received", next_status: "invoice_created" });
    assert.equal(repeated.status, 200);
    assert.equal(paid.body.status, "invoice_paid");
    assert.equal(afterPaid.status, 409);
    // One event per real change: created, received, paid.
    assert.deepEqual(await eventTypes(), ["invoice.created", "invoice.received", "invoice.paid"]);
    assert.deepEqual(
      paid.body.status_history.map((entry) => entry.status),
      ["invoice_pending", "invoice_created", "invoice_received", "invoice_paid"]
    );
  });
});

test("racing status syncs record one transition and emit one event", async () => {
  const nodeId = "02" + "7".repeat(64);
  const invoiceAdapter = new FiberRpcInvoiceAdapter({
    client: {
      async call(method) {
        if (method === "node_info") return { pubkey: nodeId };
        if (method === "new_invoice") {
          return { invoice_address: "fibt1race", invoice: { data: { payment_hash: "0x" + "5".repeat(64) } } };
        }
        // Let both syncs read the same starting status before either writes.
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { invoice_address: "fibt1race", invoice: { amount: "0x3e8", currency: "Fibt" }, status: "Paid" };
      }
    }
  });

  await withServer(async (baseUrl) => {
    const created = await postJson(`${baseUrl}/demo/offers`, { amount: "1000" });
    const invoice = await postJson(`${baseUrl}/offers/${created.body.offer_id}/invoice`, {
      amount: "1000",
      asset: { asset_type: "ckb", symbol: "CKB" }
    });
    const syncUrl = `${baseUrl}/offers/${created.body.offer_id}/resolutions/${invoice.body.resolution_id}/sync`;

    const results = await Promise.all([postJson(syncUrl, {}), postJson(syncUrl, {}), postJson(syncUrl, {})]);
    const events = await getJson(`${baseUrl}/offers/${created.body.offer_id}/webhook-events`);

    assert.deepEqual(results.map((result) => result.status), [200, 200, 200]);
    assert.equal(results.filter((result) => result.body.changed).length, 1);
    assert.equal(results.every((result) => result.body.resolution.status === "invoice_paid"), true);
    assert.equal(events.body.events.filter((event) => event.type === "invoice.paid").length, 1);
  }, { invoiceAdapter });
});

test("a lapsed invoice is recorded as expired once and announced once", async () => {
  // Issue the invoice as if an hour ago, so its lifetime has already run out.
  const invoiceAdapter = new MockInvoiceAdapter({ invoiceTtlSeconds: 60, now: () => Date.now() - 3600_000 });
  await withServer(async (baseUrl, server) => {
    const created = await postJson(`${baseUrl}/demo/offers`, { amount: "1000" });
    const invoice = await postJson(`${baseUrl}/offers/${created.body.offer_id}/invoice`, {
      amount: "1000",
      asset: { asset_type: "ckb", symbol: "CKB" }
    });
    const stored = async () => (await server.store.getResolution(created.body.offer_id, invoice.body.resolution_id)).status;
    const expiredEvents = async () =>
      (await getJson(`${baseUrl}/offers/${created.body.offer_id}/webhook-events`)).body.events.filter(
        (event) => event.type === "invoice.expired"
      );

    assert.equal(await stored(), "invoice_created");
    const firstPass = await server.backgroundWorkers.runSettlementSyncPass();
    const secondPass = await server.backgroundWorkers.runSettlementSyncPass();

    assert.equal(firstPass.expired, 1);
    assert.equal(secondPass.expired, 0);
    assert.equal(await stored(), "invoice_expired");
    const events = await expiredEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0].payload.resolution.expired_at, invoice.body.expires_at);
  }, { invoiceAdapter });
});

test("rejects invoice requests outside offer bounds", async () => {
  await withServer(async (baseUrl) => {
    const created = await postJson(`${baseUrl}/demo/offers`, {
      amount_min: "1000",
      amount_max: "2000"
    });
    const rejected = await postJson(`${baseUrl}/offers/${created.body.offer_id}/invoice`, {
      amount: "2500",
      asset: { asset_type: "ckb", symbol: "CKB" }
    });

    assert.equal(rejected.status, 422);
    assert.equal(rejected.body.error.code, "AMOUNT_TOO_HIGH");
  });
});

test("binds live offers to the configured Fiber node identity", async () => {
  const configuredNodeId = "02" + "c".repeat(64);
  await withServer(async (baseUrl) => {
    const keys = generateOfferKeyPair();
    const offer = createSignedOffer(
      {
        node_id: "03" + "d".repeat(64),
        public_key: keys.publicKeyPem,
        resolver_url: baseUrl,
        assets: [{ asset_type: "ckb", symbol: "CKB" }]
      },
      keys.privateKeyPem
    );
    const rejected = await postJson(`${baseUrl}/offers`, { encoded_offer: encodeOffer(offer) });
    assert.equal(rejected.status, 403);
    assert.equal(rejected.body.error.code, "OFFER_NODE_MISMATCH");

    const created = await postJson(`${baseUrl}/demo/offers`, { amount: "1000" });
    assert.equal(created.body.offer.node_id, configuredNodeId);
    assert.equal(created.body.ownership.status, "verified");
  }, { invoiceAdapter: new MockInvoiceAdapter({ nodeId: configuredNodeId }), enforceNodeOwnership: true });
});

test("revokes an offer with its signed lifecycle key", async () => {
  await withServer(async (baseUrl) => {
    const created = await postJson(`${baseUrl}/demo/offers`, { amount: "1000" });
    const revocation = createOfferRevocation(created.body.offer, created.body.offer_private_key_pem);
    const revoked = await deleteJsonBody(`${baseUrl}/offers/${created.body.offer_id}`, { revocation });
    const invoice = await postJson(`${baseUrl}/offers/${created.body.offer_id}/invoice`, {
      amount: "1000",
      asset: { asset_type: "ckb", symbol: "CKB" }
    });
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body.revoked, true);
    assert.equal(invoice.status, 410);
    assert.equal(invoice.body.error.code, "OFFER_REVOKED");
  });
});

test("each subscriber to a recurring offer has their own cycles and caps", async () => {
  await withServer(async (baseUrl) => {
    const created = await postJson(`${baseUrl}/demo/offers`, {
      amount: "1000",
      recurrence: { interval: "custom_seconds", custom_seconds: 1, amount: "1000", cap_cycles: 2 }
    });
    const offer = created.body.offer;
    const offerUrl = `${baseUrl}/offers/${offer.offer_id}`;
    const asset = { asset_type: "ckb", symbol: "CKB" };
    const alice = generateOfferKeyPair();
    const bob = generateOfferKeyPair();
    const cycle = (subscriber, number) =>
      postJson(`${offerUrl}/invoice`, signRecurrenceRequest(offer, { amount: "1000", asset, recurrence_cycle: number }, subscriber.privateKeyPem));
    const pay = (invoice) => postJson(`${offerUrl}/resolutions/${invoice.body.resolution_id}/status`, { status: "invoice_paid" });
    const statusOf = async (subscriber) =>
      (await getJson(`${offerUrl}/recurrence-status?approval_id=${subscriptionId(subscriber.publicKeyPem)}`)).body;

    // Both start at cycle 1. One payer's cycle does not move the other's.
    const aliceOne = await cycle(alice, 1);
    const bobOne = await cycle(bob, 1);
    assert.deepEqual([aliceOne.status, bobOne.status], [201, 201]);
    assert.equal(aliceOne.body.recurrence.approval_id, subscriptionId(alice.publicKeyPem));

    // Alice cannot skip ahead, or request cycle 1 twice, while it is unpaid.
    const skipped = await cycle(alice, 2);
    const repeated = await cycle(alice, 1);
    assert.deepEqual([skipped.status, skipped.body.error.code], [409, "INVALID_RECURRENCE_CYCLE"]);
    assert.equal(skipped.body.error.details.next_cycle, 1);
    assert.deepEqual([repeated.status, repeated.body.error.code], [409, "RECURRENCE_CYCLE_OUTSTANDING"]);

    // Payment is what advances a subscription.
    await pay(aliceOne);
    const aliceTwo = await cycle(alice, 2);
    await pay(aliceTwo);
    // Both cycles are paid. A wallet cannot even sign a third: the signed terms
    // rule it out before anything is sent. And the resolver refuses another
    // request for a cycle within the cap, because the subscription is spent.
    assert.throws(() => cycle(alice, 3), (error) => error.code === "RECURRENCE_CYCLE_CAP_REACHED");
    const capped = await cycle(alice, 2);
    assert.equal(aliceTwo.status, 201);
    assert.deepEqual([capped.status, capped.body.error.code], [409, "RECURRENCE_CYCLE_CAP_REACHED"]);

    // Bob is untouched by Alice reaching her cap.
    const aliceStatus = await statusOf(alice);
    const bobStatus = await statusOf(bob);
    assert.deepEqual(
      [aliceStatus.cycles_paid, aliceStatus.cap_reached, aliceStatus.cycle_cap_remaining, aliceStatus.next_cycle],
      [2, true, 0, undefined]
    );
    assert.deepEqual([bobStatus.cycles_paid, bobStatus.next_cycle, bobStatus.outstanding.cycle], [0, 1, 1]);
    const summary = (await getJson(`${offerUrl}/recurrence-status`)).body;
    assert.deepEqual([summary.subscriptions, summary.cycles_created, summary.cycles_paid], [2, 3, 2]);
  });
});

test("a recurring cycle request must be signed by its subscription's key", async () => {
  await withServer(async (baseUrl) => {
    const created = await postJson(`${baseUrl}/demo/offers`, {
      amount: "1000",
      recurrence: { interval: "daily", amount: "1000", cap_cycles: 5 }
    });
    const offer = created.body.offer;
    const invoiceUrl = `${baseUrl}/offers/${offer.offer_id}/invoice`;
    const asset = { asset_type: "ckb", symbol: "CKB" };
    const alice = generateOfferKeyPair();
    const mallory = generateOfferKeyPair();
    const aliceRequest = signRecurrenceRequest(offer, { amount: "1000", asset, recurrence_cycle: 1 }, alice.privateKeyPem);
    const malloryRequest = signRecurrenceRequest(offer, { amount: "1000", asset, recurrence_cycle: 1 }, mallory.privateKeyPem);
    const codeOf = async (body) => {
      const result = await postJson(invoiceUrl, body);
      return [result.status, result.body.error?.code];
    };

    // No proof at all, as a pre-subscription client would send.
    assert.deepEqual(await codeOf({ amount: "1000", asset, recurrence_cycle: 1 }), [400, "SUBSCRIPTION_PROOF_REQUIRED"]);
    // Mallory names Alice's subscription with her own key and signature.
    assert.deepEqual(
      await codeOf({ ...malloryRequest, approval_id: aliceRequest.approval_id }),
      [403, "SUBSCRIPTION_KEY_MISMATCH"]
    );
    // Mallory replays Alice's signature on a different cycle.
    assert.deepEqual(await codeOf({ ...aliceRequest, recurrence_cycle: 2 }), [403, "INVALID_SUBSCRIPTION_SIGNATURE"]);
    // None of that created an invoice, so none of it used anything of Alice's.
    const resolutions = await getJson(`${baseUrl}/offers/${offer.offer_id}/resolutions`);
    assert.equal(resolutions.body.resolutions.length, 0);
    assert.deepEqual(await codeOf(aliceRequest), [201, undefined]);

    const readiness = await postJson(`${baseUrl}/offers/${offer.offer_id}/check`, { amount: "1000", asset, recurrence_cycle: 1 });
    assert.equal(readiness.body.ready, false);
    assert.equal(readiness.body.checks.find((item) => item.id === "subscription").code, "SUBSCRIPTION_PROOF_REQUIRED");
  });
});

test("an unpaid recurring cycle is released when its invoice lapses", async () => {
  let clock = () => Date.now();
  const invoiceAdapter = new MockInvoiceAdapter({ invoiceTtlSeconds: 60, now: () => clock() });
  await withServer(async (baseUrl) => {
    const created = await postJson(`${baseUrl}/demo/offers`, {
      amount: "1000",
      recurrence: { interval: "daily", amount: "1000", cap_cycles: 1 }
    });
    const offer = created.body.offer;
    const subscriber = generateOfferKeyPair();
    const request = signRecurrenceRequest(
      offer,
      { amount: "1000", asset: { asset_type: "ckb", symbol: "CKB" }, recurrence_cycle: 1 },
      subscriber.privateKeyPem
    );
    const invoiceUrl = `${baseUrl}/offers/${offer.offer_id}/invoice`;

    // The first invoice for cycle 1 is never paid and runs out.
    clock = () => Date.now() - 3600_000;
    const lapsed = await postJson(invoiceUrl, request, { "idempotency-key": "sub:1" });
    clock = () => Date.now();
    // Cycle 1 again under a new key: the cap of one cycle was not spent.
    const fresh = await postJson(invoiceUrl, request, { "idempotency-key": "sub:1:1" });

    assert.deepEqual([lapsed.status, fresh.status], [201, 201]);
    assert.equal(fresh.body.recurrence.cycle, 1);
    assert.notEqual(fresh.body.invoice, lapsed.body.invoice);
  }, { invoiceAdapter });
});

test("rejects Fiber Address username collisions", async () => {
  await withServer(async (baseUrl) => {
    await postJson(`${baseUrl}/demo/offers`, { username: "claimed", amount: "1000" });
    const collision = await postJson(`${baseUrl}/demo/offers`, { username: "claimed", amount: "2000" });
    assert.equal(collision.status, 409);
    assert.equal(collision.body.error.code, "USERNAME_ALREADY_CLAIMED");
  });
});

test("returns a stable unavailable-recipient error when invoice RPC fails", async () => {
  const invoiceAdapter = new MockInvoiceAdapter();
  invoiceAdapter.createInvoice = async () => {
    const error = new Error("connect refused");
    error.code = "ECONNREFUSED";
    throw error;
  };
  await withServer(async (baseUrl) => {
    const created = await postJson(`${baseUrl}/demo/offers`, { amount: "1000" });
    const result = await postJson(`${baseUrl}/offers/${created.body.offer_id}/invoice`, {
      amount: "1000",
      asset: { asset_type: "ckb", symbol: "CKB" }
    });
    assert.equal(result.status, 503);
    assert.equal(result.body.error.code, "RECIPIENT_UNAVAILABLE");
    assert.match(result.body.error.message, /temporarily unavailable/);
  }, { invoiceAdapter });
});

test("tells payers whether an invoice failure is worth retrying", async () => {
  const nodeId = "02" + "a".repeat(64);
  let newInvoice;
  const invoiceAdapter = new FiberRpcInvoiceAdapter({
    url: "http://fiber.test",
    timeoutMs: 1000,
    fetchImpl: async (_url, init) => {
      const { method } = JSON.parse(init.body);
      return method === "node_info" ? rpcResult({ pubkey: nodeId }) : newInvoice();
    }
  });

  await withServer(async (baseUrl) => {
    const created = await postJson(`${baseUrl}/demo/offers`, { amount: "1000" });
    const invoiceUrl = `${baseUrl}/offers/${created.body.offer_id}/invoice`;
    const request = { amount: "1000", asset: { asset_type: "ckb", symbol: "CKB" } };

    newInvoice = async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    };
    const unreachable = await postJson(invoiceUrl, request);

    newInvoice = async () => rpcFailure(-32602, "Invalid params: unknown currency");
    const rejected = await postJson(invoiceUrl, request);

    newInvoice = async () => new Response("Unauthorized", { status: 401 });
    const unauthorized = await postJson(invoiceUrl, request);

    newInvoice = async () => new Response("<html>Bad Gateway</html>", { status: 502 });
    const proxyDown = await postJson(invoiceUrl, request);

    newInvoice = async () => rpcResult({ unexpected: "shape" });
    const unusable = await postJson(invoiceUrl, request);

    const resolutions = await getJson(`${baseUrl}/offers/${created.body.offer_id}/resolutions`);

    assert.equal(unreachable.status, 503);
    assert.equal(unreachable.body.error.code, "RECIPIENT_UNAVAILABLE");
    assert.equal(unreachable.body.error.details.retryable, true);
    assert.equal(unreachable.body.error.details.cause_code, "FIBER_RPC_UNREACHABLE");

    assert.equal(rejected.status, 502);
    assert.equal(rejected.body.error.code, "FIBER_INVOICE_REJECTED");
    assert.equal(rejected.body.error.details.retryable, false);
    assert.equal(rejected.body.error.details.cause_code, -32602);
    // The node's own message stays in the server log, not the public response.
    assert.doesNotMatch(JSON.stringify(rejected.body), /unknown currency/);

    assert.equal(unauthorized.status, 502);
    assert.equal(unauthorized.body.error.code, "FIBER_RPC_UNAUTHORIZED");
    assert.equal(unauthorized.body.error.details.retryable, false);

    assert.equal(proxyDown.status, 503);
    assert.equal(proxyDown.body.error.code, "RECIPIENT_UNAVAILABLE");
    assert.equal(proxyDown.body.error.details.retryable, true);

    assert.equal(unusable.status, 502);
    assert.equal(unusable.body.error.code, "FIBER_RPC_INVALID_RESPONSE");
    assert.equal(unusable.body.error.details.retryable, false);

    assert.equal(resolutions.body.resolutions.length, 0);
  }, { invoiceAdapter });
});

test("a hung Fiber node times out instead of holding the offer's invoice lock", async () => {
  const nodeId = "02" + "b".repeat(64);
  let hang = true;
  const invoiceAdapter = new FiberRpcInvoiceAdapter({
    url: "http://fiber.test",
    timeoutMs: 40,
    fetchImpl: async (_url, init) => {
      const { method } = JSON.parse(init.body);
      if (method === "node_info") return rpcResult({ pubkey: nodeId });
      if (hang) return new Promise(() => {});
      return rpcResult({ invoice_address: "fibt1afterhang", invoice: { data: { payment_hash: "0x" + "3".repeat(64) } } });
    }
  });

  await withServer(async (baseUrl) => {
    const created = await postJson(`${baseUrl}/demo/offers`, { amount: "1000" });
    const invoiceUrl = `${baseUrl}/offers/${created.body.offer_id}/invoice`;
    const request = { amount: "1000", asset: { asset_type: "ckb", symbol: "CKB" } };

    const timedOut = await postJson(invoiceUrl, request);
    hang = false;
    const recovered = await postJson(invoiceUrl, request);

    assert.equal(timedOut.status, 503);
    assert.equal(timedOut.body.error.code, "RECIPIENT_UNAVAILABLE");
    assert.equal(timedOut.body.error.details.cause_code, "FIBER_RPC_TIMEOUT");
    assert.equal(recovered.status, 201);
    assert.equal(recovered.body.invoice, "fibt1afterhang");
  }, { invoiceAdapter });
});

test("encrypts webhook signing secrets in JSON persistence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fiber-offers-store-"));
  try {
    const path = join(directory, "offers.json");
    const store = new JsonOfferStore(path, { encryptionKey: "test-encryption-key" });
    const keys = generateOfferKeyPair();
    const offer = createSignedOffer(
      {
        node_id: "02" + "e".repeat(64),
        public_key: keys.publicKeyPem,
        resolver_url: "https://resolver.example",
        assets: [{ asset_type: "ckb", symbol: "CKB" }]
      },
      keys.privateKeyPem
    );
    await store.upsertOffer(offer, encodeOffer(offer));
    await store.addWebhook(offer.offer_id, {
      url: "https://merchant.example/hook",
      events: ["invoice.paid"],
      secret: "whsec_plaintext-must-not-persist"
    });
    const raw = await readFile(path, "utf8");
    assert.doesNotMatch(raw, /plaintext-must-not-persist/);
    assert.match(raw, /enc:v1:/);

    const reloaded = new JsonOfferStore(path, { encryptionKey: "test-encryption-key" });
    assert.equal((await reloaded.listWebhooks(offer.offer_id))[0].secret, "whsec_plaintext-must-not-persist");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("blocks private webhook targets when production policy is enabled", async () => {
  await withServer(async (baseUrl) => {
    const created = await postJson(`${baseUrl}/demo/offers`, { amount: "1000" });
    const webhook = await postJson(`${baseUrl}/offers/${created.body.offer_id}/webhooks`, {
      url: "http://127.0.0.1:9999/internal",
      events: ["invoice.paid"]
    });
    assert.equal(webhook.status, 400);
    assert.equal(webhook.body.error.code, "INVALID_WEBHOOK_URL");
  }, { allowPrivateWebhookTargets: false });
});

test("rate limits repeated public invoice creation", async () => {
  await withServer(async (baseUrl) => {
    const created = await postJson(`${baseUrl}/demo/offers`, { amount: "1000" });
    const request = { amount: "1000", asset: { asset_type: "ckb", symbol: "CKB" } };
    const first = await postJson(`${baseUrl}/offers/${created.body.offer_id}/invoice`, request);
    const blocked = await postJson(`${baseUrl}/offers/${created.body.offer_id}/invoice`, request);
    assert.equal(first.status, 201);
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error.code, "RATE_LIMITED");
  }, { rateLimitMax: 1 });
});

test("forwarding headers a client sends do not move the rate limit or the links", async () => {
  await withServer(async (baseUrl) => {
    const created = await postJson(`${baseUrl}/demo/offers`, { amount: "1000" });
    const checkUrl = `${baseUrl}/offers/${created.body.offer_id}/check`;
    const request = { amount: "1000", asset: { asset_type: "ckb", symbol: "CKB" } };

    const statuses = [];
    for (let index = 0; index < 6; index += 1) {
      const result = await postJson(checkUrl, request, { "x-forwarded-for": `198.51.100.${index}` });
      statuses.push(result.status);
    }
    const spoofed = await fetch(`${baseUrl}/offers/${created.body.offer_id}`, {
      headers: { "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" }
    }).then((response) => response.json());

    // A different X-Forwarded-For on every request is still one client.
    assert.deepEqual(statuses, [200, 200, 200, 429, 429, 429]);
    assert.equal(spoofed.payment_link, `${baseUrl}/pay/${created.body.offer_id}`);
  }, { rateLimitMax: 3 });
});

test("a configured public URL is the only origin in responses", async () => {
  await withServer(async (baseUrl) => {
    const created = await postJson(`${baseUrl}/demo/offers`, { amount: "1000", username: "shop" });
    const fetched = await fetch(`${baseUrl}/offers/${created.body.offer_id}`, {
      headers: { "x-forwarded-host": "evil.example", host: "also-evil.example" }
    }).then((response) => response.json());

    assert.equal(created.body.offer.resolver_url, "https://offers.merchant.example");
    assert.equal(fetched.payment_link, `https://offers.merchant.example/pay/${created.body.offer_id}`);
    assert.equal(fetched.fiber_address, "shop@offers.merchant.example");
    assert.equal(fetched.lookup_url, "https://offers.merchant.example/.well-known/fiberoffer/shop");
  }, { publicOrigin: "https://offers.merchant.example/" });

  assert.throws(
    () => createServer({ store: new InMemoryOfferStore(), invoiceAdapter: new MockInvoiceAdapter(), publicOrigin: "not a url" }),
    (error) => error.code === "INVALID_PUBLIC_URL"
  );
});

test("behind a trusted proxy the client is the address that proxy saw", async () => {
  await withServer(async (baseUrl) => {
    const created = await postJson(`${baseUrl}/demo/offers`, { amount: "1000" });
    const checkUrl = `${baseUrl}/offers/${created.body.offer_id}/check`;
    const request = { amount: "1000", asset: { asset_type: "ckb", symbol: "CKB" } };
    const check = (forwardedFor) => postJson(checkUrl, request, { "x-forwarded-for": forwardedFor });

    // The proxy appends the real client last; whatever the client put before it is ignored.
    const sameClient = [];
    for (let index = 0; index < 4; index += 1) {
      sameClient.push((await check(`10.9.9.${index}, 203.0.113.7`)).status);
    }
    const otherClient = await check("10.9.9.9, 203.0.113.8");
    const forwarded = await fetch(`${baseUrl}/offers/${created.body.offer_id}`, {
      headers: { "x-forwarded-host": "shop.example", "x-forwarded-proto": "https" }
    }).then((response) => response.json());

    assert.deepEqual(sameClient, [200, 200, 429, 429]);
    assert.equal(otherClient.status, 200);
    assert.equal(forwarded.payment_link, `https://shop.example/pay/${created.body.offer_id}`);
  }, { rateLimitMax: 2, trustedProxyHops: 1 });
});

test("limits API key guesses and survives a rate limiter outage", async () => {
  await withServer(async (baseUrl) => {
    const statuses = [];
    for (let index = 0; index < 12; index += 1) {
      const attempt = await postJson(`${baseUrl}/operator/session`, { api_key: `guess-${index}` });
      statuses.push(attempt.status);
    }
    assert.deepEqual(statuses.slice(0, 10), Array(10).fill(401));
    assert.deepEqual(statuses.slice(10), [429, 429]);
  }, { apiKey: "operator-secret" });

  const brokenLimiter = {
    async take() {
      throw new Error("redis is down");
    }
  };
  const request = { amount: "1000", asset: { asset_type: "ckb", symbol: "CKB" } };
  await withServer(async (baseUrl) => {
    const created = await postJson(`${baseUrl}/demo/offers`, { amount: "1000" });
    const invoice = await postJson(`${baseUrl}/offers/${created.body.offer_id}/invoice`, request);
    assert.equal(invoice.status, 201);
  }, { rateLimiter: brokenLimiter });
  await withServer(async (baseUrl) => {
    const created = await postJson(`${baseUrl}/demo/offers`, { amount: "1000" });
    const invoice = await postJson(`${baseUrl}/offers/${created.body.offer_id}/invoice`, request);
    assert.equal(invoice.status, 503);
    assert.equal(invoice.body.error.code, "RATE_LIMITER_UNAVAILABLE");
  }, { rateLimiter: brokenLimiter, rateLimitFailOpen: false });
});

test("the in-memory rate limiter forgets expired buckets", () => {
  const limiter = createMemoryRateLimiter({ windowMs: 1000, max: 5 });
  for (let index = 0; index < 5000; index += 1) limiter.take(`scope:client-${index}`, 0);
  assert.equal(limiter.size(), 5000);
  // Once their window has passed, the next sweep drops them.
  for (let index = 0; index < 1000; index += 1) limiter.take(`scope:later-${index}`, 2000);
  assert.ok(limiter.size() <= 1000);
  // A per-call limit overrides the default.
  assert.equal(limiter.take("login:a", 5000, { max: 1 }).allowed, true);
  assert.equal(limiter.take("login:a", 5000, { max: 1 }).allowed, false);
});

function readyDirectTopology() {
  return {
    ok: true,
    status: "ready",
    summary: "A direct payer-to-merchant channel is connected and has payer outbound liquidity.",
    readiness: {
      deterministic_local_payment: true,
      direct_channel_ready: true,
      dry_run_required: true
    },
    direct_channel: {
      usable_for_payer_to_merchant: true,
      payer_local_balance_total: "5000",
      payer_local_balance_total_hex: "0x1388"
    },
    payer: {
      channels: {
        ckb: 1,
        pending_tlc_count: 0
      }
    },
    merchant: {
      channels: {
        ckb: 1,
        pending_tlc_count: 0
      }
    },
    route_candidates: {
      direct: {
        payer_local_balance_total: "5000",
        payer_local_balance_total_hex: "0x1388"
      },
      shared_counterparties: []
    },
    common_channel_counterparties: [],
    online_common_channel_counterparties: [],
    blockers: [],
    warnings: [],
    next_actions: ["Run a Fiber send_payment dry-run against a fresh invoice before sending funds."]
  };
}

function rpcResult(result) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: "test", result }), { status: 200 });
}

function rpcFailure(code, message) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: "test", error: { code, message } }), { status: 200 });
}

async function withServer(callback, options = {}) {
  const server = createServer({
    store: new InMemoryOfferStore(),
    invoiceAdapter: options.invoiceAdapter ?? new MockInvoiceAdapter(),
    apiKey: options.apiKey,
    publicOperatorAccess: options.publicOperatorAccess,
    topologyClient: options.topologyClient ?? false,
    fetchImpl: options.fetchImpl,
    workers: options.workers,
    publicOrigin: options.publicOrigin,
    enforceNodeOwnership: options.enforceNodeOwnership,
    allowPrivateWebhookTargets: options.allowPrivateWebhookTargets,
    rateLimitMax: options.rateLimitMax,
    rateLimitWindowMs: options.rateLimitWindowMs,
    rateLimiter: options.rateLimiter,
    rateLimitFailOpen: options.rateLimitFailOpen,
    trustedProxyHops: options.trustedProxyHops,
    logger: options.logger ?? { error() {} }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://${address.address}:${address.port}`;

  try {
    await callback(baseUrl, server);
  } finally {
    server.stopBackgroundWorkers?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function withWebhookReceiver(callback) {
  const requests = [];
  const server = createHttpServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    requests.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body
    });
    response.writeHead(204);
    response.end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const receiver = {
    url: `http://${address.address}:${address.port}/webhooks/fiber`,
    requests
  };

  try {
    await callback(receiver);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function getJson(url) {
  const response = await fetch(url);
  return {
    status: response.status,
    body: await response.json()
  };
}

async function getText(url) {
  const response = await fetch(url);
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    body: await response.text()
  };
}

async function postJson(url, body, headers = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
  return {
    status: response.status,
    body: await response.json()
  };
}

async function patchJson(url, body, headers = {}) {
  const response = await fetch(url, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
  return {
    status: response.status,
    body: await response.json()
  };
}

async function deleteJson(url, headers = {}) {
  const response = await fetch(url, { method: "DELETE", headers });
  return {
    status: response.status,
    body: await response.json()
  };
}

async function deleteJsonBody(url, body, headers = {}) {
  const response = await fetch(url, {
    method: "DELETE",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}
