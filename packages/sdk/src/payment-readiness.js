export function analyzePaymentReadiness(input = {}) {
  const amount = input.amount ?? input.request?.amount;
  const asset = input.asset ?? input.request?.asset;
  const topology = input.topology;
  const routeCheck = input.routeCheck ?? input.route_check ?? topology?.route_check;
  const invoice = input.invoice ?? input.payment_request ?? input.paymentRequest;
  const checks = normalizeChecks(input.checks);

  if (topology) addTopologyChecks(checks, topology, amount, asset);
  if (routeCheck || invoice) addRouteDryRunCheck(checks, routeCheck, invoice);

  const failures = checks.filter((check) => check.status === "fail");
  const warnings = checks.filter((check) => check.status === "warn");
  const ready = failures.length === 0;
  const confidence = readinessConfidence({ ready, topology, routeCheck });
  const payable = paymentPayable({ ready, topology, routeCheck, confidence });
  const failure = routeCheck?.failure ?? issueFromCheck(failures[0]);
  const nextActions = nextActionsFor({ checks, topology, routeCheck, invoice, ready });
  const nextAction = nextActionFor({ ready, routeCheck, invoice });
  const summary = readinessSummary({ ready, topology, routeCheck, invoice, failures, confidence });

  return cleanUndefined({
    offer_id: input.offer_id,
    ok: ready,
    ready,
    payable,
    confidence,
    code: failure?.code,
    summary,
    amount,
    asset,
    invoice_mode: input.invoice_mode,
    payment_link: input.payment_link,
    checks,
    blockers: failures.map(issueFromCheck),
    warnings: warnings.map(issueFromCheck),
    next_actions: nextActions,
    next_action: nextAction,
    topology: topologySnapshot(topology),
    route_check: routeCheck,
    failure
  });
}

function paymentPayable({ ready, topology, routeCheck, confidence }) {
  if (!ready) return false;
  if (routeCheck) return Boolean(routeCheck.ok);
  if (topology) return confidence !== "low";
  return undefined;
}

function addTopologyChecks(checks, topology, amount, asset) {
  if (topology.status === "error") {
    checks.push(
      warnCheck("topology", "Fiber topology could not be checked.", {
        code: topology.error?.code ?? "TOPOLOGY_CHECK_FAILED",
        details: topology.error,
        next_actions: ["Check Fiber RPC connectivity and retry the readiness check."]
      })
    );
    return;
  }

  if (topology.configured === false || topology.status === "unconfigured") {
    checks.push(
      warnCheck("topology", "Fiber topology reporting is not configured.", {
        code: "TOPOLOGY_UNCONFIGURED",
        next_actions: ["Set merchant and payer Fiber RPC URLs before relying on live route confidence."]
      })
    );
    return;
  }

  const direct = topology.direct_channel ?? {};
  const sharedOnline = onlineSharedCounterpartyCount(topology);
  const topologyBlocker = firstIssue(topology.blockers);

  if (topology.status === "blocked" && !direct.usable_for_payer_to_merchant && sharedOnline === 0) {
    checks.push(
      failCheck("topology", topology.summary ?? topologyBlocker?.summary ?? "Fiber topology has a routing blocker.", {
        code: topologyBlocker?.code ?? "TOPOLOGY_BLOCKED",
        details: topologyBlocker?.details,
        next_actions: topologyBlocker?.next_actions ?? topology.next_actions
      })
    );
  } else if (topology.status === "degraded" || topology.status === "opening") {
    checks.push(
      warnCheck("topology", topology.summary ?? "Fiber topology has warnings that may affect payment reliability.", {
        code: firstIssue(topology.warnings)?.code ?? topology.status?.toUpperCase(),
        next_actions: topology.next_actions
      })
    );
  } else {
    checks.push(passCheck("topology", topology.summary ?? "Fiber topology did not report a local routing blocker."));
  }

  addRouteCandidateCheck(checks, topology);
  addAmountLiquidityCheck(checks, topology, amount);
  addAssetLiquidityCheck(checks, topology, asset);
  addPendingTlcCheck(checks, topology);
}

