import {
  ckbScriptHash,
  createSignedOffer,
  createOfferRevocation,
  decodeOffer,
  encodeOffer,
  generateOfferKeyPair,
  normalizeCkbScript,
  offerToPaymentLink,
  parseCkbScript,
  verifyOffer,
  verifyOfferRevocation
} from "@fiber-offers/protocol";
import { FiberNodeDiagnosticsClient, summarizeFiberChannels } from "./fiber-diagnostics.js";
import {
  FIBER_CURRENCIES,
  fiberCurrencyForNetwork,
  fiberNodeNetwork,
  networkForChainHash,
  networkForFiberCurrency
} from "./fiber-network.js";
import { fetchText, normalizeTimeoutMs } from "./http.js";
import { formatInvoiceDescription, parseInvoiceBinding } from "./invoice-binding.js";
import { normalizeParsedInvoice, verifyInvoiceForOffer } from "./invoice-verification.js";
import {
  FiberPaymentClient,
  FiberRpcClient,
  fiberSendPaymentParams,
  toFiberDecimalQuantity,
  toFiberHexQuantity
} from "./fiber-payment.js";
import { analyzeFiberTopology, FiberTopologyClient, planDirectChannelFixture } from "./fiber-topology.js";
import { fiberNodeError, normalizeFiberPaymentFailure } from "./failures.js";
import { FiberPaymentFlowClient } from "./payment-flow.js";
import { analyzePaymentReadiness } from "./payment-readiness.js";
import {
  FiberRecurringPaymentScheduler,
  InMemoryRecurringApprovalStore,
  WebStorageRecurringApprovalStore
} from "./recurrence.js";

export {
  ckbScriptHash,
  normalizeCkbScript,
  parseCkbScript,
  createSignedOffer,
  createOfferRevocation,
  decodeOffer,
  encodeOffer,
  FIBER_CURRENCIES,
  fiberCurrencyForNetwork,
  fiberNodeNetwork,
  networkForChainHash,
  networkForFiberCurrency,
  normalizeParsedInvoice,
  verifyInvoiceForOffer,
  formatInvoiceDescription,
  parseInvoiceBinding,
  FiberNodeDiagnosticsClient,
  FiberPaymentFlowClient,
  FiberPaymentClient,
  FiberRpcClient,
  FiberRecurringPaymentScheduler,
  InMemoryRecurringApprovalStore,
  WebStorageRecurringApprovalStore,
  FiberTopologyClient,
  analyzeFiberTopology,
  analyzePaymentReadiness,
  planDirectChannelFixture,
  fiberNodeError,
  fiberSendPaymentParams,
  generateOfferKeyPair,
  normalizeFiberPaymentFailure,
  offerToPaymentLink,
  summarizeFiberChannels,
  toFiberDecimalQuantity,
  toFiberHexQuantity,
  verifyOffer,
  verifyOfferRevocation
};

const DEFAULT_RESOLVER_TIMEOUT_MS = 30000;

export async function createOffer(input, options = {}) {
  const rpc = options.rpcClient ?? new FiberRpcClient({
    url: options.fiberRpcUrl,
    username: options.username,
    password: options.password,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl
  });
  const nodeInfo = await rpc.call(options.nodeInfoMethod ?? "node_info", []);
  const nodeId = nodeInfo?.pubkey ?? nodeInfo?.public_key ?? nodeInfo?.node_id;
  if (typeof nodeId !== "string" || !/^(02|03)[0-9a-fA-F]{64}$/.test(nodeId)) {
    const error = new Error("Fiber node_info did not return a compressed node public key");
    error.code = "FIBER_NODE_ID_UNAVAILABLE";
    throw error;
  }
  // The offer's network is signed into it, so it has to be the node's network.
  // When the node follows a public chain the network is taken from the node and
  // a conflicting explicit value is refused, rather than producing an offer no
  // invoice can ever be minted for.
  const node = fiberNodeNetwork(nodeInfo);
  if (node.network && input.network && input.network !== node.network) {
    const error = new Error(
      `offer network "${input.network}" does not match the Fiber node, which is on ${node.network}`
    );
    error.code = "OFFER_NETWORK_MISMATCH";
    error.details = { offer_network: input.network, node_network: node.network };
    throw error;
  }
  const keys = options.keyPair ?? generateOfferKeyPair();
  const offer = createSignedOffer(
    {
      ...input,
      network: input.network ?? node.network,
      node_id: nodeId.toLowerCase(),
      public_key: keys.publicKeyPem
    },
    keys.privateKeyPem
  );
  return {
    offer,
    encoded_offer: encodeOffer(offer),
    offer_private_key_pem: keys.privateKeyPem,
    node_identity: {
      node_id: offer.node_id,
      source: options.nodeInfoMethod ?? "node_info",
      ...(node.network ? { network: node.network, network_source: node.source } : {})
    }
  };
}

