import { createServer as createHttpServer } from "node:http";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { analyzePaymentReadiness, FiberTopologyClient } from "../../../packages/sdk/src/index.js";
import {
  createSignedOffer,
  decodeOffer,
  encodeOffer,
  FiberOfferError,
  generateOfferKeyPair,
  offerToPaymentLink,
  validateResolutionRequest,
  verifyOffer,
  verifyOfferRevocation
} from "../../../packages/protocol/src/index.js";
import { createInvoiceAdapter } from "./invoice-adapter.js";
import { PostgresOfferStore } from "./postgres-store.js";
import { renderOfferQrSvg } from "./qr.js";
import { RedisRateLimiter } from "./redis-rate-limiter.js";
import { InMemoryOfferStore, JsonOfferStore, normalizeUsername } from "./store.js";
import { deliverWebhookEvent } from "./webhook-delivery.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
const defaultStaticRoot = resolve(currentDir, "../../demo/public");
const defaultDataPath = resolve(currentDir, "../data/offers.json");
const maxJsonBytes = 1024 * 1024;
const resolutionStatuses = new Set([
  "invoice_created",
  "invoice_received",
  "invoice_paid",
  "invoice_expired",
  "invoice_failed",
  "invoice_cancelled"
]);
const terminalResolutionStatuses = new Set([
  "invoice_paid",
  "invoice_expired",
  "invoice_failed",
  "invoice_cancelled"
]);
const webhookSubscriptionEventTypes = new Set([
  "invoice.created",
  "invoice.received",
  "invoice.paid",
  "invoice.expired",
  "invoice.failed",
  "invoice.cancelled"
]);
const webhookEventTypes = new Set([...webhookSubscriptionEventTypes, "webhook.test"]);
const operatorSessionCookie = "fiber_offers_operator";

export { InMemoryOfferStore, JsonOfferStore, PostgresOfferStore };

export function createServer(options = {}) {
  const encryptionKey = options.encryptionKey ?? process.env.RESOLVER_SECRET_ENCRYPTION_KEY;
  const store = options.store ?? (process.env.DATABASE_URL
    ? new PostgresOfferStore({
        connectionString: process.env.DATABASE_URL,
        maxConnections: process.env.DATABASE_POOL_MAX,
        encryptionKey
      })
    : new JsonOfferStore(options.dataPath ?? defaultDataPath, { encryptionKey }));
  const invoiceAdapter = options.invoiceAdapter ?? createInvoiceAdapter(process.env);
  const staticRoot = options.staticRoot ?? defaultStaticRoot;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const apiKey = options.apiKey ?? process.env.RESOLVER_API_KEY;
  const operatorSessionTtlSeconds = positiveInteger(
    options.operatorSessionTtlSeconds ?? process.env.RESOLVER_ADMIN_SESSION_TTL_SECONDS,
    28800
  );
  const topologyClient = options.topologyClient ?? createTopologyClientFromEnv(process.env, fetchImpl);
  const demoWebhookInbox = options.demoWebhookInbox ?? [];
  const logger = options.logger ?? console;
  const publicOrigin = options.publicOrigin ?? process.env.RESOLVER_PUBLIC_URL;
  const webhookDeliveryTimeoutMs = positiveInteger(
    options.webhookDeliveryTimeoutMs ?? process.env.RESOLVER_WEBHOOK_TIMEOUT_MS,
    10000
  );
  const context = {
    store,
    invoiceAdapter,
    staticRoot,
    fetchImpl,
    apiKey,
    operatorSessionTtlSeconds,
    topologyClient,
    demoWebhookInbox,
    logger,
    publicOrigin,
    webhookDeliveryTimeoutMs,
    allowPrivateWebhookTargets:
      options.allowPrivateWebhookTargets ??
      (process.env.RESOLVER_ALLOW_PRIVATE_WEBHOOKS === undefined
        ? process.env.NODE_ENV !== "production"
        : booleanEnv(process.env.RESOLVER_ALLOW_PRIVATE_WEBHOOKS)),
    rateLimiter: options.rateLimiter ?? (process.env.REDIS_URL
      ? new RedisRateLimiter({
          url: process.env.REDIS_URL,
          prefix: process.env.REDIS_KEY_PREFIX ?? "fiber-offers",
          windowMs: positiveInteger(options.rateLimitWindowMs ?? process.env.RESOLVER_RATE_LIMIT_WINDOW_MS, 60000),
          max: positiveInteger(options.rateLimitMax ?? process.env.RESOLVER_RATE_LIMIT_MAX, 120)
        })
      : createRateLimiter({
      windowMs: positiveInteger(options.rateLimitWindowMs ?? process.env.RESOLVER_RATE_LIMIT_WINDOW_MS, 60000),
      max: positiveInteger(options.rateLimitMax ?? process.env.RESOLVER_RATE_LIMIT_MAX, 120)
        })),
    enforceNodeOwnership: options.enforceNodeOwnership ?? invoiceAdapter.mode === "fiber-rpc",
    invoiceLocks: new Map()
  };
  const backgroundWorkers = createBackgroundWorkers(context, {
    ...backgroundWorkerOptionsFromEnv(process.env),
    ...(options.workers === true ? { enabled: true } : options.workers === false ? { enabled: false } : (options.workers ?? {}))
  });
  context.backgroundWorkers = backgroundWorkers;

  const server = createHttpServer(async (request, response) => {
    try {
      await handleRequest(request, response, context);
    } catch (error) {
      sendError(response, error, logger);
    }
  });

  server.store = store;
  server.invoiceAdapter = invoiceAdapter;
  server.backgroundWorkers = backgroundWorkers;
  server.startBackgroundWorkers = () => backgroundWorkers.start();
  server.stopBackgroundWorkers = () => backgroundWorkers.stop();
  server.on("close", () => {
    backgroundWorkers.stop();
    context.rateLimiter.close?.().catch((error) => logger.error?.(error));
    store.close?.().catch((error) => logger.error?.(error));
  });
  if (backgroundWorkers.enabled) backgroundWorkers.start();
  return server;
}

