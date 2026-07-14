import { FiberNodeDiagnosticsClient } from "./fiber-diagnostics.js";
import { FiberPaymentClient, toFiberDecimalQuantity, toFiberHexQuantity } from "./fiber-payment.js";

export class FiberTopologyClient {
  constructor(options = {}) {
    this.merchantOptions = endpointOptions(options.merchant ?? options.merchantRpcUrl, options.fetchImpl);
    this.payerOptions = endpointOptions(options.payer ?? options.payerRpcUrl, options.fetchImpl);
    this.merchantRpcUrl = this.merchantOptions.url;
    this.payerRpcUrl = this.payerOptions.url;
    this.merchant = options.merchantClient ?? new FiberNodeDiagnosticsClient(this.merchantOptions);
    this.payer = options.payerClient ?? new FiberNodeDiagnosticsClient(this.payerOptions);
    this.paymentClient = options.paymentClient;
  }

  async inspectPair() {
    const [merchant, payer] = await Promise.all([this.merchant.inspectNode(), this.payer.inspectNode()]);
    return analyzeFiberTopology({
      merchant,
      payer,
      merchantRpcUrl: this.merchantRpcUrl,
      payerRpcUrl: this.payerRpcUrl
    });
  }

  async checkInvoiceRoute(invoice, options = {}) {
    const { paymentClient = this.paymentClient ?? new FiberPaymentClient(this.payerOptions), ...paymentOptions } = options;
    const topology = await this.inspectPair();
    const route = await paymentClient.checkPaymentRoute(invoice, {
      ...paymentOptions,
      diagnostics: topology.diagnostics
    });

    return {
      ...topology,
      route_check: route
    };
  }
}

export function analyzeFiberTopology(input = {}) {
  const merchant = normalizeRole("merchant", input.merchant, input.merchantRpcUrl);
  const payer = normalizeRole("payer", input.payer, input.payerRpcUrl);
  const payerCounterparties = counterpartyPubkeys(payer.channels);
  const merchantCounterparties = counterpartyPubkeys(merchant.channels);
  const commonCounterparties = payerCounterparties.filter((pubkey) => merchantCounterparties.includes(pubkey));
  const commonOnlineFromPayer = commonCounterparties.filter((pubkey) => payer.peers.includes(pubkey));
  const commonOnlineFromMerchant = commonCounterparties.filter((pubkey) => merchant.peers.includes(pubkey));
  const commonOnlineBoth = commonCounterparties.filter(
    (pubkey) => payer.peers.includes(pubkey) && merchant.peers.includes(pubkey)
  );
  const direct = directChannelReport({ merchant, payer });
  const blockers = topologyBlockers({ merchant, payer, direct, commonCounterparties, commonOnlineBoth });
  const warnings = topologyWarnings({ merchant, payer, direct, commonCounterparties, commonOnlineBoth });
  const nextActions = uniqueActions([
    ...blockers.flatMap((issue) => issue.next_actions ?? []),
    ...warnings.flatMap((issue) => issue.next_actions ?? []),
    "Run a Fiber send_payment dry-run against a fresh invoice before sending funds."
  ]);
  const deterministicLocalPayment = direct.usable_for_payer_to_merchant || commonOnlineBoth.length > 0;
  const status = direct.opening ? "opening" : blockers.length > 0 ? "blocked" : warnings.length > 0 ? "degraded" : "ready";

  return {
    ok: status !== "blocked",
    status,
    summary: topologySummary({
      direct,
      commonCounterparties,
      commonOnlineBoth,
      blockers,
      warnings
    }),
    readiness: {
      deterministic_local_payment: deterministicLocalPayment,
      direct_channel_ready: direct.usable_for_payer_to_merchant,
      direct_channel_opening: direct.opening,
      shared_online_counterparty_count: commonOnlineBoth.length,
      dry_run_required: true
    },
    merchant,
    payer,
    direct_channel: direct,
    common_channel_counterparties: commonCounterparties,
    online_common_channel_counterparties: commonOnlineBoth,
    route_candidates: {
      direct: direct.usable_for_payer_to_merchant
        ? {
            payer_pubkey: payer.pubkey,
            merchant_pubkey: merchant.pubkey,
            payer_local_balance_total: direct.payer_local_balance_total,
            payer_local_balance_total_hex: direct.payer_local_balance_total_hex
          }
        : undefined,
      shared_counterparties: commonCounterparties.map((pubkey) => ({
        pubkey,
        online_from_payer: commonOnlineFromPayer.includes(pubkey),
        online_from_merchant: commonOnlineFromMerchant.includes(pubkey),
        online_from_both: commonOnlineBoth.includes(pubkey)
      }))
    },
    blockers,
    warnings,
    next_actions: nextActions,
    fixture_recommendation: deterministicFixtureRecommendation({ merchant, payer, direct }),
    diagnostics: {
      merchant: diagnosticsRole(merchant),
      payer: diagnosticsRole(payer),
      direct_channel: {
        merchant_to_payer: direct.merchant_to_payer,
        payer_to_merchant: direct.payer_to_merchant
      },
      common_channel_counterparties: commonCounterparties
    }
  };
}

