import { createServer as createHttpServer } from "node:http";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { analyzePaymentReadiness, FiberTopologyClient } from "../../../packages/sdk/src/index.js";
import {
  createSignedOffer,
  decodeOffer,
  encodeOffer,
  FiberOfferError,
  generateOfferKeyPair,
  validateResolutionRequest,
  verifyOffer,
  verifyOfferRevocation,
  verifyRecurrenceRequest
} from "../../../packages/protocol/src/index.js";
import { createInvoiceAdapter } from "./invoice-adapter.js";
import { classifyInvoiceFailure } from "./invoice-errors.js";
import { PostgresOfferStore } from "./postgres-store.js";
import { assertProductionConfiguration } from "./production-guard.js";
import { renderOfferQrSvg } from "./qr.js";
import { RedisRateLimiter } from "./redis-rate-limiter.js";
import {
  assertSingleUseCapacity,
  canTransition,
  countedResolutions,
  isConsumed,
  PUBLIC_RESOLUTION_STATUSES,
  recurrenceReservation,
  resolutionUnderCheck,
  subscriptionStatus,
  TERMINAL_RESOLUTION_STATUSES
} from "./resolution-rules.js";
import { InMemoryOfferStore, JsonOfferStore, normalizeUsername } from "./store.js";
import { deliverWebhookEvent } from "./webhook-delivery.js";
import { assertWebhookUrlAllowed } from "./webhook-target.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
const defaultStaticRoot = resolve(currentDir, "../../demo/public");
const defaultDataPath = resolve(currentDir, "../data/offers.json");
const maxJsonBytes = 1024 * 1024;
const resolutionStatuses = new Set(PUBLIC_RESOLUTION_STATUSES);
const terminalResolutionStatuses = new Set(TERMINAL_RESOLUTION_STATUSES);
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
// The demo webhook inbox keeps the most recent deliveries only.
const demoInboxLimits = { entries: 50, entryBytes: 64 * 1024, totalBytes: 512 * 1024 };
// How long one dependency probe answers /health, so anonymous health checks
// cannot be used to hammer the Fiber node, the database or Redis.
const healthCacheMs = 5000;

export { InMemoryOfferStore, JsonOfferStore, PostgresOfferStore, createRateLimiter as createMemoryRateLimiter };

// The store the environment configures: PostgreSQL when DATABASE_URL is set,
// the JSON file otherwise. Also used by rotate-secrets.js, so the rotation
// command always works on the store the resolver itself would open.
export function createStoreFromEnv(env = process.env, options = {}) {
  const encryption = {
    encryptionKey: options.encryptionKey ?? env.RESOLVER_SECRET_ENCRYPTION_KEY,
    // Still accepted for reading while secrets are re-encrypted under a new key.
    previousEncryptionKey: options.previousEncryptionKey ?? env.RESOLVER_SECRET_ENCRYPTION_KEY_PREVIOUS
  };
  return env.DATABASE_URL
    ? new PostgresOfferStore({
        connectionString: env.DATABASE_URL,
        maxConnections: env.DATABASE_POOL_MAX,
        ...encryption
      })
    : new JsonOfferStore(options.dataPath ?? env.RESOLVER_DATA_PATH ?? defaultDataPath, encryption);
}

export function createServer(options = {}) {
  const store = options.store ?? createStoreFromEnv(process.env, options);
  const invoiceAdapter = options.invoiceAdapter ?? createInvoiceAdapter(process.env);
  const staticRoot = options.staticRoot ?? defaultStaticRoot;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const apiKey = options.apiKey ?? process.env.RESOLVER_API_KEY;
  const logger = options.logger ?? console;
  // Demo mode switches on everything that exists for the public demo and has no
  // place on a merchant's resolver: the /demo routes, operator access for every
  // visitor, and route checks on the operator's payer node for anonymous callers.
  const demoMode = options.demoMode ?? booleanEnv(process.env.RESOLVER_DEMO_MODE);
  const publicOperatorAccessRequested =
    options.publicOperatorAccess ?? booleanEnv(process.env.RESOLVER_PUBLIC_OPERATOR_ACCESS);
  if (publicOperatorAccessRequested && !demoMode) {
    logger.warn?.("RESOLVER_PUBLIC_OPERATOR_ACCESS is ignored because RESOLVER_DEMO_MODE is not enabled");
  }
  const publicOperatorAccess = Boolean(demoMode && publicOperatorAccessRequested);
  const operatorSessionTtlSeconds = positiveInteger(
    options.operatorSessionTtlSeconds ?? process.env.RESOLVER_ADMIN_SESSION_TTL_SECONDS,
    28800
  );
  const topologyClient = options.topologyClient ?? createTopologyClientFromEnv(process.env, fetchImpl);
  const demoWebhookInbox = { entries: [], sizes: [], bytes: 0, sequence: 0 };
  const publicOrigin = normalizePublicOrigin(options.publicOrigin ?? process.env.RESOLVER_PUBLIC_URL);
  // How many reverse proxies this resolver sits behind. Forwarding headers are
  // believed only from that many trusted hops; with 0 they are ignored.
  const trustedProxyHops = positiveInteger(
    options.trustedProxyHops ?? process.env.RESOLVER_TRUSTED_PROXY_HOPS,
    0
  );
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
    demoMode,
    publicOperatorAccess,
    operatorSessionTtlSeconds,
    topologyClient,
    demoWebhookInbox,
    logger,
    publicOrigin,
    trustedProxyHops,
    rateLimitFailOpen:
      options.rateLimitFailOpen ??
      (process.env.RESOLVER_RATE_LIMIT_FAIL_OPEN === undefined
        ? true
        : booleanEnv(process.env.RESOLVER_RATE_LIMIT_FAIL_OPEN)),
    webhookDeliveryTimeoutMs,
    // A DNS lookup to use for webhook targets in place of the system's (tests).
    webhookLookup: options.webhookLookup,
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
  server.demoMode = demoMode;
  server.publicOperatorAccess = publicOperatorAccess;
  server.backgroundWorkers = backgroundWorkers;
  server.startBackgroundWorkers = () => backgroundWorkers.start();
  server.stopBackgroundWorkers = () => backgroundWorkers.stop();
  // Stops the workers, lets a pass that is already running finish, then closes
  // the rate limiter and the store. Runs once however it is reached.
  let resourcesClosed;
  const closeResources = () =>
    (resourcesClosed ??= (async () => {
      backgroundWorkers.stop();
      await backgroundWorkers.idle();
      const results = await Promise.allSettled([context.rateLimiter.close?.(), store.close?.()]);
      for (const result of results) if (result.status === "rejected") logger.error?.(result.reason);
    })());
  server.on("close", closeResources);

  // Graceful stop: take no new connections, let requests in progress finish
  // (for at most `timeoutMs`), then close everything behind them.
  server.shutdown = async ({ timeoutMs = 8000 } = {}) => {
    backgroundWorkers.stop();
    const closed = new Promise((resolveClosed) => server.close(() => resolveClosed()));
    // A connection that is idle now, or becomes idle when its request ends, is
    // closed; one still waiting on a response is left to finish.
    const sweep = setInterval(() => server.closeIdleConnections(), 50);
    const deadline = setTimeout(() => server.closeAllConnections(), timeoutMs);
    server.closeIdleConnections();
    try {
      await closed;
    } finally {
      clearInterval(sweep);
      clearTimeout(deadline);
    }
    await closeResources();
  };
  if (backgroundWorkers.enabled) backgroundWorkers.start();
  return server;
}

