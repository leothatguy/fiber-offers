const resolverUrl = trimTrailingSlash(process.env.RESOLVER_URL ?? "http://127.0.0.1:8787");
const apiKey = process.env.RESOLVER_API_KEY;
const amount = process.env.FIBER_CHECK_AMOUNT ?? "100000000";

try {
  const health = await request("/health");
  if (health.invoice_mode !== "fiber-rpc") {
    throw checkError("resolver is not running in Fiber RPC mode", {
      invoice_mode: health.invoice_mode
    });
  }

  const offer = await request("/demo/offers", {
    method: "POST",
    body: {
      username: `sync-${Date.now().toString(36)}`,
      amount_min: amount,
      amount_max: amount,
      description: "Fiber Offers live sync check"
    }
  });
  const invoice = await request(`/offers/${offer.offer_id}/invoice`, {
    method: "POST",
    body: {
      amount,
      asset: { asset_type: "ckb", symbol: "CKB" }
    }
  });
  const synced = await request(`/offers/${offer.offer_id}/resolutions/${invoice.resolution_id}/sync`, {
    method: "POST",
    body: {}
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        resolver_url: resolverUrl,
        offer_id: offer.offer_id,
        resolution_id: invoice.resolution_id,
        invoice_mode: invoice.invoice_mode,
        mocked: invoice.mocked,
        payment_hash: invoice.payment_hash,
        changed: synced.changed,
        resolution_status: synced.resolution.status,
        fiber_status: synced.invoice_source.fiber_status
      },
      null,
      2
    )
  );
} catch (error) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          details: error.details
        }
      },
      null,
      2
    )
  );
  process.exit(1);
}

async function request(path, options = {}) {
  const headers = {
    accept: "application/json",
    ...authHeaders(),
    ...(options.body ? { "content-type": "application/json" } : {})
  };
  const response = await fetch(`${resolverUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : undefined;
  if (!response.ok) {
    const error = new Error(body?.error?.message ?? `request failed with ${response.status}`);
    error.code = body?.error?.code;
    error.details = body?.error?.details;
    throw error;
  }

  return body;
}

function authHeaders() {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

function trimTrailingSlash(value) {
  return String(value).replace(/\/+$/, "");
}

function checkError(message, details) {
  const error = new Error(message);
  error.code = "LIVE_FIBER_SYNC_CHECK_FAILED";
  error.details = details;
  return error;
}