export class FiberOffersClient {
  constructor(options = {}) {
    this.resolverUrl = trimTrailingSlash(options.resolverUrl ?? "");
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.apiKey = options.apiKey;
    this.timeoutMs = normalizeTimeoutMs(options.timeoutMs, DEFAULT_RESOLVER_TIMEOUT_MS);

    if (typeof this.fetchImpl !== "function") {
      throw new Error("FiberOffersClient requires a fetch implementation");
    }
  }

  async registerOffer(offerOrEncoded, options = {}) {
    const encoded_offer = typeof offerOrEncoded === "string" ? offerOrEncoded : encodeOffer(offerOrEncoded);
    return this.#request("/offers", {
      method: "POST",
      body: {
        encoded_offer,
        username: options.username
      }
    });
  }

  async createAndRegisterOffer(input, privateKeyPem, options = {}) {
    const offer = createSignedOffer(input, privateKeyPem);
    return this.registerOffer(offer, options);
  }

  async createOffer(input, options = {}) {
    return createOffer(input, options);
  }

  async createAndRegisterOfferFromNode(input, options = {}) {
    const created = await createOffer(input, options);
    const registered = await this.registerOffer(created.offer, { username: options.username });
    return { ...created, registered };
  }

  async resolveOffer(offerOrEncoded) {
    const decoded = typeof offerOrEncoded === "string" && offerOrEncoded.startsWith("fbroffer1")
      ? decodeOffer(offerOrEncoded)
      : offerOrEncoded;
    const offerId = typeof decoded === "string" ? decoded : decoded?.offer_id;
    if (!offerId) throw new Error("offer_id or encoded Fiber Offer is required");
    if (decoded && typeof decoded === "object") {
      const verification = verifyOffer(decoded);
      if (!verification.ok) {
        const error = new Error(verification.message);
        error.code = verification.code;
        throw error;
      }
    }
    // getOffer verifies the returned offer and that it is the one asked for.
    // Its ID is the hash of its contents, so an equal ID is an equal offer.
    return this.getOffer(offerId);
  }

  async resolveAndRequestInvoice(offerOrEncoded, request, options = {}) {
    const resolved = await this.resolveOffer(offerOrEncoded);
    const invoice = await this.requestInvoice(resolved.offer_id, request, options);
    return { offer: resolved, invoice };
  }

  // The resolver is not trusted to hand back the right offer. The returned
  // offer must be validly signed and must be the one that was asked for;
  // otherwise this throws (code RESOLVED_OFFER_MISMATCH or the verification code).
  async getOffer(offerId) {
    const resolved = await this.#request(`/offers/${offerId}`);
    return verifiedOfferResponse(resolved, offerId);
  }

  async listOffers() {
    return this.#request("/offers");
  }

  async diagnostics() {
    return this.#request("/diagnostics");
  }

  offerQrUrl(offerId, payload = "link") {
    return offerQrUrl(offerId, this.resolverUrl, payload);
  }

  async checkPayment(offerOrId, request, options = {}) {
    const offerId = typeof offerOrId === "string" ? offerOrId : offerOrId.offer_id;
    if (!offerId) throw new Error("offer_id is required to check payment readiness");

    // Passing the invoice request's idempotency key lets the resolver recognise
    // a retry of an earlier request instead of counting it as a new use.
    return this.#request(`/offers/${offerId}/check`, {
      method: "POST",
      body: request,
      headers: options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : undefined
    });
  }

  async getResolutions(offerOrId) {
    const offerId = typeof offerOrId === "string" ? offerOrId : offerOrId.offer_id;
    if (!offerId) throw new Error("offer_id is required to list resolutions");

    return this.#request(`/offers/${offerId}/resolutions`);
  }

  async getRecurrenceStatus(offerOrId) {
    const offerId = typeof offerOrId === "string" ? offerOrId : offerOrId.offer_id;
    if (!offerId) throw new Error("offer_id is required to get recurrence status");
    return this.#request(`/offers/${offerId}/recurrence-status`);
  }

  async revokeOffer(offerOrId, revocation) {
    const offerId = typeof offerOrId === "string" ? offerOrId : offerOrId.offer_id;
    if (!offerId) throw new Error("offer_id is required to revoke an offer");
    return this.#request(`/offers/${offerId}`, { method: "DELETE", body: { revocation } });
  }

  async getResolution(offerOrId, resolutionId) {
    const offerId = typeof offerOrId === "string" ? offerOrId : offerOrId.offer_id;
    if (!offerId) throw new Error("offer_id is required to get a resolution");
    if (!resolutionId) throw new Error("resolution_id is required");

    return this.#request(`/offers/${offerId}/resolutions/${resolutionId}`);
  }

  async getReceipt(offerOrId, resolutionId) {
    const offerId = typeof offerOrId === "string" ? offerOrId : offerOrId.offer_id;
    if (!offerId) throw new Error("offer_id is required to get a receipt");
    if (!resolutionId) throw new Error("resolution_id is required");

    return this.#request(`/offers/${offerId}/resolutions/${resolutionId}/receipt.json`);
  }

  async getReconciliation(offerOrId) {
    const offerId = typeof offerOrId === "string" ? offerOrId : offerOrId.offer_id;
    if (!offerId) throw new Error("offer_id is required to get reconciliation");

    return this.#request(`/offers/${offerId}/reconciliation.json`);
  }

  async getReconciliationCsv(offerOrId) {
    const offerId = typeof offerOrId === "string" ? offerOrId : offerOrId.offer_id;
    if (!offerId) throw new Error("offer_id is required to get reconciliation CSV");

    return this.#requestText(`/offers/${offerId}/reconciliation.csv`);
  }

  async createWebhook(offerOrId, webhook) {
    const offerId = typeof offerOrId === "string" ? offerOrId : offerOrId.offer_id;
    if (!offerId) throw new Error("offer_id is required to create a webhook");

    return this.#request(`/offers/${offerId}/webhooks`, {
      method: "POST",
      body: webhook
    });
  }

  async getWebhooks(offerOrId) {
    const offerId = typeof offerOrId === "string" ? offerOrId : offerOrId.offer_id;
    if (!offerId) throw new Error("offer_id is required to list webhooks");

    return this.#request(`/offers/${offerId}/webhooks`);
  }

  async updateWebhook(offerOrId, webhookId, update) {
    const offerId = typeof offerOrId === "string" ? offerOrId : offerOrId.offer_id;
    if (!offerId) throw new Error("offer_id is required to update a webhook");
    if (!webhookId) throw new Error("webhook_id is required");

    return this.#request(`/offers/${offerId}/webhooks/${webhookId}`, {
      method: "PATCH",
      body: update
    });
  }

  async deleteWebhook(offerOrId, webhookId) {
    const offerId = typeof offerOrId === "string" ? offerOrId : offerOrId.offer_id;
    if (!offerId) throw new Error("offer_id is required to delete a webhook");
    if (!webhookId) throw new Error("webhook_id is required");

    return this.#request(`/offers/${offerId}/webhooks/${webhookId}`, { method: "DELETE" });
  }

  async rotateWebhookSecret(offerOrId, webhookId) {
    const offerId = typeof offerOrId === "string" ? offerOrId : offerOrId.offer_id;
    if (!offerId) throw new Error("offer_id is required to rotate a webhook secret");
    if (!webhookId) throw new Error("webhook_id is required");

    return this.#request(`/offers/${offerId}/webhooks/${webhookId}/rotate-secret`, {
      method: "POST",
      body: {}
    });
  }

  async testWebhook(offerOrId, webhookId) {
    const offerId = typeof offerOrId === "string" ? offerOrId : offerOrId.offer_id;
    if (!offerId) throw new Error("offer_id is required to test a webhook");
    if (!webhookId) throw new Error("webhook_id is required");

    return this.#request(`/offers/${offerId}/webhooks/${webhookId}/test`, {
      method: "POST",
      body: {}
    });
  }

  async getWebhookEvents(offerOrId) {
    const offerId = typeof offerOrId === "string" ? offerOrId : offerOrId.offer_id;
    if (!offerId) throw new Error("offer_id is required to list webhook events");

    return this.#request(`/offers/${offerId}/webhook-events`);
  }

  async deliverWebhookEvents(offerOrId, options = {}) {
    const offerId = typeof offerOrId === "string" ? offerOrId : offerOrId.offer_id;
    if (!offerId) throw new Error("offer_id is required to deliver webhook events");

    return this.#request(`/offers/${offerId}/webhook-events/deliver`, {
      method: "POST",
      body: {
        retry_failed: Boolean(options.retryFailed)
      }
    });
  }

  async deliverWebhookEvent(offerOrId, eventId, options = {}) {
    const offerId = typeof offerOrId === "string" ? offerOrId : offerOrId.offer_id;
    if (!offerId) throw new Error("offer_id is required to deliver a webhook event");
    if (!eventId) throw new Error("event_id is required");

    return this.#request(`/offers/${offerId}/webhook-events/${eventId}/deliver`, {
      method: "POST",
      body: {
        retry_failed: Boolean(options.retryFailed)
      }
    });
  }

  reconciliationCsvUrl(offerOrId) {
    const offerId = typeof offerOrId === "string" ? offerOrId : offerOrId.offer_id;
    if (!offerId) throw new Error("offer_id is required to build reconciliation CSV URL");
    if (!this.resolverUrl) throw new Error("resolverUrl is required");

    return `${this.resolverUrl}/offers/${offerId}/reconciliation.csv`;
  }

  async updateResolutionStatus(offerOrId, resolutionId, update) {
    const offerId = typeof offerOrId === "string" ? offerOrId : offerOrId.offer_id;
    if (!offerId) throw new Error("offer_id is required to update a resolution");
    if (!resolutionId) throw new Error("resolution_id is required");

    return this.#request(`/offers/${offerId}/resolutions/${resolutionId}/status`, {
      method: "POST",
      body: update
    });
  }

  async syncResolution(offerOrId, resolutionId) {
    const offerId = typeof offerOrId === "string" ? offerOrId : offerOrId.offer_id;
    if (!offerId) throw new Error("offer_id is required to sync a resolution");
    if (!resolutionId) throw new Error("resolution_id is required");

    return this.#request(`/offers/${offerId}/resolutions/${resolutionId}/sync`, {
      method: "POST",
      body: {}
    });
  }

  async syncResolutions(offerOrId, options = {}) {
    const offerId = typeof offerOrId === "string" ? offerOrId : offerOrId.offer_id;
    if (!offerId) throw new Error("offer_id is required to sync resolutions");

    return this.#request(`/offers/${offerId}/resolutions/sync`, {
      method: "POST",
      body: {
        include_terminal: Boolean(options.includeTerminal)
      }
    });
  }

  async requestInvoice(offerOrId, request, options = {}) {
    const offerId = typeof offerOrId === "string" ? offerOrId : offerOrId.offer_id;
    if (!offerId) throw new Error("offer_id is required to request an invoice");

    return this.#request(`/offers/${offerId}/invoice`, {
      method: "POST",
      body: request,
      headers: options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : undefined
    });
  }

  async bindFiberAddress(username, offerId) {
    return this.#request("/fiber-addresses", {
      method: "POST",
      body: { username, offer_id: offerId }
    });
  }

  // Looks up `user@domain` at that domain. The configured resolver is used
  // only when it is that domain (which also lets a local http resolver serve
  // its own addresses); an address on another domain is never silently looked
  // up somewhere else. The returned offer is verified like any other.
  async resolveFiberAddress(address, options = {}) {
    const { username, domain } = parseFiberAddress(address);
    const baseUrl = trimTrailingSlash(options.baseUrl ?? this.#fiberAddressBaseUrl(domain));
    const resolved = await this.#request(`/.well-known/fiberoffer/${encodeURIComponent(username)}`, {
      baseUrl
    });
    verifiedOfferResponse(resolved);
    if (resolved.username !== undefined && String(resolved.username).toLowerCase() !== username) {
      const error = new Error("resolver answered for a different Fiber Address than the one requested");
      error.code = "FIBER_ADDRESS_MISMATCH";
      throw error;
    }
    return resolved;
  }

  #fiberAddressBaseUrl(domain) {
    if (this.resolverUrl) {
      try {
        if (new URL(this.resolverUrl).host.toLowerCase() === domain) return this.resolverUrl;
      } catch {
        // An unparseable resolverUrl cannot be the address's domain.
      }
    }
    return `https://${domain}`;
  }

  async demoCreateOffer(input) {
    return this.#request("/demo/offers", {
      method: "POST",
      body: input
    });
  }

  async #request(path, options = {}) {
    const baseUrl = trimTrailingSlash(options.baseUrl ?? this.resolverUrl);
    if (!baseUrl) throw new Error("resolverUrl is required");

    const { response, text } = await this.#send(`${baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers: {
        accept: "application/json",
        // The API key belongs to the configured resolver and is never sent to
        // another host, such as the domain of someone else's Fiber Address.
        ...(baseUrl === this.resolverUrl ? authHeaders(this.apiKey) : {}),
        ...options.headers,
        ...(options.body ? { "content-type": "application/json" } : {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    });

    let body;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      // A proxy error page or a captive portal, not the resolver.
      const error = new Error(`Fiber Offers resolver returned a non-JSON response (HTTP ${response.status})`);
      error.status = response.status;
      error.code = "RESOLVER_INVALID_RESPONSE";
      error.retryable = response.status >= 500;
      throw error;
    }
    if (!response.ok) {
      const error = new Error(body?.error?.message ?? `Fiber Offers request failed with ${response.status}`);
      error.status = response.status;
      error.code = body?.error?.code;
      error.details = body?.error?.details;
      // The resolver says whether repeating the request can help (502/503).
      if (typeof body?.error?.details?.retryable === "boolean") error.retryable = body.error.details.retryable;
      throw error;
    }

    return body;
  }

  async #requestText(path, options = {}) {
    const baseUrl = trimTrailingSlash(options.baseUrl ?? this.resolverUrl);
    if (!baseUrl) throw new Error("resolverUrl is required");

    const { response, text } = await this.#send(`${baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers: {
        accept: "text/csv, text/plain",
        ...authHeaders(this.apiKey)
      }
    });

    if (!response.ok) {
      const error = new Error(text || `Fiber Offers request failed with ${response.status}`);
      error.status = response.status;
      throw error;
    }

    return text;
  }

  async #send(url, init) {
    try {
      return await fetchText(this.fetchImpl, url, init, this.timeoutMs);
    } catch (error) {
      const timedOut = error?.kind === "timeout";
      const failure = new Error(
        timedOut
          ? `Fiber Offers resolver did not respond within ${this.timeoutMs}ms`
          : `Fiber Offers resolver could not be reached: ${error?.message ?? "request failed"}`
      );
      failure.code = timedOut ? "RESOLVER_TIMEOUT" : "RESOLVER_UNREACHABLE";
      failure.kind = timedOut ? "timeout" : "transport";
      failure.retryable = true;
      failure.cause = error;
      throw failure;
    }
  }
}