// ---- Routes ----------------------------------------------------------------
//
// Every HTTP route is declared in ROUTES with who may call it. The dispatcher
// enforces that before the handler runs, so a handler cannot forget the check,
// and apps/resolver/test/route-access.test.js fails when a route is added
// without its access being stated there too.
//
//   access "public"    anyone: the payment path itself, or a read addressed by
//                      an ID only its holder knows
//   access "operator"  the API key or an operator session
//   demo: true         the route exists only when RESOLVER_DEMO_MODE=true
//   query              the route applies only when this query parameter is given
//   offer: true        `:offerId` must name a stored offer (404 otherwise)
//   rateLimit          per-client limit, applied before anything is looked up

const PATH_PARAMETERS = {
  offerId: "0x[0-9a-f]{64}",
  resolutionId: "res_[a-z0-9-]+",
  webhookId: "wh_[a-z0-9-]+",
  eventId: "evt_[a-z0-9-]+",
  username: "[^/]+",
  format: "json|csv"
};

const ROUTES = [
  route("GET", "/health", { access: "public" }, getHealth),
  route("GET", "/diagnostics", { access: "operator" }, async ({ response, context }) => {
    sendJson(response, 200, await createDiagnostics(context));
  }),
  route("GET", "/topology", { access: "operator" }, async ({ response, context }) => {
    sendJson(response, 200, await createTopologyReport(context));
  }),

  route("GET", "/operator/session", { access: "public" }, getOperatorSession),
  route("POST", "/operator/session", { access: "public" }, loginOperator),
  route("DELETE", "/operator/session", { access: "operator" }, ({ request, response }) => {
    response.writeHead(204, {
      "cache-control": "no-store",
      "set-cookie": expiredOperatorSessionHeader(request)
    });
    response.end();
  }),

  route("POST", "/demo/offers", { access: "operator", demo: true }, async ({ request, response, context, origin }) => {
    const body = await readJsonBody(request);
    sendJson(response, 201, await createDemoOffer(body, origin, context));
  }),
  route("POST", "/demo/webhook-receiver", { access: "public", demo: true }, receiveDemoWebhook),
  route("GET", "/demo/webhook-receiver", { access: "operator", demo: true }, ({ response, context }) => {
    sendJson(response, 200, { received: context.demoWebhookInbox.entries });
  }),

  route("GET", "/offers", { access: "operator" }, listOffers),
  route("POST", "/offers", { access: "operator" }, registerOffer),
  route("POST", "/fiber-addresses", { access: "operator" }, bindFiberAddress),
  route("GET", "/.well-known/fiberoffer/:username", { access: "public" }, lookupFiberAddress),

  route("GET", "/offers/:offerId", { access: "public", offer: true }, async ({ response, context, entry, origin }) => {
    const username = await context.store.getUsernameForOffer(entry.offer.offer_id);
    sendJson(response, 200, offerResponse(entry, origin, username));
  }),
  // Revocation carries its own proof: a signature by the offer's key.
  route(
    "DELETE",
    "/offers/:offerId",
    { access: "public", offer: true, rateLimit: { scope: "offer-revoke" } },
    revokeOffer
  ),
  route(
    "GET",
    "/offers/:offerId/qr.svg",
    { access: "public", offer: true, rateLimit: { scope: "offer-qr" } },
    async ({ response, entry, origin, url }) => {
      const qr = await renderOfferQrSvg(entry, origin, url.searchParams.get("payload") ?? "link");
      sendSvg(response, 200, qr.svg);
    }
  ),
  route(
    "POST",
    "/offers/:offerId/check",
    { access: "public", offer: true, rateLimit: { scope: "offer-check" } },
    checkOffer
  ),
  route(
    "POST",
    "/offers/:offerId/invoice",
    { access: "public", offer: true, rateLimit: { scope: "invoice-create" } },
    async ({ request, response, context, entry, origin }) => {
      const body = await readJsonBody(request);
      const idempotencyKey = invoiceRequestIdempotencyKey(request, body);
      const result = await resolveInvoice(entry, body, context, origin, { idempotencyKey });
      sendJson(response, result.idempotent_replay ? 200 : 201, result);
    }
  ),
  // Where one subscription stands, for its payer: the subscription ID is derived
  // from a key only that payer holds. The same path without it is the summary
  // across every subscriber, which is the merchant's.
  route(
    "GET",
    "/offers/:offerId/recurrence-status",
    { access: "public", offer: true, query: "approval_id", rateLimit: { scope: "recurrence-status" } },
    async ({ response, context, url, entry, origin }) => {
      const approvalId = url.searchParams.get("approval_id");
      // The payer asks which cycle to request next. Bring the subscription's
      // open invoice up to date first, so a payment the node has already seen
      // is counted. If the node cannot be asked, answer from what is stored.
      await settleOpenResolutions(context, entry, origin, approvalId).catch(() => {});
      sendJson(response, 200, await recurrenceStatus(entry, context.store, approvalId));
    }
  ),
  route(
    "GET",
    "/offers/:offerId/recurrence-status",
    { access: "operator", offer: true },
    async ({ response, context, entry }) => {
      sendJson(response, 200, await recurrenceStatus(entry, context.store));
    }
  ),

  // One resolution and its receipt are addressed by the resolution ID, which
  // only the payer who requested that invoice (and the merchant) holds.
  route(
    "GET",
    "/offers/:offerId/resolutions/:resolutionId",
    { access: "public", offer: true },
    async ({ response, context, params, origin }) => {
      const resolution = await storedResolution(context, params);
      sendJson(response, 200, publicResolution(resolution, origin, params.offerId));
    }
  ),
  route(
    "GET",
    "/offers/:offerId/resolutions/:resolutionId/receipt.json",
    { access: "public", offer: true },
    async ({ response, context, params, entry, origin }) => {
      const resolution = await storedResolution(context, params);
      sendJson(response, 200, receiptResponse(entry, resolution, origin));
    }
  ),

  // The offer ID is in every payment link, so anything listing an offer's
  // payments is the merchant's payment history and needs operator access.
  route(
    "GET",
    "/offers/:offerId/resolutions",
    { access: "operator", offer: true },
    async ({ response, context, params, origin }) => {
      const resolutions = await context.store.getResolutions(params.offerId);
      sendJson(response, 200, {
        offer_id: params.offerId,
        resolutions: resolutions.map((resolution) => publicResolution(resolution, origin, params.offerId))
      });
    }
  ),
  route(
    "GET",
    "/offers/:offerId/reconciliation.:format",
    { access: "operator", offer: true },
    async ({ response, context, params, origin }) => {
      const report = await createReconciliationReport(context.store, params.offerId, origin);
      if (params.format === "csv") {
        sendCsv(response, 200, reconciliationCsv(report), `fiber-offers-${params.offerId.slice(2, 10)}.csv`);
        return;
      }
      sendJson(response, 200, report);
    }
  ),
  route(
    "POST",
    "/offers/:offerId/resolutions/sync",
    { access: "operator", offer: true },
    async ({ request, response, context, params, origin }) => {
      const body = await readJsonBody(request);
      const result = await syncOfferResolutions(context, params.offerId, origin, {
        includeTerminal: Boolean(body.include_terminal)
      });
      sendJson(response, 200, result);
    }
  ),
  route(
    "POST",
    "/offers/:offerId/resolutions/:resolutionId/sync",
    { access: "operator", offer: true },
    async ({ response, context, params, origin }) => {
      sendJson(
        response,
        200,
        await syncResolutionFromInvoiceSource(context, params.offerId, params.resolutionId, origin)
      );
    }
  ),
  route(
    "POST",
    "/offers/:offerId/resolutions/:resolutionId/status",
    { access: "operator", offer: true },
    async ({ request, response, context, params, origin }) => {
      const body = await readJsonBody(request);
      const resolution = await updateResolutionStatus(context, params.offerId, params.resolutionId, body, origin);
      sendJson(response, 200, publicResolution(resolution, origin, params.offerId));
    }
  ),

  route(
    "GET",
    "/offers/:offerId/webhooks",
    { access: "operator", offer: true },
    async ({ response, context, params }) => {
      sendJson(response, 200, {
        offer_id: params.offerId,
        webhooks: (await context.store.listWebhooks(params.offerId)).map((webhook) => publicWebhook(webhook))
      });
    }
  ),
  route(
    "POST",
    "/offers/:offerId/webhooks",
    { access: "operator", offer: true },
    async ({ request, response, context, params }) => {
      const body = await readJsonBody(request);
      const webhook = await context.store.addWebhook(params.offerId, normalizeWebhookInput(body, context));
      sendJson(response, 201, publicWebhook(webhook, { includeSecret: true }));
    }
  ),
  route(
    "PATCH",
    "/offers/:offerId/webhooks/:webhookId",
    { access: "operator", offer: true },
    async ({ request, response, context, params }) => {
      await storedWebhook(context, params);
      const body = await readJsonBody(request);
      const updated = await context.store.updateWebhook(
        params.offerId,
        params.webhookId,
        normalizeWebhookUpdate(body, context)
      );
      sendJson(response, 200, publicWebhook(updated));
    }
  ),
  route(
    "DELETE",
    "/offers/:offerId/webhooks/:webhookId",
    { access: "operator", offer: true },
    async ({ response, context, params }) => {
      await storedWebhook(context, params);
      await context.store.deleteWebhook(params.offerId, params.webhookId);
      sendJson(response, 200, { offer_id: params.offerId, webhook_id: params.webhookId, deleted: true });
    }
  ),
  route(
    "POST",
    "/offers/:offerId/webhooks/:webhookId/rotate-secret",
    { access: "operator", offer: true },
    async ({ response, context, params }) => {
      await storedWebhook(context, params);
      const updated = await context.store.updateWebhook(params.offerId, params.webhookId, {
        secret: createWebhookSigningSecret()
      });
      sendJson(response, 200, publicWebhook(updated, { includeSecret: true }));
    }
  ),
  route("POST", "/offers/:offerId/webhooks/:webhookId/test", { access: "operator", offer: true }, sendTestWebhook),
  route(
    "GET",
    "/offers/:offerId/webhook-events",
    { access: "operator", offer: true },
    async ({ response, context, params }) => {
      sendJson(response, 200, {
        offer_id: params.offerId,
        events: (await context.store.listWebhookEvents(params.offerId)).map(publicWebhookEvent)
      });
    }
  ),
  route("POST", "/offers/:offerId/webhook-events/deliver", { access: "operator", offer: true }, deliverWebhookEvents),
  route(
    "POST",
    "/offers/:offerId/webhook-events/:eventId/deliver",
    { access: "operator", offer: true },
    deliverWebhookEvents
  )
];

