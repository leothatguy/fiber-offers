export function normalizeFiberPaymentFailure(error, options = {}) {
  if (!error) return undefined;

  const diagnostics = options.diagnostics;
  const stage = options.stage;
  const message = error.message ?? "";
  const detailsMessage = error.details?.error?.message ?? error.error?.message ?? "";
  const combinedMessage = `${message} ${detailsMessage}`;
  const payer = diagnostics?.payer;
  const merchant = diagnostics?.merchant;
  const routeContext = diagnostics
    ? {
        stage,
        payer_connected_peers: payer?.peers ?? [],
        payer_offline_channel_counterparties: payer?.channels?.offline_counterparties ?? [],
        merchant_offline_channel_counterparties: merchant?.channels?.offline_counterparties ?? [],
        common_channel_counterparties: diagnostics.common_channel_counterparties ?? [],
        direct_channel: diagnostics.direct_channel
      }
    : undefined;

  const failure = {
    code: "ROUTE_OR_PAYMENT_FAILED",
    summary: "Fiber rejected the route or payment attempt.",
    fiber_error: fiberNodeError(error),
    likely_causes: [],
    next_actions: ["Inspect the raw Fiber RPC error details and node channel diagnostics."],
    route_context: routeContext
  };

  if (/max outbound liquidity 0|insufficient balance/i.test(combinedMessage)) {
    failure.code = "ROUTE_OUTBOUND_LIQUIDITY_UNUSABLE";
    failure.summary = "Fiber could not find a route with usable outbound liquidity from the payer to this invoice.";
    failure.next_actions = [
      "Connect the payer node to a channel counterparty that has a route toward the merchant.",
      "Use trampoline hops or hop hints only after the selected hop is reachable.",
      "Open or rebalance a direct payer-to-merchant channel for deterministic local E2E tests.",
      "Retry with dry_run=true before sending a real payment."
    ];

    if ((payer?.channels?.usable_outbound ?? 1) === 0) {
      failure.likely_causes.push("The payer has no enabled channel with local balance.");
    }

    if (diagnostics?.direct_channel && !diagnostics.direct_channel.payer_to_merchant) {
      failure.likely_causes.push("The payer and merchant do not have a direct ready channel.");
    }

    const offlineCommon = offlineCommonCounterparties(diagnostics);
    if (offlineCommon.length > 0) {
      failure.likely_causes.push(
        "A shared channel counterparty exists, but the payer is not connected to it as a live peer."
      );
      failure.route_context.offline_common_counterparties = offlineCommon;
    }

    if ((payer?.channels?.pending_tlc_count ?? 0) > 0) {
      failure.likely_causes.push("The payer has pending TLCs that may reduce spendable channel liquidity.");
    }
  }

  if (/invoice.*expired|expired.*invoice/i.test(combinedMessage)) {
    failure.code = "INVOICE_EXPIRED";
    failure.summary = "The Fiber invoice expired before the payment could complete.";
    failure.next_actions = [
      "Request a fresh invoice from the resolver.",
      "Retry the payment immediately after invoice creation."
    ];
  }

  if (/timeout|timed out/i.test(combinedMessage)) {
    failure.code = failure.code === "ROUTE_OR_PAYMENT_FAILED" ? "PAYMENT_TIMEOUT" : failure.code;
    failure.summary =
      failure.code === "PAYMENT_TIMEOUT"
        ? "The Fiber payment attempt timed out before reaching a terminal state."
        : failure.summary;
    if (!failure.next_actions.some((action) => action.includes("dry_run"))) {
      failure.next_actions.push("Run a dry-run route check before retrying with funds.");
    }
  }

  return failure;
}

export function fiberNodeError(error) {
  const raw = error.details?.error ?? error.error;

  if (raw) {
    return {
      method: error.details?.method ?? error.method,
      url: error.details?.url ?? error.url,
      code: raw.code ?? error.code,
      message: raw.message ?? error.message,
      data: raw.data
    };
  }

  return {
    method: error.method,
    url: error.url,
    code: error.code,
    message: error.message,
    details: error.details
  };
}

function offlineCommonCounterparties(diagnostics) {
  const commonCounterparties = diagnostics?.common_channel_counterparties ?? [];
  const payerPeers = new Set(diagnostics?.payer?.peers ?? []);
  return commonCounterparties.filter((pubkey) => !payerPeers.has(pubkey));
}