async function handleRequest(request, response, context) {
  setCorsHeaders(response);
  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  const url = new URL(request.url, requestOrigin(request));
  const { pathname } = url;

  if (request.method === "GET" && (await serveStatic(pathname, response, context.staticRoot))) {
    return;
  }

  if (request.method === "GET" && pathname === "/health") {
    const dependencies = await dependencyHealth(context);
    const ok = Object.values(dependencies).every((dependency) => dependency.ok);
    sendJson(response, ok ? 200 : 503, {
      ok,
      service: "fiber-offers-resolver",
      invoice_mode: context.invoiceAdapter.mode,
      auth_required: Boolean(context.apiKey),
      dependencies
    });
    return;
  }

  if (request.method === "GET" && pathname === "/diagnostics") {
    sendJson(response, 200, await createDiagnostics(context));
    return;
  }

  if (pathname === "/operator/session") {
    if (request.method === "GET") {
      sendJson(response, 200, {
        auth_required: Boolean(context.apiKey),
        authenticated: !context.apiKey || hasValidApiCredential(request, context)
      });
      return;
    }

    if (request.method === "POST") {
      if (!context.apiKey) {
        sendJson(response, 200, { authenticated: true, auth_required: false });
        return;
      }
      const body = await readJsonBody(request);
      if (!safeSecretEqual(body.api_key, context.apiKey)) {
        throw httpError(401, "UNAUTHORIZED", "valid API key is required");
      }
      response.writeHead(204, {
        "cache-control": "no-store",
        "set-cookie": operatorSessionHeader(context, request)
      });
      response.end();
      return;
    }

    if (request.method === "DELETE") {
      requireApiKey(request, context);
      response.writeHead(204, {
        "cache-control": "no-store",
        "set-cookie": expiredOperatorSessionHeader(request)
      });
      response.end();
      return;
    }
  }

  if (request.method === "GET" && pathname === "/topology") {
    sendJson(response, 200, await createTopologyReport(context));
    return;
  }

  if (pathname === "/demo/webhook-receiver") {
    if (request.method === "POST") {
      const body = await readJsonBody(request);
      context.demoWebhookInbox.push({
        id: `demo_inbox_${context.demoWebhookInbox.length + 1}`,
        received_at: new Date().toISOString(),
        headers: request.headers,
        body
      });
      response.writeHead(204, { "cache-control": "no-store" });
      response.end();
      return;
    }

    if (request.method === "GET") {
      sendJson(response, 200, {
        received: context.demoWebhookInbox
      });
      return;
    }
  }

  if (request.method === "GET" && pathname === "/offers") {
    requireApiKey(request, context);
    const entries = await context.store.listOffers();
    const offers = await Promise.all(
      entries
        .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)))
        .map(async (entry) => {
          const username = await context.store.getUsernameForOffer(entry.offer.offer_id);
          return offerListItem(entry, requestOrigin(request), username);
        })
    );
    sendJson(response, 200, { offers });
    return;
  }

  if (request.method === "POST" && pathname === "/offers") {
    requireApiKey(request, context);
    const body = await readJsonBody(request);
    const { offer, encodedOffer } = submittedOffer(body);
    const verification = verifyOffer(offer);
    if (!verification.ok) {
      throw httpError(400, verification.code, verification.message);
    }

    const ownership = await verifyOfferNodeOwnership(offer, context);

    const entry = await context.store.upsertOffer(offer, encodedOffer, {
      username: body.username,
      ownership
    });

    sendJson(response, 201, offerResponse(entry, requestOrigin(request), body.username));
    return;
  }

  if (request.method === "POST" && pathname === "/demo/offers") {
    requireApiKey(request, context);
    const body = await readJsonBody(request);
    const origin = requestOrigin(request);
    const responseBody = await createDemoOffer(body, origin, context);
    sendJson(response, 201, responseBody);
    return;
  }

  if (request.method === "POST" && pathname === "/fiber-addresses") {
    requireApiKey(request, context);
    const body = await readJsonBody(request);
    if (!body.offer_id) throw httpError(400, "MISSING_OFFER_ID", "offer_id is required");

    const binding = await context.store.bindUsername(body.username, body.offer_id);
    sendJson(response, 201, {
      ...binding,
      address: `${binding.username}@${hostOnly(request)}`,
      lookup_url: `${requestOrigin(request)}/.well-known/fiberoffer/${binding.username}`
    });
    return;
  }

  const wellKnownMatch = pathname.match(/^\/\.well-known\/fiberoffer\/([^/]+)$/);
  if (request.method === "GET" && wellKnownMatch) {
    const username = decodeURIComponent(wellKnownMatch[1]);
    const result = await context.store.getByUsername(username);
    if (!result) throw httpError(404, "FIBER_ADDRESS_NOT_FOUND", "Fiber Address was not found");

    sendJson(response, 200, {
      username: result.username,
      address: `${result.username}@${hostOnly(request)}`,
      ...offerResponse(result.entry, requestOrigin(request), result.username)
    });
    return;
  }

  const qrMatch = pathname.match(/^\/offers\/(0x[0-9a-f]{64})\/qr\.svg$/);
  if (request.method === "GET" && qrMatch) {
    const [, offerId] = qrMatch;
    const entry = await context.store.getOffer(offerId);
    if (!entry) throw httpError(404, "OFFER_NOT_FOUND", "offer_id was not found");

    const qr = await renderOfferQrSvg(entry, requestOrigin(request), url.searchParams.get("payload") ?? "link");
    sendSvg(response, 200, qr.svg);
    return;
  }

  const reconciliationMatch = pathname.match(/^\/offers\/(0x[0-9a-f]{64})\/reconciliation\.(json|csv)$/);
  if (request.method === "GET" && reconciliationMatch) {
    const [, offerId, format] = reconciliationMatch;
    const entry = await context.store.getOffer(offerId);
    if (!entry) throw httpError(404, "OFFER_NOT_FOUND", "offer_id was not found");

    const report = await createReconciliationReport(context.store, offerId, requestOrigin(request));
    if (format === "csv") {
      sendCsv(response, 200, reconciliationCsv(report), `fiber-offers-${offerId.slice(2, 10)}.csv`);
      return;
    }

    sendJson(response, 200, report);
    return;
  }

  const receiptMatch = pathname.match(/^\/offers\/(0x[0-9a-f]{64})\/resolutions\/(res_[a-z0-9-]+)\/receipt\.json$/);
  if (request.method === "GET" && receiptMatch) {
    const [, offerId, resolutionId] = receiptMatch;
    const entry = await context.store.getOffer(offerId);
    if (!entry) throw httpError(404, "OFFER_NOT_FOUND", "offer_id was not found");

    const resolution = await context.store.getResolution(offerId, resolutionId);
    if (!resolution) throw httpError(404, "RESOLUTION_NOT_FOUND", "resolution_id was not found");

    sendJson(response, 200, receiptResponse(entry, resolution, requestOrigin(request)));
    return;
  }

  const webhookMatch = pathname.match(/^\/offers\/(0x[0-9a-f]{64})\/(webhooks|webhook-events)$/);
  if (webhookMatch) {
    const [, offerId, resource] = webhookMatch;
    const entry = await context.store.getOffer(offerId);
    if (!entry) throw httpError(404, "OFFER_NOT_FOUND", "offer_id was not found");

    if (request.method === "GET" && resource === "webhooks") {
      requireApiKey(request, context);
      sendJson(response, 200, {
        offer_id: offerId,
        webhooks: (await context.store.listWebhooks(offerId)).map((webhook) => publicWebhook(webhook))
      });
      return;
    }

    if (request.method === "POST" && resource === "webhooks") {
      requireApiKey(request, context);
      const body = await readJsonBody(request);
      const webhook = await context.store.addWebhook(offerId, normalizeWebhookInput(body, context));
      sendJson(response, 201, publicWebhook(webhook, { includeSecret: true }));
      return;
    }

    if (request.method === "GET" && resource === "webhook-events") {
      requireApiKey(request, context);
      sendJson(response, 200, {
        offer_id: offerId,
        events: await context.store.listWebhookEvents(offerId)
      });
      return;
    }
  }

  const webhookSubscriptionMatch = pathname.match(
    /^\/offers\/(0x[0-9a-f]{64})\/webhooks\/(wh_[a-z0-9-]+)(?:\/(test|rotate-secret))?$/
  );
  if (webhookSubscriptionMatch) {
    requireApiKey(request, context);
    const [, offerId, webhookId, action] = webhookSubscriptionMatch;
    const entry = await context.store.getOffer(offerId);
    if (!entry) throw httpError(404, "OFFER_NOT_FOUND", "offer_id was not found");
    const webhook = await context.store.getWebhook(offerId, webhookId);
    if (!webhook) throw httpError(404, "WEBHOOK_NOT_FOUND", "webhook subscription was not found");

    if (request.method === "PATCH" && !action) {
      const body = await readJsonBody(request);
      const updated = await context.store.updateWebhook(offerId, webhookId, normalizeWebhookUpdate(body, context));
      sendJson(response, 200, publicWebhook(updated));
      return;
    }

    if (request.method === "DELETE" && !action) {
      await context.store.deleteWebhook(offerId, webhookId);
      sendJson(response, 200, { offer_id: offerId, webhook_id: webhookId, deleted: true });
      return;
    }

    if (request.method === "POST" && action === "rotate-secret") {
      const updated = await context.store.updateWebhook(offerId, webhookId, { secret: createWebhookSigningSecret() });
      sendJson(response, 200, publicWebhook(updated, { includeSecret: true }));
      return;
    }

    if (request.method === "POST" && action === "test") {
      if (webhook.disabled) throw httpError(409, "WEBHOOK_DISABLED", "resume this webhook before sending a test event");
      const event = await context.store.addWebhookEvent(
        offerId,
        {
          type: "webhook.test",
          payload: {
            offer_id: offerId,
            webhook_id: webhookId,
            message: "Fiber Offers webhook test"
          }
        },
        { webhookIds: [webhookId] }
      );
      const delivery = await drainWebhookEvents(context, offerId, { eventId: event.id });
      sendJson(response, 200, { event_id: event.id, ...delivery });
      return;
    }
  }

  const webhookDeliveryMatch = pathname.match(
    /^\/offers\/(0x[0-9a-f]{64})\/webhook-events(?:\/(evt_[a-z0-9-]+))?\/deliver$/
  );
  if (request.method === "POST" && webhookDeliveryMatch) {
    requireApiKey(request, context);
    const [, offerId, eventId] = webhookDeliveryMatch;
    const entry = await context.store.getOffer(offerId);
    if (!entry) throw httpError(404, "OFFER_NOT_FOUND", "offer_id was not found");

    const body = await readJsonBody(request);
    const result = await drainWebhookEvents(context, offerId, {
      eventId,
      retryFailed: Boolean(body.retry_failed)
    });
    sendJson(response, 200, result);
    return;
  }

  const batchResolutionSyncMatch = pathname.match(/^\/offers\/(0x[0-9a-f]{64})\/resolutions\/sync$/);
  if (request.method === "POST" && batchResolutionSyncMatch) {
    requireApiKey(request, context);
    const [, offerId] = batchResolutionSyncMatch;
    const entry = await context.store.getOffer(offerId);
    if (!entry) throw httpError(404, "OFFER_NOT_FOUND", "offer_id was not found");

    const body = await readJsonBody(request);
    const result = await syncOfferResolutions(context, offerId, requestOrigin(request), {
      includeTerminal: Boolean(body.include_terminal)
    });
    sendJson(response, 200, result);
    return;
  }

  const resolutionSyncMatch = pathname.match(/^\/offers\/(0x[0-9a-f]{64})\/resolutions\/(res_[a-z0-9-]+)\/sync$/);
  if (request.method === "POST" && resolutionSyncMatch) {
    requireApiKey(request, context);
    const [, offerId, resolutionId] = resolutionSyncMatch;
    const entry = await context.store.getOffer(offerId);
    if (!entry) throw httpError(404, "OFFER_NOT_FOUND", "offer_id was not found");

    const result = await syncResolutionFromInvoiceSource(context, offerId, resolutionId, requestOrigin(request));
    sendJson(response, 200, result);
    return;
  }

  const resolutionMatch = pathname.match(/^\/offers\/(0x[0-9a-f]{64})\/resolutions\/(res_[a-z0-9-]+)(?:\/status)?$/);
  if (resolutionMatch) {
    const [, offerId, resolutionId] = resolutionMatch;
    const isStatusRoute = pathname.endsWith("/status");
    const entry = await context.store.getOffer(offerId);
    if (!entry) throw httpError(404, "OFFER_NOT_FOUND", "offer_id was not found");

    if (request.method === "GET" && !isStatusRoute) {
      const resolution = await context.store.getResolution(offerId, resolutionId);
      if (!resolution) throw httpError(404, "RESOLUTION_NOT_FOUND", "resolution_id was not found");

      sendJson(response, 200, publicResolution(resolution, requestOrigin(request), offerId));
      return;
    }

    if (request.method === "POST" && isStatusRoute) {
      requireApiKey(request, context);
      const body = await readJsonBody(request);
      const resolution = await updateResolutionStatus(context.store, offerId, resolutionId, body);
      await appendWebhookEvent(context.store, offerId, webhookEventTypeForStatus(resolution.status), {
        offer_id: offerId,
        resolution: publicResolution(resolution, requestOrigin(request), offerId)
      });
      sendJson(response, 200, publicResolution(resolution, requestOrigin(request), offerId));
      return;
    }
  }

  const offerMatch = pathname.match(/^\/offers\/(0x[0-9a-f]{64})(?:\/(invoice|resolutions|check|recurrence-status))?$/);
  if (offerMatch) {
    const [, offerId, action] = offerMatch;
    const entry = await context.store.getOffer(offerId);
    if (!entry) throw httpError(404, "OFFER_NOT_FOUND", "offer_id was not found");

    if (request.method === "DELETE" && !action) {
      const body = await readJsonBody(request);
      const verification = verifyOfferRevocation(entry.offer, body.revocation ?? body);
      if (!verification.ok) throw httpError(400, verification.code, verification.message);
      const revoked = await context.store.revokeOffer(offerId, body.revocation ?? body);
      sendJson(response, 200, { offer_id: offerId, revoked: true, revoked_at: revoked.revoked_at });
      return;
    }

    if (request.method === "GET" && !action) {
      const username = await context.store.getUsernameForOffer(offerId);
      sendJson(response, 200, offerResponse(entry, requestOrigin(request), username));
      return;
    }

    if (request.method === "GET" && action === "resolutions") {
      const resolutions = await context.store.getResolutions(offerId);
      sendJson(response, 200, {
        offer_id: offerId,
        resolutions: resolutions.map((resolution) => publicResolution(resolution, requestOrigin(request), offerId))
      });
      return;
    }

    if (request.method === "GET" && action === "recurrence-status") {
      sendJson(response, 200, await recurrenceStatus(entry, context.store));
      return;
    }

    if (request.method === "POST" && action === "check") {
      await enforceRateLimit(request, context, "offer-check");
      const body = await readJsonBody(request);
      const result = await checkOfferReadiness(entry, body, context, requestOrigin(request));
      sendJson(response, 200, result);
      return;
    }

    if (request.method === "POST" && action === "invoice") {
      await enforceRateLimit(request, context, "invoice-create");
      const body = await readJsonBody(request);
      const idempotencyKey = invoiceRequestIdempotencyKey(request, body);
      const result = await resolveInvoice(entry, body, context, requestOrigin(request), { idempotencyKey });
      sendJson(response, result.idempotent_replay ? 200 : 201, result);
      return;
    }
  }

  throw httpError(404, "NOT_FOUND", "route was not found");
}