// The route table without its handlers, for the access test and for documentation.
export function describeRoutes() {
  return ROUTES.map(({ method, path, query, access, demo }) => ({
    method,
    path: query ? `${path}?${query}=:${query}` : path,
    access,
    demo
  }));
}

function route(method, path, options, handler) {
  const names = [];
  const source = path
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/:([a-zA-Z]+)/g, (_match, name) => {
      if (!PATH_PARAMETERS[name]) throw new Error(`route ${path} uses an unknown parameter :${name}`);
      names.push(name);
      return `(${PATH_PARAMETERS[name]})`;
    });
  if (!["public", "operator"].includes(options.access)) {
    throw new Error(`route ${method} ${path} must declare access as "public" or "operator"`);
  }
  return {
    method,
    path,
    access: options.access,
    demo: Boolean(options.demo),
    offer: Boolean(options.offer),
    rateLimit: options.rateLimit,
    query: options.query,
    pattern: new RegExp(`^${source}$`),
    names,
    handler
  };
}

// The first route that fits wins, so a route narrowed by `query` is listed
// before the same path without it.
function matchRoute(method, url) {
  for (const candidate of ROUTES) {
    if (candidate.method !== method) continue;
    if (candidate.query && !url.searchParams.get(candidate.query)) continue;
    const match = candidate.pattern.exec(url.pathname);
    if (!match) continue;
    const params = {};
    candidate.names.forEach((name, index) => {
      params[name] = match[index + 1];
    });
    return { route: candidate, params };
  }
  return undefined;
}

async function handleRequest(request, response, context) {
  // Decided once per request from configuration and trusted hops, so no later
  // code reads a forwarding header a client could have set.
  request.resolverOrigin = resolveRequestOrigin(request, context);
  request.clientAddress = resolveClientAddress(request, context);
  setCorsHeaders(response);
  setSecurityHeaders(response, request);
  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  const url = new URL(request.url, requestOrigin(request));
  if (request.method === "GET" && (await serveStatic(url.pathname, request, response, context.staticRoot))) {
    return;
  }

  const matched = matchRoute(request.method, url);
  // On a resolver that is not in demo mode, a demo route does not exist.
  if (!matched || (matched.route.demo && !context.demoMode)) {
    throw httpError(404, "NOT_FOUND", "route was not found");
  }

  const { route: selected, params } = matched;
  if (selected.access === "operator") requireApiKey(request, context);
  if (selected.rateLimit) {
    await enforceRateLimit(request, context, selected.rateLimit.scope, { max: selected.rateLimit.max });
  }

  const call = { request, response, context, url, params, origin: requestOrigin(request) };
  if (selected.offer) {
    call.entry = await context.store.getOffer(params.offerId);
    if (!call.entry) throw httpError(404, "OFFER_NOT_FOUND", "offer_id was not found");
  }
  await selected.handler(call);
}

// Anyone may ask whether the resolver is up. Which dependency is down, and the
// node behind it, are told to operators only.
async function getHealth({ request, response, context }) {
  const dependencies = await cachedDependencyHealth(context);
  const ok = Object.values(dependencies).every((dependency) => dependency.ok);
  const body = {
    ok,
    service: "fiber-offers-resolver",
    invoice_mode: context.invoiceAdapter.mode
  };
  if (isOperator(request, context)) {
    Object.assign(body, {
      auth_required: Boolean(context.apiKey),
      demo_mode: context.demoMode,
      public_operator_access: Boolean(context.apiKey && context.publicOperatorAccess),
      dependencies
    });
  }
  sendJson(response, ok ? 200 : 503, body);
}

function getOperatorSession({ request, response, context }) {
  const publicSession = Boolean(context.apiKey && context.publicOperatorAccess);
  if (publicSession && !hasValidApiCredential(request, context)) {
    response.setHeader("set-cookie", operatorSessionHeader(context, request));
  }
  sendJson(response, 200, {
    auth_required: Boolean(context.apiKey),
    authenticated: !context.apiKey || publicSession || hasValidApiCredential(request, context),
    public_operator_access: publicSession,
    demo_mode: context.demoMode
  });
}

async function loginOperator({ request, response, context }) {
  if (!context.apiKey) {
    sendJson(response, 200, { authenticated: true, auth_required: false });
    return;
  }
  // Each attempt is a guess at the API key.
  await enforceRateLimit(request, context, "operator-login", { max: 10 });
  const body = await readJsonBody(request);
  if (!safeSecretEqual(body.api_key, context.apiKey)) {
    throw httpError(401, "UNAUTHORIZED", "valid API key is required");
  }
  response.writeHead(204, {
    "cache-control": "no-store",
    "set-cookie": operatorSessionHeader(context, request)
  });
  response.end();
}

