#!/usr/bin/env node
// Live end-to-end check against real Fiber nodes.
//
// Starts a resolver in this process, wired to a real merchant node, and drives
// it only through the public SDK (FiberOffersClient, FiberPaymentFlowClient,
// FiberPaymentClient, FiberRecurringPaymentScheduler) with a real payer node.
// Every case sends real payments unless FIBER_E2E_DRY_RUN_ONLY=true.
//
//   npm run fiber:local -- start          # merchant on 8227, payer on 8229
//   npm run fiber:e2e-check
//   npm run fiber:e2e-check -- --evidence docs/evidence/live-fiber-run.json
//
// Environment:
//   MERCHANT_FIBER_RPC_URL  default http://127.0.0.1:8227
//   PAYER_FIBER_RPC_URL     default http://127.0.0.1:8229
//   DATABASE_URL            use PostgreSQL as the resolver's store (also enables
//                           the two-replica case); in-memory otherwise
//   FIBER_E2E_AMOUNT        per-payment amount in shannons, default 100000000 (1 CKB)
//   FIBER_E2E_INVOICE_TTL   invoice lifetime in seconds, default 10
//   FIBER_E2E_DRY_RUN_ONLY  true: verify and dry-run every invoice, send nothing
//   FIBER_E2E_MAX_FEE_AMOUNT, FIBER_E2E_MAX_FEE_RATE, FIBER_E2E_TRAMPOLINE_HOPS
//
// Exits 0 when no case failed. A case that cannot run here (no token channel,
// no PostgreSQL) is reported as skipped, with the reason.
import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { createServer, InMemoryOfferStore, PostgresOfferStore } from "../apps/resolver/src/server.js";
import { FiberRpcInvoiceAdapter } from "../apps/resolver/src/invoice-adapter.js";
import {
  createOfferRevocation,
  createSignedOffer,
  generateOfferKeyPair,
  signRecurrenceRequest
} from "../packages/protocol/src/index.js";
import {
  FiberOffersClient,
  FiberPaymentClient,
  FiberPaymentFlowClient,
  FiberRecurringPaymentScheduler,
  FiberRpcClient,
  InMemoryRecurringApprovalStore
} from "../packages/sdk/src/index.js";

const { values: flags } = parseArgs({ options: { evidence: { type: "string" } } });
const merchantRpcUrl = process.env.MERCHANT_FIBER_RPC_URL ?? process.env.FIBER_RPC_URL ?? "http://127.0.0.1:8227";
const payerRpcUrl = process.env.PAYER_FIBER_RPC_URL ?? "http://127.0.0.1:8229";
const amount = process.env.FIBER_E2E_AMOUNT ?? "100000000";
const invoiceTtlSeconds = Number(process.env.FIBER_E2E_INVOICE_TTL ?? 10);
const execute = process.env.FIBER_E2E_DRY_RUN_ONLY !== "true";
const databaseUrl = process.env.DATABASE_URL;
const ckb = { asset_type: "ckb", symbol: "CKB" };
const routeOptions = clean({
  maxFeeAmount: process.env.FIBER_E2E_MAX_FEE_AMOUNT,
  maxFeeRate: process.env.FIBER_E2E_MAX_FEE_RATE,
  trampolineHops: process.env.FIBER_E2E_TRAMPOLINE_HOPS
});

const merchantRpc = new FiberRpcClient({ url: merchantRpcUrl });
const payerRpc = new FiberRpcClient({ url: payerRpcUrl });
const payer = new FiberPaymentClient({ rpc: payerRpc });
const cases = [];
const closers = [];