function endpointOptions(endpoint, fetchImpl) {
  if (typeof endpoint === "string") {
    return {
      url: endpoint,
      fetchImpl
    };
  }

  return {
    ...(endpoint ?? {}),
    fetchImpl: endpoint?.fetchImpl ?? fetchImpl
  };
}

function normalizeRole(role, inspected = {}, rpcUrl) {
  const node = inspected.node ?? inspected[role]?.node ?? {};
  const peers = inspected.peers ?? inspected[role]?.peers ?? {};
  const channels = inspected.channels ?? inspected[role]?.channels ?? {};
  const pendingChannels = inspected.pending_channels ?? inspected[role]?.pending_channels ?? {};
  const peerPubkeys = Array.isArray(peers) ? peers : peers.pubkeys ?? inspected[role]?.peers ?? [];

  return {
    rpc_url: rpcUrl ?? inspected.rpc_url ?? inspected[role]?.rpc_url,
    pubkey: node.pubkey ?? inspected.pubkey ?? inspected[role]?.pubkey,
    node_id: node.node_id,
    version: node.version,
    network: node.network,
    chain: node.chain,
    peers_count: node.peers_count ?? inspected.peers_count ?? inspected[role]?.peers_count ?? String(peerPubkeys.length),
    channel_count:
      node.channel_count ?? inspected.channel_count ?? inspected[role]?.channel_count ?? numberString(channels.total),
    open_channel_auto_accept_min_ckb_funding_amount: node.open_channel_auto_accept_min_ckb_funding_amount,
    auto_accept_channel_ckb_funding_amount: node.auto_accept_channel_ckb_funding_amount,
    addresses: node.addresses,
    peers: peerPubkeys,
    peer_details: Array.isArray(peers) ? inspected.peer_details ?? [] : peers.peers ?? inspected.peer_details ?? [],
    channels: normalizeChannels(channels),
    pending_channels: normalizePendingChannels(pendingChannels)
  };
}