// The demo page points its sample webhook here. Entries are trimmed to what
// the page shows, and the inbox is bounded by count and by size.
async function receiveDemoWebhook({ request, response, context }) {
  const body = await readJsonBody(request, demoInboxLimits.entryBytes);
  const inbox = context.demoWebhookInbox;
  inbox.sequence += 1;
  const entry = {
    id: `demo_inbox_${inbox.sequence}`,
    received_at: new Date().toISOString(),
    signed: typeof request.headers["x-fiber-offers-signature"] === "string",
    body
  };
  const bytes = Buffer.byteLength(JSON.stringify(entry));
  inbox.entries.push(entry);
  inbox.sizes.push(bytes);
  inbox.bytes += bytes;
  while (inbox.entries.length > demoInboxLimits.entries || inbox.bytes > demoInboxLimits.totalBytes) {
    inbox.entries.shift();
    inbox.bytes -= inbox.sizes.shift();
  }
  response.writeHead(204, { "cache-control": "no-store" });
  response.end();
}

async function listOffers({ response, context, origin }) {
  const entries = await context.store.listOffers();
  const offers = await Promise.all(
    entries
      .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)))
      .map(async (entry) => {
        const username = await context.store.getUsernameForOffer(entry.offer.offer_id);
        return offerListItem(entry, origin, username);
      })
  );
  sendJson(response, 200, { offers });
}

async function registerOffer({ request, response, context, origin }) {
  const body = await readJsonBody(request);
  const { offer, encodedOffer } = submittedOffer(body);
  const verification = verifyOffer(offer);
  if (!verification.ok) {
    throw httpError(400, verification.code, verification.message);
  }

  const ownership = await verifyOfferNodeOwnership(offer, context);
  await assertOfferAssetsSupported(offer, context);

  const entry = await context.store.upsertOffer(offer, encodedOffer, {
    username: body.username,
    ownership
  });

  sendJson(response, 201, offerResponse(entry, origin, body.username));
}

async function bindFiberAddress({ request, response, context, origin }) {
  const body = await readJsonBody(request);
  if (!body.offer_id) throw httpError(400, "MISSING_OFFER_ID", "offer_id is required");

  const binding = await context.store.bindUsername(body.username, body.offer_id);
  sendJson(response, 201, {
    ...binding,
    address: `${binding.username}@${hostOnly(request)}`,
    lookup_url: `${origin}/.well-known/fiberoffer/${binding.username}`
  });
}

async function lookupFiberAddress({ request, response, context, params, origin }) {
  let username;
  try {
    username = decodeURIComponent(params.username);
  } catch {
    // A stray "%" in the path is a malformed name, not a fault of the resolver.
    throw httpError(400, "INVALID_USERNAME", "username is not valid percent-encoding");
  }
  const result = await context.store.getByUsername(username);
  if (!result) throw httpError(404, "FIBER_ADDRESS_NOT_FOUND", "Fiber Address was not found");

  sendJson(response, 200, {
    username: result.username,
    address: `${result.username}@${hostOnly(request)}`,
    ...offerResponse(result.entry, origin, result.username)
  });
}

async function revokeOffer({ request, response, context, params, entry }) {
  const body = await readJsonBody(request);
  const verification = verifyOfferRevocation(entry.offer, body.revocation ?? body);
  if (!verification.ok) throw httpError(400, verification.code, verification.message);
  const revoked = await context.store.revokeOffer(params.offerId, body.revocation ?? body);
  sendJson(response, 200, { offer_id: params.offerId, revoked: true, revoked_at: revoked.revoked_at });
}

async function checkOffer({ request, response, context, entry, origin }) {
  const body = await readJsonBody(request);
  const idempotencyKey = invoiceRequestIdempotencyKey(request, body);
  const result = await checkOfferReadiness(entry, body, context, origin, {
    idempotencyKey,
    // A route check runs on the operator's own payer node and reports its
    // channels, so it is for operators, or for everyone on a demo resolver.
    includeTopology: context.demoMode || isOperator(request, context)
  });
  sendJson(response, 200, result);
}

async function sendTestWebhook({ response, context, params }) {
  const webhook = await storedWebhook(context, params);
  if (webhook.disabled) throw httpError(409, "WEBHOOK_DISABLED", "resume this webhook before sending a test event");
  const event = await context.store.addWebhookEvent(
    params.offerId,
    {
      type: "webhook.test",
      payload: {
        offer_id: params.offerId,
        webhook_id: params.webhookId,
        message: "Fiber Offers webhook test"
      }
    },
    { webhookIds: [params.webhookId] }
  );
  const delivery = await drainWebhookEvents(context, params.offerId, { eventId: event.id });
  sendJson(response, 200, { event_id: event.id, ...delivery });
}

async function deliverWebhookEvents({ request, response, context, params }) {
  const body = await readJsonBody(request);
  const result = await drainWebhookEvents(context, params.offerId, {
    eventId: params.eventId,
    retryFailed: Boolean(body.retry_failed)
  });
  sendJson(response, 200, result);
}

async function storedResolution(context, params) {
  const resolution = await context.store.getResolution(params.offerId, params.resolutionId);
  if (!resolution) throw httpError(404, "RESOLUTION_NOT_FOUND", "resolution_id was not found");
  return resolution;
}