try {
  const [merchantInfo, payerInfo, payerChannels] = await Promise.all([
    merchantRpc.call("node_info", []),
    payerRpc.call("node_info", []),
    payerRpc.call("list_channels", [{}])
  ]);
  const replicaA = await startResolver();
  const client = replicaA.client;
  const flow = new FiberPaymentFlowClient({ resolverClient: client, paymentClient: payer });
  const pay = (offer, request, options = {}) =>
    flow.payOffer(offer, request, { execute, confirm: true, ...routeOptions, ...options });
  const newOffer = (input, options = {}) =>
    client.createAndRegisterOfferFromNode(
      { resolver_url: replicaA.url, amount_min: amount, amount_max: amount, assets: [ckb], ...input },
      { fiberRpcUrl: merchantRpcUrl, ...options }
    );
  const done = execute ? "payment_succeeded" : "ready_to_send";

  await runCase("reusable-ckb", "A reusable offer is paid twice with distinct invoices", async () => {
    const created = await newOffer({ description: "E2E reusable offer", amount_max: String(BigInt(amount) * 10n) });
    const first = await pay(created.offer, { amount, asset: ckb });
    const second = await pay(created.encoded_offer, { amount: String((BigInt(amount) * 3n) / 2n), asset: ckb });
    expect(first.status === done && second.status === done, "both payments complete", [first.status, second.status]);
    expect(first.invoice.invoice !== second.invoice.invoice, "the two invoices are different");
    expect(first.invoice_verification.verified && second.invoice_verification.verified, "both invoices were verified");
    if (!execute) return { offer_id: created.offer.offer_id, payments: [brief(first), brief(second)] };

    expect(first.payment_hash !== second.payment_hash, "the two payment hashes are different");
    const synced = await client.syncResolutions(created.offer.offer_id);
    const statuses = synced.results.map((result) => result.resolution?.status ?? result.status);
    expect(statuses.every((status) => status === "invoice_paid"), "resolver records both as invoice_paid", statuses);
    return {
      offer_id: created.offer.offer_id,
      payments: await Promise.all([first, second].map(settlementRecord)),
      resolver_statuses: statuses
    };
  });

  await runCase("token-invoice", "A token invoice is minted with the token's script and verified", async () => {
    const diagnostics = await client.diagnostics();
    const token = diagnostics.invoice_source?.assets?.udt?.[0];
    if (!token) return skip("the merchant node whitelists no token with an exact type script");
    const asset = { asset_type: "udt", symbol: token.name ?? "UDT", type_script_hash: token.type_script_hash };
    const created = await newOffer({ description: "E2E token offer", assets: [ckb, asset] });
    const prepared = await flow.preparePayment(created.offer, { amount, asset }, { requireInitialReadiness: false });
    expect(prepared.invoice_verification?.verified, "the payer node verified the token invoice", prepared.failure);
    expect(
      prepared.invoice_verification.invoice.type_script_hash === token.type_script_hash,
      "the invoice's script hashes to the offer's type_script_hash"
    );
    const hasTokenChannel = (payerChannels.channels ?? []).some((channel) => channel.funding_udt_type_script);
    return {
      offer_id: created.offer.offer_id,
      token,
      invoice: prepared.invoice.invoice,
      verification: prepared.invoice_verification.checks.map((check) => `${check.id}:${check.status}`),
      payment: hasTokenChannel ? "not attempted by this check" : "skipped: the payer has no token channel"
    };
  });

  await runCase("single-use", "A single-use offer is released by a lapsed invoice and used up by payment", async () => {
    const created = await newOffer({ description: "E2E single-use offer", single_use: true });
    const request = { amount, asset: ckb };
    const abandoned = await client.requestInvoice(created.offer.offer_id, request);
    const whileUnpaid = await codeOf(client.requestInvoice(created.offer.offer_id, request));
    expect(whileUnpaid === "OFFER_INVOICE_OUTSTANDING", "a second request is held while the first is unpaid", whileUnpaid);
    await sleep((invoiceTtlSeconds + 2) * 1000);
    const paid = await pay(created.offer, request);
    expect(paid.status === done, "after the first invoice lapsed, a new one is issued and paid", paid.failure ?? paid.status);
    const afterPayment = execute ? await codeOf(client.requestInvoice(created.offer.offer_id, request)) : undefined;
    if (execute) expect(afterPayment === "OFFER_ALREADY_USED", "once paid, the offer is used up", afterPayment);
    const resolutions = await client.getResolutions(created.offer.offer_id);
    return {
      offer_id: created.offer.offer_id,
      abandoned_resolution: abandoned.resolution_id,
      while_unpaid: whileUnpaid,
      payment: brief(paid),
      after_payment: afterPayment,
      stored_statuses: resolutions.resolutions.map((resolution) => resolution.status)
    };
  });

  await runCase("recurring-two-subscribers", "Two subscribers each pay their own cycles of one recurring offer", async () => {
    if (!execute) return skip("needs real payments to advance cycles");
    const created = await newOffer({
      description: "E2E recurring offer",
      recurrence: { interval: "custom_seconds", custom_seconds: 2, amount, cap_cycles: 2 }
    });
    const approvals = new InMemoryRecurringApprovalStore();
    const events = [];
    const scheduler = new FiberRecurringPaymentScheduler({
      paymentFlow: flow,
      store: approvals,
      onEvent: (event) => events.push(event.type)
    });
    const first = await scheduler.approve(created.offer);
    const second = await scheduler.approve(created.offer);
    for (let pass = 0; pass < 3; pass += 1) {
      await scheduler.runDue();
      await sleep(2300);
    }
    const [a, b] = [await approvals.get(first.id), await approvals.get(second.id)];
    expect(a.cycles_paid === 2 && b.cycles_paid === 2, "each subscription paid its two cycles", [a.cycles_paid, b.cycles_paid]);
    expect(a.status === "cap_reached" && b.status === "cap_reached", "each then reached its own cap", [a.status, b.status]);
    const status = await client.getRecurrenceStatus(created.offer.offer_id, a.subscription_id);
    expect(status.cycles_paid === 2 && status.cap_reached, "the resolver agrees for the first subscription", status);

    const forged = signRecurrenceRequest(created.offer, { amount, asset: ckb, recurrence_cycle: 1 }, generateOfferKeyPair().privateKeyPem);
    const forgery = await codeOf(client.requestInvoice(created.offer.offer_id, { ...forged, approval_id: a.subscription_id }));
    expect(forgery === "SUBSCRIPTION_KEY_MISMATCH", "a request naming another subscription is refused", forgery);
    return {
      offer_id: created.offer.offer_id,
      subscriptions: [a, b].map((approval) => ({
        subscription_id: approval.subscription_id,
        cycles_paid: approval.cycles_paid,
        payment_hashes: approval.attempts.map((attempt) => attempt.payment_hash)
      })),
      events: events.filter((type) => type.startsWith("cycle.") || type.startsWith("approval.")),
      forged_request: forgery
    };
  });

  await runCase("invoice-expiry", "An unpaid invoice expires on the node and is recorded as expired", async () => {
    const created = await newOffer({ description: "E2E expiring invoice" });
    const key = `e2e-expiry-${Date.now()}`;
    const issued = await client.requestInvoice(created.offer.offer_id, { amount, asset: ckb }, { idempotencyKey: key });
    await sleep((invoiceTtlSeconds + 2) * 1000);
    const onNode = await merchantRpc.call("get_invoice", [{ payment_hash: issued.payment_hash }]);
    expect(onNode.status === "Expired", "the node reports the invoice Expired", onNode.status);
    const synced = await client.syncResolution(created.offer.offer_id, issued.resolution_id);
    expect(synced.resolution.status === "invoice_expired", "the resolver records invoice_expired", synced.resolution.status);
    // Retrying with the same key replays the dead invoice; the SDK refuses to pay it.
    const replay = await flow.preparePayment(created.offer, { amount, asset: ckb }, { idempotencyKey: key });
    expect(replay.failure?.code === "INVOICE_EXPIRED", "the SDK refuses to pay the expired invoice", replay.failure ?? replay.status);
    return {
      offer_id: created.offer.offer_id,
      payment_hash: issued.payment_hash,
      expires_at: issued.expires_at,
      node_status: onNode.status,
      resolver_status: synced.resolution.status,
      replay: replay.failure.code
    };
  });

  await runCase("revocation", "A signed revocation stops an offer", async () => {
    const created = await newOffer({ description: "E2E revoked offer" });
    const revocation = createOfferRevocation(created.offer, created.offer_private_key_pem, { reason: "e2e" });
    const revoked = await client.revokeOffer(created.offer.offer_id, revocation);
    const afterwards = await statusAndCode(client.requestInvoice(created.offer.offer_id, { amount, asset: ckb }));
    expect(afterwards === "410 OFFER_REVOKED", "invoice requests are refused with 410", afterwards);
    return { offer_id: created.offer.offer_id, revoked_at: revoked.revoked_at, after_revocation: afterwards };
  });

  await runCase("tamper-rejection", "The SDK refuses offers and invoices a resolver substituted", async () => {
    const victim = await newOffer({ description: "E2E victim order" });
    const attacker = await newOffer({ description: "E2E attacker order" });
    // A genuine invoice from the same node, for the same amount, for another order.
    const swapInvoice = hostileResolver(client, {
      requestInvoice: async (original) => ({
        ...original,
        ...pick(await client.requestInvoice(attacker.offer.offer_id, { amount, asset: ckb }), ["invoice", "payment_request", "payment_hash"])
      })
    });
    // The right offer ID answered with a different, validly signed offer.
    const swapOffer = hostileResolver(client, { getOffer: async () => client.getOffer(attacker.offer.offer_id) });
    const sentBefore = await paymentCount();
    const swapped = await new FiberPaymentFlowClient({ resolverClient: swapInvoice, paymentClient: payer }).payOffer(
      victim.offer,
      { amount, asset: ckb },
      { execute: true, confirm: true }
    );
    const offerSwap = await codeOf(
      new FiberPaymentFlowClient({ resolverClient: swapOffer, paymentClient: payer }).payOffer(
        victim.offer.offer_id,
        { amount, asset: ckb },
        { execute: true }
      )
    );
    expect(swapped.status === "invoice_rejected", "an invoice for another order is rejected", swapped.status);
    expect(swapped.failure.code === "INVOICE_OFFER_MISMATCH", "because it names a different offer", swapped.failure.code);
    expect(offerSwap === "RESOLVED_OFFER_MISMATCH", "a substituted offer is rejected", offerSwap);
    expect((await paymentCount()) === sentBefore, "no payment left the payer node");
    return { victim_offer: victim.offer.offer_id, invoice_swap: swapped.failure.code, offer_swap: offerSwap };
  });

  await runCase("idempotent-retry", "A payment that fails in transit is retried on the same invoice", async () => {
    if (!execute) return skip("needs a real send to retry");
    const created = await newOffer({ description: "E2E retry offer", single_use: true });
    let dropFirst = true;
    const flaky = {
      parseInvoice: (invoice) => payer.parseInvoice(invoice),
      checkPaymentRoute: (invoice, options) => payer.checkPaymentRoute(invoice, options),
      getPayment: (hash) => payer.getPayment(hash),
      async sendPayment(invoice, options) {
        if (dropFirst) {
          dropFirst = false;
          throw Object.assign(new Error("socket hang up"), { kind: "transport", retryable: true });
        }
        return payer.sendPayment(invoice, options);
      }
    };
    const flakyFlow = new FiberPaymentFlowClient({ resolverClient: client, paymentClient: flaky });
    const options = { execute: true, confirm: true, idempotencyKey: `e2e-retry-${Date.now()}`, ...routeOptions };
    const failed = await flakyFlow.payOffer(created.offer, { amount, asset: ckb }, options);
    const retried = await flakyFlow.payOffer(created.offer, { amount, asset: ckb }, options);
    expect(failed.status === "payment_failed", "the first attempt fails in transit", failed.status);
    expect(retried.status === "payment_succeeded", "the retry succeeds", retried.failure ?? retried.status);
    expect(retried.invoice.invoice === failed.invoice.invoice, "on the very same invoice");
    return { offer_id: created.offer.offer_id, payment: await settlementRecord(retried) };
  });

  await runCase("two-replicas-single-use", "Two resolver replicas issue one invoice for a single-use offer", async () => {
    if (!databaseUrl) return skip("needs DATABASE_URL: two replicas share state through PostgreSQL");
    const replicaB = await startResolver();
    const created = await newOffer({ description: "E2E two-replica offer", single_use: true });
    const request = { amount, asset: ckb };
    const outcomes = await Promise.all([
      statusAndCode(replicaA.client.requestInvoice(created.offer.offer_id, request)),
      statusAndCode(replicaB.client.requestInvoice(created.offer.offer_id, request)),
      statusAndCode(replicaA.client.requestInvoice(created.offer.offer_id, request)),
      statusAndCode(replicaB.client.requestInvoice(created.offer.offer_id, request))
    ]);
    const issued = outcomes.filter((outcome) => outcome === "issued").length;
    expect(issued === 1, "exactly one of four concurrent requests is issued an invoice", outcomes);
    return { offer_id: created.offer.offer_id, outcomes };
  });

  await runCase("fiber-address", "A Fiber Address resolves to a verified offer", async () => {
    const username = `e2e-${Date.now().toString(36)}`;
    const created = await newOffer({ description: "E2E addressed offer" }, { username });
    const address = `${username}@${new URL(replicaA.url).host}`;
    const resolved = await client.resolveFiberAddress(address);
    expect(resolved.offer.offer_id === created.offer.offer_id, "the address resolves to the registered offer");
    return { address, offer_id: resolved.offer.offer_id };
  });

  await runCase("webhook-delivery", "A payment is announced to a merchant webhook, signed", async () => {
    if (!execute) return skip("needs a real payment to announce");
    const receiver = await startWebhookReceiver();
    const created = await newOffer({ description: "E2E webhook offer" });
    const webhook = await client.createWebhook(created.offer.offer_id, { url: receiver.url, events: ["invoice.created", "invoice.paid"] });
    const paid = await pay(created.offer, { amount, asset: ckb });
    await client.syncResolution(created.offer.offer_id, paid.invoice.resolution_id);
    await client.deliverWebhookEvents(created.offer.offer_id);
    const types = receiver.requests.map((request) => request.headers["x-fiber-offers-event-type"]);
    expect(types.includes("invoice.created") && types.includes("invoice.paid"), "created and paid were both delivered", types);
    const signaturesValid = receiver.requests.every(
      (request) =>
        request.headers["x-fiber-offers-signature"] ===
        `sha256=${createHmac("sha256", webhook.signing_secret).update(`${request.headers["x-fiber-offers-timestamp"]}.${request.body}`).digest("hex")}`
    );
    expect(signaturesValid, "every delivery carries a valid HMAC signature");
    return { offer_id: created.offer.offer_id, delivered: types };
  });

  await runCase("network-mismatch", "An offer signed for another network is refused", async () => {
    const keys = generateOfferKeyPair();
    const otherNetwork = replicaA.network === "mainnet" ? "testnet" : "mainnet";
    const offer = createSignedOffer(
      { node_id: merchantInfo.pubkey, network: otherNetwork, public_key: keys.publicKeyPem, resolver_url: replicaA.url, assets: [ckb] },
      keys.privateKeyPem
    );
    const outcome = await statusAndCode(client.registerOffer(offer));
    if (!replicaA.network) return skip("the merchant node is on a private chain; set FIBER_NETWORK to enforce this");
    expect(outcome === "422 OFFER_NETWORK_MISMATCH", "registration is refused", outcome);
    return { node_network: replicaA.network, offer_network: otherNetwork, outcome };
  });

  const report = {
    generated_at: new Date().toISOString(),
    command: "npm run fiber:e2e-check",
    git: await gitState(),
    mode: execute ? "real payments" : "dry run only",
    store: databaseUrl ? "postgresql" : "memory",
    invoice_ttl_seconds: invoiceTtlSeconds,
    amount_per_payment: amount,
    nodes: {
      merchant: pick(merchantInfo, ["version", "commit_hash", "pubkey", "chain_hash"]),
      payer: pick(payerInfo, ["version", "commit_hash", "pubkey", "chain_hash"]),
      network: replicaA.network ?? "unknown",
      payer_channels: (payerChannels.channels ?? []).map((channel) => ({
        state: channel.state?.state_name,
        peer: channel.pubkey,
        token: Boolean(channel.funding_udt_type_script)
      }))
    },
    summary: {
      passed: cases.filter((item) => item.status === "passed").length,
      failed: cases.filter((item) => item.status === "failed").length,
      skipped: cases.filter((item) => item.status === "skipped").length
    },
    cases
  };

  for (const item of cases) {
    const mark = { passed: "PASS", failed: "FAIL", skipped: "SKIP" }[item.status];
    console.log(`${mark}  ${item.id}: ${item.title}${item.reason ? ` (${item.reason})` : ""}${item.error ? `\n      ${item.error.message}` : ""}`);
  }
  console.log(`\n${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.skipped} skipped`);
  if (flags.evidence) {
    const path = resolve(flags.evidence);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Transcript written to ${path}`);
  }
  process.exitCode = report.summary.failed === 0 ? 0 : 1;
} catch (error) {
  console.error(`live e2e check could not run: ${error.message}`);
  if (error.details) console.error(JSON.stringify(error.details));
  process.exitCode = 1;
} finally {
  for (const close of closers.reverse()) await close().catch(() => {});
}

// --- helpers ----------------------------------------------------------------

async function runCase(id, title, run) {
  const startedAt = Date.now();
  try {
    const detail = (await run()) ?? {};
    cases.push({ id, title, status: detail.skipped ? "skipped" : "passed", duration_ms: Date.now() - startedAt, ...detail });
  } catch (error) {
    cases.push({
      id,
      title,
      status: "failed",
      duration_ms: Date.now() - startedAt,
      error: { message: error.message, code: error.code, details: error.details }
    });
  }
}

function skip(reason) {
  return { skipped: true, reason };
}

function expect(condition, message, details = undefined) {
  if (condition) return;
  const error = new Error(`expected: ${message}`);
  error.details = details;
  throw error;
}

// A resolver exactly as deployed, in this process: the real server and the
// real invoice adapter, talking to the real merchant node.
async function startResolver() {
  const store = databaseUrl ? new PostgresOfferStore({ connectionString: databaseUrl }) : new InMemoryOfferStore();
  const invoiceAdapter = new FiberRpcInvoiceAdapter({ url: merchantRpcUrl, invoiceTtlSeconds });
  const server = createServer({
    store,
    invoiceAdapter,
    topologyClient: false,
    workers: false,
    allowPrivateWebhookTargets: true,
    rateLimitMax: 0,
    logger: { error: (error) => console.error(error), info() {} }
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const url = `http://127.0.0.1:${server.address().port}`;
  closers.push(() => new Promise((resolveClose) => server.close(resolveClose)));
  const identity = await invoiceAdapter.getNodeIdentity();
  return { url, client: new FiberOffersClient({ resolverUrl: url }), network: identity.network };
}

// A resolver client that lies in one specific way, standing in for a
// compromised resolver. Everything else passes through to the honest one.
function hostileResolver(honest, lies) {
  return {
    resolverUrl: honest.resolverUrl,
    checkPayment: (...args) => honest.checkPayment(...args),
    getOffer: lies.getOffer ?? ((...args) => honest.getOffer(...args)),
    requestInvoice: async (...args) => {
      const original = await honest.requestInvoice(...args);
      return lies.requestInvoice ? lies.requestInvoice(original) : original;
    }
  };
}

async function startWebhookReceiver() {
  const requests = [];
  const server = createHttpServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ headers: request.headers, body: Buffer.concat(chunks).toString("utf8") });
    response.writeHead(204).end();
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  closers.push(() => new Promise((resolveClose) => server.close(resolveClose)));
  return { url: `http://127.0.0.1:${server.address().port}/hook`, requests };
}