export function planDirectChannelFixture(topology, options = {}) {
  const fundingAmount = fixtureFundingAmount(topology, options);
  const publicChannel = Boolean(options.publicChannel ?? options.public_channel ?? false);
  const oneWay = Boolean(options.oneWay ?? options.one_way ?? false);
  const merchantPeerAddress =
    options.merchantPeerAddress ??
    options.merchant_peer_address ??
    topology?.merchant?.peer_details?.find((peer) => peer.pubkey === topology?.merchant?.pubkey)?.address ??
    topology?.payer?.peer_details?.find((peer) => peer.pubkey === topology?.merchant?.pubkey)?.address;
  const payerRpcUrl = options.payerRpcUrl ?? options.payer_rpc_url ?? topology?.payer?.rpc_url;
  const merchantRpcUrl = options.merchantRpcUrl ?? options.merchant_rpc_url ?? topology?.merchant?.rpc_url;
  const merchantPubkey = options.merchantPubkey ?? options.merchant_pubkey ?? topology?.merchant?.pubkey;
  const alreadyReady = Boolean(topology?.direct_channel?.usable_for_payer_to_merchant);
  const alreadyOpening = Boolean(topology?.direct_channel?.opening);
  const stalledOpening = Boolean(topology?.direct_channel?.partial_opening);
  const acceptCandidate = directChannelAcceptCandidate(topology?.direct_channel);
  const connectNeeded = !topology?.direct_channel?.payer_connected_to_merchant;
  const acceptNeeded = Boolean(acceptCandidate);
  const openNeeded = !alreadyReady && !alreadyOpening && !stalledOpening;
  const fundingAmountDecimal = fundingAmount ? toFiberDecimalQuantity(fundingAmount) : undefined;
  const fundingAmountHex = fundingAmount ? toFiberHexQuantity(fundingAmount) : undefined;
  const acceptFundingAmount = fixtureAcceptFundingAmount(topology, options);
  const acceptFundingAmountDecimal = acceptFundingAmount ? toFiberDecimalQuantity(acceptFundingAmount) : undefined;
  const acceptFundingAmountHex = acceptFundingAmount ? toFiberHexQuantity(acceptFundingAmount) : undefined;
  const missing = [];

  if (!payerRpcUrl) missing.push("payer_rpc_url");
  if (!merchantRpcUrl) missing.push("merchant_rpc_url");
  if (!merchantPubkey) missing.push("merchant_pubkey");
  if (connectNeeded && !merchantPeerAddress) missing.push("merchant_peer_address");
  if (openNeeded && !fundingAmount) missing.push("funding_amount");
  if (acceptNeeded && !acceptFundingAmount) missing.push("accept_funding_amount");

  const openChannelParams = openNeeded
    ? cleanUndefined({
        pubkey: merchantPubkey,
        funding_amount: fundingAmountHex,
        public: publicChannel,
        one_way: oneWay
      })
    : undefined;
  const connectPeerParams = connectNeeded
    ? cleanUndefined({
        address: merchantPeerAddress,
        save: true
      })
    : undefined;
  const acceptChannelParams = acceptNeeded
    ? cleanUndefined({
        temporary_channel_id: acceptCandidate.channelId,
        funding_amount: acceptFundingAmountHex
      })
    : undefined;
  const steps = [];

  if (connectNeeded) {
    steps.push({
      id: "connect_peer",
      rpc_url: payerRpcUrl,
      rpc_method: "connect_peer",
      rpc_params: connectPeerParams,
      command: connectPeerCommand(payerRpcUrl, merchantPeerAddress)
    });
  }

  if (openNeeded) {
    steps.push({
      id: "open_channel",
      rpc_url: payerRpcUrl,
      rpc_method: "open_channel",
      rpc_params: openChannelParams,
      command: openChannelCommand({
        payerRpcUrl,
        merchantPubkey,
        fundingAmount: fundingAmountDecimal,
        publicChannel,
        oneWay
      })
    });
  }

  if (acceptNeeded) {
    steps.push({
      id: "accept_channel",
      rpc_url: merchantRpcUrl,
      rpc_method: "accept_channel",
      rpc_params: acceptChannelParams,
      command: acceptChannelCommand({
        merchantRpcUrl,
        temporaryChannelId: acceptCandidate.channelId,
        fundingAmount: acceptFundingAmountDecimal
      })
    });
  }

  const status = alreadyReady
    ? "already_ready"
    : missing.length > 0
      ? "missing_input"
      : acceptNeeded
        ? "ready_to_accept"
        : alreadyOpening
          ? "already_opening"
          : stalledOpening
            ? "stalled_opening"
            : "ready_to_execute";

  return {
    ok: status !== "missing_input",
    status,
    execute_guard: "FIBER_FIXTURE_OPEN_DIRECT_CHANNEL=true",
    summary: directFixturePlanSummary(status),
    already_ready: alreadyReady,
    already_opening: alreadyOpening,
    stalled_opening: stalledOpening,
    accept_needed: acceptNeeded,
    connect_needed: connectNeeded,
    open_needed: openNeeded,
    missing,
    payer_rpc_url: payerRpcUrl,
    merchant_rpc_url: merchantRpcUrl,
    merchant_pubkey: merchantPubkey,
    merchant_peer_address: merchantPeerAddress,
    funding_amount: fundingAmountDecimal,
    funding_amount_hex: fundingAmountHex,
    accept_temporary_channel_id: acceptCandidate?.channelId,
    accept_funding_amount: acceptFundingAmountDecimal,
    accept_funding_amount_hex: acceptFundingAmountHex,
    public_channel: publicChannel,
    one_way: oneWay,
    steps,
    post_checks: [
      "Re-run npm run fiber:topology-check.",
      "Request a fresh invoice.",
      "Run FIBER_E2E_DRY_RUN_ONLY=true npm run fiber:e2e-check before sending a real payment."
    ],
    warning:
      "Opening a Fiber channel can mutate Fiber/on-chain state and requires spendable funding capacity on the payer node."
  };
}