async function createDemoOffer(body, origin, context) {
  const keys = generateOfferKeyPair();
  const username = optionalUsername(body.username);
  const assets = body.assets ?? [{ asset_type: body.asset_type ?? "ckb", symbol: body.symbol ?? "CKB" }];
  const pricing = demoOfferPricing(body);
  const nodeIdentity = await configuredNodeIdentity(context);
  const offer = createSignedOffer(
    {
      node_id: nodeIdentity?.node_id ?? body.node_id ?? demoNodeId(),
      public_key: keys.publicKeyPem,
      resolver_url: body.resolver_url ?? origin,
      description: body.description ?? "Demo merchant offer",
      network: body.network ?? "testnet",
      assets,
      amount_min: pricing.amount_min,
      amount_max: pricing.amount_max,
      expiry: body.expiry,
      single_use: Boolean(body.single_use ?? false),
      recurrence: body.recurrence,
      metadata: {
        demo: true,
        ...(body.metadata ?? {}),
        pricing_type: pricing.type
      }
    },
    keys.privateKeyPem
  );
  const encodedOffer = encodeOffer(offer);
  const ownership = await verifyOfferNodeOwnership(offer, context);
  const entry = await context.store.upsertOffer(offer, encodedOffer, { username, ownership });

  return {
    ...offerResponse(entry, origin, username),
    public_key_pem: keys.publicKeyPem,
    offer_private_key_pem: keys.privateKeyPem
  };
}

function demoOfferPricing(body) {
  const requestedType = body.pricing_type;
  const fixedAmount = body.amount ?? body.amount_min ?? body.amount_max ?? "1000";

  if (requestedType === "fixed" || (requestedType === undefined && body.amount !== undefined)) {
    return { type: "fixed", amount_min: fixedAmount, amount_max: fixedAmount };
  }

  if (requestedType === "open") {
    return { type: "open", amount_min: body.amount_min ?? body.amount ?? "1000", amount_max: undefined };
  }

  if (requestedType === "range") {
    return {
      type: "range",
      amount_min: body.amount_min ?? "1000",
      amount_max: body.amount_max ?? "1000000"
    };
  }

  if (requestedType !== undefined) {
    throw new FiberOfferError("pricing_type must be fixed, open, or range", "INVALID_PRICING_TYPE");
  }

  const amountMin = body.amount_min ?? "1000";
  const amountMax = body.amount_max ?? "1000000";
  return {
    type: String(amountMin) === String(amountMax) ? "fixed" : "range",
    amount_min: amountMin,
    amount_max: amountMax
  };
}

async function resolveInvoice(entry, body, context, origin, options = {}) {
  return withOfferInvoiceLock(context, entry.offer.offer_id, async () => {
    const startedAt = Date.now();
    assertOfferActive(entry);
    const verification = verifyOffer(entry.offer);
    if (!verification.ok) {
      throw httpError(400, verification.code, verification.message);
    }

    await verifyOfferNodeOwnership(entry.offer, context);

    const request = {
      ...validateResolutionRequest(entry.offer, body),
      recurrence_cycle: body?.recurrence_cycle,
      scheduled_for: body?.scheduled_for,
      approval_id: body?.approval_id
    };
    const idempotencyFingerprint = options.idempotencyKey ? invoiceRequestFingerprint(request) : undefined;
    const reservation = await context.store.reserveInvoiceAttempt(entry.offer.offer_id, {
      request,
      idempotencyKey: options.idempotencyKey,
      idempotencyFingerprint
    });
    if (reservation.replay) {
      return invoiceResolutionResponse(entry.offer.offer_id, reservation.record, { idempotentReplay: true });
    }

    let invoice;
    try {
      invoice = await context.invoiceAdapter.createInvoice({
        offer: entry.offer,
        amount: request.amount,
        asset: request.asset,
        request: body
      });
    } catch (error) {
      await context.store.abandonInvoiceReservation(entry.offer.offer_id, reservation.record.id).catch(() => {});
      logResolution(context.logger, {
        outcome: "failed",
        offer_id: entry.offer.offer_id,
        amount: request.amount,
        asset: request.asset,
        code: error.code ?? "FIBER_RPC_UNAVAILABLE",
        duration_ms: Date.now() - startedAt
      });
      throw httpError(503, "RECIPIENT_UNAVAILABLE", "recipient temporarily unavailable, try again", {
        cause_code: error.code ?? "FIBER_RPC_UNAVAILABLE"
      });
    }

    const record = await context.store.finalizeInvoiceReservation(entry.offer.offer_id, reservation.record.id, invoice);
    const webhookEvent = await appendWebhookEvent(context.store, entry.offer.offer_id, "invoice.created", {
      offer_id: entry.offer.offer_id,
      resolution: publicResolution(record, origin, entry.offer.offer_id)
    });

    logResolution(context.logger, {
      outcome: "invoice_created",
      offer_id: entry.offer.offer_id,
      resolution_id: record.id,
      amount: request.amount,
      asset: request.asset,
      invoice_mode: invoice.mode,
      recurrence_cycle: record.recurrence?.cycle,
      duration_ms: Date.now() - startedAt
    });

    return invoiceResolutionResponse(entry.offer.offer_id, record, { webhookEvent });
  });
}

function invoiceResolutionResponse(offerId, record, options = {}) {
  const invoice = record.invoice ?? {};
  return {
    offer_id: offerId,
    resolution_id: record.id,
    status: record.status,
    status_history: record.status_history,
    amount: record.amount,
    asset: record.asset,
    invoice: invoice.invoice,
    payment_request: invoice.payment_request ?? invoice.invoice,
    payment_hash: invoice.payment_hash,
    expires_at: invoice.expires_at,
    invoice_mode: invoice.mode,
    mocked: invoice.mocked,
    recurrence: record.recurrence,
    ...(record.idempotency_key ? { idempotency_key: record.idempotency_key } : {}),
    ...(options.idempotentReplay ? { idempotent_replay: true } : {}),
    ...(options.webhookEvent
      ? {
          webhook_event_id: options.webhookEvent.id,
          webhook_delivery_count: options.webhookEvent.deliveries.length
        }
      : {}),
    raw_result: invoice.raw_result
  };
}

function invoiceRequestIdempotencyKey(request, body) {
  const headerValue = request.headers["idempotency-key"];
  const headerKey = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  const bodyKey = body?.idempotency_key ?? body?.idempotencyKey;

  if (headerKey && bodyKey && headerKey !== bodyKey) {
    throw httpError(400, "IDEMPOTENCY_KEY_MISMATCH", "idempotency key header and body value must match");
  }

  return normalizeIdempotencyKey(headerKey ?? bodyKey);
}

function normalizeIdempotencyKey(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw httpError(
      400,
      "INVALID_IDEMPOTENCY_KEY",
      "idempotency key must be 1-128 characters using letters, numbers, dot, underscore, colon, or dash"
    );
  }
  return value;
}

function invoiceRequestFingerprint(request) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        amount: request.amount,
        asset: request.asset,
        recurrence_cycle: request.recurrence_cycle,
        scheduled_for: request.scheduled_for,
        approval_id: request.approval_id
      })
    )
    .digest("hex");
}

async function withOfferInvoiceLock(context, offerId, operation) {
  const previous = context.invoiceLocks.get(offerId) ?? Promise.resolve();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  context.invoiceLocks.set(offerId, tail);

  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (context.invoiceLocks.get(offerId) === tail) context.invoiceLocks.delete(offerId);
  }
}