async function storedWebhook(context, params) {
  const webhook = await context.store.getWebhook(params.offerId, params.webhookId);
  if (!webhook) throw httpError(404, "WEBHOOK_NOT_FOUND", "webhook subscription was not found");
  return webhook;
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
      network: body.network ?? nodeIdentity?.network ?? "testnet",
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
  await assertOfferAssetsSupported(offer, context);
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
    // A stored offer can stop passing verification when the rules tighten
    // between versions. That is the offer's fault, not the payer's request.
    const verification = safeVerifyOffer(entry.offer);
    if (!verification.ok) {
      throw httpError(
        409,
        "OFFER_INVALID",
        "this offer does not pass verification and cannot be paid; ask the merchant for a new one",
        { cause_code: verification.code, cause: verification.message, retryable: false }
      );
    }

    await verifyOfferNodeOwnership(entry.offer, context);

    const request = {
      ...validateResolutionRequest(entry.offer, body),
      recurrence_cycle: body?.recurrence_cycle,
      scheduled_for: body?.scheduled_for,
      approval_id: body?.approval_id
    };
    assertSubscriptionProof(entry.offer, body);
    const idempotencyFingerprint = options.idempotencyKey ? invoiceRequestFingerprint(request) : undefined;
    // Whether this offer can issue another invoice depends on what became of
    // the earlier ones, so their outcomes are brought up to date first.
    await settleOpenResolutions(context, entry, origin, request.approval_id);
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
        resolutionId: reservation.record.id,
        request: body
      });
    } catch (error) {
      await context.store.abandonInvoiceReservation(entry.offer.offer_id, reservation.record.id).catch(() => {});
      const failure = classifyInvoiceFailure(error);
      logResolution(context.logger, {
        outcome: "failed",
        offer_id: entry.offer.offer_id,
        amount: request.amount,
        asset: request.asset,
        code: failure.cause_code ?? failure.code,
        error_code: failure.code,
        error_kind: error.kind,
        error_message: error.message,
        retryable: failure.retryable,
        duration_ms: Date.now() - startedAt
      });
      if (failure.unclassified) context.logger.error?.(error);
      throw httpError(failure.status, failure.code, failure.message, {
        ...(failure.details ?? {}),
        retryable: failure.retryable,
        ...(failure.cause_code !== undefined ? { cause_code: failure.cause_code } : {})
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
      : {})
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

// An operator (or an external settlement source) sets a resolution's status.
async function updateResolutionStatus(context, offerId, resolutionId, body, origin) {
  const current = await context.store.getResolution(offerId, resolutionId);
  if (!current) throw httpError(404, "RESOLUTION_NOT_FOUND", "resolution_id was not found");

  const nextStatus = normalizeResolutionStatus(body.status);
  const from = current.status ?? "invoice_created";
  // Repeating the current status changes nothing and announces nothing.
  if (from === nextStatus) return current;
  if (!canTransition(from, nextStatus)) {
    throw httpError(
      409,
      "INVALID_STATUS_TRANSITION",
      terminalResolutionStatuses.has(from)
        ? "terminal resolution status cannot be changed"
        : "resolution status can only move forward",
      { current_status: from, next_status: nextStatus }
    );
  }

  const result = await applyResolutionTransition(context, offerId, current, nextStatus, origin, {
    source: body.source ?? "manual",
    note: body.note,
    settlement: normalizeSettlement(body),
    details: body.details
  });
  if (!result.applied) {
    throw httpError(409, "RESOLUTION_STATUS_CHANGED", "resolution status changed while this update was being applied", {
      current_status: result.record.status
    });
  }
  return result.record;
}

// The one place a resolution changes status. The transition must be allowed by
// the state machine and is applied only if the resolution is still in the
// status the caller saw, so when a manual update, a node sync and a background
// pass race, exactly one of them wins and exactly one webhook event is emitted.
async function applyResolutionTransition(context, offerId, current, nextStatus, origin, update = {}, eventPayload = {}) {
  const from = current.status ?? "invoice_created";
  if (from === nextStatus) return { applied: false, reason: "unchanged", record: current };
  if (!canTransition(from, nextStatus)) return { applied: false, reason: "not_allowed", record: current };

  const { applied, record } = await context.store.transitionResolution(offerId, current.id, {
    ...update,
    from,
    status: nextStatus
  });
  if (!applied) return { applied: false, reason: "lost_race", record };

  const webhookEvent = await appendWebhookEvent(context.store, offerId, webhookEventTypeForStatus(nextStatus), {
    offer_id: offerId,
    resolution: publicResolution(record, origin, offerId),
    ...eventPayload
  });
  return { applied: true, record, webhookEvent, previous_status: from };
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
  const result = await applyResolutionTransition(
    context,
    offerId,
    current,
    nextStatus,
    origin,
    {
      source: "fiber-rpc",
      note: `Fiber invoice status: ${invoiceSource.fiber_status}`,
      settlement: settlementFromInvoiceSync(invoiceSource, nextStatus),
      details: {
        fiber_status: invoiceSource.fiber_status,
        get_invoice_method: invoiceSource.get_invoice_method,
        amount: invoiceSource.amount,
        currency: invoiceSource.currency
      }
    },
    { invoice_source: publicInvoiceSyncSource(invoiceSource) }
  );

  // Nothing to record: the node agrees with the resolver, someone else already
  // recorded the change, or the node reports a status the resolution has
  // already moved past (it never goes backwards).
  if (!result.applied) {
    return {
      offer_id: offerId,
      resolution_id: resolutionId,
      changed: false,
      ...(result.reason === "not_allowed" ? { ignored_status: nextStatus } : {}),
      invoice_source: publicInvoiceSyncSource(invoiceSource),
      resolution: publicResolution(result.record, origin, offerId)
    };
  }

  return {
    offer_id: offerId,
    resolution_id: resolutionId,
    changed: true,
    previous_status: result.previous_status,
    next_status: nextStatus,
    invoice_source: publicInvoiceSyncSource(invoiceSource),
    webhook_event_id: result.webhookEvent.id,
    webhook_delivery_count: result.webhookEvent.deliveries.length,
    resolution: publicResolution(result.record, origin, offerId)
  };
}

// Records the outcome of invoices whose lifetime has run out, so the stored
// status, cap accounting and webhooks all agree with what a reader is shown.
// A live invoice is settled by asking the node, which is the authority on
// whether it expired or was paid at the last moment. A mock invoice has no
// node, so the clock decides.
async function settleOverdueResolutions(context, offerId, origin, resolutions = undefined) {
  const records = resolutions ?? (await context.store.getResolutions(offerId));
  const now = Date.now();
  let expired = 0;
  for (const record of records) {
    if (!["invoice_created", "invoice_received"].includes(record.status)) continue;
    const expiresAt = Date.parse(record.invoice?.expires_at ?? "");
    if (!Number.isFinite(expiresAt) || expiresAt > now) continue;

    if (canSyncFromInvoiceSource(context, record)) {
      const synced = await syncResolutionFromInvoiceSource(context, offerId, record.id, origin);
      if (synced.changed && synced.next_status === "invoice_expired") expired += 1;
      continue;
    }
    const result = await applyResolutionTransition(context, offerId, record, "invoice_expired", origin, {
      source: "resolver",
      note: "invoice lifetime elapsed",
      expired_at: record.invoice.expires_at
    });
    if (result.applied) expired += 1;
  }
  return expired;
}

// Before deciding whether a limited offer (single-use or recurring) can issue
// another invoice, find out what became of the invoices still open on it: paid
// uses the offer up, expired or cancelled gives the capacity back. A live
// invoice is settled by asking the node; a mock one by the clock. A plain
// reusable offer is not limited by its history, so nothing is asked.
async function settleOpenResolutions(context, entry, origin, approvalId = undefined) {
  if (!entry.offer.single_use && !entry.offer.recurrence) return;
  const offerId = entry.offer.offer_id;
  // A recurring offer is limited per subscription, so only the requesting
  // subscription's invoices matter, however many subscribers the offer has.
  const onlySubscription = entry.offer.recurrence && !entry.offer.single_use;
  const open = (await context.store.getResolutions(offerId)).filter(
    (record) =>
      ["invoice_created", "invoice_received"].includes(record.status) &&
      (!onlySubscription || record.recurrence?.approval_id === approvalId)
  );
  if (open.length === 0) return;

  const overdue = [];
  for (const record of open) {
    if (!canSyncFromInvoiceSource(context, record)) {
      overdue.push(record);
      continue;
    }
    try {
      await syncResolutionFromInvoiceSource(context, offerId, record.id, origin);
    } catch (error) {
      const failure = classifyInvoiceFailure(error);
      throw httpError(failure.status, failure.code, failure.message, {
        retryable: failure.retryable,
        ...(failure.cause_code !== undefined ? { cause_code: failure.cause_code } : {})
      });
    }
  }
  if (overdue.length > 0) await settleOverdueResolutions(context, offerId, origin, overdue);
}

function canSyncFromInvoiceSource(context, record) {
  return (
    typeof context.invoiceAdapter.syncInvoice === "function" &&
    context.invoiceAdapter.mode !== "mock" &&
    record.invoice?.mocked !== true &&
    Boolean(record.invoice?.payment_hash) &&
    (!record.invoice?.mode || record.invoice.mode === context.invoiceAdapter.mode)
  );
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

async function checkOfferReadiness(entry, body, context, origin, options = {}) {
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
      const assetIssue = await assetSupportIssue(request.asset, context);
      if (assetIssue) checks.push(failCheck("asset_source", assetIssue.message, assetIssue.code));
    } catch (error) {
      checks.push(failCheck("request", error.message, error.code ?? "INVALID_REQUEST"));
    }
  } else {
    checks.push(failCheck("request", "Request cannot be checked until the offer signature is valid", "SIGNATURE_REQUIRED"));
  }

  // Bring earlier invoices up to date first, as the invoice endpoint does, so
  // the two never disagree. If the node cannot be asked, the check carries on
  // with what is stored and says so.
  try {
    await settleOpenResolutions(context, entry, origin, body?.approval_id);
  } catch (error) {
    checks.push(
      warnCheck("settlement", "Earlier invoices could not be brought up to date with the Fiber node", error.code)
    );
  }
  const priorResolutions = await context.store.getResolutions(entry.offer.offer_id);
  const suppliedInvoice = invoiceFromReadinessBody(body);
  // The check may be about an invoice this offer already issued (the post-invoice
  // check) or an idempotent retry of an earlier request. Neither is a new use of
  // the offer, so that resolution must not be counted against itself.
  const underCheck = resolutionUnderCheck(priorResolutions, {
    invoice: suppliedInvoice,
    idempotencyKey: options.idempotencyKey
  });
  const current = underCheck?.resolution;

  if (suppliedInvoice) {
    checks.push(
      underCheck?.matched_by === "invoice"
        ? passCheck("invoice_match", "Invoice was issued by this resolver for this offer")
        : warnCheck(
            "invoice_match",
            "Invoice was not issued by this resolver for this offer",
            "INVOICE_NOT_ISSUED_FOR_OFFER"
          )
    );
  }

  let replayAllowed = Boolean(current);
  if (underCheck?.matched_by === "idempotency_key" && request) {
    const fingerprint = invoiceRequestFingerprint({
      ...request,
      recurrence_cycle: body?.recurrence_cycle,
      scheduled_for: body?.scheduled_for,
      approval_id: body?.approval_id
    });
    if (current.idempotency_fingerprint !== fingerprint) {
      replayAllowed = false;
      checks.push(
        failCheck(
          "idempotency",
          "Idempotency key was already used for a different invoice request",
          "IDEMPOTENCY_KEY_REUSED"
        )
      );
    } else {
      checks.push(passCheck("idempotency", "Request replays an invoice this offer already issued"));
    }
  }

  // The same rules the stores apply when reserving an invoice, minus the
  // resolution this check is about.
  const excluding = { excludeId: replayAllowed ? current.id : undefined };
  try {
    assertSingleUseCapacity(entry.offer, priorResolutions, excluding);
    checks.push(
      passCheck(
        "single_use",
        entry.offer.single_use && replayAllowed
          ? "This is the invoice issued for this single-use offer"
          : "Offer can produce another invoice"
      )
    );
  } catch (error) {
    checks.push(failCheck("single_use", error.message, error.code));
  }

  if (entry.offer.recurrence) {
    try {
      assertSubscriptionProof(entry.offer, body);
      checks.push(passCheck("subscription", "Request is signed by the subscription's key"));
    } catch (error) {
      checks.push(failCheck("subscription", error.message, error.code));
    }
    try {
      if (replayAllowed && current.recurrence) {
        assertReplayedRecurrenceCycle(current, body);
      } else if (!suppliedInvoice) {
        recurrenceReservation(entry.offer, { ...body, amount: request?.amount ?? body?.amount }, priorResolutions, excluding);
      }
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

  const topology = options.includeTopology ? await createReadinessTopologyReport(context, body) : undefined;

  return analyzePaymentReadiness({
    offer_id: entry.offer.offer_id,
    amount: request?.amount ?? body?.amount,
    asset: request?.asset ?? body?.asset,
    invoice_mode: context.invoiceAdapter.mode,
    payment_link: paymentLink(entry.offer, origin),
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
    invoice: publicInvoice(record.invoice),
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

// What a payer needs from a stored invoice. The request sent to the Fiber node
// and its raw answer stay in the store.
function publicInvoice(invoice) {
  if (!invoice) return undefined;
  return cleanUndefined({
    mode: invoice.mode,
    invoice: invoice.invoice,
    payment_request: invoice.payment_request,
    payment_hash: invoice.payment_hash,
    expiry_seconds: invoice.expiry_seconds,
    expires_at: invoice.expires_at,
    mocked: invoice.mocked
  });
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
  const supplied = typeof body.secret === "string" && body.secret.length > 0 ? body.secret : undefined;
  // "enc:" marks a value the store has already encrypted.
  if (supplied?.startsWith("enc:")) {
    throw httpError(400, "INVALID_WEBHOOK_SECRET", "a webhook secret must not start with \"enc:\"");
  }
  return { url, events, secret: supplied ?? createWebhookSigningSecret() };
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

// Delivery history as recorded. Response bodies were stored by earlier
// versions; they are not returned.
function publicWebhookEvent(event) {
  return {
    ...event,
    deliveries: (event.deliveries ?? []).map(({ response_body: _body, ...delivery }) => delivery)
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
        timeoutMs: context.webhookDeliveryTimeoutMs,
        allowPrivateTargets: context.allowPrivateWebhookTargets,
        lookup: context.webhookLookup
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

// Checked here as far as the URL's text allows, so the operator hears about a
// refused target when registering it. The check that counts is made on the
// resolved address at every delivery; see webhook-target.js.
function normalizeWebhookUrl(value, context) {
  if (typeof value !== "string" || value.trim() === "") {
    throw httpError(400, "INVALID_WEBHOOK_URL", "webhook url is required");
  }

  try {
    return assertWebhookUrlAllowed(value, { allowPrivateTargets: context?.allowPrivateWebhookTargets }).toString();
  } catch (error) {
    throw httpError(400, "INVALID_WEBHOOK_URL", "webhook url must be a public HTTP(S) URL", {
      cause: error.message,
      cause_code: error.code
    });
  }
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

  // Passes in progress, so shutdown can wait for them before closing the store.
  const inFlight = new Set();

  async function runTask(task, fn) {
    if (task.running) return task.last_result ?? { skipped: true, reason: "already_running" };
    const pass = executeTask(task, fn);
    inFlight.add(pass);
    try {
      return await pass;
    } finally {
      inFlight.delete(pass);
    }
  }

  async function executeTask(task, fn) {
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
    // Resolves when no pass is running.
    async idle() {
      await Promise.allSettled([...inFlight]);
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
    // There is no node to ask, but invoices still run out: record that.
    let expired = 0;
    for (const entry of await context.store.listOffers()) {
      const origin = context.publicOrigin ?? entry.offer.resolver_url;
      expired += await settleOverdueResolutions(context, entry.offer.offer_id, origin);
    }
    return {
      skipped: true,
      reason: "invoice_sync_unsupported",
      invoice_mode: context.invoiceAdapter.mode,
      expired
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
  let takesSinceSweep = 0;
  // Expired buckets are dropped as they are found, and swept periodically, so
  // a caller cycling through keys cannot grow this map without bound.
  const sweep = (now) => {
    takesSinceSweep = 0;
    for (const [key, bucket] of buckets) {
      if (now >= bucket.resetAt) buckets.delete(key);
    }
  };
  return {
    async healthCheck() {
      return { ok: true, backend: "memory" };
    },
    size() {
      return buckets.size;
    },
    take(key, now = Date.now(), limits = {}) {
      const max = limits.max ?? options.max;
      if (max === 0 || options.windowMs === 0) return { allowed: true };
      takesSinceSweep += 1;
      if (takesSinceSweep >= 1000 || buckets.size >= 10000) sweep(now);
      const bucket = buckets.get(key);
      if (!bucket || now >= bucket.resetAt) {
        buckets.set(key, { count: 1, resetAt: now + options.windowMs });
        return { allowed: true, remaining: max - 1, resetAt: now + options.windowMs };
      }
      bucket.count += 1;
      return {
        allowed: bucket.count <= max,
        remaining: Math.max(0, max - bucket.count),
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

async function cachedDependencyHealth(context) {
  const cached = context.healthCache;
  if (cached && Date.now() - cached.at < healthCacheMs) return cached.value;
  const value = await dependencyHealth(context);
  context.healthCache = { at: Date.now(), value };
  return value;
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

async function enforceRateLimit(request, context, scope, limits = {}) {
  const address = request.clientAddress ?? request.socket?.remoteAddress ?? "unknown";
  let result;
  try {
    result = await context.rateLimiter.take(`${scope}:${address}`, Date.now(), limits);
  } catch (error) {
    // The limiter's backing store is down. Payments stay available by default;
    // set RESOLVER_RATE_LIMIT_FAIL_OPEN=false to refuse requests instead.
    context.logger.error?.(error);
    if (context.rateLimitFailOpen) return;
    throw httpError(503, "RATE_LIMITER_UNAVAILABLE", "request limiting is temporarily unavailable, try again", {
      retryable: true
    });
  }
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
      token: env.MERCHANT_FIBER_RPC_TOKEN ?? env.FIBER_RPC_TOKEN,
      username: env.MERCHANT_FIBER_RPC_USERNAME ?? env.FIBER_RPC_USERNAME,
      password: env.MERCHANT_FIBER_RPC_PASSWORD ?? env.FIBER_RPC_PASSWORD,
      timeoutMs: env.FIBER_RPC_TIMEOUT_MS,
      fetchImpl
    },
    payer: {
      url: payerUrl,
      // Never the merchant node's token: the payer node has its own key.
      token: env.PAYER_FIBER_RPC_TOKEN,
      username: env.PAYER_FIBER_RPC_USERNAME ?? env.FIBER_RPC_USERNAME,
      password: env.PAYER_FIBER_RPC_PASSWORD ?? env.FIBER_RPC_PASSWORD,
      timeoutMs: env.FIBER_RPC_TIMEOUT_MS,
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

// Whether the caller may see what operators see. With no API key configured
// (local development) every caller is the operator.
function isOperator(request, context) {
  return !context.apiKey || hasValidApiCredential(request, context);
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
    payment_link: paymentLink(entry.offer, origin),
    qr_link_url: `${qrBase}?payload=link`,
    qr_offer_url: `${qrBase}?payload=offer`,
    fiber_address: normalizedUsername ? `${normalizedUsername}@${new URL(origin).host}` : undefined,
    lookup_url: normalizedUsername ? `${origin}/.well-known/fiberoffer/${normalizedUsername}` : undefined,
    created_at: entry.created_at,
    updated_at: entry.updated_at,
    disabled: Boolean(entry.disabled),
    revoked_at: entry.revoked_at,
    ownership: entry.ownership,
    ...offerValidity(entry.offer)
  };
}

// The link is built from the stored ID alone, so it can be shown even for an
// offer that no longer passes verification.
function paymentLink(offer, origin) {
  return `${origin.replace(/\/$/, "")}/pay/${offer.offer_id}`;
}

function offerValidity(offer) {
  const verification = safeVerifyOffer(offer);
  return verification.ok
    ? { valid: true }
    : { valid: false, invalid_code: verification.code, invalid_reason: verification.message };
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
    payment_link: paymentLink(offer, origin),
    // False for an offer stored by an earlier version that no longer passes
    // verification. It cannot be paid and has to be issued again.
    ...offerValidity(offer),
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
  // The node's network is known when it was configured or the node follows a
  // public chain. An offer signed for another network could never be paid here:
  // the node would refuse to mint an invoice in that network's currency.
  if (identity.network && identity.network !== offer.network) {
    throw httpError(422, "OFFER_NETWORK_MISMATCH", "offer network does not match the resolver's Fiber node", {
      offer_network: offer.network,
      node_network: identity.network,
      node_network_source: identity.network_source
    });
  }
  return {
    status: "verified",
    method: "resolver-node-info",
    node_id: identity.node_id,
    source: identity.source,
    ...(identity.network ? { network: identity.network, network_source: identity.network_source } : {}),
    verified_at: new Date().toISOString()
  };
}

// An offer that lists a token the resolver cannot mint invoices for would
// advertise a payment option that always fails, so it is refused at
// registration rather than at the payer's first attempt.
async function assertOfferAssetsSupported(offer, context) {
  const unsupported = await unsupportedOfferAssets(offer.assets, context);
  if (unsupported.length > 0) {
    throw httpError(
      422,
      "ASSET_SCRIPT_NOT_CONFIGURED",
      "this resolver has no type script configured for one or more of the offer's assets",
      { assets: unsupported, retryable: false }
    );
  }
}

async function assetSupportIssue(asset, context) {
  try {
    const unsupported = await unsupportedOfferAssets([asset], context);
    if (unsupported.length === 0) return undefined;
    return {
      code: "ASSET_SCRIPT_NOT_CONFIGURED",
      message: "This resolver has no type script configured for the requested asset"
    };
  } catch (error) {
    return { code: error.code ?? "RECIPIENT_UNAVAILABLE", message: error.message };
  }
}

async function unsupportedOfferAssets(assets, context) {
  if (typeof context.invoiceAdapter.unsupportedAssets !== "function") return [];
  try {
    return await context.invoiceAdapter.unsupportedAssets(assets);
  } catch (error) {
    // The registry may need the node to answer; report its failure the same way
    // an invoice request would.
    const failure = classifyInvoiceFailure(error);
    throw httpError(failure.status, failure.code, failure.message, {
      retryable: failure.retryable,
      ...(failure.cause_code !== undefined ? { cause_code: failure.cause_code } : {})
    });
  }
}

function assertOfferActive(entry) {
  if (entry.disabled) throw httpError(410, "OFFER_REVOKED", "offer has been revoked");
}

// Every invoice request on a recurring offer is a cycle of one subscription and
// must be signed by that subscription's key. Without this, anyone could
// request cycles in a payer's name.
function assertSubscriptionProof(offer, body) {
  if (!offer.recurrence) return;
  const proof = verifyRecurrenceRequest(offer, body);
  if (proof.ok) return;
  const status =
    {
      SUBSCRIPTION_KEY_MISMATCH: 403,
      INVALID_SUBSCRIPTION_SIGNATURE: 403,
      RECURRENCE_CYCLE_CAP_REACHED: 409,
      RECURRENCE_SPENDING_CAP_REACHED: 409,
      INVALID_RECURRENCE_CYCLE: 409,
      AMOUNT_TOO_LOW: 422,
      AMOUNT_TOO_HIGH: 422,
      AMOUNT_MUST_MATCH_FIXED_AMOUNT: 422,
      UNSUPPORTED_ASSET: 422,
      OFFER_EXPIRED: 422
    }[proof.code] ?? 400;
  throw httpError(status, proof.code, proof.message);
}

// A replayed recurring request must name the cycle its resolution was issued for.
function assertReplayedRecurrenceCycle(resolution, body) {
  if (body?.recurrence_cycle === undefined) return;
  if (Number(body.recurrence_cycle) !== resolution.recurrence.cycle) {
    throw httpError(
      409,
      "INVALID_RECURRENCE_CYCLE",
      `this invoice was issued for recurrence cycle ${resolution.recurrence.cycle}`
    );
  }
}

// With `approval_id`: where that one subscription stands, for its payer.
// Without: a summary of the offer across all its subscriptions.
async function recurrenceStatus(entry, store, approvalId = undefined) {
  const recurrence = entry.offer.recurrence;
  if (!recurrence) {
    return { offer_id: entry.offer.offer_id, enabled: false, revoked: Boolean(entry.disabled) };
  }
  const resolutions = await store.getResolutions(entry.offer.offer_id);
  const base = {
    offer_id: entry.offer.offer_id,
    enabled: true,
    revoked: Boolean(entry.disabled),
    terms: recurrence
  };
  if (approvalId) {
    return { ...base, ...subscriptionStatus(entry.offer, resolutions, approvalId) };
  }

  // Cycles that ended unpaid were released and are not counted.
  const cycles = countedResolutions(resolutions).filter((resolution) => resolution.recurrence);
  const paid = cycles.filter(isConsumed);
  const subscriptions = new Set(cycles.map((resolution) => resolution.recurrence.approval_id));
  return {
    ...base,
    subscriptions: subscriptions.size,
    cycles_created: cycles.length,
    cycles_paid: paid.length,
    reserved_total: cycles.reduce((total, resolution) => total + BigInt(resolution.amount), 0n).toString(),
    paid_total: paid.reduce((total, resolution) => total + BigInt(resolution.amount), 0n).toString()
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

async function readJsonBody(request, maxBytes = maxJsonBytes) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
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

const STATIC_CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".png": "image/png"
};

async function serveStatic(pathname, request, response, staticRoot) {
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
  } else if (pathname === "/subscription.js") {
    filePath = join(staticRoot, "subscription.js");
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
  const type = STATIC_CONTENT_TYPES[extname(filePath)];
  response.writeHead(200, {
    "content-type": type,
    "cache-control": "no-store",
    // A page loads its own scripts and styles; everything else keeps the
    // stricter policy set for every response.
    ...(type.startsWith("text/html") ? { "content-security-policy": pageContentSecurityPolicy(request) } : {})
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
  // The standard way to say when to come back, beside the same number in the body.
  if (Number.isFinite(error.details?.retry_after_seconds)) {
    response.setHeader("retry-after", String(error.details.retry_after_seconds));
  }

  // Details of an unexpected server error stay out of the response. Errors the
  // resolver raised on purpose (expose) keep theirs, so a payer can read
  // `retryable` on a 502/503.
  sendJson(response, status, {
    error: {
      code,
      message,
      details: status >= 500 && !error.expose ? undefined : error.details
    }
  });
}

function statusForError(error) {
  if (error instanceof FiberOfferError) {
    if (["AMOUNT_TOO_LOW", "AMOUNT_TOO_HIGH", "AMOUNT_MUST_MATCH_FIXED_AMOUNT", "UNSUPPORTED_ASSET", "OFFER_EXPIRED"].includes(error.code)) {
      return 422;
    }
    // The request conflicts with the offer's recurrence terms as they stand.
    if (["RECURRENCE_CYCLE_CAP_REACHED", "RECURRENCE_SPENDING_CAP_REACHED", "INVALID_RECURRENCE_CYCLE"].includes(error.code)) {
      return 409;
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

// Sent with every response, so they do not depend on a proxy adding them.
function setSecurityHeaders(response, request) {
  // Never guess a content type from the bytes.
  response.setHeader("x-content-type-options", "nosniff");
  // Resolution and receipt URLs are readable by whoever holds them, so they
  // must not travel to other sites in a Referer header.
  response.setHeader("referrer-policy", "no-referrer");
  // The operator console must not be framed by another site.
  response.setHeader("x-frame-options", "DENY");
  // API responses (JSON, CSV, the QR image) load nothing and run nothing, even
  // when opened directly in a browser. Pages replace this with their own policy.
  response.setHeader("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
  if (requestOrigin(request).startsWith("https://")) {
    response.setHeader("strict-transport-security", "max-age=31536000");
  }
}

// The pages use only their own scripts and styles, with no inline code. The
// QR image and API calls use the resolver's public address, which can differ
// from the address the page was opened on.
function pageContentSecurityPolicy(request) {
  const publicOrigin = new URL(requestOrigin(request)).origin;
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    `img-src 'self' data: ${publicOrigin}`,
    `connect-src 'self' ${publicOrigin}`,
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'"
  ].join("; ");
}

function setCorsHeaders(response) {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-methods", "GET,POST,PATCH,DELETE,OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type,authorization,x-api-key,idempotency-key");
}

// The origin used in every link this response contains.
function requestOrigin(request) {
  return request.resolverOrigin ?? resolveRequestOrigin(request, {});
}

// 1. A configured public URL always wins: links never depend on request headers.
// 2. Behind trusted proxies, the forwarding headers those proxies set are used.
// 3. Otherwise the Host header of a direct connection, which is how a local or
//    test resolver knows its own port.
function resolveRequestOrigin(request, context) {
  if (context.publicOrigin) return context.publicOrigin;
  const trusted = (context.trustedProxyHops ?? 0) > 0;
  const proto = (trusted && lastHeaderValue(request.headers["x-forwarded-proto"])) || "http";
  const host =
    (trusted && lastHeaderValue(request.headers["x-forwarded-host"])) || request.headers.host || "localhost";
  return `${proto}://${host}`;
}

// The address to rate-limit by. Each trusted proxy appends the address it
// received the request from to X-Forwarded-For, so with N trusted hops the real
// client is the Nth entry from the right. Anything further left was supplied by
// the client and is ignored; with no trusted hops the header is not read at all.
function resolveClientAddress(request, context) {
  const remote = request.socket?.remoteAddress ?? "unknown";
  const hops = context.trustedProxyHops ?? 0;
  if (hops <= 0) return remote;
  const forwarded = request.headers["x-forwarded-for"];
  const chain = (Array.isArray(forwarded) ? forwarded.join(",") : forwarded ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return chain[chain.length - hops] ?? chain[0] ?? remote;
}

function lastHeaderValue(value) {
  const text = Array.isArray(value) ? value[value.length - 1] : value;
  if (typeof text !== "string") return undefined;
  const last = text.split(",").pop().trim();
  return last.length > 0 ? last : undefined;
}

function normalizePublicOrigin(value) {
  if (value === undefined || value === null || String(value).trim() === "") return undefined;
  try {
    const parsed = new URL(String(value).trim());
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("protocol must be http or https");
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch (error) {
    const failure = new Error(`RESOLVER_PUBLIC_URL must be an absolute http(s) URL: ${error.message}`);
    failure.code = "INVALID_PUBLIC_URL";
    throw failure;
  }
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
  try {
    assertProductionConfiguration(process.env);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  applyDefaultRuntimeConfiguration(process.env);
  const port = Number(process.env.PORT ?? 8787);
  const server = createServer();
  server.listen(port, () => {
    console.log(`Fiber Offers resolver running at http://localhost:${port}`);
    console.log(`Invoice mode: ${server.invoiceAdapter.mode}`);
    console.log(`Settlement workers: ${server.backgroundWorkers.enabled ? "enabled" : "disabled"}`);
    if (server.demoMode) {
      console.warn(
        [
          "",
          "WARNING: RESOLVER_DEMO_MODE is on.",
          "  - The /demo routes are served (offers signed with server-generated keys, a public webhook inbox).",
          "  - Anyone can run route checks on the payer node through /offers/:id/check.",
          ...(server.publicOperatorAccess ? ["  - Every visitor is given operator access."] : []),
          "  Do not use this on a resolver that takes real payments.",
          ""
        ].join("\n")
      );
    }
  });

  // A deploy or restart sends SIGTERM. Requests in progress are answered and
  // pending writes reach the store before the process exits.
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.once(signal, () => {
      console.log(`${signal} received: finishing requests in progress, then stopping`);
      // Under Docker's default of ten seconds between SIGTERM and SIGKILL.
      server.shutdown({ timeoutMs: positiveInteger(process.env.RESOLVER_SHUTDOWN_TIMEOUT_MS, 8000) }).then(
        () => process.exit(0),
        (error) => {
          console.error(error);
          process.exit(1);
        }
      );
    });
  }
}
