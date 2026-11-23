import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import test from "node:test";
import { MockInvoiceAdapter } from "../src/invoice-adapter.js";
import { createServer, InMemoryOfferStore } from "../src/server.js";
import { deliverWebhookEvent } from "../src/webhook-delivery.js";
import { assertWebhookUrlAllowed, isNonPublicAddress } from "../src/webhook-target.js";

const event = {
  id: "evt_test",
  offer_id: `0x${"b".repeat(64)}`,
  type: "invoice.created",
  created_at: new Date().toISOString(),
  payload: { resolution: { id: "res_test" } }
};

test("only public unicast addresses count as public", () => {
  const notPublic = [
    "0.0.0.0",
    "0.1.2.3",
    "10.0.0.1",
    "100.64.0.1",
    "100.127.255.254",
    "127.0.0.1",
    "127.255.255.254",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.254",
    "192.168.1.1",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::127.0.0.1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:10.0.0.1",
    "::ffff:169.254.169.254",
    "64:ff9b::7f00:1",
    "64:ff9b::10.0.0.1",
    "2002:7f00:1::",
    "2002:c0a8:101::1",
    "2001::1",
    "2001:db8::1",
    "fc00::1",
    "fd00::1",
    "fe80::1",
    "fe80::1%eth0",
    "fec0::1",
    "ff02::1",
    "not-an-address",
    ""
  ];
  const isPublic = [
    "1.1.1.1",
    "8.8.8.8",
    "100.63.255.254",
    "100.128.0.1",
    "172.15.255.254",
    "172.32.0.1",
    "192.169.0.1",
    "2606:4700:4700::1111",
    "2a00:1450:4001:81b::200e",
    "::ffff:8.8.8.8",
    "64:ff9b::808:808",
    "2002:808:808::1"
  ];
  for (const address of notPublic) assert.equal(isNonPublicAddress(address), true, address);
  for (const address of isPublic) assert.equal(isNonPublicAddress(address), false, address);
});

test("a webhook URL that names a private target is refused when it is registered", () => {
  const refused = [
    "http://0.0.0.0/",
    "http://127.0.0.1:9999/internal",
    "http://2130706433/", // 127.0.0.1 as one number
    "http://0x7f.1/", // 127.0.0.1 in hex
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[fd00::1]/",
    "http://[fe80::1]/",
    "http://100.64.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://localhost/",
    "http://LOCALHOST./",
    "http://app.localhost/",
    "http://redis:6379/",
    "http://printer.local/",
    "http://metadata.google.internal/"
  ];
  for (const url of refused) {
    assert.throws(() => assertWebhookUrlAllowed(url), (error) => error.code === "WEBHOOK_TARGET_PRIVATE", url);
    // An operator can opt in to private targets for local development.
    assert.equal(assertWebhookUrlAllowed(url, { allowPrivateTargets: true }).protocol, "http:");
  }
  for (const url of ["ftp://merchant.example/hook", "https://user:pass@merchant.example/hook", "not a url"]) {
    assert.throws(() => assertWebhookUrlAllowed(url), (error) => error.code === "WEBHOOK_URL_INVALID", url);
  }
  assert.equal(assertWebhookUrlAllowed("https://hooks.merchant.example/fiber").hostname, "hooks.merchant.example");
  assert.equal(assertWebhookUrlAllowed("https://8.8.8.8/hook").hostname, "8.8.8.8");
});

test("a name that resolves to a private address is refused at delivery, before any connection", async () => {
  await withHttpServer((_request, response) => response.writeHead(204).end(), async (canary) => {
    const url = `http://hooks.attacker.example:${canary.port}/steal`;
    const cases = {
      loopback: [{ address: "127.0.0.1", family: 4 }],
      "cloud metadata": [{ address: "169.254.169.254", family: 4 }],
      "IPv4-mapped loopback": [{ address: "::ffff:127.0.0.1", family: 6 }],
      "unique local IPv6": [{ address: "fd00::1", family: 6 }],
      // DNS rebinding: one public answer does not excuse a private one.
      "public and private together": [
        { address: "8.8.8.8", family: 4 },
        { address: "127.0.0.1", family: 4 }
      ]
    };

    for (const [label, addresses] of Object.entries(cases)) {
      const result = await deliver(url, { lookup: fixedLookup(addresses) });
      assert.equal(result.status, "failed", label);
      assert.equal(result.error.code, "WEBHOOK_TARGET_PRIVATE", label);
    }
    assert.equal(canary.requests.length, 0);

    // The same name, with private targets allowed: the connection goes to the
    // address the lookup returned and nowhere else.
    const allowed = await deliver(url, {
      lookup: fixedLookup([{ address: "127.0.0.1", family: 4 }]),
      allowPrivateTargets: true
    });
    assert.equal(allowed.status, "delivered");
    assert.equal(canary.requests.length, 1);
    assert.equal(canary.requests[0].headers.host, `hooks.attacker.example:${canary.port}`);
  });
});

test("a redirect is a failed delivery and is never followed", async () => {
  await withHttpServer((_request, response) => response.writeHead(204).end(), async (internal) => {
    await withHttpServer(
      (_request, response) => response.writeHead(302, { location: `http://127.0.0.1:${internal.port}/admin` }).end(),
      async (redirecting) => {
        const result = await deliver(`http://127.0.0.1:${redirecting.port}/hook`, { allowPrivateTargets: true });

        assert.equal(result.status, "failed");
        assert.equal(result.response_status, 302);
        assert.equal(result.error.code, "WEBHOOK_REDIRECT_REFUSED");
        assert.equal(redirecting.requests.length, 1);
        assert.equal(internal.requests.length, 0);
      }
    );
  });
});