async function updateResolutionStatus(store, offerId, resolutionId, body) {
  const current = await store.getResolution(offerId, resolutionId);
  if (!current) throw httpError(404, "RESOLUTION_NOT_FOUND", "resolution_id was not found");

  const nextStatus = normalizeResolutionStatus(body.status);
  assertStatusTransition(current.status, nextStatus);

  return store.updateResolutionStatus(offerId, resolutionId, {
    status: nextStatus,
    source: body.source ?? "manual",
    note: body.note,
    settlement: normalizeSettlement(body),
    details: body.details
  });
}

async function syncResolutionFromInvoiceSource(context, offerId, resolutionId, origin) {
  const current = await context.store.getResolution(offerId, resolutionId);
  if (!current) throw httpError(404, "RESOLUTION_NOT_FOUND", "resolution_id was not found");

  const paymentHash = current.invoice?.payment_hash ?? current.payment_hash;
  if (!paymentHash) {
    throw httpError(409, "MISSING_PAYMENT_HASH", "resolution does not have a payment_hash to sync");
  }

  if (typeof context.invoiceAdapter.syncInvoice !== "function") {
    throw httpError(409, "INVOICE_SYNC_UNSUPPORTED", "configured invoice adapter does not support invoice sync");
  }

  const invoiceSource = await context.invoiceAdapter.syncInvoice(paymentHash);
  const nextStatus = normalizeResolutionStatus(invoiceSource.status);
  const currentStatus = current.status ?? "invoice_created";

  if (currentStatus === nextStatus) {
    return {
      offer_id: offerId,
      resolution_id: resolutionId,
      changed: false,
      invoice_source: publicInvoiceSyncSource(invoiceSource),
      resolution: publicResolution(current, origin, offerId)
    };
  }

  assertStatusTransition(currentStatus, nextStatus);

  const resolution = await context.store.updateResolutionStatus(offerId, resolutionId, {
    status: nextStatus,
    source: "fiber-rpc",
    note: `Fiber invoice status: ${invoiceSource.fiber_status}`,
    settlement: settlementFromInvoiceSync(invoiceSource, nextStatus),
    details: {
      fiber_status: invoiceSource.fiber_status,
      get_invoice_method: invoiceSource.get_invoice_method,
      amount: invoiceSource.amount,
      currency: invoiceSource.currency
    }
  });
  const publicSyncedResolution = publicResolution(resolution, origin, offerId);
  const webhookEvent = await appendWebhookEvent(context.store, offerId, webhookEventTypeForStatus(resolution.status), {
    offer_id: offerId,
    resolution: publicSyncedResolution,
    invoice_source: publicInvoiceSyncSource(invoiceSource)
  });

  return {
    offer_id: offerId,
    resolution_id: resolutionId,
    changed: true,
    previous_status: currentStatus,
    next_status: nextStatus,
    invoice_source: publicInvoiceSyncSource(invoiceSource),
    webhook_event_id: webhookEvent.id,
    webhook_delivery_count: webhookEvent.deliveries.length,
    resolution: publicSyncedResolution
  };
}

async function syncOfferResolutions(context, offerId, origin, options = {}) {
  const resolutions = await context.store.getResolutions(offerId);
  const results = [];

  for (const resolution of resolutions) {
    const status = resolution.status ?? "invoice_created";
    if (!options.includeTerminal && terminalResolutionStatuses.has(status)) {
      results.push({
        resolution_id: resolution.id,
        skipped: true,
        reason: "terminal_status",
        status
      });
      continue;
    }

    const invoiceMode = resolution.invoice?.mode;
    if (resolution.invoice?.mocked === true || (invoiceMode && invoiceMode !== context.invoiceAdapter.mode)) {
      results.push({
        resolution_id: resolution.id,
        skipped: true,
        reason: "invoice_source_mismatch",
        status,
        invoice_mode: invoiceMode ?? "unknown",
        active_invoice_mode: context.invoiceAdapter.mode
      });
      continue;
    }

    if (!resolution.invoice?.payment_hash) {
      results.push({
        resolution_id: resolution.id,
        skipped: true,
        reason: "missing_payment_hash",
        status
      });
      continue;
    }

    try {
      results.push(await syncResolutionFromInvoiceSource(context, offerId, resolution.id, origin));
    } catch (error) {
      results.push({
        resolution_id: resolution.id,
        failed: true,
        status,
        error: {
          code: error.code ?? "INVOICE_SYNC_FAILED",
          message: error.message,
          details: error.details
        }
      });
    }
  }

  return {
    offer_id: offerId,
    checked: resolutions.length,
    changed: results.filter((result) => result.changed).length,
    skipped: results.filter((result) => result.skipped).length,
    failed: results.filter((result) => result.failed).length,
    results
  };
}

async function checkOfferReadiness(entry, body, context, origin) {
  const checks = [];
  const verification = safeVerifyOffer(entry.offer);

  if (entry.disabled) {
    checks.push(failCheck("offer_state", "Offer has been revoked", "OFFER_REVOKED"));
  } else {
    checks.push(passCheck("offer_state", "Offer is active"));
  }

  checks.push(
    verification.ok
      ? passCheck("signature", "Offer signature is valid")
      : failCheck("signature", verification.message ?? "Offer signature is invalid", verification.code)
  );

  let request;
  if (verification.ok) {
    try {
      request = validateResolutionRequest(entry.offer, body);
      checks.push(passCheck("request", "Amount and asset are accepted by this offer"));
    } catch (error) {
      checks.push(failCheck("request", error.message, error.code ?? "INVALID_REQUEST"));
    }
  } else {
    checks.push(failCheck("request", "Request cannot be checked until the offer signature is valid", "SIGNATURE_REQUIRED"));
  }

  const priorResolutions = await context.store.getResolutions(entry.offer.offer_id);
  if (entry.offer.single_use && priorResolutions.length > 0) {
    checks.push(failCheck("single_use", "Single-use offer has already produced an invoice", "OFFER_ALREADY_USED"));
  } else {
    checks.push(passCheck("single_use", "Offer can produce another invoice"));
  }

  if (entry.offer.recurrence) {
    try {
      if (!invoiceFromReadinessBody(body)) validateRecurrenceCycle(entry.offer, body, priorResolutions);
      checks.push(passCheck("recurrence", "Recurring cycle is within the approved caps"));
    } catch (error) {
      checks.push(failCheck("recurrence", error.message, error.code ?? "RECURRENCE_BLOCKED"));
    }
  }

  checks.push(
    context.invoiceAdapter.mode === "mock"
      ? warnCheck("invoice_source", "Resolver is in mock invoice mode")
      : passCheck("invoice_source", "Resolver is configured for Fiber RPC invoices")
  );

  const topology = await createReadinessTopologyReport(context, body);

  return analyzePaymentReadiness({
    offer_id: entry.offer.offer_id,
    amount: request?.amount ?? body?.amount,
    asset: request?.asset ?? body?.asset,
    invoice_mode: context.invoiceAdapter.mode,
    payment_link: offerToPaymentLink(entry.offer, origin),
    invoice: invoiceFromReadinessBody(body),
    checks,
    topology
  });
}

async function createReadinessTopologyReport(context, body) {
  if (!context.topologyClient) return undefined;

  const invoice = invoiceFromReadinessBody(body);
  try {
    if (invoice) {
      return await context.topologyClient.checkInvoiceRoute(invoice, paymentRouteOptionsFromBody(body));
    }

    return await context.topologyClient.inspectPair();
  } catch (error) {
    return {
      ok: false,
      configured: true,
      status: "error",
      summary: "Fiber readiness topology check failed.",
      error: {
        code: error.code ?? "FIBER_READINESS_CHECK_FAILED",
        message: error.message,
        details: error.details
      },
      next_actions: ["Check Fiber RPC connectivity and retry the readiness check."]
    };
  }
}

function invoiceFromReadinessBody(body = {}) {
  return body.invoice ?? body.payment_request ?? body.paymentRequest;
}

function paymentRouteOptionsFromBody(body = {}) {
  return cleanUndefined({
    timeoutSeconds: body.timeout_seconds ?? body.timeoutSeconds,
    maxFeeAmount: body.max_fee_amount ?? body.maxFeeAmount,
    maxFeeRate: body.max_fee_rate ?? body.maxFeeRate,
    maxParts: body.max_parts ?? body.maxParts,
    trampolineHops: body.trampoline_hops ?? body.trampolineHops,
    hopHints: body.hop_hints ?? body.hopHints,
    udtTypeScript: body.udt_type_script ?? body.udtTypeScript,
    allowSelfPayment: body.allow_self_payment ?? body.allowSelfPayment,
    customRecords: body.custom_records ?? body.customRecords
  });
}

function publicResolution(record, origin, offerId) {
  const status = effectiveResolutionStatus(record);
  return {
    id: record.id,
    offer_id: offerId,
    status,
    amount: record.amount,
    asset: record.asset,
    invoice: record.invoice,
    payment_hash: record.invoice?.payment_hash,
    invoice_url: `${origin}/offers/${offerId}/resolutions/${record.id}`,
    receipt_url: `${origin}/offers/${offerId}/resolutions/${record.id}/receipt.json`,
    created_at: record.created_at,
    updated_at: record.updated_at,
    received_at: record.received_at,
    settled_at: record.settled_at,
    expired_at: status === "invoice_expired" ? (record.expired_at ?? record.invoice?.expires_at) : record.expired_at,
    failed_at: record.failed_at,
    cancelled_at: record.cancelled_at,
    settlement: record.settlement,
    recurrence: record.recurrence,
    status_history: record.status_history ?? []
  };
}