function normalizeChannels(channels = {}) {
  return {
    total: numberValue(channels.total),
    ready: numberValue(channels.ready),
    enabled: numberValue(channels.enabled),
    disabled: numberValue(channels.disabled),
    public: numberValue(channels.public),
    private: numberValue(channels.private),
    ckb: numberValue(channels.ckb),
    udt: numberValue(channels.udt),
    usable_outbound: numberValue(channels.usable_outbound),
    usable_inbound: numberValue(channels.usable_inbound),
    local_balance_total: stringValue(channels.local_balance_total, "0"),
    local_balance_total_hex: stringValue(channels.local_balance_total_hex, "0x0"),
    remote_balance_total: stringValue(channels.remote_balance_total, "0"),
    remote_balance_total_hex: stringValue(channels.remote_balance_total_hex, "0x0"),
    pending_tlc_count: numberValue(channels.pending_tlc_count),
    counterparties: Array.isArray(channels.counterparties) ? channels.counterparties : [],
    offline_counterparties: Array.isArray(channels.offline_counterparties) ? channels.offline_counterparties : []
  };
}

function normalizePendingChannels(channels = {}) {
  return {
    total: numberValue(channels.total),
    opening: numberValue(channels.opening),
    failed: numberValue(channels.failed),
    counterparties: Array.isArray(channels.counterparties) ? channels.counterparties : []
  };
}

function diagnosticsRole(role) {
  return {
    rpc_url: role.rpc_url,
    pubkey: role.pubkey,
    peers_count: role.peers_count,
    channel_count: role.channel_count,
    peers: role.peers,
    channels: role.channels,
    pending_channels: role.pending_channels
  };
}

