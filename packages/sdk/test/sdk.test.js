import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FiberOffersClient,
  FiberNodeDiagnosticsClient,
  FiberPaymentFlowClient,
  FiberPaymentClient,
  FiberRecurringPaymentScheduler,
  FiberRpcClient,
  FiberTopologyClient,
  InMemoryRecurringApprovalStore,
  WebStorageRecurringApprovalStore,
  analyzeFiberTopology,
  analyzePaymentReadiness,
  createOffer,
  fiberCurrencyForNetwork,
  fiberSendPaymentParams,
  formatInvoiceDescription,
  networkForChainHash,
  networkForFiberCurrency,
  normalizeFiberPaymentFailure,
  offerQrUrl,
  parseFiberAddress,
  parseInvoiceBinding,
  planDirectChannelFixture,
  summarizeFiberChannels,
  toFiberDecimalQuantity,
  toFiberHexQuantity,
  verifyInvoiceForOffer,
  waitForFiberPayment
} from "../src/index.js";
import { JsonFileRecurringApprovalStore } from "../src/node.js";
import {
  ckbScriptHash,
  createSignedOffer,
  encodeOffer,
  generateOfferKeyPair,
  serializeCkbScript
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
  assert.equal(sdkPackage.exports["./node"].types, "./src/node.d.ts");
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

test("signs an offer for the network its Fiber node is on", async () => {
  const mainnetGenesis = "0x92b197aa1fba0f63633922c61c92375c9c074a93e85963554f5499fe1450d0e5";
  const nodeInfo = { pubkey: "02" + "a".repeat(64), chain_hash: mainnetGenesis };
  const input = {
    resolver_url: "https://resolver.example",
    assets: [{ asset_type: "ckb", symbol: "CKB" }]
  };
  const rpcClient = { call: async () => nodeInfo };

  const derived = await createOffer(input, { rpcClient });
  const matching = await createOffer({ ...input, network: "mainnet" }, { rpcClient });
  const privateChain = await createOffer(
    { ...input, network: "dev" },
    { rpcClient: { call: async () => ({ ...nodeInfo, chain_hash: "0x" + "7".repeat(64) }) } }
  );

  assert.equal(derived.offer.network, "mainnet");
  assert.deepEqual(
    [derived.node_identity.network, derived.node_identity.network_source],
    ["mainnet", "chain_hash"]
  );
  assert.equal(matching.offer.network, "mainnet");
  assert.equal(privateChain.offer.network, "dev");
  await assert.rejects(
    () => createOffer({ ...input, network: "testnet" }, { rpcClient }),
    (error) => error.code === "OFFER_NETWORK_MISMATCH" && error.details.node_network === "mainnet"
  );
});

test("maps offer networks to Fiber currencies and chain hashes", () => {
  assert.deepEqual(
    ["mainnet", "testnet", "dev"].map(fiberCurrencyForNetwork),
    ["Fibb", "Fibt", "Fibd"]
  );
  assert.throws(() => fiberCurrencyForNetwork("signet"), (error) => error.code === "UNSUPPORTED_NETWORK");
  assert.equal(networkForFiberCurrency("Fibd"), "dev");
  assert.equal(networkForFiberCurrency("0x" + "1".repeat(64)), undefined);
  assert.equal(
    networkForChainHash("10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606"),
    "testnet"
  );
  assert.equal(networkForChainHash("0x" + "7".repeat(64)), undefined);
  assert.equal(networkForChainHash(undefined), undefined);
});

test("rejects an offer the resolver tampered with or swapped", async () => {
  const keys = generateOfferKeyPair();
  const make = (description) =>
    createSignedOffer(
      {
        node_id: "03" + "b".repeat(64),
        public_key: keys.publicKeyPem,
        resolver_url: "https://resolver.example",
        description,
        assets: [{ asset_type: "ckb", symbol: "CKB" }]
      },
      keys.privateKeyPem
    );
  const offer = make("Genuine offer");
  const other = make("Another validly signed offer");
  const clientReturning = (body) =>
    new FiberOffersClient({
      resolverUrl: "https://resolver.example",
      fetchImpl: async () => new Response(JSON.stringify(body), { status: 200 })
    });
  const failureOf = async (body, call = (client) => client.getOffer(offer.offer_id)) => {
    try {
      await call(clientReturning(body));
    } catch (error) {
      return error.code;
    }
    return "accepted";
  };

  assert.equal(await failureOf({ offer_id: offer.offer_id, offer, encoded_offer: encodeOffer(offer) }), "accepted");
  // Fields changed after signing.
  assert.equal(
    await failureOf({ offer_id: offer.offer_id, offer: { ...offer, node_id: "02" + "c".repeat(64) } }),
    "OFFER_ID_MISMATCH"
  );
  // A different, validly signed offer in place of the one requested.
  assert.equal(await failureOf({ offer_id: other.offer_id, offer: other }), "RESOLVED_OFFER_MISMATCH");
  assert.equal(await failureOf({ offer_id: offer.offer_id, offer: other }), "RESOLVED_OFFER_MISMATCH");
  // The right offer with someone else's encoded payload attached.
  assert.equal(
    await failureOf({ offer_id: offer.offer_id, offer, encoded_offer: encodeOffer(other) }),
    "RESOLVED_OFFER_MISMATCH"
  );
  assert.equal(await failureOf({ offer_id: offer.offer_id }), "INVALID_OFFER");
  // The scanned-payload path goes through the same checks.
  assert.equal(
    await failureOf({ offer_id: other.offer_id, offer: other }, (client) => client.resolveOffer(encodeOffer(offer))),
    "RESOLVED_OFFER_MISMATCH"
  );
});

test("resolves a Fiber Address at its own domain and verifies the answer", async () => {
  const keys = generateOfferKeyPair();
  const offer = createSignedOffer(
    {
      node_id: "02" + "d".repeat(64),
      public_key: keys.publicKeyPem,
      resolver_url: "https://shop.example",
      assets: [{ asset_type: "ckb", symbol: "CKB" }]
    },
    keys.privateKeyPem
  );
  const calls = [];
  let answer = { username: "alice", offer_id: offer.offer_id, offer };
  const client = new FiberOffersClient({
    resolverUrl: "https://my-resolver.example",
    apiKey: "operator-secret",
    fetchImpl: async (url, init) => {
      calls.push({ url, authorization: init.headers.authorization });
      return new Response(JSON.stringify(answer), { status: 200 });
    }
  });

  const foreign = await client.resolveFiberAddress("Alice@Shop.Example");
  await client.resolveFiberAddress("alice@my-resolver.example");
  await client.getOffer(offer.offer_id).catch(() => {});

  // An address on another domain is looked up there, without the API key.
  assert.equal(foreign.offer.offer_id, offer.offer_id);
  assert.deepEqual(calls[0], { url: "https://shop.example/.well-known/fiberoffer/alice", authorization: undefined });
  // The configured resolver serves its own addresses.
  assert.equal(calls[1].url, "https://my-resolver.example/.well-known/fiberoffer/alice");
  assert.equal(calls[2].authorization, "Bearer operator-secret");

  answer = { username: "mallory", offer_id: offer.offer_id, offer };
  await assert.rejects(
    () => client.resolveFiberAddress("alice@shop.example"),
    (error) => error.code === "FIBER_ADDRESS_MISMATCH"
  );
  answer = { username: "alice", offer_id: offer.offer_id, offer: { ...offer, description: "edited" } };
  await assert.rejects(
    () => client.resolveFiberAddress("alice@shop.example"),
    (error) => error.code === "OFFER_ID_MISMATCH"
  );
});

test("reads invoices in every attribute form a Fiber node may use", async () => {
  const keys = generateOfferKeyPair();
  const script = { code_hash: "0x" + "aa".repeat(32), hash_type: "type", args: "0x" + "01".repeat(32) };
  const tokenAsset = { asset_type: "udt", symbol: "USDI", type_script_hash: ckbScriptHash(script) };
  const nodeId = "02" + "e".repeat(64);
  const offer = createSignedOffer(
    {
      node_id: nodeId,
      network: "mainnet",
      public_key: keys.publicKeyPem,
      resolver_url: "https://resolver.example",
      assets: [{ asset_type: "ckb", symbol: "CKB" }, tokenAsset]
    },
    keys.privateKeyPem
  );
  const now = Date.parse("2026-01-01T00:00:00.000Z");
  const invoice = (attrs, extra = {}) => ({
    currency: "Fibb",
    amount: "0x3e8",
    data: { timestamp: `0x${now.toString(16)}`, payment_hash: "0x" + "1".repeat(64), attrs },
    ...extra
  });
  // This test is about attribute shapes; binding is covered separately below.
  const verify = (parsed, request = { amount: "1000" }) =>
    verifyInvoiceForOffer({ offer, request, parsed, requireBinding: false, now: now + 1000 });

  const snakeCase = verify({ invoice: invoice([{ payee_public_key: nodeId }, { expiry_time: { secs: 600, nanos: 0 } }]) });
  const camelCase = verify(invoice([{ PayeePublicKey: `0x${nodeId.toUpperCase()}` }, { ExpiryTime: "0x258" }]));
  const moleculeScript = `0x${Buffer.from(serializeCkbScript(script)).toString("hex")}`;
  const tokenAsHex = verify(invoice([{ payee_public_key: nodeId }, { udt_script: moleculeScript }]), {
    amount: "1000",
    asset: tokenAsset
  });
  const tokenAsObject = verify(invoice([{ payee_public_key: nodeId }, { udt_script: script }]), {
    amount: "1000",
    asset: tokenAsset
  });
  const expired = verify(invoice([{ payee_public_key: nodeId }, { expiry_time: 0 }]));
  const noAmount = verify(invoice([{ payee_public_key: nodeId }], { amount: undefined }));
  const garbage = verify({ unexpected: true });

  assert.equal(snakeCase.ok, true);
  assert.equal(snakeCase.invoice.expires_at, new Date(now + 600_000).toISOString());
  assert.equal(camelCase.ok, true);
  assert.equal(camelCase.invoice.payee_public_key, nodeId);
  assert.equal(tokenAsHex.ok, true);
  assert.equal(tokenAsObject.ok, true);
  assert.equal(expired.failure.code, "INVOICE_EXPIRED");
  assert.equal(noAmount.failure.code, "INVOICE_AMOUNT_MISSING");
  assert.equal(garbage.failure.code, "INVOICE_UNPARSEABLE");
});

test("an invoice must name the offer it was issued for", () => {
  const keys = generateOfferKeyPair();
  const nodeId = "02" + "f".repeat(64);
  const offer = createSignedOffer(
    {
      node_id: nodeId,
      public_key: keys.publicKeyPem,
      resolver_url: "https://resolver.example",
      // An offer's own text may try to look like a commitment; only the end counts.
      description: `Sneaky (fiberoffer:0x${"1".repeat(64)}:res_fake) checkout`,
      assets: [{ asset_type: "ckb", symbol: "CKB" }]
    },
    keys.privateKeyPem
  );
  const withDescription = (description) => ({
    currency: "Fibt",
    amount: "0x3e8",
    data: { payment_hash: "0x" + "1".repeat(64), attrs: [{ payee_public_key: nodeId }, { description }] }
  });
  const verify = (description, extra = {}) =>
    verifyInvoiceForOffer({ offer, request: { amount: "1000" }, parsed: withDescription(description), ...extra });
  const bound = formatInvoiceDescription(offer, "res_abc-123");

  assert.equal(bound.endsWith(`(fiberoffer:${offer.offer_id}:res_abc-123)`), true);
  assert.deepEqual(parseInvoiceBinding(bound), { offer_id: offer.offer_id, resolution_id: "res_abc-123" });
  assert.deepEqual(parseInvoiceBinding(formatInvoiceDescription({ offer_id: offer.offer_id })), {
    offer_id: offer.offer_id
  });
  assert.equal(parseInvoiceBinding("Coffee checkout"), undefined);
  assert.equal(parseInvoiceBinding(undefined), undefined);
  // A very long description is shortened, never the commitment.
  assert.equal(
    parseInvoiceBinding(formatInvoiceDescription({ offer_id: offer.offer_id, description: "x".repeat(5000) }, "res_1"))
      .offer_id,
    offer.offer_id
  );

  assert.equal(verify(bound, { expectedResolutionId: "res_abc-123" }).ok, true);
  assert.equal(verify(bound, { expectedResolutionId: "res_other" }).failure.code, "INVOICE_RESOLUTION_MISMATCH");
  assert.equal(verify(offer.description).failure.code, "INVOICE_BINDING_MISSING");
  assert.equal(verify(offer.description, { requireBinding: false }).ok, true);
  assert.equal(
    verify(`Order (fiberoffer:0x${"2".repeat(64)}:res_abc-123)`).failure.code,
    "INVOICE_OFFER_MISMATCH"
  );
  // Even with binding optional, a commitment to another offer is a rejection.
  assert.equal(
    verify(`Order (fiberoffer:0x${"2".repeat(64)})`, { requireBinding: false }).failure.code,
    "INVOICE_OFFER_MISMATCH"
  );
});

test("FiberPaymentClient reads an invoice through the payer node", async () => {
  const calls = [];
  const client = new FiberPaymentClient({
    rpc: {
      async call(method, params) {
        calls.push({ method, params });
        return { invoice: { currency: "Fibt" } };
      }
    }
  });

  assert.deepEqual(await client.parseInvoice("fibt1example"), { invoice: { currency: "Fibt" } });
  assert.deepEqual(calls, [{ method: "parse_invoice", params: [{ invoice: "fibt1example" }] }]);
  await assert.rejects(() => client.parseInvoice(""), /invoice is required/);
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
        return { ok: true, status: "payment_succeeded", payment_hash: `hash-${request.recurrence_cycle}` };
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

test("automatically runs due recurring payments and persists approvals privately", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fiber-offers-recurrence-"));
  const path = join(directory, "approvals.json");
  const keys = generateOfferKeyPair();
  const offer = createSignedOffer(
    {
      node_id: "02" + "d".repeat(64),
      public_key: keys.publicKeyPem,
      resolver_url: "https://resolver.example",
      assets: [{ asset_type: "ckb", symbol: "CKB" }],
      recurrence: { interval: "custom_seconds", custom_seconds: 60, amount: "1000", cap_cycles: 2 }
    },
    keys.privateKeyPem
  );
  let calls = 0;
  const events = [];
  const scheduler = new FiberRecurringPaymentScheduler({
    paymentFlow: {
      async payOffer() {
        calls += 1;
        return { ok: true, status: "payment_succeeded", payment_hash: `hash-${calls}` };
      }
    },
    store: new JsonFileRecurringApprovalStore(path),
    intervalMs: 5,
    onEvent: (event) => events.push(event)
  });

  try {
    const approval = await scheduler.approve(offer);
    scheduler.start();
    await waitFor(async () => (await new JsonFileRecurringApprovalStore(path).get(approval.id))?.cycles_paid === 1);
    const restored = await new JsonFileRecurringApprovalStore(path).get(approval.id);

    assert.equal(restored.cycles_paid, 1);
    assert.equal(scheduler.status().running, true);
    assert.ok(events.some((event) => event.type === "cycle.paid"));
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    scheduler.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("persists browser approvals and retries failed recurring attempts", async () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value)
  };
  const keys = generateOfferKeyPair();
  const offer = createSignedOffer(
    {
      node_id: "03" + "e".repeat(64),
      public_key: keys.publicKeyPem,
      resolver_url: "https://resolver.example",
      assets: [{ asset_type: "ckb", symbol: "CKB" }],
      recurrence: { interval: "daily", amount: "1000", spending_cap_total: "3000" }
    },
    keys.privateKeyPem
  );
  let current = new Date("2026-01-01T00:00:00.000Z");
  let calls = 0;
  const scheduler = new FiberRecurringPaymentScheduler({
    paymentFlow: {
      async payOffer() {
        calls += 1;
        return calls === 1
          ? { ok: false, status: "payment_failed", failure: { code: "NO_ROUTE", summary: "route unavailable" } }
          : { ok: true, status: "payment_succeeded", payment_hash: "hash-retry" };
      }
    },
    store: new WebStorageRecurringApprovalStore({ storage }),
    retryDelayMs: 1000,
    now: () => current
  });
  const approval = await scheduler.approve(offer);
  await scheduler.runDue();
  const afterFailure = await new WebStorageRecurringApprovalStore({ storage }).get(approval.id);
  current = new Date("2026-01-01T00:00:01.000Z");
  await scheduler.runDue();
  const afterRetry = await new WebStorageRecurringApprovalStore({ storage }).get(approval.id);

  assert.equal(afterFailure.consecutive_failures, 1);
  assert.equal(afterFailure.next_retry_at, current.toISOString());
  assert.equal(afterRetry.cycles_paid, 1);
  assert.equal(afterRetry.next_retry_at, undefined);
  assert.equal(calls, 2);
});

function recurringOffer(recurrence) {
  const keys = generateOfferKeyPair();
  return createSignedOffer(
    {
      node_id: "02" + "c".repeat(64),
      public_key: keys.publicKeyPem,
      resolver_url: "https://resolver.example",
      assets: [{ asset_type: "ckb", symbol: "CKB" }],
      recurrence
    },
    keys.privateKeyPem
  );
}

test("a recurring cycle counts as paid only once the node confirms it", async () => {
  const offer = recurringOffer({ interval: "daily", amount: "1000", cap_cycles: 5 });
  let current = new Date("2026-01-01T00:00:00.000Z");
  let sends = 0;
  let executeResult = { ok: true, status: "payment_pending", payment_hash: "0xhash1" };
  let confirmResult = { ok: true, status: "payment_pending", payment_hash: "0xhash1" };
  const events = [];
  const store = new InMemoryRecurringApprovalStore();
  const scheduler = new FiberRecurringPaymentScheduler({
    paymentFlow: {
      async preparePayment() {
        return { ok: true, status: "ready_to_send", invoice: { payment_hash: "0xhash1" } };
      },
      async executePrepared() {
        sends += 1;
        return executeResult;
      },
      async confirmPayment() {
        return confirmResult;
      }
    },
    store,
    retryDelayMs: 1000,
    now: () => current,
    onEvent: (event) => events.push(event.type)
  });
  const approval = await scheduler.approve(offer);

  // Sent but not settled: not paid, not a failure, and remembered.
  await scheduler.runDue();
  const afterSend = await store.get(approval.id);
  assert.equal(afterSend.cycles_paid, 0);
  assert.equal(afterSend.consecutive_failures ?? 0, 0);
  assert.equal(afterSend.in_flight.payment_hash, "0xhash1");

  // Still in flight on the next run: nothing is sent again.
  await scheduler.runDue();
  assert.equal(sends, 1);
  assert.equal((await store.get(approval.id)).cycles_paid, 0);

  // The node reports success: now the cycle is paid and the schedule advances.
  confirmResult = { ok: true, status: "payment_succeeded", payment_hash: "0xhash1" };
  await scheduler.runDue();
  const afterSuccess = await store.get(approval.id);
  assert.equal(sends, 1);
  assert.equal(afterSuccess.cycles_paid, 1);
  assert.equal(afterSuccess.in_flight, undefined);
  assert.equal(afterSuccess.next_due_at, "2026-01-02T00:00:00.000Z");

  // A payment that fails after being sent does not advance the cycle.
  current = new Date("2026-01-02T00:00:00.000Z");
  executeResult = { ok: false, status: "payment_failed", failure: { code: "PAYMENT_FAILED" } };
  await scheduler.runDue();
  const afterFailure = await store.get(approval.id);
  assert.equal(afterFailure.cycles_paid, 1);
  assert.equal(afterFailure.consecutive_failures, 1);
  assert.equal(afterFailure.in_flight, undefined);
  assert.deepEqual(events.filter((type) => type.startsWith("cycle.")), [
    "cycle.payment_pending",
    "cycle.payment_pending",
    "cycle.paid",
    "cycle.retry_scheduled"
  ]);
});

test("a scheduler restarted mid-payment asks the node instead of paying again", async () => {
  const offer = recurringOffer({ interval: "daily", amount: "1000", cap_cycles: 5 });
  const current = new Date("2026-01-01T00:00:00.000Z");
  const store = new InMemoryRecurringApprovalStore();
  const keys = [];
  let sends = 0;
  const flow = (behaviour) => ({
    async preparePayment(_offer, _request, options) {
      keys.push(options.idempotencyKey);
      return { ok: true, status: "ready_to_send", invoice: { payment_hash: "0xcrash" } };
    },
    async executePrepared() {
      sends += 1;
      return behaviour.execute();
    },
    async confirmPayment(hash) {
      return behaviour.confirm(hash);
    }
  });

  // The process dies after the payment hash was recorded, during the send.
  const crashing = new FiberRecurringPaymentScheduler({
    paymentFlow: flow({
      execute: () => {
        throw new Error("process killed");
      }
    }),
    store,
    now: () => current
  });
  const approval = await crashing.approve(offer);
  await assert.rejects(() => crashing.runDue(), /process killed/);
  assert.equal((await store.get(approval.id)).in_flight.payment_hash, "0xcrash");

  // Restart. The node says the payment went through: no second send.
  const confirmed = [];
  const restarted = new FiberRecurringPaymentScheduler({
    paymentFlow: flow({
      execute: () => assert.fail("must not send again"),
      confirm: (hash) => {
        confirmed.push(hash);
        return { ok: true, status: "payment_succeeded", payment_hash: hash };
      }
    }),
    store,
    now: () => current
  });
  await restarted.runDue();
  const settled = await store.get(approval.id);
  assert.deepEqual(confirmed, ["0xcrash"]);
  assert.equal(sends, 1);
  assert.equal(settled.cycles_paid, 1);

  // Had the node never seen it, the same invoice is requested and sent again.
  const second = await restarted.approve(offer, { id: "approval_never_sent" });
  await store.put({ ...second, in_flight: { cycle: 1, scheduled_for: second.next_due_at, payment_hash: "0xlost" } });
  const retried = new FiberRecurringPaymentScheduler({
    paymentFlow: flow({
      execute: () => ({ ok: true, status: "payment_succeeded", payment_hash: "0xlost" }),
      confirm: () => ({ ok: false, status: "payment_unknown" })
    }),
    store,
    now: () => current
  });
  await retried.runDue();
  assert.equal((await store.get("approval_never_sent")).cycles_paid, 1);
  assert.equal(keys.at(-1), "approval_never_sent:1");
});

test("the scheduler asks for a new invoice after one expires, keeps month-end dates, and bounds its history", async () => {
  const offer = recurringOffer({ interval: "monthly", amount: "1000", cap_cycles: 40 });
  let current = new Date("2026-01-31T00:00:00.000Z");
  const keys = [];
  let outcome = { ok: false, status: "invoice_rejected", failure: { code: "INVOICE_EXPIRED" } };
  const store = new InMemoryRecurringApprovalStore();
  const scheduler = new FiberRecurringPaymentScheduler({
    paymentFlow: {
      async payOffer(_offer, _request, options) {
        keys.push(options.idempotencyKey);
        return outcome;
      }
    },
    store,
    retryDelayMs: 1000,
    maxConsecutiveFailures: 100,
    now: () => current
  });
  const approval = await scheduler.approve(offer, { id: "plan", startAt: current });

  await scheduler.runDue();
  current = new Date(current.getTime() + 1000);
  outcome = { ok: true, status: "payment_succeeded", payment_hash: "0x1" };
  await scheduler.runDue();
  // The first key replayed an expired invoice; the second asks for a fresh one.
  assert.deepEqual(keys, ["plan:1", "plan:1:1"]);
  assert.equal((await store.get(approval.id)).next_due_at, "2026-02-28T00:00:00.000Z");

  current = new Date("2026-02-28T00:00:00.000Z");
  await scheduler.runDue();
  // Anchored to the 31st, so March is the 31st again, not the 28th.
  assert.equal((await store.get(approval.id)).next_due_at, "2026-03-31T00:00:00.000Z");
  assert.equal(keys.at(-1), "plan:2");

  for (let month = 3; month <= 30; month += 1) {
    current = new Date((await store.get(approval.id)).next_due_at);
    await scheduler.runDue();
  }
  const final = await store.get(approval.id);
  assert.equal(final.cycles_paid, 30);
  assert.equal(final.attempts.length, 20);
  assert.equal(final.attempts.at(-1).cycle, 30);
});

test("a payment flow that cannot report status needs confirm: false to count sent as paid", async () => {
  const offer = recurringOffer({ interval: "daily", amount: "1000", cap_cycles: 2 });
  const current = new Date("2026-01-01T00:00:00.000Z");
  const sendOnly = { payOffer: async () => ({ ok: true, status: "payment_sent", payment_hash: "0xsent" }) };

  const strictStore = new InMemoryRecurringApprovalStore();
  const strict = new FiberRecurringPaymentScheduler({ paymentFlow: sendOnly, store: strictStore, now: () => current });
  const strictApproval = await strict.approve(offer);
  await strict.runDue();

  const legacyStore = new InMemoryRecurringApprovalStore();
  const legacy = new FiberRecurringPaymentScheduler({
    paymentFlow: sendOnly,
    store: legacyStore,
    confirm: false,
    now: () => current
  });
  const legacyApproval = await legacy.approve(offer);
  await legacy.runDue();

  assert.equal((await strictStore.get(strictApproval.id)).cycles_paid, 0);
  assert.equal((await legacyStore.get(legacyApproval.id)).cycles_paid, 1);
});

test("waits for a Fiber payment to settle and reports the outcome", async () => {
  const statuses = ["Created", "Inflight", "Success"];
  const slept = [];
  const settles = await waitForFiberPayment(
    async () => ({ status: statuses.shift(), fee: "0x1" }),
    "0xhash",
    { pollIntervalMs: 250, sleep: async (ms) => slept.push(ms) }
  );

  // A dropped connection while polling is retried; the deadline still applies.
  let clock = 0;
  let attempts = 0;
  const neverSettles = await waitForFiberPayment(
    async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error("fetch failed"), { retryable: true });
      return { status: "Inflight" };
    },
    "0xhash",
    { timeoutMs: 1000, pollIntervalMs: 400, now: () => clock, sleep: async (ms) => { clock += ms; } }
  );
  const failed = await waitForFiberPayment(async () => ({ status: "Failed", failed_error: "no route" }), "0xhash");

  assert.deepEqual([settles.settled, settles.status], [true, "Success"]);
  assert.deepEqual(slept, [250, 250]);
  assert.deepEqual([neverSettles.settled, neverSettles.status, attempts], [false, "Inflight", 3]);
  assert.deepEqual([failed.settled, failed.status], [true, "Failed"]);
  // The node saying it has no such payment is an answer, not something to retry.
  await assert.rejects(
    () => waitForFiberPayment(async () => { throw Object.assign(new Error("payment not found"), { retryable: false }); }, "0xhash"),
    /payment not found/
  );
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
  const checkOptions = [];
  const resolver = {
    async checkPayment(_id, request, options) {
      checkOptions.push(options);
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
  // Both readiness checks carry the key so the resolver can recognise a retry.
  assert.deepEqual(checkOptions, [
    { idempotencyKey: "wallet-attempt-42" },
    { idempotencyKey: "wallet-attempt-42" }
  ]);
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

test("FiberRpcClient classifies failures so callers know whether to retry", async () => {
  const failureOf = async (fetchImpl, extra = {}) => {
    const rpc = new FiberRpcClient({ url: "http://fiber.test", fetchImpl, ...extra });
    try {
      await rpc.call("new_invoice", [{}]);
    } catch (error) {
      return error;
    }
    assert.fail("expected the RPC call to throw");
  };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

  const unreachable = await failureOf(async () => {
    throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  });
  const rejected = await failureOf(async () =>
    json({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Invalid params" } })
  );
  const unauthorized = await failureOf(async () => new Response("Unauthorized", { status: 401 }));
  const badGateway = await failureOf(async () => new Response("<html>502</html>", { status: 502 }));
  const loginPage = await failureOf(async () => new Response("<html>Sign in</html>", { status: 200 }));
  const noResult = await failureOf(async () => json({ jsonrpc: "2.0", id: 1 }));
  // A fetch that never settles and ignores the abort signal must still time out.
  const hung = await failureOf(() => new Promise(() => {}), { timeoutMs: 20 });

  assert.deepEqual(
    [unreachable.kind, unreachable.code, unreachable.retryable, unreachable.details.cause_code],
    ["transport", "FIBER_RPC_UNREACHABLE", true, "ECONNREFUSED"]
  );
  assert.deepEqual([rejected.kind, rejected.code, rejected.retryable], ["rpc", -32602, false]);
  assert.equal(rejected.details.error.message, "Invalid params");
  assert.equal(rejected.details.method, "new_invoice");
  assert.deepEqual(
    [unauthorized.kind, unauthorized.http_status, unauthorized.retryable],
    ["http", 401, false]
  );
  assert.deepEqual([badGateway.kind, badGateway.http_status, badGateway.retryable], ["http", 502, true]);
  assert.deepEqual([loginPage.kind, loginPage.retryable], ["invalid_response", false]);
  assert.equal(noResult.kind, "invalid_response");
  assert.deepEqual([hung.kind, hung.code, hung.retryable], ["timeout", "FIBER_RPC_TIMEOUT", true]);
  assert.match(hung.message, /timed out after 20ms/);
});

test("FiberRpcClient accepts a null JSON-RPC result", async () => {
  const rpc = new FiberRpcClient({
    url: "http://fiber.test",
    fetchImpl: async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }), { status: 200 })
  });

  assert.equal(await rpc.call("connect_peer", [{}]), null);
});

test("FiberOffersClient reports an unresponsive or broken resolver as retryable", async () => {
  const offerId = "0x" + "1".repeat(64);
  const failureOf = async (options) => {
    try {
      await new FiberOffersClient({ resolverUrl: "http://resolver.test", ...options }).getOffer(offerId);
    } catch (error) {
      return error;
    }
    assert.fail("expected the resolver request to throw");
  };

  const hung = await failureOf({ timeoutMs: 20, fetchImpl: () => new Promise(() => {}) });
  const unreachable = await failureOf({
    fetchImpl: async () => {
      throw new TypeError("fetch failed");
    }
  });
  const proxyPage = await failureOf({ fetchImpl: async () => new Response("<html>502</html>", { status: 502 }) });
  const rejected = await failureOf({
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          error: { code: "FIBER_INVOICE_REJECTED", message: "rejected", details: { retryable: false } }
        }),
        { status: 502 }
      )
  });

  assert.deepEqual([hung.code, hung.retryable], ["RESOLVER_TIMEOUT", true]);
  assert.deepEqual([unreachable.code, unreachable.retryable], ["RESOLVER_UNREACHABLE", true]);
  assert.deepEqual([proxyPage.code, proxyPage.status, proxyPage.retryable], ["RESOLVER_INVALID_RESPONSE", 502, true]);
  assert.deepEqual([rejected.code, rejected.status, rejected.retryable], ["FIBER_INVOICE_REJECTED", 502, false]);
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
  // This resolver stub cannot return the signed offer, so there is nothing to
  // verify the invoice against: executing is refused unless that is overridden.
  const unverified = await flow.payOffer(
    "0x" + "a".repeat(64),
    {
      amount: "1200",
      asset: { asset_type: "ckb", symbol: "CKB" }
    },
    { execute: true }
  );
  assert.equal(unverified.status, "invoice_unverified");
  assert.equal(unverified.failure.code, "INVOICE_NOT_VERIFIED");
  assert.equal(sendCount, 0);

  const sent = await flow.payOffer(
    "0x" + "a".repeat(64),
    {
      amount: "1200",
      asset: { asset_type: "ckb", symbol: "CKB" }
    },
    { execute: true, skipInvoiceVerification: true }
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

async function waitFor(predicate, timeoutMs = 1000) {
  const startedAt = Date.now();
  while (!(await predicate())) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
