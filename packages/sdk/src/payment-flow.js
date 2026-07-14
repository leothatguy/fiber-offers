import { normalizeFiberPaymentFailure } from "./failures.js";
import { decodeOffer, verifyOffer } from "@fiber-offers/protocol";

export class FiberPaymentFlowClient {
  constructor(options = {}) {
    this.resolver = options.resolverClient ?? options.resolver;
    this.paymentClient = options.paymentClient ?? options.payerPaymentClient;

    if (!this.resolver) {
      throw new Error("FiberPaymentFlowClient requires a resolverClient");
    }
  }

  async preparePayment(offerOrId, request, options = {}) {
    const offerReference = normalizeOfferReference(offerOrId);
    const initialReadiness = options.skipInitialReadiness
      ? undefined
      : await this.resolver.checkPayment(offerReference, request);

    if (initialReadiness && !initialReadiness.ready && options.requireInitialReadiness !== false) {
      return paymentFlowResult({
        ok: false,
        status: "blocked_before_invoice",
        request,
        readiness: initialReadiness,
        failure: failureFromReadiness(initialReadiness)
      });
    }

    const invoice = await this.resolver.requestInvoice(offerReference, request, invoiceRequestOptions(options));
    const invoiceValue = invoice.invoice?.invoice ?? invoice.invoice;
    if (!invoiceValue) {
      return paymentFlowResult({
        ok: false,
        status: "invoice_unavailable",
        request,
        invoice,
        failure: {
          code: "INVOICE_UNAVAILABLE",
          summary: "The resolver did not return a Fiber invoice for this payment request.",
          next_actions: ["Inspect the resolver invoice adapter response."]
        }
      });
    }

    const invoiceReadiness = await this.resolver.checkPayment(offerReference, {
      ...request,
      ...resolverRouteOptions(options),
      invoice: invoiceValue
    });
    const routeCheck = await routeCheckForInvoice(invoiceReadiness, invoiceValue, this.paymentClient, options);
    const readiness = mergeRouteCheck(invoiceReadiness, routeCheck);

    return paymentFlowResult({
      ok: Boolean(readiness.ready && readiness.payable),
      status: readiness.ready && readiness.payable ? "ready_to_send" : "blocked_after_invoice",
      request,
      invoice,
      readiness,
      route_check: routeCheck,
      failure: readiness.ready && readiness.payable ? undefined : readiness.failure ?? failureFromReadiness(readiness)
    });
  }

  async payOffer(offerOrId, request, options = {}) {
    const prepared = await this.preparePayment(offerOrId, request, options);
    if (!prepared.ok) return prepared;

    if (!options.execute) {
      return paymentFlowResult({
        ...prepared,
        status: "ready_to_send",
        execute_required: true,
        next_action: "call_pay_offer_with_execute_true"
      });
    }

    if (!this.paymentClient) {
      return paymentFlowResult({
        ...prepared,
        ok: false,
        status: "payment_client_required",
        failure: {
          code: "PAYMENT_CLIENT_REQUIRED",
          summary: "A payer Fiber payment client is required to execute the payment.",
          next_actions: ["Construct FiberPaymentFlowClient with paymentClient before calling payOffer with execute=true."]
        }
      });
    }

    const invoiceValue = prepared.invoice.invoice?.invoice ?? prepared.invoice.invoice;
    try {
      const payment = await this.paymentClient.sendPayment(invoiceValue, paymentOptions(options));
      return paymentFlowResult({
        ...prepared,
        ok: true,
        status: "payment_sent",
        payment,
        payment_hash: payment?.payment_hash ?? prepared.route_check?.payment_hash,
        fee: payment?.fee ?? prepared.route_check?.fee,
        next_action: "poll_payment_status"
      });
    } catch (error) {
      const failure = normalizeFiberPaymentFailure(error, {
        stage: "send_payment",
        diagnostics: prepared.readiness?.topology?.diagnostics
      });
      return paymentFlowResult({
        ...prepared,
        ok: false,
        status: "payment_failed",
        failure,
        next_action: "fix_request"
      });
    }
  }
}

function normalizeOfferReference(offerOrId) {
  if (typeof offerOrId !== "string" || !offerOrId.startsWith("fbroffer1")) return offerOrId;
  const offer = decodeOffer(offerOrId);
  const verification = verifyOffer(offer);
  if (!verification.ok) {
    const error = new Error(verification.message);
    error.code = verification.code;
    throw error;
  }
  return offer.offer_id;
}

async function routeCheckForInvoice(readiness, invoice, paymentClient, options) {
  if (readiness?.route_check && !options.forceLocalDryRun) return readiness.route_check;
  if (!paymentClient) return readiness?.route_check;
  return paymentClient.checkPaymentRoute(invoice, paymentOptions(options));
}