function directChannelReport({ merchant, payer }) {
  const payerView = counterpartyByPubkey(payer.channels, merchant.pubkey);
  const merchantView = counterpartyByPubkey(merchant.channels, payer.pubkey);
  const pendingPayerView = openingCounterpartyByPubkey(payer.pending_channels, merchant.pubkey);
  const pendingMerchantView = openingCounterpartyByPubkey(merchant.pending_channels, payer.pubkey);
  const payerLocal = balanceValue(payerView?.local_balance_total_hex ?? payerView?.local_balance_total);
  const merchantRemote = balanceValue(merchantView?.remote_balance_total_hex ?? merchantView?.remote_balance_total);
  const payerConnected = Boolean(merchant.pubkey && payer.peers.includes(merchant.pubkey));
  const merchantConnected = Boolean(payer.pubkey && merchant.peers.includes(payer.pubkey));
  const opening = Boolean(pendingPayerView && pendingMerchantView);
  const partialOpening = Boolean((pendingPayerView && !pendingMerchantView) || (!pendingPayerView && pendingMerchantView));

  return {
    payer_to_merchant: Boolean(payerView),
    merchant_to_payer: Boolean(merchantView),
    pending_payer_to_merchant: Boolean(pendingPayerView),
    pending_merchant_to_payer: Boolean(pendingMerchantView),
    opening,
    partial_opening: partialOpening,
    ready: Boolean(payerView && merchantView),
    payer_connected_to_merchant: payerConnected,
    merchant_connected_to_payer: merchantConnected,
    usable_for_payer_to_merchant: Boolean(payerView && payerLocal > 0n && payerConnected),
    payer_local_balance_total: payerLocal.toString(),
    payer_local_balance_total_hex: hexString(payerLocal),
    merchant_remote_balance_total: merchantRemote.toString(),
    merchant_remote_balance_total_hex: hexString(merchantRemote),
    payer_view: payerView,
    merchant_view: merchantView,
    pending_payer_view: pendingPayerView,
    pending_merchant_view: pendingMerchantView
  };
}

function topologyBlockers({ merchant, payer, direct, commonCounterparties, commonOnlineBoth }) {
  const blockers = [];

  if (!payer.pubkey) {
    blockers.push(issue("PAYER_PUBKEY_UNAVAILABLE", "The payer node pubkey could not be read.", [
      "Check the payer Fiber RPC URL and node_info response."
    ]));
  }

  if (!merchant.pubkey) {
    blockers.push(issue("MERCHANT_PUBKEY_UNAVAILABLE", "The merchant node pubkey could not be read.", [
      "Check the merchant Fiber RPC URL and node_info response."
    ]));
  }

  if (payer.channels.enabled === 0) {
    blockers.push(issue("PAYER_NO_ENABLED_CHANNELS", "The payer node has no enabled ready channels.", [
      "Open or restore at least one ready payer channel before attempting payment."
    ]));
  }

  if (payer.channels.usable_outbound === 0) {
    blockers.push(issue("PAYER_NO_OUTBOUND_LIQUIDITY", "The payer node has no enabled channel with local balance.", [
      "Open, fund, or rebalance a payer channel with outbound CKB/asset capacity."
    ]));
  }

  if (merchant.channels.enabled === 0) {
    blockers.push(issue("MERCHANT_NO_ENABLED_CHANNELS", "The merchant node has no enabled ready channels.", [
      "Open or restore at least one ready merchant channel before requesting live payments."
    ]));
  }

  if (direct.partial_opening) {
    blockers.push(
      issue(
        "DIRECT_CHANNEL_HANDSHAKE_STALLED",
        "A direct-channel opening is visible from only one node; the funding handshake is not synchronized.",
        [
          "Inspect the pending channel on the node that still sees it.",
          "Abort or let the stale pending channel expire before opening another direct channel.",
          "When retrying, fund the new channel at or above the merchant auto-accept minimum."
        ],
        {
          payer_view: direct.pending_payer_view,
          merchant_view: direct.pending_merchant_view
        }
      )
    );
  }

  if (direct.opening) {
    return blockers;
  }

  if (!direct.usable_for_payer_to_merchant && commonCounterparties.length === 0) {
    blockers.push(
      issue(
        "NO_DIRECT_OR_SHARED_LOCAL_ROUTE",
        "The payer and merchant do not have a direct channel or an obvious shared local counterparty.",
        [
          "Open a direct payer-to-merchant channel for deterministic local tests.",
          "Alternatively connect both nodes to a shared online routing counterparty and retry dry-run."
        ]
      )
    );
  }

  if (!direct.usable_for_payer_to_merchant && commonCounterparties.length > 0 && commonOnlineBoth.length === 0) {
    blockers.push(
      issue(
        "SHARED_COUNTERPARTY_OFFLINE",
        "A shared channel counterparty exists, but it is not connected to both nodes as a live peer.",
        [
          "Connect the payer and merchant to the shared counterparty or restart the offline peer.",
          "Open a direct payer-to-merchant channel when a deterministic fixture is preferred."
        ],
        { common_channel_counterparties: commonCounterparties }
      )
    );
  }

  return blockers;
}

