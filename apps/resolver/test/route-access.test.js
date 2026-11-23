import assert from "node:assert/strict";
import test from "node:test";
import { createSignedOffer, encodeOffer, generateOfferKeyPair } from "../../../packages/protocol/src/index.js";
import { MockInvoiceAdapter } from "../src/invoice-adapter.js";
import { createServer, describeRoutes, InMemoryOfferStore } from "../src/server.js";

const API_KEY = "route-access-test-key";

// Who may call each route. This list is the review gate for the resolver's
// HTTP surface: a route added to the server without a line here fails the
// first test below, so nothing ships open by accident. Before adding a
// "public" line, check that the route returns nothing about other payers and
// nothing about the node beyond what a payment needs.
const EXPECTED_ACCESS = {
  // Liveness, and the operator sign-in itself.
  "GET /health": "public",
  "GET /operator/session": "public",
  "POST /operator/session": "public",
  "DELETE /operator/session": "operator",

  // The payment path: what a payer's wallet calls.
  "GET /.well-known/fiberoffer/:username": "public",
  "GET /offers/:offerId": "public",
  "GET /offers/:offerId/qr.svg": "public",
  "POST /offers/:offerId/check": "public",
  "POST /offers/:offerId/invoice": "public",
  // One subscription, addressed by an ID derived from the payer's own key.
  "GET /offers/:offerId/recurrence-status?approval_id=:approval_id": "public",
  "GET /offers/:offerId/resolutions/:resolutionId": "public",
  "GET /offers/:offerId/resolutions/:resolutionId/receipt.json": "public",
  // Authorised by a signature from the offer's own key, not by the API key.
  "DELETE /offers/:offerId": "public",

  // The merchant's side.
  "GET /diagnostics": "operator",
  "GET /topology": "operator",
  "GET /offers": "operator",
  "POST /offers": "operator",
  "POST /fiber-addresses": "operator",
  "GET /offers/:offerId/resolutions": "operator",
  "GET /offers/:offerId/recurrence-status": "operator",
  "GET /offers/:offerId/reconciliation.:format": "operator",
  "POST /offers/:offerId/resolutions/sync": "operator",
  "POST /offers/:offerId/resolutions/:resolutionId/sync": "operator",
  "POST /offers/:offerId/resolutions/:resolutionId/status": "operator",
  "GET /offers/:offerId/webhooks": "operator",
  "POST /offers/:offerId/webhooks": "operator",
  "PATCH /offers/:offerId/webhooks/:webhookId": "operator",
  "DELETE /offers/:offerId/webhooks/:webhookId": "operator",
  "POST /offers/:offerId/webhooks/:webhookId/rotate-secret": "operator",
  "POST /offers/:offerId/webhooks/:webhookId/test": "operator",
  "GET /offers/:offerId/webhook-events": "operator",
  "POST /offers/:offerId/webhook-events/deliver": "operator",
  "POST /offers/:offerId/webhook-events/:eventId/deliver": "operator",

  // Served only when RESOLVER_DEMO_MODE=true.
  "POST /demo/offers": "demo operator",
  "POST /demo/webhook-receiver": "demo public",
  "GET /demo/webhook-receiver": "demo operator"
};

test("every route states who may call it", () => {
  const declared = Object.fromEntries(
    describeRoutes().map((route) => [`${route.method} ${route.path}`, `${route.demo ? "demo " : ""}${route.access}`])
  );
  assert.deepEqual(declared, EXPECTED_ACCESS);
});

test("with an API key set, no operator or demo route answers an anonymous caller", async () => {
  await withResolver({ demoMode: false }, async ({ baseUrl, sample }) => {
    for (const route of describeRoutes()) {
      const label = `${route.method} ${route.path}`;
      const anonymous = await call(baseUrl, route, sample);
      if (route.demo) {
        // Not there at all, with or without credentials.
        assert.equal(anonymous.status, 404, label);
        assert.equal((await call(baseUrl, route, sample, { "x-api-key": API_KEY })).status, 404, label);
      } else if (route.access === "operator") {
        assert.equal(anonymous.status, 401, label);
        assert.equal(anonymous.body.error.code, "UNAUTHORIZED", label);
      } else if (label === "POST /operator/session") {
        // The sign-in itself: an empty body is a wrong key.
        assert.equal(anonymous.status, 401, label);
      } else {
        assert.ok(![401, 403, 404, 500].includes(anonymous.status), `${label} answered ${anonymous.status}`);
      }
    }
  });
});

