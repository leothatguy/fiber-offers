import { createHmac } from "node:crypto";
import { postWebhook } from "./webhook-target.js";

const defaultWebhookTimeoutMs = 10000;

// Delivers one event to one webhook and returns what to record about the
// attempt. Only the status code of the answer is kept, never its body.
//
// Options: `timeoutMs`, `allowPrivateTargets`, and `lookup` (a DNS lookup to
// use in place of the system's, for tests).
export async function deliverWebhookEvent(event, webhook, delivery, options = {}) {
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

  try {
    const response = await postWebhook(delivery.url, {
      headers,
      body,
      timeoutMs: deliveryTimeoutMs(options.timeoutMs),
      allowPrivateTargets: options.allowPrivateTargets,
      lookup: options.lookup
    });
    if (response.status >= 200 && response.status < 300) {
      return { status: "delivered", response_status: response.status };
    }
    if (response.status >= 300 && response.status < 400) {
      // Following it would send the event, and the resolver's network
      // position, wherever the target says.
      return {
        status: "failed",
        response_status: response.status,
        error: {
          code: "WEBHOOK_REDIRECT_REFUSED",
          message: "webhook target answered with a redirect, which is not followed; register the final URL"
        }
      };
    }
    return { status: "failed", response_status: response.status };
  } catch (error) {
    return {
      status: "failed",
      error: { message: error.message, code: error.code }
    };
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