function topologyWarnings({ merchant, payer, direct, commonCounterparties, commonOnlineBoth }) {
  const warnings = [];

  if (!direct.ready) {
    if (direct.opening) {
      warnings.push(
        issue(
          "DIRECT_CHANNEL_OPENING",
          "A direct payer-to-merchant channel opening is in progress but is not ready yet.",
          [
            "Wait for the channel to leave the funding negotiation/confirmation state.",
            "Re-run the topology check before attempting another route dry-run."
          ],
          {
            payer_view: direct.pending_payer_view,
            merchant_view: direct.pending_merchant_view
          }
        )
      );
    } else if (!direct.partial_opening) {
      warnings.push(issue("NO_DIRECT_CHANNEL", "No ready direct payer-to-merchant channel is visible from both nodes.", [
        "Use a direct channel when you need deterministic local e2e settlement."
      ]));
    }
  } else if (!direct.usable_for_payer_to_merchant) {
    warnings.push(
      issue("DIRECT_CHANNEL_NOT_USABLE", "A direct channel exists, but it is not currently usable by the payer.", [
        "Confirm the payer is connected to the merchant and has local balance in the direct channel."
      ])
    );
  }

  if (merchant.peers.length === 0) {
    warnings.push(issue("MERCHANT_NO_CONNECTED_PEERS", "The merchant node has no connected peers.", [
      "Connect the merchant node to the payer or a routing peer."
    ]));
  }

  if (payer.peers.length === 0) {
    warnings.push(issue("PAYER_NO_CONNECTED_PEERS", "The payer node has no connected peers.", [
      "Connect the payer node to the merchant or a routing peer."
    ]));
  }

  if (merchant.channels.usable_inbound === 0) {
    warnings.push(issue("MERCHANT_NO_VISIBLE_INBOUND", "The merchant has no enabled channel with remote balance.", [
      "Add or rebalance inbound capacity toward the merchant before expecting incoming payments."
    ]));
  }

  if (payer.channels.pending_tlc_count > 0 || merchant.channels.pending_tlc_count > 0) {
    warnings.push(
      issue("PENDING_TLCS", "At least one node has pending TLCs that can reduce available liquidity.", [
        "Wait for pending TLCs to settle or inspect stuck payments before retrying."
      ])
    );
  }

  if (commonCounterparties.length > 0 && commonOnlineBoth.length === 0) {
    warnings.push(
      issue("NO_ONLINE_SHARED_COUNTERPARTY", "Shared channel counterparties are not online from both nodes.", [
        "Reconnect the offline shared counterparty or use a direct channel fixture."
      ])
    );
  }

  if (payer.channels.offline_counterparties.length > 0 || merchant.channels.offline_counterparties.length > 0) {
    warnings.push(
      issue("OFFLINE_CHANNEL_COUNTERPARTIES", "Some ready channel counterparties are not connected as peers.", [
        "Reconnect offline channel counterparties before relying on routed payment tests."
      ])
    );
  }

  return warnings;
}

