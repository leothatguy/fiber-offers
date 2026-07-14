import { createHash, randomBytes } from "node:crypto";
import { base64UrlEncode } from "../../../packages/protocol/src/index.js";
import { assetToFiberCurrency, FiberRpcClient, toHexQuantity } from "./fiber-rpc.js";

export class MockInvoiceAdapter {
  constructor(options = {}) {
    this.mode = "mock";
    this.invoiceTtlSeconds = options.invoiceTtlSeconds ?? 900;
    this.nodeId = options.nodeId;
  }

  async createInvoice({ offer, amount, asset }) {
    const preimage = randomBytes(32);
    const paymentHash = createHash("sha256").update(preimage).digest("hex");
    const nonce = base64UrlEncode(randomBytes(18));

    return {
      mode: this.mode,
      invoice: `fibermock_${offer.offer_id.slice(2, 10)}_${asset.symbol.toLowerCase()}_${amount}_${nonce}`,
      payment_request: `fibermock_${offer.offer_id.slice(2, 10)}_${asset.symbol.toLowerCase()}_${amount}_${nonce}`,
      payment_hash: `0x${paymentHash}`,
      expires_at: new Date(Date.now() + this.invoiceTtlSeconds * 1000).toISOString(),
      mocked: true
    };
  }

  async probe() {
    return {
      mode: this.mode,
      configured: false,
      reachable: false,
      status: "mock",
      message: "Mock invoices were explicitly enabled for isolated development or testing"
    };
  }

  async getNodeIdentity() {
    return this.nodeId ? { node_id: this.nodeId, verified: true, source: "mock-fixture" } : undefined;
  }

  async syncInvoice() {
    const error = new Error("invoice sync requires a Fiber RPC invoice adapter");
    error.code = "INVOICE_SYNC_UNSUPPORTED";
    error.status = 409;
    throw error;
  }
}

export class FiberRpcInvoiceAdapter {
  constructor(options) {
    this.mode = "fiber-rpc";
    this.method = options.method ?? "new_invoice";
    this.getInvoiceMethod = options.getInvoiceMethod ?? "get_invoice";
    this.probeMethod = options.probeMethod ?? "node_info";
    this.client = options.client ?? new FiberRpcClient(options);
  }

  async createInvoice({ offer, amount, asset }) {
    const params = {
      amount: toHexQuantity(amount),
      currency: assetToFiberCurrency(asset),
      description: offer.description ?? offer.offer_id
    };

    const result = await this.client.call(this.method, [params]);
    const invoice = extractInvoice(result);
    const paymentHash = extractPaymentHash(result);

    return {
      mode: this.mode,
      invoice,
      payment_request: invoice,
      payment_hash: paymentHash,
      rpc_method: this.method,
      rpc_params: params,
      raw_result: result,
      mocked: false
    };
  }

  async getNodeIdentity() {
    const result = await this.client.call(this.probeMethod, []);
    const nodeId = result?.pubkey ?? result?.public_key ?? result?.node_id;
    if (typeof nodeId !== "string" || !/^(02|03)[0-9a-fA-F]{64}$/.test(nodeId)) {
      const error = new Error("Fiber node_info response did not include a compressed identity public key");
      error.code = "FIBER_NODE_ID_UNAVAILABLE";
      error.status = 502;
      throw error;
    }
    return { node_id: nodeId.toLowerCase(), verified: true, source: this.probeMethod };
  }

  async probe() {
    try {
      const [result, peersProbe, channelsProbe] = await Promise.all([
        this.client.call(this.probeMethod, []),
        safeRpcCall(this.client, "list_peers", []),
        safeRpcCall(this.client, "list_channels", [{}])
      ]);
      const peers = peersProbe.ok ? summarizePeers(peersProbe.result) : undefined;
      const channels = channelsProbe.ok ? summarizeChannels(channelsProbe.result, peers?.pubkeys ?? []) : undefined;
      const warnings = fiberReadinessWarnings({ peersProbe, channelsProbe, peers, channels });

      return {
        mode: this.mode,
        configured: true,
        reachable: true,
        status: warnings.length > 0 ? "degraded" : "ok",
        method: this.probeMethod,
        result_summary: summarizeRpcResult(result),
        node: summarizeNodeInfo(result),
        peers,
        channels,
        warnings
      };
    } catch (error) {
      return {
        mode: this.mode,
        configured: true,
        reachable: false,
        status: "error",
        method: this.probeMethod,
        error: {
          code: error.code ?? "FIBER_RPC_PROBE_FAILED",
          message: error.message,
          details: error.details
        }
      };
    }
  }