function addRouteCandidateCheck(checks, topology) {
  const direct = topology.direct_channel ?? {};
  const sharedOnline = onlineSharedCounterpartyCount(topology);

  if (direct.usable_for_payer_to_merchant) {
    checks.push(
      passCheck("direct_channel", "A connected direct payer-to-merchant channel has payer outbound liquidity.")
    );
    return;
  }

  if (sharedOnline > 0) {
    checks.push(
      warnCheck("direct_channel", "No usable direct channel is visible, but an online shared counterparty exists.", {
        code: "DIRECT_CHANNEL_NOT_AVAILABLE",
        next_actions: ["Run a Fiber dry-run to confirm the routed path before sending funds."]
      })
    );
    return;
  }

  const blocker = firstIssue(topology.blockers) ?? firstIssue(topology.warnings);
  checks.push(
    failCheck("direct_channel", blocker?.summary ?? "No usable local route candidate is visible.", {
      code: blocker?.code ?? "NO_USABLE_LOCAL_ROUTE",
      next_actions: blocker?.next_actions ?? [
        "Open or rebalance a direct payer-to-merchant channel.",
        "Reconnect both nodes to a shared online routing counterparty."
      ]
    })
  );
}

function addAmountLiquidityCheck(checks, topology, amount) {
  const requested = quantityValue(amount);
  if (requested === undefined) {
    checks.push(
      warnCheck("amount_liquidity", "Requested amount was not available for liquidity comparison.", {
        code: "AMOUNT_NOT_CHECKED"
      })
    );
    return;
  }

  const direct = topology.direct_channel ?? {};
  if (direct.usable_for_payer_to_merchant) {
    const available = quantityValue(direct.payer_local_balance_total_hex ?? direct.payer_local_balance_total) ?? 0n;
    if (available >= requested) {
      checks.push(
        passCheck(
          "amount_liquidity",
          `Direct payer outbound liquidity covers the requested amount (${requested.toString()}).`,
          {
            details: {
              requested_amount: requested.toString(),
              direct_payer_outbound: available.toString()
            }
          }
        )
      );
      return;
    }

    checks.push(
      failCheck(
        "amount_liquidity",
        `Requested amount ${requested.toString()} exceeds direct payer outbound liquidity ${available.toString()}.`,
        {
          code: "DIRECT_OUTBOUND_LIQUIDITY_TOO_LOW",
          details: {
            requested_amount: requested.toString(),
            direct_payer_outbound: available.toString()
          },
          next_actions: [
            "Lower the payment amount.",
            "Open, fund, or rebalance the direct payer-to-merchant channel.",
            "Retry with a fresh invoice after liquidity changes."
          ]
        }
      )
    );
    return;
  }

  if (onlineSharedCounterpartyCount(topology) > 0) {
    checks.push(
      warnCheck("amount_liquidity", "Amount-specific liquidity cannot be proven from shared-route topology alone.", {
        code: "SHARED_ROUTE_LIQUIDITY_UNPROVEN",
        next_actions: ["Run a Fiber dry-run against the invoice before sending funds."]
      })
    );
  }
}