function deterministicFixtureRecommendation({ merchant, payer, direct }) {
  const acceptCandidate = directChannelAcceptCandidate(direct);

  return {
    direct_payer_to_merchant_channel: {
      needed: !direct.usable_for_payer_to_merchant && !direct.opening && !direct.partial_opening,
      ready: direct.usable_for_payer_to_merchant,
      opening: direct.opening,
      stalled_opening: direct.partial_opening,
      accept_needed: Boolean(acceptCandidate),
      accept_temporary_channel_id: acceptCandidate?.channelId,
      payer_rpc_url: payer.rpc_url,
      merchant_rpc_url: merchant.rpc_url,
      payer_pubkey: payer.pubkey,
      merchant_pubkey: merchant.pubkey,
      recommended_funding_amount:
        merchant.open_channel_auto_accept_min_ckb_funding_amount ?? merchant.auto_accept_channel_ckb_funding_amount,
      reason: direct.usable_for_payer_to_merchant
        ? "A connected direct channel with payer outbound liquidity is already visible."
        : acceptCandidate
          ? "A direct-channel opening is waiting for merchant acceptance."
          : direct.opening
          ? "A direct channel is already opening; wait for it to become ready before sending payments."
          : direct.partial_opening
            ? "A direct-channel opening is only visible from one node; clean up the stale pending state before retrying."
            : "A direct channel gives local tests a deterministic first hop and avoids depending on external route graph state.",
      next_actions: direct.usable_for_payer_to_merchant
        ? ["Request a fresh invoice and run a send_payment dry-run from the payer node."]
        : acceptCandidate
          ? [
              "Accept the pending direct channel from the merchant node.",
              "Re-run the topology check and wait for ChannelReady.",
              "Run a send_payment dry-run against a fresh invoice."
            ]
          : direct.opening
          ? [
              "Wait for the direct channel to reach ChannelReady.",
              "Re-run the topology check, then run the route check against a fresh invoice."
            ]
          : direct.partial_opening
            ? [
                "Inspect the node that still shows the pending direct channel.",
                "Abort or wait out the stale pending channel before opening another direct channel.",
                "Retry with a funding amount at or above the merchant auto-accept minimum."
              ]
            : [
                "Connect payer and merchant nodes as peers.",
                "Open or rebalance a direct CKB channel from payer to merchant with payer outbound capacity.",
                "Re-run the topology check, then run the route check against a fresh invoice."
              ]
    }
  };
}

function fixtureFundingAmount(topology, options) {
  const configured =
    options.fundingAmount ??
    options.funding_amount ??
    options.channelFundingAmount ??
    options.channel_funding_amount;
  if (configured !== undefined && configured !== null && String(configured).length > 0) return configured;

  return (
    topology?.merchant?.open_channel_auto_accept_min_ckb_funding_amount ??
    topology?.merchant?.auto_accept_channel_ckb_funding_amount
  );
}

function fixtureAcceptFundingAmount(topology, options) {
  const configured =
    options.acceptFundingAmount ??
    options.accept_funding_amount ??
    options.merchantAcceptFundingAmount ??
    options.merchant_accept_funding_amount;
  if (configured !== undefined && configured !== null && String(configured).length > 0) return configured;

  return (
    topology?.merchant?.auto_accept_channel_ckb_funding_amount ??
    topology?.merchant?.open_channel_auto_accept_min_ckb_funding_amount
  );
}

function directChannelAcceptCandidate(direct = {}) {
  const merchantView = direct.pending_merchant_view;
  if (!merchantView || (merchantView.opening ?? 0) <= 0) return undefined;

  const states = merchantView.opening_states ?? merchantView.states ?? [];
  if (!states.includes("NegotiatingFunding")) return undefined;

  const channelId = (merchantView.opening_channel_ids ?? merchantView.channel_ids ?? [])[0];
  if (!channelId) return undefined;

  return {
    channelId,
    merchant_view: merchantView
  };
}

function directFixturePlanSummary(status) {
  if (status === "already_ready") return "A usable direct payer-to-merchant channel already exists.";
  if (status === "ready_to_accept") return "A direct-channel opening is waiting for merchant acceptance.";
  if (status === "already_opening") return "A direct payer-to-merchant channel is already opening.";
  if (status === "stalled_opening") return "A direct-channel opening is stalled because only one node still sees it.";
  if (status === "missing_input") return "The direct-channel fixture needs additional inputs before it can run.";
  return "The direct-channel fixture is ready to execute when the explicit guard is enabled.";
}