  async syncInvoice(paymentHash) {
    if (typeof paymentHash !== "string" || paymentHash.length === 0) {
      const error = new Error("payment_hash is required to sync a Fiber invoice");
      error.code = "MISSING_PAYMENT_HASH";
      error.status = 409;
      throw error;
    }

    const result = await this.client.call(this.getInvoiceMethod, [{ payment_hash: paymentHash }]);
    const fiberStatus = extractFiberInvoiceStatus(result);

    return {
      mode: this.mode,
      payment_hash: paymentHash,
      status: mapFiberInvoiceStatus(fiberStatus),
      fiber_status: fiberStatus,
      invoice: safeExtractInvoice(result),
      amount: result?.invoice?.amount,
      currency: result?.invoice?.currency,
      get_invoice_method: this.getInvoiceMethod,
      raw_result: result
    };
  }
}

export function createInvoiceAdapter(env = process.env, options = {}) {
  const configuredMode = String(env.FIBER_INVOICE_MODE ?? "fiber-rpc").trim().toLowerCase();
  if (configuredMode === "mock") return new MockInvoiceAdapter();
  if (configuredMode !== "fiber-rpc") {
    const error = new Error("FIBER_INVOICE_MODE must be fiber-rpc or mock");
    error.code = "INVALID_FIBER_INVOICE_MODE";
    throw error;
  }

  const rpcUrl = env.FIBER_RPC_URL ?? env.MERCHANT_FIBER_RPC_URL;
  if (rpcUrl) {
    return new FiberRpcInvoiceAdapter({
      url: rpcUrl,
      username: env.FIBER_RPC_USERNAME ?? env.MERCHANT_FIBER_RPC_USERNAME,
      password: env.FIBER_RPC_PASSWORD ?? env.MERCHANT_FIBER_RPC_PASSWORD,
      method: env.FIBER_RPC_INVOICE_METHOD ?? "new_invoice",
      getInvoiceMethod: env.FIBER_RPC_GET_INVOICE_METHOD ?? "get_invoice",
      probeMethod: env.FIBER_RPC_PROBE_METHOD ?? "node_info",
      fetchImpl: options.fetchImpl
    });
  }

  const error = new Error("FIBER_RPC_URL or MERCHANT_FIBER_RPC_URL is required in live Fiber RPC mode");
  error.code = "FIBER_RPC_URL_REQUIRED";
  throw error;
}

async function safeRpcCall(client, method, params) {
  try {
    return {
      ok: true,
      result: await client.call(method, params)
    };
  } catch (error) {
    return {
      ok: false,
      error: publicRpcError(error)
    };
  }
}

function summarizeRpcResult(result) {
  if (result === null || result === undefined) return result;
  if (typeof result !== "object") return result;

  const summary = {};
  for (const key of [
    "node_id",
    "pubkey",
    "public_key",
    "version",
    "chain",
    "network",
    "addresses",
    "peers",
    "channels",
    "peers_count",
    "channel_count"
  ]) {
    if (result[key] !== undefined) summary[key] = result[key];
  }

  return Object.keys(summary).length > 0 ? summary : { keys: Object.keys(result).slice(0, 12) };
}

function summarizeNodeInfo(result) {
  if (!result || typeof result !== "object") return undefined;

  return {
    node_id: result.node_id,
    pubkey: result.pubkey ?? result.public_key,
    version: result.version,
    network: result.network,
    chain: result.chain,
    peers_count: decimalString(result.peers_count ?? result.peers),
    channel_count: decimalString(result.channel_count ?? result.channels),
    addresses: result.addresses
  };
}

function summarizePeers(result) {
  const peers = Array.isArray(result?.peers) ? result.peers : [];
  const pubkeys = peers.map((peer) => peer.pubkey).filter(Boolean);

  return {
    count: peers.length,
    pubkeys,
    peers: peers.map((peer) => ({
      pubkey: peer.pubkey,
      address: peer.address
    }))
  };
}