function addAssetLiquidityCheck(checks, topology, asset) {
  const assetType = assetTypeOf(asset);
  if (!assetType) return;

  if (assetType === "ckb") {
    const payerCkb = Number(topology.payer?.channels?.ckb ?? 0);
    const merchantCkb = Number(topology.merchant?.channels?.ckb ?? 0);
    if (payerCkb > 0 && merchantCkb > 0) {
      checks.push(passCheck("asset_liquidity", "CKB channel capacity is visible on both payer and merchant nodes."));
    } else {
      checks.push(
        warnCheck("asset_liquidity", "CKB channel capacity is not visible on both nodes.", {
          code: "CKB_CHANNEL_CAPACITY_NOT_VISIBLE",
          next_actions: ["Confirm the payer and merchant have ready CKB channels before requesting payment."]
        })
      );
    }
    return;
  }

  const payerUdt = Number(topology.payer?.channels?.udt ?? 0);
  const merchantUdt = Number(topology.merchant?.channels?.udt ?? 0);
  if (payerUdt > 0 && merchantUdt > 0) {
    checks.push(passCheck("asset_liquidity", `${assetType.toUpperCase()} channel capacity is visible on both nodes.`));
  } else {
    checks.push(
      warnCheck("asset_liquidity", `${assetType.toUpperCase()} liquidity is not visible in the topology summary.`, {
        code: "ASSET_LIQUIDITY_NOT_VISIBLE",
        next_actions: ["Run an invoice dry-run with the target asset before sending funds."]
      })
    );
  }
}

function addPendingTlcCheck(checks, topology) {
  const payerPending = Number(topology.payer?.channels?.pending_tlc_count ?? 0);
  const merchantPending = Number(topology.merchant?.channels?.pending_tlc_count ?? 0);
  if (payerPending === 0 && merchantPending === 0) return;

  checks.push(
    warnCheck("pending_tlcs", "Pending TLCs may reduce spendable route liquidity.", {
      code: "PENDING_TLCS",
      details: {
        payer_pending_tlcs: payerPending,
        merchant_pending_tlcs: merchantPending
      },
      next_actions: ["Wait for pending TLCs to settle or inspect stuck payments before retrying."]
    })
  );
}

function addRouteDryRunCheck(checks, routeCheck, invoice) {
  if (routeCheck) {
    if (routeCheck.ok) {
      checks.push(passCheck("route_dry_run", "Fiber send_payment dry-run accepted this invoice."));
    } else {
      const failure = routeCheck.failure ?? {};
      checks.push(
        failCheck("route_dry_run", failure.summary ?? "Fiber send_payment dry-run rejected this invoice.", {
          code: failure.code ?? "ROUTE_DRY_RUN_FAILED",
          details: {
            fiber_error: failure.fiber_error,
            route_context: failure.route_context
          },
          likely_causes: failure.likely_causes,
          next_actions: failure.next_actions
        })
      );
    }
    return;
  }

  checks.push(
    warnCheck(
      "route_dry_run",
      invoice
        ? "An invoice was supplied, but no Fiber dry-run result was available."
        : "No invoice was supplied; run a Fiber dry-run after invoice creation.",
      {
        code: invoice ? "ROUTE_DRY_RUN_NOT_AVAILABLE" : "INVOICE_REQUIRED_FOR_DRY_RUN",
        next_actions: ["Request a fresh invoice, then run send_payment with dry_run=true before sending funds."]
      }
    )
  );
}

function readinessConfidence({ ready, topology, routeCheck }) {
  if (!ready) return "low";
  if (routeCheck?.ok) return "high";
  if (!topology) return "medium";
  if (topology.status === "error" || topology.status === "unconfigured" || topology.configured === false) {
    return "low";
  }

  if (topology.direct_channel?.usable_for_payer_to_merchant || onlineSharedCounterpartyCount(topology) > 0) {
    return "medium";
  }

  return "low";
}

function readinessSummary({ ready, topology, routeCheck, invoice, failures, confidence }) {
  if (!ready) return failures[0]?.message ?? routeCheck?.failure?.summary ?? "Payment is not ready.";
  if (routeCheck?.ok) return "Fiber dry-run passed; this invoice is payable from the payer node.";
  if (topology?.direct_channel?.usable_for_payer_to_merchant) {
    return invoice
      ? "Direct channel liquidity is visible; run a Fiber dry-run before sending funds."
      : "Request is valid and direct channel liquidity is visible; request an invoice next.";
  }
  if (topology && onlineSharedCounterpartyCount(topology) > 0) {
    return "A shared route candidate is online; request an invoice and confirm it with a Fiber dry-run.";
  }
  if (!topology && !routeCheck) {
    return invoice
      ? "Invoice is valid; route confirmation belongs to the payer wallet."
      : "Request is valid; a fresh Fiber invoice can be created.";
  }
  if (confidence === "low") return "Request is valid, but the configured payer fixture has low route confidence.";
  return "Request is valid; request an invoice and confirm it with a Fiber dry-run.";
}

