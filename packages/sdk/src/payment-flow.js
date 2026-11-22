import { fiberNodeError, normalizeFiberPaymentFailure } from "./failures.js";
import { fiberPaymentStatus, waitForFiberPayment } from "./fiber-payment.js";
import { verifyInvoiceForOffer } from "./invoice-verification.js";
import { decodeOffer, validateResolutionRequest, verifyOffer } from "@fiber-offers/protocol";

// Runs a payment from a signed offer to a sent Fiber payment, treating the
// resolver as untrusted: the offer's signature is checked, the resolver must be
// the one the offer names, and the invoice it returns is read by the payer's
// own node and matched against the offer before any funds move.
export class FiberPaymentFlowClient {
  constructor(options = {}) {
    this.resolver = options.resolverClient ?? options.resolver;
    this.paymentClient = options.paymentClient ?? options.payerPaymentClient;
    // For tests and local setups where the resolver is reached at a different
    // address than the one signed into the offer.
    this.allowResolverMismatch = Boolean(options.allowResolverMismatch);
    // For paying through a resolver that predates invoice binding. Such an
    // invoice cannot be told apart from one issued for another order.
    this.allowUnboundInvoices = Boolean(options.allowUnboundInvoices);

    if (!this.resolver) {
      throw new Error("FiberPaymentFlowClient requires a resolverClient");
    }
  }

  async preparePayment(offerOrId, request, options = {}) {
    const { offerId: offerReference, offer } = await this.#signedOffer(offerOrId);

    if (offer) {
      const blocked = this.#checkBeforeContact(offer, request, options);
      if (blocked) return blocked;
    }

    const initialReadiness = options.skipInitialReadiness
      ? undefined
      : await this.resolver.checkPayment(offerReference, request, invoiceRequestOptions(options));

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

    const verification = await this.#verifyInvoice(offer, request, invoice, invoiceValue, options);
    if (verification.attempted && !verification.verified) {
      return paymentFlowResult({
        ok: false,
        status: "invoice_rejected",
        request,
        invoice,
        invoice_verification: verification,
        failure: verification.failure,
        next_action: "do_not_pay"
      });
    }

    const invoiceReadiness = await this.resolver.checkPayment(
      offerReference,
      {
        ...request,
        ...resolverRouteOptions(options),
        invoice: invoiceValue
      },
      invoiceRequestOptions(options)
    );
    const routeCheck = await routeCheckForInvoice(invoiceReadiness, invoiceValue, this.paymentClient, options);
    const readiness = mergeRouteCheck(invoiceReadiness, routeCheck);

    return paymentFlowResult({
      ok: Boolean(readiness.ready && readiness.payable),
      status: readiness.ready && readiness.payable ? "ready_to_send" : "blocked_after_invoice",
      request,
      invoice,
      invoice_verification: verification,
      readiness,
      route_check: routeCheck,
      failure: readiness.ready && readiness.payable ? undefined : readiness.failure ?? failureFromReadiness(readiness)
    });
  }

  // Prepares and, with `execute: true`, sends. With `confirm: true` it also
  // waits for the node to report the payment settled, and ends in
  // payment_succeeded or payment_failed instead of payment_sent.
  async payOffer(offerOrId, request, options = {}) {
    const prepared = await this.preparePayment(offerOrId, request, options);
    return this.executePrepared(prepared, options);
  }