test("operator routes answer the API key, and demo routes exist only in demo mode", async () => {
  await withResolver({ demoMode: true }, async ({ baseUrl, sample }) => {
    for (const route of describeRoutes()) {
      const label = `${route.method} ${route.path}`;
      if (route.access !== "operator") continue;
      assert.equal((await call(baseUrl, route, sample)).status, 401, label);
      assert.notEqual((await call(baseUrl, route, sample, { "x-api-key": API_KEY })).status, 401, label);
    }
    const delivered = await fetch(`${baseUrl}/demo/webhook-receiver`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    assert.equal(delivered.status, 204);
  });
});

test("an unknown path or method is not found", async () => {
  await withResolver({ demoMode: false }, async ({ baseUrl, sample }) => {
    assert.equal((await fetch(`${baseUrl}/offers/${sample.offerId}/everything`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/diagnostics`, { method: "POST" })).status, 404);
    assert.equal((await fetch(`${baseUrl}/admin`)).status, 404);
  });
});

test("anonymous health says only whether the resolver is up", async () => {
  await withResolver({ demoMode: false }, async ({ baseUrl }) => {
    const anonymous = await fetch(`${baseUrl}/health`).then((response) => response.json());
    const operator = await fetch(`${baseUrl}/health`, { headers: { "x-api-key": API_KEY } }).then((response) =>
      response.json()
    );

    assert.deepEqual(Object.keys(anonymous).sort(), ["invoice_mode", "ok", "service"]);
    assert.equal(operator.auth_required, true);
    assert.equal(operator.demo_mode, false);
    assert.equal(operator.dependencies.invoice_source.ok, true);
  });
});

test("a payer reads their own subscription; the offer-wide summary is the operator's", async () => {
  await withResolver({ demoMode: false }, async ({ baseUrl, sample }) => {
    const statusUrl = `${baseUrl}/offers/${sample.offerId}/recurrence-status`;
    const summary = await fetch(statusUrl);
    const own = await fetch(`${statusUrl}?approval_id=sub_${"a".repeat(40)}`);
    const keyed = await fetch(statusUrl, { headers: { "x-api-key": API_KEY } });

    assert.equal(summary.status, 401);
    assert.equal(own.status, 200);
    assert.equal(keyed.status, 200);
  });
});

test("route checks on the payer node are not run for anonymous callers", async () => {
  let inspections = 0;
  const topologyClient = {
    async inspectPair() {
      inspections += 1;
      return { ok: true, status: "ready", direct_channel: { payer_local_balance_total: "5000" } };
    },
    async checkInvoiceRoute() {
      inspections += 1;
      return { ok: true, status: "ready", route_check: { ok: true } };
    }
  };
  const request = { amount: "1000", asset: { asset_type: "ckb", symbol: "CKB" } };

  await withResolver({ demoMode: false, topologyClient }, async ({ baseUrl, sample }) => {
    const checkUrl = `${baseUrl}/offers/${sample.offerId}/check`;
    const anonymous = await postJson(checkUrl, { ...request, invoice: "fibt1anything", max_fee_amount: "1" });
    assert.equal(anonymous.status, 200);
    assert.equal(anonymous.body.topology, undefined);
    assert.equal(anonymous.body.route_check, undefined);
    assert.equal(inspections, 0);

    const operator = await postJson(checkUrl, request, { "x-api-key": API_KEY });
    assert.equal(operator.status, 200);
    assert.equal(inspections, 1);
  });

  // A demo resolver runs them for everyone.
  inspections = 0;
  await withResolver({ demoMode: true, topologyClient }, async ({ baseUrl, sample }) => {
    await postJson(`${baseUrl}/offers/${sample.offerId}/check`, request);
    assert.equal(inspections, 1);
  });
});

test("public responses carry the invoice, not the node's raw RPC exchange", async () => {
  const invoiceAdapter = {
    mode: "fiber-rpc",
    async createInvoice() {
      return {
        mode: "fiber-rpc",
        invoice: "fibt1public",
        payment_request: "fibt1public",
        payment_hash: `0x${"7".repeat(64)}`,
        expiry_seconds: 900,
        expires_at: new Date(Date.now() + 900_000).toISOString(),
        rpc_method: "new_invoice",
        rpc_params: { description: "internal request" },
        raw_result: { invoice_address: "fibt1public", internal: "node answer" },
        mocked: false
      };
    }
  };

  await withResolver({ demoMode: false, invoiceAdapter }, async ({ baseUrl, sample }) => {
    const created = await postJson(`${baseUrl}/offers/${sample.offerId}/invoice`, {
      amount: "1000",
      asset: { asset_type: "ckb", symbol: "CKB" }
    });
    const base = `${baseUrl}/offers/${sample.offerId}/resolutions/${created.body.resolution_id}`;
    const resolution = await fetch(base).then((response) => response.json());
    const receipt = await fetch(`${base}/receipt.json`).then((response) => response.json());
    const listed = await fetch(`${baseUrl}/offers/${sample.offerId}/resolutions`, {
      headers: { "x-api-key": API_KEY }
    }).then((response) => response.json());

    assert.equal(created.status, 201);
    assert.equal(created.body.invoice, "fibt1public");
    assert.equal(resolution.invoice.invoice, "fibt1public");
    assert.equal(resolution.invoice.payment_hash, `0x${"7".repeat(64)}`);
    for (const body of [created.body, resolution, receipt, listed]) {
      assert.doesNotMatch(JSON.stringify(body), /raw_result|rpc_params|rpc_method|internal request|node answer/);
    }
  });
});

test("operator access for every visitor needs demo mode", async () => {
  const warnings = [];
  const logger = { error() {}, info() {}, warn: (message) => warnings.push(message) };

  await withResolver({ demoMode: false, publicOperatorAccess: true, logger }, async ({ baseUrl }) => {
    const session = await fetch(`${baseUrl}/operator/session`);
    const body = await session.json();
    assert.equal(session.headers.get("set-cookie"), null);
    assert.equal(body.authenticated, false);
    assert.equal(body.public_operator_access, false);
    assert.equal(body.demo_mode, false);
    assert.match(warnings.join("\n"), /RESOLVER_PUBLIC_OPERATOR_ACCESS is ignored/);
  });

  await withResolver({ demoMode: true, publicOperatorAccess: true, logger }, async ({ baseUrl }) => {
    const session = await fetch(`${baseUrl}/operator/session`);
    const body = await session.json();
    assert.match(session.headers.get("set-cookie"), /^fiber_offers_operator=/);
    assert.equal(body.authenticated, true);
    assert.equal(body.demo_mode, true);
  });
});

test("the demo webhook inbox is bounded and keeps no request headers", async () => {
  await withResolver({ demoMode: true }, async ({ baseUrl }) => {
    const receiver = `${baseUrl}/demo/webhook-receiver`;
    const deliver = (body, headers = {}) =>
      fetch(receiver, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body)
      });

    await deliver({ n: 0 }, { cookie: "session=secret", authorization: "Bearer secret", "x-fiber-offers-signature": "sha256=abc" });
    for (let index = 1; index <= 60; index += 1) await deliver({ n: index });
    const oversized = await deliver({ padding: "x".repeat(70 * 1024) });

    const anonymous = await fetch(receiver);
    const inbox = await fetch(receiver, { headers: { "x-api-key": API_KEY } }).then((response) => response.json());

    assert.equal(oversized.status, 413);
    assert.equal(anonymous.status, 401);
    assert.equal(inbox.received.length, 50);
    // Oldest entries are dropped first.
    assert.equal(inbox.received[0].body.n, 11);
    assert.equal(inbox.received.at(-1).body.n, 60);
    assert.doesNotMatch(JSON.stringify(inbox), /secret|headers/);
    assert.deepEqual(Object.keys(inbox.received[0]).sort(), ["body", "id", "received_at", "signed"]);
  });

  // Many large deliveries stay under the total size cap.
  await withResolver({ demoMode: true }, async ({ baseUrl }) => {
    const receiver = `${baseUrl}/demo/webhook-receiver`;
    for (let index = 0; index < 20; index += 1) {
      await fetch(receiver, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ n: index, padding: "x".repeat(60 * 1024) })
      });
    }
    const inbox = await fetch(receiver, { headers: { "x-api-key": API_KEY } }).then((response) => response.text());
    assert.ok(inbox.length < 600 * 1024, `inbox is ${inbox.length} bytes`);
    assert.equal(JSON.parse(inbox).received.at(-1).body.n, 19);
  });
});

test("every response carries the security headers itself", async () => {
  await withResolver({ demoMode: false }, async ({ baseUrl, sample }) => {
    const apiPolicy = "default-src 'none'; frame-ancestors 'none'";
    const responses = {
      page: await fetch(`${baseUrl}/`),
      docs: await fetch(`${baseUrl}/docs`),
      script: await fetch(`${baseUrl}/app.js`),
      json: await fetch(`${baseUrl}/offers/${sample.offerId}`),
      qr: await fetch(`${baseUrl}/offers/${sample.offerId}/qr.svg`),
      refused: await fetch(`${baseUrl}/diagnostics`),
      missing: await fetch(`${baseUrl}/nothing-here`)
    };

    for (const [label, response] of Object.entries(responses)) {
      assert.equal(response.headers.get("x-content-type-options"), "nosniff", label);
      assert.equal(response.headers.get("referrer-policy"), "no-referrer", label);
      assert.equal(response.headers.get("x-frame-options"), "DENY", label);
      assert.equal(response.headers.get("cache-control"), "no-store", label);
      // Plain HTTP here, so no HSTS.
      assert.equal(response.headers.get("strict-transport-security"), null, label);
    }

    // API responses load and run nothing, even opened directly in a browser.
    for (const label of ["script", "json", "qr", "refused", "missing"]) {
      assert.equal(responses[label].headers.get("content-security-policy"), apiPolicy, label);
    }
    // Pages may load their own scripts and styles, and nothing inline.
    for (const label of ["page", "docs"]) {
      const policy = responses[label].headers.get("content-security-policy");
      assert.match(policy, /default-src 'none'/, label);
      assert.match(policy, /script-src 'self'(;|$)/, label);
      assert.match(policy, /style-src 'self'(;|$)/, label);
      assert.match(policy, /frame-ancestors 'none'/, label);
      assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval|\*/, label);
    }

    assert.equal(responses.page.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(responses.script.headers.get("content-type"), "text/javascript; charset=utf-8");
    const diagram = await fetch(`${baseUrl}/docs/system-design.png`);
    assert.equal(diagram.headers.get("content-type"), "image/png");
    assert.deepEqual([...new Uint8Array(await diagram.arrayBuffer()).slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  });

  // Behind HTTPS the resolver asks browsers to keep using it.
  await withResolver({ demoMode: false, publicOrigin: "https://offers.merchant.example" }, async ({ baseUrl }) => {
    const page = await fetch(`${baseUrl}/`);
    assert.equal(page.headers.get("strict-transport-security"), "max-age=31536000");
    assert.match(page.headers.get("content-security-policy"), /img-src 'self' data: https:\/\/offers\.merchant\.example/);
  });
});

test("the pages contain no inline script or style for the policy to block", async () => {
  await withResolver({ demoMode: false }, async ({ baseUrl }) => {
    const paths = ["/", "/docs", "/docs/concepts", "/docs/quickstart", "/docs/self-hosting", "/docs/api", "/docs/wallets", "/docs/merchants", "/docs/fiber", "/docs/sdk", "/docs/production"];
    for (const path of paths) {
      const html = await fetch(`${baseUrl}${path}`).then((response) => response.text());
      assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, `${path} has an inline script`);
      assert.doesNotMatch(html, /<style[\s>]/i, `${path} has an inline style element`);
      assert.doesNotMatch(html, /\sstyle=["']/i, `${path} has an inline style attribute`);
      assert.doesNotMatch(html, /\son[a-z]+=["']/i, `${path} has an inline event handler`);
      assert.doesNotMatch(html, /(src|href)=["']https?:\/\/[^"']+\.(js|css)/i, `${path} loads code from another origin`);
    }
  });
});

// A resolver with an API key, one registered offer and one invoice on it,
// so every route can be addressed with IDs that exist.
async function withResolver(options, callback) {
  const server = createServer({
    store: new InMemoryOfferStore(),
    invoiceAdapter: options.invoiceAdapter ?? new MockInvoiceAdapter(),
    apiKey: API_KEY,
    demoMode: options.demoMode,
    publicOperatorAccess: options.publicOperatorAccess,
    publicOrigin: options.publicOrigin,
    topologyClient: options.topologyClient ?? false,
    workers: false,
    rateLimitMax: 0,
    logger: options.logger ?? { error() {}, info() {} }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const keys = generateOfferKeyPair();
    const offer = createSignedOffer(
      {
        node_id: `02${"c".repeat(64)}`,
        public_key: keys.publicKeyPem,
        resolver_url: baseUrl,
        description: "Route access fixture",
        network: "testnet",
        assets: [{ asset_type: "ckb", symbol: "CKB" }],
        amount_min: "1000",
        amount_max: "5000"
      },
      keys.privateKeyPem
    );
    const registered = await postJson(
      `${baseUrl}/offers`,
      { encoded_offer: encodeOffer(offer), username: "shop" },
      { "x-api-key": API_KEY }
    );
    assert.equal(registered.status, 201);
    const invoice = await postJson(`${baseUrl}/offers/${offer.offer_id}/invoice`, {
      amount: "1000",
      asset: { asset_type: "ckb", symbol: "CKB" }
    });
    assert.equal(invoice.status, 201);
    await callback({
      baseUrl,
      server,
      sample: {
        offerId: offer.offer_id,
        resolutionId: invoice.body.resolution_id,
        webhookId: "wh_sample",
        eventId: "evt_sample",
        username: "shop",
        format: "json",
        approval_id: `sub_${"a".repeat(40)}`
      }
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function call(baseUrl, route, sample, headers = {}) {
  const path = route.path.replace(/:([a-zA-Z_]+)/g, (_match, name) => sample[name]);
  const hasBody = route.method !== "GET";
  return fetch(`${baseUrl}${path}`, {
    method: route.method,
    headers: { ...(hasBody ? { "content-type": "application/json" } : {}), ...headers },
    body: hasBody ? "{}" : undefined
  }).then(async (response) => {
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: response.status, body };
  });
}

async function postJson(url, body, headers = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}
