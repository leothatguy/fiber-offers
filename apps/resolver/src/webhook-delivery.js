import { createHmac } from "node:crypto";

const defaultWebhookTimeoutMs = 10000;

export async function deliverWebhookEvent(event, webhook, delivery, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("webhook delivery requires a fetch implementation");
  }

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const body = JSON.stringify(eventPayload(event));
  const headers = {
    "content-type": "application/json",
    "user-agent": "fiber-offers-resolver/0.1",
    "x-fiber-offers-event-id": event.id,
    "x-fiber-offers-event-type": event.type,
    "x-fiber-offers-timestamp": timestamp,
    "x-fiber-offers-delivery-id": `${event.id}:${delivery.webhook_id}`
  };

  if (webhook.secret) {
    headers["x-fiber-offers-signature"] = signWebhookPayload(webhook.secret, timestamp, body);
  }

  const timeoutMs = deliveryTimeoutMs(options.timeoutMs);
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetchImpl(delivery.url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal
    });
    const responseBody = await safeReadText(response);
    const ok = response.status >= 200 && response.status < 300;

    return {
      status: ok ? "delivered" : "failed",
      response_status: response.status,
      response_body: responseBody.slice(0, 2000)
    };
  } catch (error) {
    return {
      status: "failed",
      error: {
        message: timedOut ? `webhook delivery timed out after ${timeoutMs}ms` : error.message,
        code: timedOut ? "WEBHOOK_DELIVERY_TIMEOUT" : error.code
      }
    };
  } finally {
    clearTimeout(timeout);
  }
}

function deliveryTimeoutMs(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : defaultWebhookTimeoutMs;
}

export function signWebhookPayload(secret, timestamp, body) {
  const digest = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `sha256=${digest}`;
}

function eventPayload(event) {
  return {
    id: event.id,
    offer_id: event.offer_id,
    type: event.type,
    created_at: event.created_at,
    payload: event.payload
  };
}

async function safeReadText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