test("only the status code of a delivery's answer is kept", async () => {
  await withHttpServer(
    (_request, response) => response.writeHead(500, { "content-type": "text/plain" }).end("internal secret"),
    async (receiver) => {
      const result = await deliver(`http://127.0.0.1:${receiver.port}/hook`, { allowPrivateTargets: true });
      assert.deepEqual(result, { status: "failed", response_status: 500 });
    }
  );
});

test("a webhook target that never answers times out", async () => {
  await withHttpServer(
    () => {},
    async (silent) => {
      const result = await deliver(`http://127.0.0.1:${silent.port}/hook`, { allowPrivateTargets: true, timeoutMs: 40 });
      assert.equal(result.status, "failed");
      assert.equal(result.error.code, "WEBHOOK_DELIVERY_TIMEOUT");
      assert.match(result.error.message, /timed out after 40ms/);
    }
  );
});

test("the resolver refuses private webhook targets at registration and again at delivery", async () => {
  await withHttpServer(
    (_request, response) => response.writeHead(200, { "content-type": "text/plain" }).end("internal secret"),
    async (internal) => {
      // What the public-looking name resolves to; changed mid-test.
      let answer = [{ address: "127.0.0.1", family: 4 }];
      const lookup = (hostname, options, callback) => fixedLookup(answer)(hostname, options, callback);

      await withResolver({ allowPrivateWebhookTargets: false, webhookLookup: lookup }, async (baseUrl, offerId) => {
        for (const url of ["http://0.0.0.0/", "http://[::ffff:127.0.0.1]/", "http://[fd00::1]/", "http://100.64.0.1/", "http://localhost/hook"]) {
          const refused = await postJson(`${baseUrl}/offers/${offerId}/webhooks`, { url, events: ["invoice.created"] });
          assert.equal(refused.status, 400, url);
          assert.equal(refused.body.error.code, "INVALID_WEBHOOK_URL", url);
          assert.equal(refused.body.error.details.cause_code, "WEBHOOK_TARGET_PRIVATE", url);
        }

        // Nothing about this URL's text is private, so it registers.
        const registered = await postJson(`${baseUrl}/offers/${offerId}/webhooks`, {
          url: `http://hooks.merchant.example:${internal.port}/hook`,
          events: ["invoice.created"]
        });
        assert.equal(registered.status, 201);

        await postJson(`${baseUrl}/offers/${offerId}/invoice`, {
          amount: "1000",
          asset: { asset_type: "ckb", symbol: "CKB" }
        });
        const delivery = await postJson(`${baseUrl}/offers/${offerId}/webhook-events/deliver`, {});
        const history = await fetch(`${baseUrl}/offers/${offerId}/webhook-events`).then((response) => response.text());

        assert.equal(delivery.body.failed, 1);
        assert.equal(delivery.body.deliveries[0].error.code, "WEBHOOK_TARGET_PRIVATE");
        assert.equal(internal.requests.length, 0);
        assert.doesNotMatch(history, /response_body|internal secret/);
      });

      // With private targets allowed the same delivery goes through, and the
      // answer's body still is not recorded.
      await withResolver({ allowPrivateWebhookTargets: true, webhookLookup: lookup }, async (baseUrl, offerId) => {
        await postJson(`${baseUrl}/offers/${offerId}/webhooks`, {
          url: `http://hooks.merchant.example:${internal.port}/hook`,
          events: ["invoice.created"]
        });
        await postJson(`${baseUrl}/offers/${offerId}/invoice`, {
          amount: "1000",
          asset: { asset_type: "ckb", symbol: "CKB" }
        });
        const delivery = await postJson(`${baseUrl}/offers/${offerId}/webhook-events/deliver`, {});
        const history = await fetch(`${baseUrl}/offers/${offerId}/webhook-events`).then((response) => response.text());

        assert.equal(delivery.body.delivered, 1);
        assert.equal(internal.requests.length, 1);
        assert.doesNotMatch(history, /response_body|internal secret/);
      });
    }
  );
});

function deliver(url, options) {
  return deliverWebhookEvent(event, { secret: "test-secret" }, { webhook_id: "wh_test", url }, options);
}

// A DNS lookup that always answers with `addresses`, in the shape node:dns uses.
function fixedLookup(addresses) {
  return (_hostname, options, callback) => {
    if (options?.all) return callback(null, addresses);
    return callback(null, addresses[0].address, addresses[0].family);
  };
}

async function withHttpServer(handler, callback) {
  const requests = [];
  const sockets = new Set();
  const server = createHttpServer((request, response) => {
    requests.push({ method: request.method, url: request.url, headers: request.headers });
    request.resume();
    handler(request, response);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await callback({ port: server.address().port, requests });
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function withResolver(options, callback) {
  const server = createServer({
    store: new InMemoryOfferStore(),
    invoiceAdapter: new MockInvoiceAdapter(),
    demoMode: true,
    topologyClient: false,
    workers: false,
    logger: { error() {}, info() {} },
    ...options
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const created = await postJson(`${baseUrl}/demo/offers`, { amount: "1000" });
    await callback(baseUrl, created.body.offer_id);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}