// Checks an offer a resolver returned: validly signed, self-consistent, and,
// when `expectedOfferId` is given, the one that was asked for.
function verifiedOfferResponse(resolved, expectedOfferId = undefined) {
  const offer = resolved?.offer;
  let verification;
  try {
    verification = verifyOffer(offer);
  } catch (error) {
    verification = { ok: false, code: error.code ?? "INVALID_OFFER", message: error.message };
  }
  if (!verification.ok) {
    const error = new Error(`resolver returned an offer that failed verification: ${verification.message}`);
    error.code = verification.code;
    throw error;
  }

  let encodedOfferId;
  if (typeof resolved.encoded_offer === "string") {
    try {
      encodedOfferId = decodeOffer(resolved.encoded_offer).offer_id;
    } catch {
      encodedOfferId = null;
    }
  }
  if (
    (expectedOfferId !== undefined && offer.offer_id !== expectedOfferId) ||
    (resolved.offer_id !== undefined && resolved.offer_id !== offer.offer_id) ||
    (encodedOfferId !== undefined && encodedOfferId !== offer.offer_id)
  ) {
    const error = new Error("resolver returned a different offer than the one requested");
    error.code = "RESOLVED_OFFER_MISMATCH";
    throw error;
  }
  return resolved;
}

export function parseFiberAddress(address) {
  if (typeof address !== "string" || !address.includes("@")) {
    throw new Error("Fiber Address must use username@domain");
  }

  const [username, domain, ...rest] = address.trim().toLowerCase().split("@");
  if (!username || !domain || rest.length > 0) {
    throw new Error("Fiber Address must use username@domain");
  }

  return { username, domain };
}

export function offerQrUrl(offerId, resolverUrl, payload = "link") {
  if (typeof offerId !== "string" || !/^0x[0-9a-f]{64}$/.test(offerId)) {
    throw new Error("offer_id must be a 0x-prefixed sha256 hex string");
  }

  const baseUrl = trimTrailingSlash(resolverUrl);
  if (!baseUrl) throw new Error("resolverUrl is required");

  const normalizedPayload = payload === "offer" ? "offer" : "link";
  return `${baseUrl}/offers/${offerId}/qr.svg?payload=${normalizedPayload}`;
}

function trimTrailingSlash(value) {
  if (typeof value !== "string") return "";
  return value.replace(/\/$/, "");
}

function authHeaders(apiKey) {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}