function publicInvoiceSyncSource(invoiceSource) {
  return {
    mode: invoiceSource.mode,
    payment_hash: invoiceSource.payment_hash,
    status: invoiceSource.status,
    fiber_status: invoiceSource.fiber_status,
    get_invoice_method: invoiceSource.get_invoice_method,
    amount: invoiceSource.amount,
    currency: invoiceSource.currency,
    invoice: invoiceSource.invoice,
    raw_result: invoiceSource.raw_result
  };
}

function settlementFromInvoiceSync(invoiceSource, nextStatus) {
  if (nextStatus !== "invoice_paid") return {};

  return {
    settlement_reference: invoiceSource.payment_hash,
    paid_amount: invoiceSource.amount
  };
}

async function appendWebhookEvent(store, offerId, type, payload) {
  if (!webhookEventTypes.has(type)) {
    throw httpError(500, "INVALID_WEBHOOK_EVENT", "internal webhook event type is not supported", { type });
  }

  return store.addWebhookEvent(offerId, {
    type,
    payload
  });
}

function webhookEventTypeForStatus(status) {
  const normalizedStatus = status ?? "invoice_created";
  return `invoice.${normalizedStatus.replace(/^invoice_/, "")}`;
}

function normalizeWebhookInput(body, context) {
  const url = normalizeWebhookUrl(body.url, context);
  const events = normalizeWebhookEvents(body.events);
  return {
    url,
    events,
    secret: typeof body.secret === "string" && body.secret.length > 0 ? body.secret : createWebhookSigningSecret()
  };
}

function normalizeWebhookUpdate(body, context) {
  const update = {};
  if (body.url !== undefined) update.url = normalizeWebhookUrl(body.url, context);
  if (body.events !== undefined) update.events = normalizeWebhookEvents(body.events);
  if (body.disabled !== undefined) {
    if (typeof body.disabled !== "boolean") {
      throw httpError(400, "INVALID_WEBHOOK_STATE", "disabled must be a boolean");
    }
    update.disabled = body.disabled;
  }
  if (Object.keys(update).length === 0) {
    throw httpError(400, "EMPTY_WEBHOOK_UPDATE", "provide url, events, or disabled to update the webhook");
  }
  return update;
}

function createWebhookSigningSecret() {
  return `whsec_${randomBytes(24).toString("base64url")}`;
}

function publicWebhook(webhook, options = {}) {
  const { secret, ...publicFields } = webhook;
  return {
    ...publicFields,
    ...(options.includeSecret && secret ? { signing_secret: secret } : {})
  };
}

async function drainWebhookEvents(context, offerId, options = {}) {
  const events = await context.store.listWebhookEvents(offerId);
  const webhooks = await context.store.listWebhooks(offerId);
  const webhookById = new Map(webhooks.map((webhook) => [webhook.id, webhook]));
  const selectedEvents = options.eventId ? events.filter((event) => event.id === options.eventId) : events;

  if (options.eventId && selectedEvents.length === 0) {
    throw httpError(404, "WEBHOOK_EVENT_NOT_FOUND", "webhook event was not found");
  }

  const deliveries = [];
  for (const event of selectedEvents) {
    for (const delivery of event.deliveries) {
      if (!shouldAttemptWebhookDelivery(delivery, options)) continue;

      const webhook = webhookById.get(delivery.webhook_id);
      if (!webhook || webhook.disabled) {
        const updated = await context.store.updateWebhookDelivery(offerId, event.id, delivery.webhook_id, {
          status: "failed",
          error: { message: "webhook subscription is missing or disabled" }
        });
        deliveries.push(publicDeliveryResult(event.id, updated));
        continue;
      }

      const result = await deliverWebhookEvent(event, webhook, delivery, {
        fetchImpl: context.fetchImpl,
        timeoutMs: context.webhookDeliveryTimeoutMs
      });
      const updated = await context.store.updateWebhookDelivery(offerId, event.id, delivery.webhook_id, result);
      deliveries.push(publicDeliveryResult(event.id, updated));
    }
  }

  return {
    offer_id: offerId,
    attempted: deliveries.length,
    delivered: deliveries.filter((delivery) => delivery.status === "delivered").length,
    failed: deliveries.filter((delivery) => delivery.status === "failed").length,
    deliveries
  };
}

function shouldAttemptWebhookDelivery(delivery, options = {}) {
  if (delivery.status === "delivered") return false;
  if (delivery.status === "failed" && !options.retryFailed) return false;

  if (delivery.status === "failed" && options.maxAttempts !== undefined && (delivery.attempts ?? 0) >= options.maxAttempts) {
    return false;
  }

  if (delivery.status === "failed" && options.minRetryAgeMs !== undefined && delivery.last_attempt_at) {
    const lastAttemptAt = Date.parse(delivery.last_attempt_at);
    if (Number.isFinite(lastAttemptAt) && Date.now() - lastAttemptAt < options.minRetryAgeMs) return false;
  }

  return true;
}

function publicDeliveryResult(eventId, delivery) {
  return {
    event_id: eventId,
    webhook_id: delivery.webhook_id,
    url: delivery.url,
    status: delivery.status,
    attempts: delivery.attempts,
    response_status: delivery.response_status,
    error: delivery.error,
    updated_at: delivery.updated_at
  };
}

function normalizeWebhookUrl(value, context) {
  if (typeof value !== "string" || value.trim() === "") {
    throw httpError(400, "INVALID_WEBHOOK_URL", "webhook url is required");
  }

  try {
    const parsed = new URL(value.trim());
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("protocol must be http or https");
    if (parsed.username || parsed.password) throw new Error("credentials are not allowed in webhook URLs");
    if (!context?.allowPrivateWebhookTargets && isPrivateWebhookHost(parsed.hostname)) {
      throw new Error("private-network webhook targets are disabled");
    }
    return parsed.toString();
  } catch (error) {
    throw httpError(400, "INVALID_WEBHOOK_URL", "webhook url must be a valid HTTP(S) URL", {
      cause: error.message
    });
  }
}

function isPrivateWebhookHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    host === "::1" ||
    host.endsWith(".local") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2[0-9]|3[01])\./.test(host)
  );
}

function normalizeWebhookEvents(events) {
  if (events === undefined || events === null) return Array.from(webhookSubscriptionEventTypes);
  if (!Array.isArray(events) || events.length === 0) {
    throw httpError(400, "INVALID_WEBHOOK_EVENTS", "events must be a non-empty array");
  }

  const normalized = [...new Set(events.map((event) => String(event).trim()))];
  const invalid = normalized.filter((event) => !webhookSubscriptionEventTypes.has(event));
  if (invalid.length > 0) {
    throw httpError(400, "INVALID_WEBHOOK_EVENTS", "events contains unsupported webhook event types", {
      invalid,
      supported_events: Array.from(webhookSubscriptionEventTypes)
    });
  }

  return normalized;
}

async function createReconciliationReport(store, offerId, origin) {
  const resolutions = await store.getResolutions(offerId);
  const rows = resolutions.map((resolution) => reconciliationRow(publicResolution(resolution, origin, offerId)));

  return {
    offer_id: offerId,
    generated_at: new Date().toISOString(),
    totals: reconciliationTotals(rows),
    rows
  };
}

function reconciliationRow(resolution) {
  return {
    resolution_id: resolution.id,
    offer_id: resolution.offer_id,
    status: resolution.status,
    amount: resolution.amount,
    asset_type: resolution.asset?.asset_type,
    asset_symbol: resolution.asset?.symbol,
    payment_hash: resolution.payment_hash,
    invoice_mode: resolution.invoice?.mode,
    created_at: resolution.created_at,
    updated_at: resolution.updated_at,
    received_at: resolution.received_at,
    settled_at: resolution.settled_at,
    expired_at: resolution.expired_at,
    failed_at: resolution.failed_at,
    cancelled_at: resolution.cancelled_at,
    settlement_reference: resolution.settlement?.settlement_reference,
    invoice_url: resolution.invoice_url,
    receipt_url: resolution.receipt_url
  };
}

function reconciliationTotals(rows) {
  const by_status = {};
  const by_asset = {};

  for (const row of rows) {
    by_status[row.status] = (by_status[row.status] ?? 0) + 1;

    const assetKey = `${row.asset_type}:${row.asset_symbol}`;
    const previous = by_asset[assetKey] ?? {
      asset_type: row.asset_type,
      asset_symbol: row.asset_symbol,
      resolution_count: 0,
      amount_total: "0",
      statuses: {}
    };

    previous.resolution_count += 1;
    previous.amount_total = (BigInt(previous.amount_total) + BigInt(row.amount ?? "0")).toString();
    previous.statuses[row.status] = (previous.statuses[row.status] ?? 0) + 1;
    by_asset[assetKey] = previous;
  }

  return {
    resolution_count: rows.length,
    by_status,
    by_asset
  };
}

function reconciliationCsv(report) {
  const headers = [
    "resolution_id",
    "offer_id",
    "status",
    "amount",
    "asset_type",
    "asset_symbol",
    "payment_hash",
    "invoice_mode",
    "created_at",
    "updated_at",
    "received_at",
    "settled_at",
    "expired_at",
    "failed_at",
    "cancelled_at",
    "settlement_reference",
    "invoice_url",
    "receipt_url"
  ];
  const rows = report.rows.map((row) => headers.map((header) => csvEscape(row[header])).join(","));
  return [headers.join(","), ...rows].join("\n") + "\n";
}