  // The sending half of payOffer, for callers that need to act between
  // preparing and sending, such as recording the payment hash first.
  async executePrepared(prepared, options = {}) {
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

    // Funds only move for an invoice that was matched against the signed offer.
    if (!prepared.invoice_verification?.verified && !options.skipInvoiceVerification) {
      return paymentFlowResult({
        ...prepared,
        ok: false,
        status: "invoice_unverified",
        failure: {
          code: "INVOICE_NOT_VERIFIED",
          summary:
            prepared.invoice_verification?.summary ??
            "The invoice could not be checked against the signed offer, so it was not paid.",
          next_actions: [
            "Pass the signed offer (or its encoded form) to payOffer, or use a resolver client that can fetch it.",
            "Use a payment client that supports parse_invoice."
          ]
        },
        next_action: "do_not_pay"
      });
    }

    const invoiceValue = prepared.invoice.invoice?.invoice ?? prepared.invoice.invoice;
    try {
      const payment = await this.paymentClient.sendPayment(invoiceValue, paymentOptions(options));
      const sent = paymentFlowResult({
        ...prepared,
        ok: true,
        status: "payment_sent",
        payment,
        payment_hash: payment?.payment_hash ?? prepared.invoice?.payment_hash ?? prepared.route_check?.payment_hash,
        fee: payment?.fee ?? prepared.route_check?.fee,
        next_action: "poll_payment_status"
      });
      return this.#settle(sent, options);
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

  // Checks whether a sent payment has settled. Resolves to a result whose status
  // is payment_succeeded, payment_failed, payment_pending (not settled by the
  // deadline; check again later) or payment_unknown (the node has no record).
  async confirmPayment(paymentHash, options = {}) {
    if (!paymentHash) {
      return {
        ok: false,
        status: "payment_unknown",
        failure: { code: "PAYMENT_HASH_REQUIRED", summary: "No payment hash was available to look the payment up." }
      };
    }
    const getPayment =
      typeof this.paymentClient?.getPayment === "function"
        ? (hash) => this.paymentClient.getPayment(hash)
        : undefined;
    if (!getPayment) {
      return {
        ok: false,
        status: "payment_unknown",
        payment_hash: paymentHash,
        failure: {
          code: "PAYMENT_CLIENT_CANNOT_CONFIRM",
          summary: "The payment client cannot report payment status (no getPayment)."
        }
      };
    }

    let outcome;
    try {
      outcome = await waitForFiberPayment(getPayment, paymentHash, {
        timeoutMs: options.confirmTimeoutMs,
        pollIntervalMs: options.confirmPollIntervalMs,
        sleep: options.sleep,
        now: options.now
      });
    } catch (error) {
      return {
        ok: false,
        status: "payment_unknown",
        payment_hash: paymentHash,
        failure: normalizeFiberPaymentFailure(error, { stage: "get_payment" }),
        next_action: "retry_payment"
      };
    }
    return settledResult(paymentHash, outcome.payment, outcome.settled ? outcome.status : undefined);
  }

  // A node may already report the outcome in its send_payment reply. Otherwise
  // the payment is only "sent" until confirmed.
  async #settle(sent, options) {
    const immediate = fiberPaymentStatus(sent.payment);
    if (immediate === "Success" || immediate === "Failed") {
      return paymentFlowResult({ ...sent, ...settledResult(sent.payment_hash, sent.payment, immediate) });
    }
    if (!options.confirm) return sent;
    const confirmation = await this.confirmPayment(sent.payment_hash, options);
    return paymentFlowResult({
      ...sent,
      ...confirmation,
      payment: confirmation.payment ?? sent.payment,
      fee: confirmation.payment?.fee ?? sent.fee
    });
  }

  // The signed offer behind whatever the caller passed: an encoded offer, a
  // signed offer object, or an offer ID (fetched from the resolver). Whichever
  // way it arrives its signature is checked here. An offer's ID is the hash of
  // its contents, so an ID alone still pins down exactly one offer.
  async #signedOffer(offerOrId) {
    if (typeof offerOrId === "string" && offerOrId.startsWith("fbroffer1")) {
      const offer = assertVerifiedOffer(decodeOffer(offerOrId));
      return { offerId: offer.offer_id, offer };
    }

    const candidate = offerOrId && typeof offerOrId === "object" ? offerOrId.offer ?? offerOrId : undefined;
    if (candidate?.scheme && candidate?.signature) {
      const offer = assertVerifiedOffer(candidate);
      return { offerId: offer.offer_id, offer };
    }

    const offerId = typeof offerOrId === "string" ? offerOrId : offerOrId?.offer_id;
    if (offerId && typeof this.resolver.getOffer === "function") {
      const resolved = await this.resolver.getOffer(offerId);
      const offer = assertVerifiedOffer(resolved?.offer);
      if (offer.offer_id !== offerId) {
        const error = new Error("resolver returned a different offer than the one requested");
        error.code = "RESOLVED_OFFER_MISMATCH";
        throw error;
      }
      return { offerId, offer };
    }

    // A resolver client that cannot fetch offers: the flow can prepare a
    // payment but has nothing to verify the invoice against.
    return { offerId: offerOrId, offer: undefined };
  }

