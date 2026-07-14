import { FiberPaymentClient, normalizeFiberPaymentFailure } from "../packages/sdk/src/index.js";

const merchantRpcUrl = process.env.MERCHANT_FIBER_RPC_URL ?? process.env.FIBER_RPC_URL ?? "http://127.0.0.1:8227";
const payerRpcUrl = process.env.PAYER_FIBER_RPC_URL ?? "http://127.0.0.1:8229";
const payerRpcUrls = csvList(process.env.PAYER_FIBER_RPC_URLS);
if (payerRpcUrls.length === 0) payerRpcUrls.push(payerRpcUrl);
const resolverUrl = trimTrailingSlash(process.env.RESOLVER_URL ?? "http://127.0.0.1:8787");
const apiKey = process.env.RESOLVER_API_KEY;
const amount = process.env.FIBER_E2E_AMOUNT ?? "100000000";
const timeoutSeconds = Number(process.env.FIBER_E2E_TIMEOUT_SECONDS ?? 60);
const pollMs = Number(process.env.FIBER_E2E_POLL_MS ?? 1000);
const sendPayment = process.env.FIBER_E2E_DRY_RUN_ONLY !== "true";
const trampolineHops = csvList(process.env.FIBER_E2E_TRAMPOLINE_HOPS);
const maxFeeAmount = process.env.FIBER_E2E_MAX_FEE_AMOUNT;
const maxFeeRate = process.env.FIBER_E2E_MAX_FEE_RATE;
const paymentCount = positiveInteger(process.env.FIBER_E2E_PAYMENT_COUNT, 2);

let stage = "init";
let latestDiagnostics;
let latestOffer;
let latestInvoice;

try {
  stage = "probe";
  const [merchantInfo, payerInfo, merchantChannels, payerChannels, merchantPeers, payerPeers] = await Promise.all([
    rpcCall(merchantRpcUrl, "node_info", []),
    rpcCall(payerRpcUrl, "node_info", []),
    rpcCall(merchantRpcUrl, "list_channels", [{}]),
    rpcCall(payerRpcUrl, "list_channels", [{}]),
    rpcCall(merchantRpcUrl, "list_peers", []),
    rpcCall(payerRpcUrl, "list_peers", [])
  ]);
  const diagnostics = createDiagnostics({
    merchantInfo,
    payerInfo,
    merchantChannels,
    payerChannels,
    merchantPeers,
    payerPeers
  });
  latestDiagnostics = diagnostics;

  stage = "resolver_health";
  const health = await resolverRequest("/health");
  if (health.invoice_mode !== "fiber-rpc") {
    throw checkError("resolver is not running in Fiber RPC mode", {
      invoice_mode: health.invoice_mode
    });
  }

  stage = "create_offer";
  const offer = await resolverRequest("/demo/offers", {
    method: "POST",
    body: {
      username: `e2e-${Date.now().toString(36)}`,
      amount_min: amount,
      amount_max: amount,
      description: "Fiber Offers live payer e2e check"
    }
  });
  latestOffer = offer;

  const sessions = [];
  for (let index = 0; index < paymentCount; index += 1) {
    const sessionId = `payer-session-${index + 1}`;
    const sessionRpcUrl = payerRpcUrls[index % payerRpcUrls.length];
    const payerPaymentClient = new FiberPaymentClient({ url: sessionRpcUrl });

    stage = `${sessionId}:request_invoice`;
    const invoice = await resolverRequest(`/offers/${offer.offer_id}/invoice`, {
      method: "POST",
      headers: { "idempotency-key": `${offer.offer_id}:${sessionId}` },
      body: {
        amount,
        asset: { asset_type: "ckb", symbol: "CKB" }
      }
    });
    latestInvoice = invoice;

    stage = `${sessionId}:dry_run_payment`;
    const routeCheck = await payerPaymentClient.checkPaymentRoute(invoice.invoice, {
      ...paymentOptions(),
      diagnostics
    });
    if (!routeCheck.ok) throw failureError(routeCheck.failure);
    const dryRun = routeCheck.dry_run;

    if (!sendPayment) {
      const resolverSync = await syncResolver(offer.offer_id, invoice.resolution_id);
      sessions.push({
        ok: true,
        session_id: sessionId,
        payer_rpc_url: sessionRpcUrl,
        invoice,
        dryRun,
        resolverSync
      });
      continue;
    }

    stage = `${sessionId}:send_payment`;
    const payment = await payerPaymentClient.sendPayment(invoice.invoice, paymentOptions());
    stage = `${sessionId}:poll_payment`;
    const finalPayment = await pollPayment(payerPaymentClient, payment.payment_hash, timeoutSeconds);
    stage = `${sessionId}:poll_invoice`;
    const finalInvoice = await pollMerchantInvoice(invoice.payment_hash, timeoutSeconds);
    stage = `${sessionId}:sync_resolver`;
    const resolverSync = await syncResolver(offer.offer_id, invoice.resolution_id);
    const ok =
      finalPayment.status === "Success" &&
      finalInvoice.status === "Paid" &&
      resolverSync.resolution?.status === "invoice_paid";

    sessions.push({
      ok,
      session_id: sessionId,
      payer_rpc_url: sessionRpcUrl,
      invoice,
      dryRun,
      payment,
      finalPayment,
      finalInvoice,
      resolverSync
    });
    if (!ok) throw failureError(analyzePaymentFailure({ ...sessions.at(-1), stage, diagnostics }));
  }

  const distinctInvoices = new Set(sessions.map((session) => session.invoice.invoice)).size === paymentCount;
  const distinctPaymentHashes = new Set(sessions.map((session) => session.invoice.payment_hash)).size === paymentCount;
  const ok = sessions.length === paymentCount && sessions.every((session) => session.ok) && distinctInvoices && distinctPaymentHashes;

  printResult({
    ok,
    dry_run_only: !sendPayment,
    stage,
    offer,
    sessions,
    distinctInvoices,
    distinctPaymentHashes,
    diagnostics
  });

  if (!ok) process.exit(1);
} catch (error) {
  const failure = normalizeFiberPaymentFailure(error, {
    diagnostics: latestDiagnostics,
    stage
  });
  printFailure({
    stage,
    failure,
    offer: latestOffer,
    invoice: latestInvoice,
    diagnostics: latestDiagnostics
  });
  process.exit(1);
}