function receiptResponse(entry, record, origin) {
  const resolution = publicResolution(record, origin, entry.offer.offer_id);
  const verification = safeVerifyOffer(entry.offer);

  return {
    receipt_id: resolution.id,
    issued_at: new Date().toISOString(),
    resolver: "fiber-offers-resolver",
    offer: {
      offer_id: entry.offer.offer_id,
      description: entry.offer.description,
      network: entry.offer.network,
      node_id: entry.offer.node_id,
      signature_valid: verification.ok
    },
    payment: {
      status: resolution.status,
      amount: resolution.amount,
      asset: resolution.asset,
      payment_hash: resolution.payment_hash,
      invoice: resolution.invoice?.invoice,
      created_at: resolution.created_at,
      received_at: resolution.received_at,
      settled_at: resolution.settled_at,
      expired_at: resolution.expired_at,
      failed_at: resolution.failed_at,
      cancelled_at: resolution.cancelled_at,
      settlement: resolution.settlement
    },
    links: {
      resolution: resolution.invoice_url,
      receipt: resolution.receipt_url
    },
    status_history: resolution.status_history
  };
}

function csvEscape(value) {
  if (value === undefined || value === null) return "";
  const text = String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

function effectiveResolutionStatus(record) {
  if (
    ["invoice_created", "invoice_received"].includes(record.status) &&
    record.invoice?.expires_at &&
    Date.now() > Date.parse(record.invoice.expires_at)
  ) {
    return "invoice_expired";
  }

  return record.status ?? "invoice_created";
}

function normalizeResolutionStatus(status) {
  if (typeof status !== "string" || !resolutionStatuses.has(status)) {
    throw httpError(400, "INVALID_RESOLUTION_STATUS", "status must be a supported resolution status", {
      supported_statuses: Array.from(resolutionStatuses)
    });
  }

  return status;
}

function assertStatusTransition(currentStatus, nextStatus) {
  const current = currentStatus ?? "invoice_created";
  if (current === nextStatus) return;

  if (terminalResolutionStatuses.has(current)) {
    throw httpError(409, "INVALID_STATUS_TRANSITION", "terminal resolution status cannot be changed", {
      current_status: current,
      next_status: nextStatus
    });
  }
}

function normalizeSettlement(body) {
  const settlement = {};

  for (const key of ["payment_preimage", "settlement_tx_hash", "settlement_reference", "paid_amount"]) {
    if (body[key] !== undefined) settlement[key] = body[key];
  }

  return settlement;
}

async function createDiagnostics(context) {
  const [store, invoice_source] = await Promise.all([
    context.store.summary(),
    probeInvoiceSource(context.invoiceAdapter)
  ]);

  return {
    ok: invoice_source.mode === "mock" || invoice_source.reachable === true,
    service: "fiber-offers-resolver",
    now: new Date().toISOString(),
    uptime_seconds: Math.round(process.uptime()),
    runtime: {
      node: process.version,
      platform: process.platform
    },
    auth_required: Boolean(context.apiKey),
    invoice_mode: context.invoiceAdapter.mode,
    invoice_source,
    workers: context.backgroundWorkers?.status(),
    store
  };
}

async function createTopologyReport(context) {
  if (!context.topologyClient) {
    return {
      ok: false,
      configured: false,
      status: "unconfigured",
      service: "fiber-offers-resolver",
      message: "Optional pair topology is unavailable because PAYER_FIBER_RPC_URL is not configured"
    };
  }

  try {
    return {
      configured: true,
      service: "fiber-offers-resolver",
      now: new Date().toISOString(),
      ...(await context.topologyClient.inspectPair())
    };
  } catch (error) {
    return {
      ok: false,
      configured: true,
      status: "error",
      service: "fiber-offers-resolver",
      now: new Date().toISOString(),
      error: {
        code: error.code ?? "FIBER_TOPOLOGY_REPORT_FAILED",
        message: error.message,
        details: error.details
      }
    };
  }
}

function createBackgroundWorkers(context, options = {}) {
  const config = normalizeBackgroundWorkerOptions(options);
  const state = {
    enabled: config.enabled,
    running: false,
    settlement_sync: workerTaskState(config.settlementSyncIntervalMs),
    webhook_delivery: workerTaskState(config.webhookDeliveryIntervalMs)
  };
  let settlementTimer;
  let webhookTimer;

  async function runTask(task, fn) {
    if (task.running) return task.last_result ?? { skipped: true, reason: "already_running" };

    task.running = true;
    task.last_started_at = new Date().toISOString();
    task.last_error = undefined;

    try {
      const result = await fn();
      task.pass_count += 1;
      task.last_result = result;
      task.last_finished_at = new Date().toISOString();
      return result;
    } catch (error) {
      task.error_count += 1;
      task.last_error = {
        code: error.code ?? "BACKGROUND_WORKER_ERROR",
        message: error.message,
        details: error.details
      };
      task.last_finished_at = new Date().toISOString();
      context.logger?.error?.(error);
      return {
        failed: true,
        error: task.last_error
      };
    } finally {
      task.running = false;
    }
  }

  const workers = {
    enabled: config.enabled,
    start() {
      if (state.running) return;
      state.running = true;
      if (config.settlementSyncIntervalMs > 0) {
        settlementTimer = setInterval(() => workers.runSettlementSyncPass(), config.settlementSyncIntervalMs);
        settlementTimer.unref?.();
      }
      if (config.webhookDeliveryIntervalMs > 0) {
        webhookTimer = setInterval(() => workers.runWebhookDeliveryPass(), config.webhookDeliveryIntervalMs);
        webhookTimer.unref?.();
      }
      if (config.runOnStart) {
        setTimeout(() => workers.runOnce(), 0).unref?.();
      }
    },
    stop() {
      if (settlementTimer) clearInterval(settlementTimer);
      if (webhookTimer) clearInterval(webhookTimer);
      settlementTimer = undefined;
      webhookTimer = undefined;
      state.running = false;
    },
    status() {
      return {
        enabled: state.enabled,
        running: state.running,
        settlement_sync: publicWorkerTaskState(state.settlement_sync),
        webhook_delivery: publicWorkerTaskState(state.webhook_delivery)
      };
    },
    async runOnce() {
      const [settlement_sync, webhook_delivery] = await Promise.all([
        workers.runSettlementSyncPass(),
        workers.runWebhookDeliveryPass()
      ]);
      return {
        settlement_sync,
        webhook_delivery
      };
    },
    async runSettlementSyncPass() {
      return runTask(state.settlement_sync, () => syncOpenResolutionsForAllOffers(context));
    },
    async runWebhookDeliveryPass() {
      return runTask(state.webhook_delivery, () =>
        drainWebhookEventsForAllOffers(context, {
          retryFailed: true,
          maxAttempts: config.webhookMaxAttempts,
          minRetryAgeMs: config.webhookRetryMinAgeMs
        })
      );
    }
  };

  return workers;
}

async function syncOpenResolutionsForAllOffers(context) {
  if (context.invoiceAdapter.mode === "mock" || typeof context.invoiceAdapter.syncInvoice !== "function") {
    return {
      skipped: true,
      reason: "invoice_sync_unsupported",
      invoice_mode: context.invoiceAdapter.mode
    };
  }

  const offers = await context.store.listOffers();
  const results = [];

  for (const entry of offers) {
    const origin = context.publicOrigin ?? entry.offer.resolver_url;
    results.push(await syncOfferResolutions(context, entry.offer.offer_id, origin, { includeTerminal: false }));
  }

  return {
    offers: offers.length,
    checked: results.reduce((total, result) => total + result.checked, 0),
    changed: results.reduce((total, result) => total + result.changed, 0),
    skipped: results.reduce((total, result) => total + result.skipped, 0),
    failed: results.reduce((total, result) => total + result.failed, 0),
    results
  };
}

async function drainWebhookEventsForAllOffers(context, options = {}) {
  const offers = await context.store.listOffers();
  const results = [];

  for (const entry of offers) {
    results.push(await drainWebhookEvents(context, entry.offer.offer_id, options));
  }

  return {
    offers: offers.length,
    attempted: results.reduce((total, result) => total + result.attempted, 0),
    delivered: results.reduce((total, result) => total + result.delivered, 0),
    failed: results.reduce((total, result) => total + result.failed, 0),
    results
  };
}

function backgroundWorkerOptionsFromEnv(env) {
  return {
    enabled: booleanEnv(env.RESOLVER_WORKERS_ENABLED),
    runOnStart: booleanEnv(env.RESOLVER_WORKERS_RUN_ON_START),
    settlementSyncIntervalMs: positiveInteger(env.RESOLVER_SETTLEMENT_SYNC_INTERVAL_MS, 3000),
    webhookDeliveryIntervalMs: positiveInteger(env.RESOLVER_WEBHOOK_RETRY_INTERVAL_MS, 30000),
    webhookMaxAttempts: positiveInteger(env.RESOLVER_WEBHOOK_MAX_ATTEMPTS, 8),
    webhookRetryMinAgeMs: positiveInteger(env.RESOLVER_WEBHOOK_RETRY_MIN_AGE_MS, 30000)
  };
}

function normalizeBackgroundWorkerOptions(options = {}) {
  return {
    enabled: Boolean(options.enabled),
    runOnStart: Boolean(options.runOnStart),
    settlementSyncIntervalMs: positiveInteger(options.settlementSyncIntervalMs, 30000),
    webhookDeliveryIntervalMs: positiveInteger(options.webhookDeliveryIntervalMs, 30000),
    webhookMaxAttempts: positiveInteger(options.webhookMaxAttempts, 8),
    webhookRetryMinAgeMs: positiveInteger(options.webhookRetryMinAgeMs, 30000)
  };
}

function workerTaskState(intervalMs) {
  return {
    interval_ms: intervalMs,
    running: false,
    pass_count: 0,
    error_count: 0,
    last_started_at: undefined,
    last_finished_at: undefined,
    last_result: undefined,
    last_error: undefined
  };
}

function publicWorkerTaskState(task) {
  return {
    interval_ms: task.interval_ms,
    running: task.running,
    pass_count: task.pass_count,
    error_count: task.error_count,
    last_started_at: task.last_started_at,
    last_finished_at: task.last_finished_at,
    last_result: task.last_result,
    last_error: task.last_error
  };
}

function booleanEnv(value) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

function createRateLimiter(options) {
  const buckets = new Map();
  return {
    async healthCheck() {
      return { ok: true, backend: "memory" };
    },
    take(key, now = Date.now()) {
      if (options.max === 0 || options.windowMs === 0) return { allowed: true };
      const bucket = buckets.get(key);
      if (!bucket || now >= bucket.resetAt) {
        buckets.set(key, { count: 1, resetAt: now + options.windowMs });
        return { allowed: true, remaining: options.max - 1, resetAt: now + options.windowMs };
      }
      bucket.count += 1;
      return {
        allowed: bucket.count <= options.max,
        remaining: Math.max(0, options.max - bucket.count),
        resetAt: bucket.resetAt
      };
    }
  };
}

async function dependencyHealth(context) {
  const checks = await Promise.allSettled([
    context.store.healthCheck?.() ?? { ok: true, backend: "custom" },
    context.rateLimiter.healthCheck?.() ?? { ok: true, backend: "custom" },
    invoiceSourceHealth(context.invoiceAdapter)
  ]);
  const result = {};
  for (const [index, name] of ["store", "rate_limiter", "invoice_source"].entries()) {
    const check = checks[index];
    result[name] = check.status === "fulfilled"
      ? check.value
      : { ok: false, error: check.reason?.code ?? check.reason?.message ?? "unavailable" };
  }
  return result;
}

async function invoiceSourceHealth(invoiceAdapter) {
  const source = await probeInvoiceSource(invoiceAdapter);
  return {
    ok: source.mode === "mock" || source.reachable === true,
    backend: source.mode,
    status: source.status,
    node_id: source.node?.pubkey ?? source.result_summary?.pubkey,
    error: source.error?.code
  };
}

async function enforceRateLimit(request, context, scope) {
  const forwarded = request.headers["x-forwarded-for"];
  const address = (Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(",")[0])?.trim() ?? request.socket.remoteAddress ?? "unknown";
  const result = await context.rateLimiter.take(`${scope}:${address}`);
  if (!result.allowed) {
    throw httpError(429, "RATE_LIMITED", "too many requests, retry after the current rate-limit window", {
      retry_after_seconds: Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000))
    });
  }
}