  // Checks that need no network: the resolver being used is the one the offer
  // signed, and the request fits the offer's signed terms.
  #checkBeforeContact(offer, request, options) {
    const contacted = originOf(this.resolver.resolverUrl);
    const signed = originOf(offer.resolver_url);
    if (
      contacted &&
      signed &&
      contacted !== signed &&
      !this.allowResolverMismatch &&
      !options.allowResolverMismatch
    ) {
      return paymentFlowResult({
        ok: false,
        status: "resolver_mismatch",
        request,
        failure: {
          code: "RESOLVER_URL_MISMATCH",
          summary: "This resolver is not the one named in the signed offer.",
          details: { offer_resolver: signed, contacted_resolver: contacted },
          next_actions: ["Request the invoice from the resolver_url signed into the offer."]
        },
        next_action: "do_not_pay"
      });
    }

    try {
      validateResolutionRequest(offer, request);
    } catch (error) {
      return paymentFlowResult({
        ok: false,
        status: "blocked_before_invoice",
        request,
        failure: {
          code: error.code ?? "INVALID_REQUEST",
          summary: error.message,
          next_actions: ["Change the amount or asset to one the offer accepts."]
        },
        next_action: "fix_request"
      });
    }
    return undefined;
  }

  async #verifyInvoice(offer, request, invoice, invoiceValue, options = {}) {
    if (!offer) {
      return {
        attempted: false,
        verified: false,
        code: "OFFER_NOT_AVAILABLE",
        summary: "The signed offer was not available, so the invoice was not checked against it."
      };
    }
    if (typeof this.paymentClient?.parseInvoice !== "function") {
      return {
        attempted: false,
        verified: false,
        code: "PAYMENT_CLIENT_REQUIRED",
        summary: "No payer node client was available to read the invoice, so it was not checked against the offer."
      };
    }

    let parsed;
    try {
      parsed = await this.paymentClient.parseInvoice(invoiceValue);
    } catch (error) {
      // A node that cannot be reached is a different problem from a node that
      // says the invoice is not an invoice.
      const unavailable = error?.retryable === true;
      return {
        attempted: true,
        verified: false,
        failure: {
          code: unavailable ? "INVOICE_VERIFICATION_UNAVAILABLE" : "INVOICE_UNPARSEABLE",
          summary: unavailable
            ? "The payer node could not be reached to read the invoice."
            : "The payer node could not read the invoice the resolver returned.",
          fiber_error: fiberNodeError(error),
          next_actions: unavailable
            ? ["Check the payer node and retry."]
            : ["Do not pay this invoice.", "Request a new invoice."]
        }
      };
    }

    const outcome = verifyInvoiceForOffer({
      offer,
      request,
      parsed,
      expectedPaymentHash: invoice.payment_hash,
      expectedResolutionId: invoice.resolution_id,
      requireBinding: !(this.allowUnboundInvoices || options.allowUnboundInvoices)
    });
    return {
      attempted: true,
      verified: outcome.ok,
      checks: outcome.checks,
      invoice: outcome.invoice,
      ...(outcome.failure ? { failure: outcome.failure } : {})
    };
  }
}

function settledResult(paymentHash, payment, status) {
  if (status === "Success") {
    return { ok: true, status: "payment_succeeded", payment, payment_hash: paymentHash, next_action: "done" };
  }
  if (status === "Failed") {
    return {
      ok: false,
      status: "payment_failed",
      payment,
      payment_hash: paymentHash,
      failure: {
        code: "PAYMENT_FAILED",
        summary: payment?.failed_error
          ? `The Fiber payment failed: ${payment.failed_error}`
          : "The Fiber payment failed after it was sent.",
        fiber_error: payment?.failed_error ? { message: payment.failed_error } : undefined,
        next_actions: ["Check route liquidity and retry; a failed payment moved no funds."]
      },
      next_action: "retry_payment"
    };
  }
  // Accepted by the node and still in flight.
  return { ok: true, status: "payment_pending", payment, payment_hash: paymentHash, next_action: "poll_payment_status" };
}

function assertVerifiedOffer(offer) {
  let verification;
  try {
    verification = verifyOffer(offer);
  } catch (error) {
    verification = { ok: false, code: error.code ?? "INVALID_OFFER", message: error.message };
  }
  if (!verification.ok) {
    const error = new Error(verification.message);
    error.code = verification.code;
    throw error;
  }
  return offer;
}

function originOf(url) {
  if (typeof url !== "string" || url.length === 0) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
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
    invoice_verification: result.invoice_verification,
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