async function pollPayment(payerPaymentClient, paymentHash, timeout) {
  const started = Date.now();
  let last;

  while (Date.now() - started <= timeout * 1000) {
    last = await payerPaymentClient.getPayment(paymentHash);
    if (["Success", "Failed"].includes(last.status)) return last;
    await sleep(pollMs);
  }

  return last;
}

async function syncResolver(offerId, resolutionId) {
  return resolverRequest(`/offers/${offerId}/resolutions/${resolutionId}/sync`, {
    method: "POST",
    body: {}
  });
}

async function pollMerchantInvoice(paymentHash, timeout) {
  const started = Date.now();
  let last;

  while (Date.now() - started <= timeout * 1000) {
    last = await rpcCall(merchantRpcUrl, "get_invoice", [{ payment_hash: paymentHash }]);
    if (["Paid", "Expired", "Cancelled"].includes(last.status)) return last;
    await sleep(pollMs);
  }

  return last;
}

async function rpcCall(url, method, params = []) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      method,
      params
    })
  });
  const body = await response.json();
  if (!response.ok || body.error) {
    const error = new Error(body.error?.message ?? `Fiber RPC ${method} failed with HTTP ${response.status}`);
    error.code = body.error?.code ?? "FIBER_RPC_ERROR";
    error.details = {
      method,
      url,
      error: body.error ?? body
    };
    throw error;
  }

  return body.result;
}