function logResolution(logger, event) {
  logger.info?.(JSON.stringify({
    event: "fiber_offer_resolution",
    at: new Date().toISOString(),
    ...event
  }));
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function createTopologyClientFromEnv(env, fetchImpl) {
  const merchantUrl = env.MERCHANT_FIBER_RPC_URL ?? env.FIBER_RPC_URL;
  const payerUrl = env.PAYER_FIBER_RPC_URL;

  if (!merchantUrl || !payerUrl) return undefined;

  return new FiberTopologyClient({
    merchant: {
      url: merchantUrl,
      username: env.MERCHANT_FIBER_RPC_USERNAME ?? env.FIBER_RPC_USERNAME,
      password: env.MERCHANT_FIBER_RPC_PASSWORD ?? env.FIBER_RPC_PASSWORD,
      fetchImpl
    },
    payer: {
      url: payerUrl,
      username: env.PAYER_FIBER_RPC_USERNAME ?? env.FIBER_RPC_USERNAME,
      password: env.PAYER_FIBER_RPC_PASSWORD ?? env.FIBER_RPC_PASSWORD,
      fetchImpl
    }
  });
}

function requireApiKey(request, context) {
  if (!context.apiKey) return;

  if (!hasValidApiCredential(request, context)) {
    throw httpError(401, "UNAUTHORIZED", "valid API key is required");
  }
}

function hasValidApiCredential(request, context) {
  const authorization = request.headers.authorization;
  const bearer = typeof authorization === "string" && authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : undefined;
  const headerKey = request.headers["x-api-key"];
  const provided = bearer ?? (Array.isArray(headerKey) ? headerKey[0] : headerKey);
  if (safeSecretEqual(provided, context.apiKey)) return true;

  const token = parseCookies(request.headers.cookie)[operatorSessionCookie];
  return verifyOperatorSession(token, context.apiKey);
}

function operatorSessionHeader(context, request) {
  const expiresAt = Math.floor(Date.now() / 1000) + context.operatorSessionTtlSeconds;
  const payload = `${expiresAt}.${randomBytes(18).toString("base64url")}`;
  const signature = createHmac("sha256", context.apiKey).update(payload).digest("base64url");
  return cookieHeader(`${payload}.${signature}`, context.operatorSessionTtlSeconds, request);
}

function expiredOperatorSessionHeader(request) {
  return cookieHeader("", 0, request);
}

function cookieHeader(value, maxAge, request) {
  const secure = requestOrigin(request).startsWith("https://") ? "; Secure" : "";
  return `${operatorSessionCookie}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`;
}

function verifyOperatorSession(token, apiKey) {
  if (!token || !apiKey) return false;
  const [expiresAt, nonce, signature, ...rest] = String(token).split(".");
  if (rest.length > 0 || !/^\d+$/.test(expiresAt) || !nonce || !signature) return false;
  if (Number(expiresAt) <= Math.floor(Date.now() / 1000)) return false;
  const expected = createHmac("sha256", apiKey).update(`${expiresAt}.${nonce}`).digest("base64url");
  return safeSecretEqual(signature, expected);
}

function safeSecretEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function parseCookies(header) {
  if (typeof header !== "string") return {};
  return Object.fromEntries(
    header.split(";").map((item) => {
      const separator = item.indexOf("=");
      if (separator < 0) return [item.trim(), ""];
      return [item.slice(0, separator).trim(), item.slice(separator + 1).trim()];
    })
  );
}

async function probeInvoiceSource(invoiceAdapter) {
  if (typeof invoiceAdapter.probe !== "function") {
    return {
      mode: invoiceAdapter.mode ?? "unknown",
      configured: false,
      reachable: false,
      status: "unsupported",
      message: "invoice adapter does not expose diagnostics"
    };
  }

  return invoiceAdapter.probe();
}

function submittedOffer(body) {
  const encodedOffer = body.encoded_offer ?? body.encodedOffer;
  if (encodedOffer) {
    return {
      offer: decodeOffer(encodedOffer),
      encodedOffer
    };
  }

  if (body.offer) {
    return {
      offer: body.offer,
      encodedOffer: encodeOffer(body.offer)
    };
  }

  throw httpError(400, "MISSING_OFFER", "encoded_offer or offer is required");
}

function offerResponse(entry, origin, username = undefined) {
  const normalizedUsername = optionalUsername(username);
  const qrBase = `${origin}/offers/${entry.offer.offer_id}/qr.svg`;
  return {
    offer_id: entry.offer.offer_id,
    encoded_offer: entry.encoded_offer,
    offer: entry.offer,
    payment_link: offerToPaymentLink(entry.offer, origin),
    qr_link_url: `${qrBase}?payload=link`,
    qr_offer_url: `${qrBase}?payload=offer`,
    fiber_address: normalizedUsername ? `${normalizedUsername}@${new URL(origin).host}` : undefined,
    lookup_url: normalizedUsername ? `${origin}/.well-known/fiberoffer/${normalizedUsername}` : undefined,
    created_at: entry.created_at,
    updated_at: entry.updated_at,
    disabled: Boolean(entry.disabled),
    revoked_at: entry.revoked_at,
    ownership: entry.ownership
  };
}

function offerListItem(entry, origin, username = undefined) {
  const offer = entry.offer;
  const normalizedUsername = optionalUsername(username);
  return {
    offer_id: offer.offer_id,
    description: offer.description,
    network: offer.network,
    assets: offer.assets,
    amount_min: offer.amount_min,
    amount_max: offer.amount_max,
    single_use: offer.single_use,
    disabled: entry.disabled,
    fiber_address: normalizedUsername ? `${normalizedUsername}@${new URL(origin).host}` : undefined,
    payment_link: offerToPaymentLink(offer, origin),
    created_at: entry.created_at,
    updated_at: entry.updated_at
  };
}

async function configuredNodeIdentity(context) {
  if (typeof context.invoiceAdapter.getNodeIdentity !== "function") return undefined;
  try {
    return await context.invoiceAdapter.getNodeIdentity();
  } catch (error) {
    if (!context.enforceNodeOwnership) return undefined;
    throw httpError(503, "FIBER_NODE_ID_UNAVAILABLE", "recipient node identity is temporarily unavailable", {
      cause_code: error.code
    });
  }
}

async function verifyOfferNodeOwnership(offer, context) {
  const identity = await configuredNodeIdentity(context);
  if (!identity) {
    return {
      status: "unverified",
      method: "not_available",
      node_id: offer.node_id
    };
  }
  if (identity.node_id !== offer.node_id.toLowerCase()) {
    throw httpError(403, "OFFER_NODE_MISMATCH", "offer node_id does not match the resolver's configured Fiber node", {
      offer_node_id: offer.node_id,
      configured_node_id: identity.node_id
    });
  }
  return {
    status: "verified",
    method: "resolver-node-info",
    node_id: identity.node_id,
    source: identity.source,
    verified_at: new Date().toISOString()
  };
}

function assertOfferActive(entry) {
  if (entry.disabled) throw httpError(410, "OFFER_REVOKED", "offer has been revoked");
}

function validateRecurrenceCycle(offer, body, priorResolutions) {
  if (!offer.recurrence) {
    if (body?.recurrence_cycle !== undefined) {
      throw httpError(400, "RECURRENCE_NOT_CONFIGURED", "offer does not define recurring payment terms");
    }
    return undefined;
  }

  const recurrence = offer.recurrence;
  const amount = String(body?.amount ?? "");
  if (!/^[1-9][0-9]*$/.test(amount)) {
    throw httpError(400, "INVALID_AMOUNT", "recurring cycle amount must be a positive integer string");
  }
  if (BigInt(amount) !== BigInt(recurrence.amount)) {
    throw httpError(400, "RECURRENCE_AMOUNT_MISMATCH", `recurring cycle amount must equal ${recurrence.amount}`);
  }

  const cycles = priorResolutions.filter((resolution) => resolution.recurrence);
  const expectedCycle = cycles.length + 1;
  const requestedCycle = body?.recurrence_cycle === undefined ? expectedCycle : Number(body.recurrence_cycle);
  if (!Number.isSafeInteger(requestedCycle) || requestedCycle <= 0 || requestedCycle !== expectedCycle) {
    throw httpError(409, "INVALID_RECURRENCE_CYCLE", `next recurrence cycle must be ${expectedCycle}`);
  }
  if (recurrence.cap_cycles !== undefined && expectedCycle > recurrence.cap_cycles) {
    throw httpError(409, "RECURRENCE_CYCLE_CAP_REACHED", "recurring payment cycle cap has been reached");
  }

  const reservedTotal = cycles.reduce((total, resolution) => total + BigInt(resolution.amount), 0n);
  if (
    recurrence.spending_cap_total !== undefined &&
    reservedTotal + BigInt(recurrence.amount) > BigInt(recurrence.spending_cap_total)
  ) {
    throw httpError(409, "RECURRENCE_SPENDING_CAP_REACHED", "recurring payment spending cap has been reached");
  }

  return {
    cycle: expectedCycle,
    interval: recurrence.interval,
    scheduled_for: body?.scheduled_for,
    approval_id: body?.approval_id
  };
}

async function recurrenceStatus(entry, store) {
  const recurrence = entry.offer.recurrence;
  if (!recurrence) {
    return { offer_id: entry.offer.offer_id, enabled: false, revoked: Boolean(entry.disabled) };
  }
  const resolutions = await store.getResolutions(entry.offer.offer_id);
  const cycles = resolutions.filter((resolution) => resolution.recurrence);
  const paid = cycles.filter((resolution) => effectiveResolutionStatus(resolution) === "invoice_paid");
  const reservedTotal = cycles.reduce((total, resolution) => total + BigInt(resolution.amount), 0n);
  const paidTotal = paid.reduce((total, resolution) => total + BigInt(resolution.amount), 0n);
  const capRemaining = recurrence.spending_cap_total === undefined
    ? undefined
    : (BigInt(recurrence.spending_cap_total) - reservedTotal < 0n
        ? 0n
        : BigInt(recurrence.spending_cap_total) - reservedTotal).toString();
  return {
    offer_id: entry.offer.offer_id,
    enabled: true,
    revoked: Boolean(entry.disabled),
    terms: recurrence,
    cycles_created: cycles.length,
    cycles_paid: paid.length,
    next_cycle: cycles.length + 1,
    reserved_total: reservedTotal.toString(),
    paid_total: paidTotal.toString(),
    spending_cap_remaining: capRemaining,
    cycle_cap_remaining: recurrence.cap_cycles === undefined ? undefined : Math.max(0, recurrence.cap_cycles - cycles.length)
  };
}

function safeVerifyOffer(offer) {
  try {
    return verifyOffer(offer);
  } catch (error) {
    return {
      ok: false,
      code: error.code ?? "INVALID_OFFER",
      message: error.message
    };
  }
}

function passCheck(id, message) {
  return { id, status: "pass", message };
}

function warnCheck(id, message, code = undefined) {
  return { id, status: "warn", message, code };
}

function failCheck(id, message, code = undefined) {
  return { id, status: "fail", message, code };
}

function cleanUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxJsonBytes) {
      throw httpError(413, "BODY_TOO_LARGE", "JSON body is too large");
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim() === "") return {};

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw httpError(400, "INVALID_JSON", "request body must be valid JSON", { cause: error.message });
  }
}

