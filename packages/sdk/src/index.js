import {
  createSignedOffer,
  createOfferRevocation,
  decodeOffer,
  encodeOffer,
  generateOfferKeyPair,
  offerToPaymentLink,
  verifyOffer,
  verifyOfferRevocation
} from "@fiber-offers/protocol";
import { FiberNodeDiagnosticsClient, summarizeFiberChannels } from "./fiber-diagnostics.js";
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
  createSignedOffer,
  createOfferRevocation,
  decodeOffer,
  encodeOffer,
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

export async function createOffer(input, options = {}) {
  const rpc = options.rpcClient ?? new FiberRpcClient({
    url: options.fiberRpcUrl,
    username: options.username,
    password: options.password,
    fetchImpl: options.fetchImpl
  });
  const nodeInfo = await rpc.call(options.nodeInfoMethod ?? "node_info", []);
  const nodeId = nodeInfo?.pubkey ?? nodeInfo?.public_key ?? nodeInfo?.node_id;
  if (typeof nodeId !== "string" || !/^(02|03)[0-9a-fA-F]{64}$/.test(nodeId)) {
    const error = new Error("Fiber node_info did not return a compressed node public key");
    error.code = "FIBER_NODE_ID_UNAVAILABLE";
    throw error;
  }
  const keys = options.keyPair ?? generateOfferKeyPair();
  const offer = createSignedOffer(
    {
      ...input,
      node_id: nodeId.toLowerCase(),
      public_key: keys.publicKeyPem
    },
    keys.privateKeyPem
  );
  return {
    offer,
    encoded_offer: encodeOffer(offer),
    offer_private_key_pem: keys.privateKeyPem,
    node_identity: { node_id: offer.node_id, source: options.nodeInfoMethod ?? "node_info" }
  };
}

export class FiberOffersClient {
  constructor(options = {}) {
    this.resolverUrl = trimTrailingSlash(options.resolverUrl ?? "");
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.apiKey = options.apiKey;

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
    const resolved = await this.getOffer(offerId);
    if (decoded && typeof decoded === "object" && resolved.offer_id !== decoded.offer_id) {
      const error = new Error("resolver returned a different offer than the scanned payload");
      error.code = "RESOLVED_OFFER_MISMATCH";
      throw error;
    }
    return resolved;
  }

  async resolveAndRequestInvoice(offerOrEncoded, request, options = {}) {
    const resolved = await this.resolveOffer(offerOrEncoded);
    const invoice = await this.requestInvoice(resolved.offer_id, request, options);
    return { offer: resolved, invoice };
  }

  async getOffer(offerId) {
    return this.#request(`/offers/${offerId}`);
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

  async checkPayment(offerOrId, request) {
    const offerId = typeof offerOrId === "string" ? offerOrId : offerOrId.offer_id;
    if (!offerId) throw new Error("offer_id is required to check payment readiness");

    return this.#request(`/offers/${offerId}/check`, {
      method: "POST",
      body: request
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

  async resolveFiberAddress(address) {
    const { username, domain } = parseFiberAddress(address);
    const baseUrl = this.resolverUrl || `https://${domain}`;
    return this.#request(`/.well-known/fiberoffer/${encodeURIComponent(username)}`, {
      baseUrl
    });
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

    const response = await this.fetchImpl(`${baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers: {
        accept: "application/json",
        ...authHeaders(this.apiKey),
        ...options.headers,
        ...(options.body ? { "content-type": "application/json" } : {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    });

    const text = await response.text();
    const body = text ? JSON.parse(text) : undefined;
    if (!response.ok) {
      const error = new Error(body?.error?.message ?? `Fiber Offers request failed with ${response.status}`);
      error.status = response.status;
      error.code = body?.error?.code;
      error.details = body?.error?.details;
      throw error;
    }

    return body;
  }

  async #requestText(path, options = {}) {
    const baseUrl = trimTrailingSlash(options.baseUrl ?? this.resolverUrl);
    if (!baseUrl) throw new Error("resolverUrl is required");

    const response = await this.fetchImpl(`${baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers: {
        accept: "text/csv, text/plain",
        ...authHeaders(this.apiKey)
      }
    });

    const text = await response.text();
    if (!response.ok) {
      const error = new Error(text || `Fiber Offers request failed with ${response.status}`);
      error.status = response.status;
      throw error;
    }

    return text;
  }
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