function summarizeChannels(result, connectedPeerPubkeys = []) {
  const channels = Array.isArray(result?.channels) ? result.channels : [];
  const ready = channels.filter((channel) => channel.state?.state_name === "ChannelReady");
  const enabled = ready.filter((channel) => channel.enabled !== false);
  const connectedPeers = new Set(connectedPeerPubkeys);
  const counterparties = summarizeChannelCounterparties(enabled, connectedPeers);
  const localBalance = sumHex(enabled.map((channel) => channel.local_balance));
  const remoteBalance = sumHex(enabled.map((channel) => channel.remote_balance));

  return {
    total: channels.length,
    ready: ready.length,
    enabled: enabled.length,
    disabled: ready.length - enabled.length,
    public: enabled.filter((channel) => channel.is_public).length,
    private: enabled.filter((channel) => !channel.is_public).length,
    ckb: enabled.filter((channel) => !channel.funding_udt_type_script).length,
    udt: enabled.filter((channel) => channel.funding_udt_type_script).length,
    usable_outbound: enabled.filter((channel) => hexValue(channel.local_balance) > 0n).length,
    usable_inbound: enabled.filter((channel) => hexValue(channel.remote_balance) > 0n).length,
    local_balance_total: localBalance.toString(),
    local_balance_total_hex: hexString(localBalance),
    remote_balance_total: remoteBalance.toString(),
    remote_balance_total_hex: hexString(remoteBalance),
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

function fiberReadinessWarnings({ peersProbe, channelsProbe, peers, channels }) {
  const warnings = [];

  if (!peersProbe.ok) {
    warnings.push({
      code: "PEER_DIAGNOSTICS_UNAVAILABLE",
      message: "list_peers failed; peer reachability could not be checked",
      error: peersProbe.error
    });
  } else if (peers.count === 0) {
    warnings.push({
      code: "NO_CONNECTED_PEERS",
      message: "Fiber node has no connected peers"
    });
  }

  if (!channelsProbe.ok) {
    warnings.push({
      code: "CHANNEL_DIAGNOSTICS_UNAVAILABLE",
      message: "list_channels failed; channel capacity could not be checked",
      error: channelsProbe.error
    });
    return warnings;
  }

  if (channels.enabled === 0) {
    warnings.push({
      code: "NO_ENABLED_CHANNELS",
      message: "Fiber node has no enabled ready channels"
    });
    return warnings;
  }

  if (channels.usable_outbound === 0) {
    warnings.push({
      code: "NO_OUTBOUND_LIQUIDITY",
      message: "Enabled channels have no local balance available for outbound payments"
    });
  }

  if (channels.usable_inbound === 0) {
    warnings.push({
      code: "NO_INBOUND_LIQUIDITY",
      message: "Enabled channels have no remote balance available for inbound payments"
    });
  }

  if (channels.public === 0) {
    warnings.push({
      code: "NO_PUBLIC_CHANNELS",
      message: "Fiber node has no public enabled channels for route discovery"
    });
  }

  if (channels.offline_counterparties.length > 0) {
    warnings.push({
      code: "OFFLINE_CHANNEL_COUNTERPARTIES",
      message: "Some enabled channel counterparties are not currently connected as peers",
      pubkeys: channels.offline_counterparties
    });
  }

  return warnings;
}

function extractInvoice(result) {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") {
    throw rpcShapeError(result);
  }

  const invoice =
    result.invoice_address ??
    result.invoice ??
    result.payment_request ??
    result.encoded_invoice ??
    result.bolt11 ??
    result.data?.invoice_address ??
    result.data?.invoice ??
    result.data?.payment_request;

  if (typeof invoice !== "string" || invoice.length === 0) {
    throw rpcShapeError(result);
  }

  return invoice;
}

function extractPaymentHash(result) {
  if (!result || typeof result !== "object") return undefined;

  const paymentHash =
    result.payment_hash ??
    result.invoice?.data?.payment_hash ??
    result.invoice?.payment_hash ??
    result.data?.payment_hash ??
    result.data?.invoice?.data?.payment_hash;

  return typeof paymentHash === "string" && paymentHash.length > 0 ? paymentHash : undefined;
}

function safeExtractInvoice(result) {
  try {
    return extractInvoice(result);
  } catch {
    return undefined;
  }
}

function extractFiberInvoiceStatus(result) {
  const status = result?.status ?? result?.invoice_status ?? result?.data?.status;
  if (typeof status !== "string" || status.length === 0) {
    const error = new Error("Fiber RPC get_invoice response did not include an invoice status");
    error.code = "INVALID_FIBER_RPC_RESPONSE";
    error.status = 502;
    error.details = result;
    throw error;
  }

  return status;
}

export function mapFiberInvoiceStatus(status) {
  const normalized = String(status).trim().toLowerCase();
  if (normalized === "open") return "invoice_created";
  if (normalized === "received") return "invoice_received";
  if (normalized === "paid") return "invoice_paid";
  if (normalized === "expired") return "invoice_expired";
  if (normalized === "cancelled" || normalized === "canceled") return "invoice_cancelled";
  if (normalized === "failed") return "invoice_failed";

  const error = new Error(`unsupported Fiber invoice status: ${status}`);
  error.code = "UNSUPPORTED_FIBER_INVOICE_STATUS";
  error.status = 502;
  error.details = { status };
  throw error;
}

function rpcShapeError(result) {
  const error = new Error("Fiber RPC response did not include an invoice string");
  error.code = "INVALID_FIBER_RPC_RESPONSE";
  error.status = 502;
  error.details = result;
  return error;
}

function publicRpcError(error) {
  return {
    code: error.code ?? "FIBER_RPC_ERROR",
    message: error.message,
    details: error.details
  };
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

function decimalString(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") return String(value);
  if (typeof value !== "string") return value;
  return value.startsWith("0x") ? BigInt(value).toString() : value;
}