// What each side reports about one settled payment.
async function settlementRecord(result) {
  const [payment, invoice] = await Promise.all([
    payer.getPayment(result.payment_hash),
    merchantRpc.call("get_invoice", [{ payment_hash: result.payment_hash }])
  ]);
  return {
    resolution_id: result.invoice.resolution_id,
    invoice: result.invoice.invoice,
    payment_hash: result.payment_hash,
    verified_before_sending: result.invoice_verification.verified,
    payer_get_payment: pick(payment, ["status", "fee", "created_at", "last_updated_at"]),
    merchant_get_invoice: { status: invoice.status }
  };
}

function brief(result) {
  return clean({
    status: result.status,
    resolution_id: result.invoice?.resolution_id,
    payment_hash: result.payment_hash ?? result.invoice?.payment_hash,
    verified_before_sending: result.invoice_verification?.verified,
    failure: result.failure?.code
  });
}

async function paymentCount() {
  const channels = await payerRpc.call("list_channels", [{}]);
  return (channels.channels ?? []).reduce((total, channel) => total + BigInt(channel.local_balance ?? "0x0"), 0n).toString();
}

function codeOf(promise) {
  return promise.then(
    (value) => value?.failure?.code ?? value?.status ?? "ok",
    (error) => error.code ?? error.message
  );
}

function statusAndCode(promise) {
  return promise.then(
    () => "issued",
    (error) => `${error.status ?? ""} ${error.code ?? error.message}`.trim()
  );
}

async function gitState() {
  const run = promisify(execFile);
  try {
    const [{ stdout: sha }, { stdout: status }] = await Promise.all([
      run("git", ["rev-parse", "HEAD"]),
      run("git", ["status", "--porcelain"])
    ]);
    return { sha: sha.trim(), uncommitted_changes: status.trim().length > 0 };
  } catch {
    return { sha: "unknown" };
  }
}

function pick(value, keys) {
  return Object.fromEntries(keys.filter((key) => value?.[key] !== undefined).map((key) => [key, value[key]]));
}

function clean(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== ""));
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
