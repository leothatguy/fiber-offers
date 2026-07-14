import { FiberRpcClient } from "./fiber-payment.js";

export class FiberNodeDiagnosticsClient {
  constructor(options = {}) {
    this.rpc = options.rpc ?? new FiberRpcClient(options);
  }

  async inspectNode() {
    const [nodeInfo, peersResult, channelsResult, pendingChannelsResult] = await Promise.all([
      this.rpc.call("node_info", []),
      this.rpc.call("list_peers", []),
      this.rpc.call("list_channels", [{}]),
      this.rpc.call("list_channels", [{ only_pending: true }])
    ]);
    const peers = summarizePeers(peersResult);

    return {
      node: summarizeNodeInfo(nodeInfo),
      peers,
      channels: summarizeChannels(channelsResult, peers.pubkeys),
      pending_channels: summarizePendingChannels(pendingChannelsResult, peers.pubkeys)
    };
  }

  async payerDiagnostics() {
    const inspected = await this.inspectNode();
    return {
      payer: {
        rpc_url: this.rpc.url,
        pubkey: inspected.node.pubkey,
        peers_count: inspected.node.peers_count,
        channel_count: inspected.node.channel_count,
        peers: inspected.peers.pubkeys,
        channels: inspected.channels,
        pending_channels: inspected.pending_channels
      }
    };
  }
}

export function summarizeFiberChannels(channelsResult, peerPubkeys = []) {
  return summarizeChannels(channelsResult, peerPubkeys);
}

function summarizeNodeInfo(result) {
  return {
    node_id: result?.node_id,
    pubkey: result?.pubkey ?? result?.public_key,
    version: result?.version,
    network: result?.network,
    chain: result?.chain,
    peers_count: decimalString(result?.peers_count ?? result?.peers),
    channel_count: decimalString(result?.channel_count ?? result?.channels),
    open_channel_auto_accept_min_ckb_funding_amount: result?.open_channel_auto_accept_min_ckb_funding_amount,
    auto_accept_channel_ckb_funding_amount: result?.auto_accept_channel_ckb_funding_amount,
    addresses: result?.addresses
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

function summarizeChannels(result, peerPubkeys = []) {
  const channels = Array.isArray(result?.channels) ? result.channels : [];
  const ready = channels.filter((channel) => channel.state?.state_name === "ChannelReady");
  const enabled = ready.filter((channel) => channel.enabled !== false);
  const connectedPeers = new Set(peerPubkeys);
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

function summarizePendingChannels(result, peerPubkeys = []) {
  const channels = Array.isArray(result?.channels) ? result.channels : [];
  const opening = channels.filter((channel) => isOpeningChannel(channel));
  const failed = channels.filter((channel) => !isOpeningChannel(channel));
  const connectedPeers = new Set(peerPubkeys);

  return {
    total: channels.length,
    opening: opening.length,
    failed: failed.length,
    counterparties: summarizePendingChannelCounterparties(channels, connectedPeers)
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

function summarizePendingChannelCounterparties(channels, connectedPeers) {
  const byPubkey = new Map();

  for (const channel of channels) {
    const pubkey = channel.pubkey;
    if (!pubkey) continue;

    const current = byPubkey.get(pubkey) ?? {
      pubkey,
      channels: 0,
      opening: 0,
      failed: 0,
      local_balance_total: 0n,
      remote_balance_total: 0n,
      opening_local_balance_total: 0n,
      opening_remote_balance_total: 0n,
      states: new Set(),
      opening_states: new Set(),
      channel_ids: [],
      opening_channel_ids: [],
      failure_details: []
    };

    current.channels += 1;
    if (isOpeningChannel(channel)) {
      current.opening += 1;
      current.opening_local_balance_total += hexValue(channel.local_balance);
      current.opening_remote_balance_total += hexValue(channel.remote_balance);
      if (channel.state?.state_name) current.opening_states.add(channel.state.state_name);
      if (channel.channel_id) current.opening_channel_ids.push(channel.channel_id);
    } else {
      current.failed += 1;
    }
    current.local_balance_total += hexValue(channel.local_balance);
    current.remote_balance_total += hexValue(channel.remote_balance);
    if (channel.state?.state_name) current.states.add(channel.state.state_name);
    if (channel.channel_id) current.channel_ids.push(channel.channel_id);
    if (channel.failure_detail) current.failure_details.push(channel.failure_detail);
    byPubkey.set(pubkey, current);
  }

  return [...byPubkey.values()].map((counterparty) => ({
    pubkey: counterparty.pubkey,
    connected: connectedPeers.has(counterparty.pubkey),
    channels: counterparty.channels,
    opening: counterparty.opening,
    failed: counterparty.failed,
    local_balance_total: counterparty.local_balance_total.toString(),
    local_balance_total_hex: hexString(counterparty.local_balance_total),
    remote_balance_total: counterparty.remote_balance_total.toString(),
    remote_balance_total_hex: hexString(counterparty.remote_balance_total),
    opening_local_balance_total: counterparty.opening_local_balance_total.toString(),
    opening_local_balance_total_hex: hexString(counterparty.opening_local_balance_total),
    opening_remote_balance_total: counterparty.opening_remote_balance_total.toString(),
    opening_remote_balance_total_hex: hexString(counterparty.opening_remote_balance_total),
    states: [...counterparty.states],
    opening_states: [...counterparty.opening_states],
    channel_ids: counterparty.channel_ids,
    opening_channel_ids: counterparty.opening_channel_ids,
    failure_details: counterparty.failure_details
  }));
}

function isOpeningChannel(channel) {
  return channel?.state?.state_name !== "Closed" && !channel?.failure_detail;
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