function connectPeerCommand(payerRpcUrl, merchantPeerAddress) {
  if (!payerRpcUrl || !merchantPeerAddress) return undefined;
  return `fnn-cli -u ${shellQuote(payerRpcUrl)} peer connect_peer --address ${shellQuote(merchantPeerAddress)}`;
}

function openChannelCommand({ payerRpcUrl, merchantPubkey, fundingAmount, publicChannel, oneWay }) {
  if (!payerRpcUrl || !merchantPubkey || !fundingAmount) return undefined;
  const flags = [
    "fnn-cli",
    "-u",
    shellQuote(payerRpcUrl),
    "channel",
    "open_channel",
    "--pubkey",
    shellQuote(merchantPubkey),
    "--funding-amount",
    shellQuote(String(fundingAmount)),
    "--public",
    String(publicChannel)
  ];
  if (oneWay) flags.push("--one-way", "true");
  return flags.join(" ");
}

function acceptChannelCommand({ merchantRpcUrl, temporaryChannelId, fundingAmount }) {
  if (!merchantRpcUrl || !temporaryChannelId || !fundingAmount) return undefined;
  return [
    "fnn-cli",
    "-u",
    shellQuote(merchantRpcUrl),
    "channel",
    "accept_channel",
    "--temporary-channel-id",
    shellQuote(temporaryChannelId),
    "--funding-amount",
    shellQuote(String(fundingAmount))
  ].join(" ");
}

function topologySummary({ direct, commonCounterparties, commonOnlineBoth, blockers, warnings }) {
  if (direct.usable_for_payer_to_merchant) {
    return "A direct payer-to-merchant channel is connected and has payer outbound liquidity; confirm with a Fiber dry-run.";
  }

  if (direct.opening) {
    return "A direct payer-to-merchant channel is opening; wait for it to become ready, then run a route dry-run.";
  }

  if (direct.partial_opening) {
    return "A direct-channel opening is visible from only one node; clean up the stale pending state before opening another direct channel.";
  }

  if (commonOnlineBoth.length > 0) {
    return "No usable direct channel is available, but at least one shared counterparty is online from both nodes; confirm route construction with a dry-run.";
  }

  if (commonCounterparties.length > 0) {
    return "A shared channel counterparty exists, but it is not online from both nodes; reconnect it or use a direct channel fixture.";
  }

  if (blockers.length > 0) return blockers[0].summary;
  if (warnings.length > 0) return warnings[0].summary;
  return "Topology did not reveal a local routing blocker; confirm with a Fiber dry-run.";
}

function issue(code, summary, nextActions = [], details) {
  return {
    code,
    summary,
    ...(details ? { details } : {}),
    next_actions: nextActions
  };
}

function counterpartyPubkeys(channels = {}) {
  return uniqueActions((channels.counterparties ?? []).map((counterparty) => counterparty.pubkey).filter(Boolean));
}

function counterpartyByPubkey(channels = {}, pubkey) {
  if (!pubkey) return undefined;
  return (channels.counterparties ?? []).find((counterparty) => counterparty.pubkey === pubkey);
}

function openingCounterpartyByPubkey(channels = {}, pubkey) {
  if (!pubkey) return undefined;
  return (channels.counterparties ?? []).find(
    (counterparty) => counterparty.pubkey === pubkey && (counterparty.opening ?? 0) > 0
  );
}

function balanceValue(value) {
  if (typeof value !== "string" || value.length === 0) return 0n;
  return value.startsWith("0x") ? BigInt(value) : BigInt(value);
}

function hexString(value) {
  return `0x${value.toString(16)}`;
}

function numberValue(value) {
  if (value === undefined || value === null) return 0;
  return Number(value);
}

function numberString(value) {
  if (value === undefined || value === null) return undefined;
  return String(value);
}

function stringValue(value, fallback) {
  if (value === undefined || value === null) return fallback;
  return String(value);
}

function uniqueActions(values) {
  return [...new Set(values.filter(Boolean))];
}

function cleanUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