async function resolverRequest(path, options = {}) {
  const response = await fetch(`${resolverUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      accept: "application/json",
      ...authHeaders(),
      ...options.headers,
      ...(options.body ? { "content-type": "application/json" } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : undefined;
  if (!response.ok) {
    const error = new Error(body?.error?.message ?? `resolver request failed with ${response.status}`);
    error.code = body?.error?.code;
    error.details = body?.error?.details;
    throw error;
  }

  return body;
}

function createDiagnostics({ merchantInfo, payerInfo, merchantChannels, payerChannels, merchantPeers, payerPeers }) {
  const merchantCounterparties = channelCounterparties(merchantChannels);
  const payerCounterparties = channelCounterparties(payerChannels);
  const commonCounterparties = merchantCounterparties.filter((pubkey) => payerCounterparties.includes(pubkey));
  const merchantPeerPubkeys = (merchantPeers.peers ?? []).map((peer) => peer.pubkey).filter(Boolean);
  const payerPeerPubkeys = (payerPeers.peers ?? []).map((peer) => peer.pubkey).filter(Boolean);

  return {
    merchant: {
      rpc_url: merchantRpcUrl,
      pubkey: merchantInfo.pubkey,
      peers_count: hexToDecimal(merchantInfo.peers_count),
      channel_count: hexToDecimal(merchantInfo.channel_count),
      peers: merchantPeerPubkeys,
      channels: summarizeChannels(merchantChannels.channels ?? [], merchantPeerPubkeys)
    },
    payer: {
      rpc_url: payerRpcUrl,
      pubkey: payerInfo.pubkey,
      peers_count: hexToDecimal(payerInfo.peers_count),
      channel_count: hexToDecimal(payerInfo.channel_count),
      peers: payerPeerPubkeys,
      channels: summarizeChannels(payerChannels.channels ?? [], payerPeerPubkeys)
    },
    direct_channel: {
      merchant_to_payer: merchantCounterparties.includes(payerInfo.pubkey),
      payer_to_merchant: payerCounterparties.includes(merchantInfo.pubkey)
    },
    common_channel_counterparties: commonCounterparties
  };
}

function summarizeChannels(channels, peerPubkeys = []) {
  const ready = channels.filter((channel) => channel.state?.state_name === "ChannelReady");
  const enabled = ready.filter((channel) => channel.enabled !== false);
  const localTotal = sumHex(enabled.map((channel) => channel.local_balance));
  const remoteTotal = sumHex(enabled.map((channel) => channel.remote_balance));
  const publicCount = enabled.filter((channel) => channel.is_public).length;
  const counterparties = summarizeChannelCounterparties(enabled, new Set(peerPubkeys));

  return {
    total: channels.length,
    ready: ready.length,
    enabled: enabled.length,
    public: publicCount,
    private: enabled.length - publicCount,
    ckb: enabled.filter((channel) => !channel.funding_udt_type_script).length,
    udt: enabled.filter((channel) => channel.funding_udt_type_script).length,
    usable_outbound: enabled.filter((channel) => hexValue(channel.local_balance) > 0n).length,
    usable_inbound: enabled.filter((channel) => hexValue(channel.remote_balance) > 0n).length,
    local_balance_total: localTotal.toString(),
    local_balance_total_hex: hexString(localTotal),
    remote_balance_total: remoteTotal.toString(),
    remote_balance_total_hex: hexString(remoteTotal),
    pending_tlc_count: enabled.reduce((total, channel) => total + (channel.pending_tlcs?.length ?? 0), 0),
    counterparties,
    offline_counterparties: counterparties
      .filter((counterparty) => !counterparty.connected)
      .map((counterparty) => counterparty.pubkey)
  };
}

function summarizeChannelCounterparties(channels, connectedPeers) {
  const byPubkey = new Map();

  for (const channel of channels) {
    const pubkey = channel.pubkey;
    if (!pubkey) continue;

    const current = byPubkey.get(pubkey) ?? {
      pubkey,
      channels: 0,
      public: 0,
      private: 0,
      local_balance_total: 0n,
      remote_balance_total: 0n,
      pending_tlc_count: 0
    };

    current.channels += 1;
    if (channel.is_public) current.public += 1;
    else current.private += 1;
    current.local_balance_total += hexValue(channel.local_balance);
    current.remote_balance_total += hexValue(channel.remote_balance);
    current.pending_tlc_count += channel.pending_tlcs?.length ?? 0;
    byPubkey.set(pubkey, current);
  }

  return [...byPubkey.values()].map((counterparty) => ({
    pubkey: counterparty.pubkey,
    connected: connectedPeers.has(counterparty.pubkey),
    channels: counterparty.channels,
    public: counterparty.public,
    private: counterparty.private,
    local_balance_total: counterparty.local_balance_total.toString(),
    local_balance_total_hex: hexString(counterparty.local_balance_total),
    remote_balance_total: counterparty.remote_balance_total.toString(),
    remote_balance_total_hex: hexString(counterparty.remote_balance_total),
    pending_tlc_count: counterparty.pending_tlc_count
  }));
}

function channelCounterparties(channelResult) {
  return [
    ...new Set(
      (channelResult.channels ?? [])
        .filter((channel) => channel.state?.state_name === "ChannelReady" && channel.enabled !== false)
        .map((channel) => channel.pubkey)
    )
  ];
}

function analyzePaymentFailure(result) {
  const failedError = result.finalPayment?.failed_error ?? result.payment?.failed_error;
  if (!failedError) {
    return normalizeFiberPaymentFailure(checkError("payment did not reach paid state"), {
      diagnostics: result.diagnostics,
      stage: result.stage
    });
  }

  const error = new Error(failedError.message ?? "Fiber payment failed");
  error.code = failedError.code ?? failedError.error_code;
  error.details = {
    method: "get_payment",
    url: payerRpcUrl,
    error: failedError
  };
  return normalizeFiberPaymentFailure(error, {
    diagnostics: result.diagnostics,
    stage: result.stage
  });
}

function printResult(result) {
  console.log(
    JSON.stringify(
      {
        ok: result.ok,
        dry_run_only: result.dry_run_only,
        amount,
        payment_count: paymentCount,
        resolver_url: resolverUrl,
        offer_id: result.offer.offer_id,
        distinct_invoices: result.distinctInvoices,
        distinct_payment_hashes: result.distinctPaymentHashes,
        sessions: result.sessions.map((session) => ({
          session_id: session.session_id,
          payer_rpc_url: session.payer_rpc_url,
          resolution_id: session.invoice.resolution_id,
          invoice_mode: session.invoice.invoice_mode,
          invoice_payment_hash: session.invoice.payment_hash,
          dry_run_status: session.dryRun.status,
          payment_hash: session.payment?.payment_hash ?? session.dryRun.payment_hash,
          payment_status: session.finalPayment?.status ?? session.payment?.status,
          payment_failed_error: session.finalPayment?.failed_error ?? session.payment?.failed_error,
          merchant_invoice_status: session.finalInvoice?.status ?? session.resolverSync?.invoice_source?.fiber_status,
          resolver_status: session.resolverSync?.resolution?.status,
          resolver_changed: session.resolverSync?.changed,
          fee: session.finalPayment?.fee ?? session.payment?.fee ?? session.dryRun.fee,
          routers: session.finalPayment?.routers ?? session.payment?.routers ?? session.dryRun.routers,
          ok: session.ok
        })),
        trampoline_hops: trampolineHops,
        max_fee_amount: maxFeeAmount,
        max_fee_rate: maxFeeRate,
        diagnostics: result.diagnostics
      },
      null,
      2
    )
  );
}

function printFailure({ stage, failure, offer, invoice, diagnostics }) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        stage,
        failure,
        offer_id: offer?.offer_id,
        resolution_id: invoice?.resolution_id,
        invoice_payment_hash: invoice?.payment_hash,
        diagnostics
      },
      null,
      2
    )
  );
}

function paymentOptions() {
  return {
    timeoutSeconds,
    ...(trampolineHops.length > 0 ? { trampolineHops } : {}),
    ...(maxFeeAmount ? { maxFeeAmount } : {}),
    ...(maxFeeRate ? { maxFeeRate } : {})
  };
}

function authHeaders() {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

function sumHex(values) {
  return values.reduce((total, value) => total + hexValue(value), 0n);
}

function hexValue(value) {
  if (typeof value !== "string" || value.length === 0) return 0n;
  return BigInt(value);
}

function hexString(value) {
  return `0x${value.toString(16)}`;
}

function hexToDecimal(value) {
  if (typeof value !== "string" || !value.startsWith("0x")) return value;
  return BigInt(value).toString();
}

function csvList(value) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function trimTrailingSlash(value) {
  return String(value).replace(/\/+$/, "");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function checkError(message, details) {
  const error = new Error(message);
  error.code = "LIVE_FIBER_E2E_CHECK_FAILED";
  error.details = details;
  return error;
}

function failureError(failure) {
  const error = new Error(failure?.summary ?? failure?.message ?? "live Fiber payment session failed");
  error.code = failure?.code ?? "LIVE_FIBER_E2E_CHECK_FAILED";
  error.details = failure;
  return error;
}

function positiveInteger(value, fallback) {
  const number = Number(value ?? fallback);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error("FIBER_E2E_PAYMENT_COUNT must be a positive integer");
  return number;
}