function nextActionFor({ ready, routeCheck, invoice }) {
  if (!ready) return "fix_request";
  if (routeCheck?.ok) return "send_payment";
  if (invoice) return "run_route_dry_run";
  return "request_invoice";
}

function nextActionsFor({ checks, topology, routeCheck, invoice, ready }) {
  const actions = [
    ...checks.flatMap((check) => check.next_actions ?? []),
    ...(topology?.next_actions ?? []),
    ...(routeCheck?.failure?.next_actions ?? [])
  ];

  if (ready && routeCheck?.ok) actions.push("Send payment from the payer node or hand the invoice to the payer wallet.");
  if (ready && !invoice) actions.push("Request a fresh invoice from the resolver.");
  if (ready && invoice && !routeCheck?.ok) actions.push("Run send_payment with dry_run=true from the payer node before sending funds.");

  return unique(actions);
}

function normalizeChecks(checks) {
  if (!Array.isArray(checks)) return [];
  return checks.map((check) =>
    cleanUndefined({
      id: check.id,
      status: check.status,
      message: check.message,
      code: check.code,
      details: check.details,
      likely_causes: check.likely_causes,
      next_actions: check.next_actions
    })
  );
}

function passCheck(id, message, options = {}) {
  return check(id, "pass", message, options);
}

function warnCheck(id, message, options = {}) {
  return check(id, "warn", message, options);
}

function failCheck(id, message, options = {}) {
  return check(id, "fail", message, options);
}

function check(id, status, message, options = {}) {
  return cleanUndefined({
    id,
    status,
    message,
    code: options.code,
    details: options.details,
    likely_causes: options.likely_causes,
    next_actions: options.next_actions
  });
}

function issueFromCheck(check) {
  if (!check) return undefined;
  return cleanUndefined({
    code: check.code ?? check.id?.toUpperCase(),
    summary: check.message,
    details: check.details,
    likely_causes: check.likely_causes,
    next_actions: check.next_actions
  });
}

function topologySnapshot(topology) {
  if (!topology) return undefined;
  return cleanUndefined({
    ok: topology.ok,
    configured: topology.configured,
    status: topology.status,
    summary: topology.summary,
    readiness: topology.readiness,
    direct_channel: topology.direct_channel,
    route_candidates: topology.route_candidates,
    common_channel_counterparties: topology.common_channel_counterparties,
    online_common_channel_counterparties: topology.online_common_channel_counterparties,
    blockers: topology.blockers,
    warnings: topology.warnings,
    next_actions: topology.next_actions,
    error: topology.error
  });
}

function onlineSharedCounterpartyCount(topology) {
  if (Array.isArray(topology?.online_common_channel_counterparties)) {
    return topology.online_common_channel_counterparties.length;
  }

  return (topology?.route_candidates?.shared_counterparties ?? []).filter((counterparty) => counterparty.online_from_both)
    .length;
}

function firstIssue(issues) {
  return Array.isArray(issues) && issues.length > 0 ? issues[0] : undefined;
}

function assetTypeOf(asset) {
  const type = asset?.asset_type ?? asset?.assetType ?? asset?.type;
  return type ? String(type).toLowerCase() : undefined;
}

function quantityValue(value) {
  if (value === undefined || value === null || value === "") return undefined;
  try {
    return BigInt(String(value).trim());
  } catch {
    return undefined;
  }
}

function unique(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

function cleanUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