function mergeRouteCheck(readiness, routeCheck) {
  if (!routeCheck || routeCheck === readiness?.route_check) return readiness;

  const ready = Boolean(readiness?.ready && routeCheck.ok);
  const routeCheckEntry = routeCheck.ok
    ? {
        id: "route_dry_run",
        status: "pass",
        message: "Fiber send_payment dry-run accepted this invoice."
      }
    : {
        id: "route_dry_run",
        status: "fail",
        message: routeCheck.failure?.summary ?? "Fiber send_payment dry-run rejected this invoice.",
        code: routeCheck.failure?.code,
        details: {
          fiber_error: routeCheck.failure?.fiber_error,
          route_context: routeCheck.failure?.route_context
        },
        likely_causes: routeCheck.failure?.likely_causes,
        next_actions: routeCheck.failure?.next_actions
      };

  return cleanUndefined({
    ...readiness,
    ready,
    ok: ready,
    payable: ready,
    confidence: ready ? "high" : "low",
    code: ready ? readiness?.code : routeCheck.failure?.code,
    summary: ready
      ? "Fiber dry-run passed; this invoice is payable from the payer node."
      : routeCheck.failure?.summary ?? readiness?.summary,
    checks: replaceCheck(readiness?.checks ?? [], routeCheckEntry),
    blockers: ready ? readiness?.blockers ?? [] : [...(readiness?.blockers ?? []), issueFromRouteFailure(routeCheck.failure)],
    route_check: routeCheck,
    failure: ready ? readiness?.failure : routeCheck.failure ?? readiness?.failure,
    next_action: ready ? "send_payment" : "fix_request"
  });
}

function paymentFlowResult(result) {
  const failure = result.failure;
  return cleanUndefined({
    ok: result.ok,
    status: result.status,
    request: result.request,
    invoice: result.invoice,
    readiness: result.readiness,
    route_check: result.route_check,
    payment: result.payment,
    payment_hash: result.payment_hash,
    fee: result.fee,
    execute_required: result.execute_required,
    next_action: result.next_action ?? result.readiness?.next_action,
    failure
  });
}

function resolverRouteOptions(options) {
  return cleanUndefined({
    timeout_seconds: options.timeout_seconds ?? options.timeoutSeconds,
    max_fee_amount: options.max_fee_amount ?? options.maxFeeAmount,
    max_fee_rate: options.max_fee_rate ?? options.maxFeeRate,
    max_parts: options.max_parts ?? options.maxParts,
    trampoline_hops: options.trampoline_hops ?? options.trampolineHops,
    hop_hints: options.hop_hints ?? options.hopHints,
    udt_type_script: options.udt_type_script ?? options.udtTypeScript,
    allow_self_payment: options.allow_self_payment ?? options.allowSelfPayment,
    custom_records: options.custom_records ?? options.customRecords
  });
}

function paymentOptions(options) {
  return cleanUndefined({
    timeoutSeconds: options.timeout_seconds ?? options.timeoutSeconds,
    maxFeeAmount: options.max_fee_amount ?? options.maxFeeAmount,
    maxFeeRate: options.max_fee_rate ?? options.maxFeeRate,
    maxParts: options.max_parts ?? options.maxParts,
    trampolineHops: options.trampoline_hops ?? options.trampolineHops,
    hopHints: options.hop_hints ?? options.hopHints,
    udtTypeScript: options.udt_type_script ?? options.udtTypeScript,
    allowSelfPayment: options.allow_self_payment ?? options.allowSelfPayment,
    customRecords: options.custom_records ?? options.customRecords
  });
}

function invoiceRequestOptions(options) {
  return options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : undefined;
}

function failureFromReadiness(readiness) {
  if (!readiness) return undefined;
  return cleanUndefined({
    code: readiness.code ?? readiness.blockers?.[0]?.code,
    summary: readiness.summary ?? readiness.blockers?.[0]?.summary,
    likely_causes: readiness.failure?.likely_causes,
    next_actions: readiness.next_actions ?? readiness.failure?.next_actions,
    fiber_error: readiness.failure?.fiber_error
  });
}

function issueFromRouteFailure(failure) {
  return cleanUndefined({
    code: failure?.code ?? "ROUTE_DRY_RUN_FAILED",
    summary: failure?.summary ?? "Fiber send_payment dry-run rejected this invoice.",
    details: {
      fiber_error: failure?.fiber_error,
      route_context: failure?.route_context
    },
    likely_causes: failure?.likely_causes,
    next_actions: failure?.next_actions
  });
}

function replaceCheck(checks, replacement) {
  const withoutExisting = checks.filter((check) => check.id !== replacement.id);
  return [...withoutExisting, cleanUndefined(replacement)];
}

function cleanUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