async function serveStatic(pathname, response, staticRoot) {
  let filePath;
  if (pathname === "/" || pathname === "/index.html" || /^\/pay\/0x[0-9a-f]{64}$/.test(pathname)) {
    filePath = join(staticRoot, "index.html");
  } else if (pathname === "/docs" || pathname === "/docs/" || pathname === "/docs.html") {
    filePath = join(staticRoot, "docs.html");
  } else if (pathname === "/docs/concepts") {
    filePath = join(staticRoot, "docs-concepts.html");
  } else if (pathname === "/docs/quickstart") {
    filePath = join(staticRoot, "docs-quickstart.html");
  } else if (pathname === "/docs/self-hosting") {
    filePath = join(staticRoot, "docs-self-hosting.html");
  } else if (pathname === "/docs/api") {
    filePath = join(staticRoot, "docs-api.html");
  } else if (pathname === "/docs/wallets") {
    filePath = join(staticRoot, "docs-wallets.html");
  } else if (pathname === "/docs/merchants") {
    filePath = join(staticRoot, "docs-merchants.html");
  } else if (pathname === "/docs/fiber") {
    filePath = join(staticRoot, "docs-fiber.html");
  } else if (pathname === "/docs/sdk") {
    filePath = join(staticRoot, "docs-sdk.html");
  } else if (pathname === "/docs/production") {
    filePath = join(staticRoot, "docs-production.html");
  } else if (pathname === "/docs/system-design.png") {
    filePath = join(staticRoot, "../../../docs/system-design.png");
  } else if (pathname === "/app.js") {
    filePath = join(staticRoot, "app.js");
  } else if (pathname === "/styles.css") {
    filePath = join(staticRoot, "styles.css");
  } else if (pathname === "/docs.css") {
    filePath = join(staticRoot, "docs.css");
  } else if (pathname === "/docs-highlight.js") {
    filePath = join(staticRoot, "docs-highlight.js");
  } else if (pathname === "/favicon.svg") {
    filePath = join(staticRoot, "favicon.svg");
  } else {
    return false;
  }

  const body = await readFile(filePath);
  const type = filePath.endsWith(".js")
    ? "text/javascript"
    : filePath.endsWith(".css")
      ? "text/css"
      : filePath.endsWith(".svg")
        ? "image/svg+xml"
        : "text/html";
  response.writeHead(200, {
    "content-type": `${type}; charset=utf-8`,
    "cache-control": "no-store"
  });
  response.end(body);
  return true;
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(body, null, 2));
}

function sendSvg(response, status, body) {
  response.writeHead(status, {
    "content-type": "image/svg+xml; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(body);
}

function sendCsv(response, status, body, filename) {
  response.writeHead(status, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="${filename}"`,
    "cache-control": "no-store"
  });
  response.end(body);
}

function sendError(response, error, logger) {
  const status = error.status ?? statusForError(error);
  const code = error.code ?? "INTERNAL_ERROR";
  const message = status >= 500 && !error.expose ? "internal server error" : error.message;

  if (status >= 500) logger.error(error);

  sendJson(response, status, {
    error: {
      code,
      message,
      details: status >= 500 ? undefined : error.details
    }
  });
}

function statusForError(error) {
  if (error instanceof FiberOfferError) {
    if (["AMOUNT_TOO_LOW", "AMOUNT_TOO_HIGH", "AMOUNT_MUST_MATCH_FIXED_AMOUNT", "UNSUPPORTED_ASSET", "OFFER_EXPIRED"].includes(error.code)) {
      return 422;
    }
    return 400;
  }

  return 500;
}

function httpError(status, code, message, details = undefined) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.details = details;
  error.expose = true;
  return error;
}

function setCorsHeaders(response) {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-methods", "GET,POST,PATCH,DELETE,OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type,authorization,x-api-key,idempotency-key");
}

function requestOrigin(request) {
  const forwardedProto = request.headers["x-forwarded-proto"];
  const forwardedHost = request.headers["x-forwarded-host"];
  const proto = Array.isArray(forwardedProto) ? forwardedProto[0] : (forwardedProto?.split(",")[0] ?? "http");
  const host = Array.isArray(forwardedHost)
    ? forwardedHost[0]
    : (forwardedHost?.split(",")[0] ?? request.headers.host ?? "localhost");
  return `${proto}://${host}`;
}

function hostOnly(request) {
  return new URL(requestOrigin(request)).host;
}

function optionalUsername(username) {
  if (username === undefined || username === null || username === "") return undefined;
  return normalizeUsername(username);
}

function demoNodeId() {
  return `02${cryptoRandomHex(32)}`;
}

function cryptoRandomHex(bytes) {
  return randomBytes(bytes).toString("hex");
}

function applyDefaultRuntimeConfiguration(env) {
  env.FIBER_INVOICE_MODE ??= "fiber-rpc";
  if (env.FIBER_INVOICE_MODE.trim().toLowerCase() === "mock") return;

  env.FIBER_RPC_URL ??= env.MERCHANT_FIBER_RPC_URL ?? "http://127.0.0.1:8227";
  env.MERCHANT_FIBER_RPC_URL ??= env.FIBER_RPC_URL;
  env.RESOLVER_WORKERS_ENABLED ??= env.REDIS_URL ? "false" : "true";
  env.RESOLVER_WORKERS_RUN_ON_START ??= env.REDIS_URL ? "false" : "true";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  applyDefaultRuntimeConfiguration(process.env);
  const port = Number(process.env.PORT ?? 8787);
  const server = createServer();
  server.listen(port, () => {
    console.log(`Fiber Offers resolver running at http://localhost:${port}`);
    console.log(`Invoice mode: ${server.invoiceAdapter.mode}`);
    console.log(`Settlement workers: ${server.backgroundWorkers.enabled ? "enabled" : "disabled"}`);
  });
}
