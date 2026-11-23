// Holds docs/schemas/v1/openapi.json to the reference resolver. The document
// is checked as OpenAPI, its routes are checked against the resolver's route
// table, and every response the resolver actually gives on those routes is
// checked against the schema the document names for that status.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import {
  createOfferRevocation,
  createSignedOffer,
  encodeOffer,
  generateOfferKeyPair,
  signRecurrenceRequest
} from "../../../packages/protocol/src/index.js";
import { loadSchemas } from "../../../packages/protocol/test/helpers/schemas.js";
import { MockInvoiceAdapter } from "../src/invoice-adapter.js";
import { createServer, describeRoutes, InMemoryOfferStore } from "../src/server.js";

const document = JSON.parse(
  await readFile(new URL("../../../docs/schemas/v1/openapi.json", import.meta.url), "utf8")
);
const openApiSchema = JSON.parse(
  await readFile(new URL("./fixtures/openapi-3.1-schema-2022-10-07.json", import.meta.url), "utf8")
);
const { problems, problemsWith, validatorFor } = loadSchemas();

const API_KEY = "openapi-test-key";
const CKB = { asset_type: "ckb", symbol: "CKB" };
const METHODS = ["get", "put", "post", "delete", "patch"];

// Public routes of the reference resolver that are not part of the wallet
// interface: another resolver need not offer them. A public route missing from
// both this list and the OpenAPI document fails the route test below.
const REFERENCE_RESOLVER_ONLY = [
  "GET /health",
  "GET /operator/session",
  "POST /operator/session",
  "GET /offers/:offerId/qr.svg",
  "GET /offers/:offerId/resolutions/:resolutionId/receipt.json"
];

// Statuses the document allows that the exchanges below do not produce, and why.
const NOT_EXERCISED = {};

const operations = Object.entries(document.paths).flatMap(([path, item]) =>
  METHODS.filter((method) => item[method]).map((method) => ({
    method: method.toUpperCase(),
    path,
    operation: item[method],
    parameters: [...(item.parameters ?? []), ...(item[method].parameters ?? [])].map(dereference)
  }))
);

function dereference(node) {
  if (typeof node?.$ref !== "string" || !node.$ref.startsWith("#/")) return node;
  const target = node.$ref
    .slice(2)
    .split("/")
    .reduce((value, key) => value?.[key.replaceAll("~1", "/").replaceAll("~0", "~")], document);
  assert.ok(target, `${node.$ref} does not exist in the document`);
  return target;
}

test("the document is valid OpenAPI 3.1", () => {
  // The official schema points at "whatever a Schema Object is in this
  // dialect" with $dynamicRef, which this validator resolves only when the
  // anchor sits at the root of a schema. Here it is the schema's own
  // definition, so the pointer is made a plain reference to it. The schema
  // also carries annotations (format) this check does not need.
  const official = JSON.parse(
    JSON.stringify(openApiSchema, (_key, value) =>
      value?.$dynamicRef === "#meta" ? { $ref: "#/$defs/schema" } : value
    )
  );
  const validate = new Ajv2020({ strict: false, validateFormats: false, allErrors: true }).compile(official);
  const valid = validate(document);
  assert.ok(valid, JSON.stringify(validate.errors, null, 2));
  assert.equal(document.jsonSchemaDialect, "https://json-schema.org/draft/2020-12/schema");

  const ids = operations.map(({ operation }) => operation.operationId);
  assert.equal(new Set(ids).size, ids.length, "operation IDs are unique");
  for (const { method, path, operation } of operations) {
    assert.ok(operation.operationId && operation.summary && operation.description, `${method} ${path}`);
  }
});

test("every reference in the document leads somewhere", () => {
  const references = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    if (typeof node.$ref === "string") references.push(node.$ref);
    Object.values(node).forEach(walk);
  };
  walk(document);

  assert.ok(references.length > 30);
  for (const reference of references) {
    if (reference.startsWith("#/")) dereference({ $ref: reference });
    else validatorFor(reference);
  }
});

test("every path parameter is declared, and nothing asks for a credential", () => {
  assert.deepEqual(document.security, []);
  assert.equal(document.components.securitySchemes, undefined);
  for (const { method, path, parameters } of operations) {
    const declared = parameters.filter((parameter) => parameter.in === "path").map((parameter) => parameter.name);
    const used = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
    assert.deepEqual(declared.sort(), used.sort(), `${method} ${path}`);
    for (const parameter of parameters) {
      assert.ok(!/^(authorization|cookie|x-api-key)$/i.test(parameter.name), `${method} ${path} takes ${parameter.name}`);
    }
  }
});

test("the document describes public routes of the resolver, and every public route is accounted for", () => {
  const routes = describeRoutes();
  const publicRoutes = routes
    .filter((route) => route.access === "public" && !route.demo)
    .map((route) => `${route.method} ${route.path}`);

  const described = operations.map(({ method, path, parameters }) => {
    const template = path
      .replace("{offer_id}", ":offerId")
      .replace("{resolution_id}", ":resolutionId")
      .replace("{user}", ":username");
    const query = parameters.filter((parameter) => parameter.in === "query" && parameter.required);
    return `${method} ${template}${query.map((parameter) => `?${parameter.name}=:${parameter.name}`).join("")}`;
  });

  for (const route of described) assert.ok(publicRoutes.includes(route), `${route} is not a public route of the resolver`);
  assert.deepEqual([...described, ...REFERENCE_RESOLVER_ONLY].sort(), publicRoutes.sort());
});

test("what the resolver answers on every wallet route fits the schema the document names", async () => {
  const seen = new Set();
  const node = { failure: undefined };
  const mock = new MockInvoiceAdapter();
  const invoiceAdapter = {
    mode: "mock",
    createInvoice: (input) => (node.failure ? Promise.reject(node.failure) : mock.createInvoice(input)),
    probe: () => mock.probe(),
    getNodeIdentity: () => mock.getNodeIdentity()
  };

  await withResolver({ invoiceAdapter }, async ({ baseUrl, register }) => {
    // Sends one request for an operation of the document and checks the answer
    // against it. `fits: false` marks a request that is malformed on purpose.
    async function exchange(operationId, { params = {}, query = {}, body, headers = {}, fits = true, raw } = {}) {
      const entry = operations.find(({ operation }) => operation.operationId === operationId);
      assert.ok(entry, `the document has no operation ${operationId}`);
      const { method, path, operation } = entry;

      const requestSchema = operation.requestBody?.content["application/json"].schema;
      if (body !== undefined && fits) {
        assert.equal(problemsWith(requestSchema, body), undefined, `${operationId} request`);
      }

      const url = new URL(`${baseUrl}${path.replace(/\{([^}]+)\}/g, (_match, name) => params[name])}`);
      for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
      const sent = raw ?? (body === undefined ? undefined : JSON.stringify(body));
      const response = await fetch(url, {
        method,
        headers: { ...(sent === undefined ? {} : { "content-type": "application/json" }), ...headers },
        body: sent
      });
      const answer = await response.json();
      const label = `${operationId} ${response.status}`;

      const described = operation.responses[String(response.status)];
      assert.ok(described, `${label} is not a response the document describes: ${JSON.stringify(answer)}`);
      const { content, headers: describedHeaders = {} } = dereference(described);
      assert.match(response.headers.get("content-type"), /^application\/json/, label);
      assert.equal(problemsWith(content["application/json"].schema, answer), undefined, `${label}: ${JSON.stringify(answer)}`);
      for (const name of Object.keys(describedHeaders)) {
        assert.ok(response.headers.get(name), `${label} should carry the ${name} header`);
      }
      // Every wallet route answers a browser on another origin.
      assert.equal(response.headers.get("access-control-allow-origin"), "*", label);

      seen.add(label);
      return { status: response.status, body: answer, code: answer.error?.code, headers: response.headers };
    }

    const keys = generateOfferKeyPair();
    const stranger = generateOfferKeyPair();
    const subscriber = generateOfferKeyPair();
    const reusable = await register(keys, { amount_min: "1000", amount_max: "5000" }, "shop");
    const singleUse = await register(keys, { description: "One ticket", single_use: true });
    const recurring = await register(keys, {
      description: "Monthly plan",
      amount_min: "2000",
      amount_max: "2000",
      recurrence: { interval: "monthly", amount: "2000", cap_cycles: 2 }
    });
    const unknownOffer = `0x${"1".repeat(64)}`;
    const at = (offer) => ({ offer_id: offer.offer_id });

    // Fetch an offer, by ID and by address.
    assert.equal((await exchange("getOffer", { params: at(reusable) })).status, 200);
    assert.equal((await exchange("getOffer", { params: { offer_id: unknownOffer } })).code, "OFFER_NOT_FOUND");
    const address = await exchange("resolveFiberAddress", { params: { user: "shop" } });
    assert.equal(address.body.offer_id, reusable.offer_id);
    assert.equal((await exchange("resolveFiberAddress", { params: { user: "SHOP" } })).body.username, "shop");
    assert.equal((await exchange("resolveFiberAddress", { params: { user: "nobody" } })).code, "FIBER_ADDRESS_NOT_FOUND");
    // A name no address can have, and one that is not even valid percent-encoding.
    for (const user of ["a%2Fb", "-shop", "%E0%A4%A", "%"]) {
      const refused = await exchange("resolveFiberAddress", { params: { user } });
      assert.equal(`${refused.status} ${refused.code}`, "400 INVALID_USERNAME", user);
    }

    // Readiness.
    assert.equal((await exchange("checkReadiness", { params: at(reusable), body: { amount: "1000", asset: CKB } })).body.ready, true);
    const notReady = await exchange("checkReadiness", { params: at(reusable), body: { amount: "1" } });
    assert.equal(notReady.body.ready, false);
    assert.equal(notReady.body.code, "AMOUNT_TOO_LOW");
    assert.equal((await exchange("checkReadiness", { params: { offer_id: unknownOffer }, body: { amount: "1000" } })).status, 404);
    assert.equal((await exchange("checkReadiness", { params: at(reusable), raw: "{not json" })).code, "INVALID_JSON");
    assert.equal((await exchange("checkReadiness", { params: at(reusable), raw: oversized() })).status, 413);

    // An invoice, its replay, and the resolution it created.
    const request = { amount: "1000", asset: CKB, idempotency_key: "order-1" };
    const created = await exchange("requestInvoice", { params: at(reusable), body: request });
    assert.equal(created.status, 201);
    const replayed = await exchange("requestInvoice", { params: at(reusable), body: request });
    assert.equal(replayed.status, 200);
    assert.equal(replayed.body.resolution_id, created.body.resolution_id);
    const byHeader = await exchange("requestInvoice", {
      params: at(reusable),
      body: { amount: "1000", asset: CKB },
      headers: { "idempotency-key": "order-1" }
    });
    assert.equal(byHeader.status, 200);

    const resolution = await exchange("getResolution", {
      params: { ...at(reusable), resolution_id: created.body.resolution_id }
    });
    assert.equal(resolution.body.invoice.invoice, created.body.invoice);
    assert.equal(
      (await exchange("getResolution", { params: { ...at(reusable), resolution_id: "res_00000000-0000-4000-8000-000000000000" } })).code,
      "RESOLUTION_NOT_FOUND"
    );

    // Each way an invoice request is refused.
    const refuse = async (offer, body, expected, options = {}) => {
      const refused = await exchange("requestInvoice", { params: at(offer), body, fits: false, ...options });
      assert.equal(`${refused.status} ${refused.code}`, expected);
      return refused;
    };
    await refuse(reusable, { amount: "abc" }, "400 INVALID_INTEGER");
    await refuse(reusable, { amount: "0" }, "400 INVALID_AMOUNT");
    await refuse(reusable, {}, "400 INVALID_AMOUNT");
    await refuse(reusable, { amount: "1000", idempotency_key: "not a key" }, "400 INVALID_IDEMPOTENCY_KEY");
    await refuse(reusable, { amount: "1" }, "422 AMOUNT_TOO_LOW");
    await refuse(reusable, { amount: "5001" }, "422 AMOUNT_TOO_HIGH");
    await refuse(reusable, { amount: "1000", asset: { asset_type: "udt", symbol: "RUSD", type_script_hash: `0x${"2".repeat(64)}` } }, "422 UNSUPPORTED_ASSET");
    await refuse(reusable, { amount: "2000", asset: CKB, idempotency_key: "order-1" }, "409 IDEMPOTENCY_KEY_REUSED");
    await refuse({ offer_id: unknownOffer }, { amount: "1000" }, "404 OFFER_NOT_FOUND");
    await refuse(reusable, undefined, "400 INVALID_JSON", { raw: "{not json" });
    await refuse(reusable, undefined, "413 BODY_TOO_LARGE", { raw: oversized() });

    // The merchant node is unreachable, then refuses.
    node.failure = Object.assign(new Error("connect ECONNREFUSED"), { kind: "transport", code: "ECONNREFUSED" });
    const unavailable = await refuse(reusable, { amount: "1000" }, "503 RECIPIENT_UNAVAILABLE");
    assert.equal(unavailable.body.error.details.retryable, true);
    node.failure = Object.assign(new Error("invoice refused"), { kind: "rpc", code: -32000 });
    const rejected = await refuse(reusable, { amount: "1000" }, "502 FIBER_INVOICE_REJECTED");
    assert.equal(rejected.body.error.details.retryable, false);
    node.failure = undefined;

    // A single-use offer while its invoice is open.
    assert.equal((await exchange("requestInvoice", { params: at(singleUse), body: { amount: "700" } })).status, 201);
    const outstanding = await refuse(singleUse, { amount: "700" }, "409 OFFER_INVOICE_OUTSTANDING");
    assert.ok(outstanding.body.error.details.outstanding_until);

    // A subscription: its status before and after the first cycle is requested.
    const cycle = (number, key = subscriber) =>
      signRecurrenceRequest(recurring, { amount: "2000", asset: CKB, recurrence_cycle: number }, key.privateKeyPem);
    const first = cycle(1);
    const status = (approvalId) =>
      exchange("getSubscriptionStatus", { params: at(recurring), query: { approval_id: approvalId } });

    const fresh = await status(first.approval_id);
    assert.equal(fresh.body.next_cycle, 1);
    assert.equal(fresh.body.outstanding, undefined);
    assert.equal((await exchange("requestInvoice", { params: at(recurring), body: first })).status, 201);
    const open = await status(first.approval_id);
    assert.equal(open.body.outstanding.cycle, 1);
    assert.equal(open.body.cycle_cap_remaining, 2);
    assert.equal((await exchange("checkReadiness", { params: at(recurring), body: first })).body.code, "RECURRENCE_CYCLE_OUTSTANDING");
    // On an offer that is not recurring there is nothing to report.
    const none = await exchange("getSubscriptionStatus", { params: at(reusable), query: { approval_id: first.approval_id } });
    assert.equal(none.body.enabled, false);
    assert.equal(
      (await exchange("getSubscriptionStatus", { params: { offer_id: unknownOffer }, query: { approval_id: first.approval_id } })).status,
      404
    );

    await refuse(recurring, { amount: "2000", asset: CKB, recurrence_cycle: 1 }, "400 SUBSCRIPTION_PROOF_REQUIRED");
    await refuse(recurring, { ...cycle(1, stranger), approval_id: first.approval_id }, "403 SUBSCRIPTION_KEY_MISMATCH");
    await refuse(recurring, { ...first, subscriber_signature: cycle(2).subscriber_signature }, "403 INVALID_SUBSCRIPTION_SIGNATURE");
    await refuse(recurring, first, "409 RECURRENCE_CYCLE_OUTSTANDING");
    const wrongCycle = await refuse(recurring, cycle(2, stranger), "409 INVALID_RECURRENCE_CYCLE");
    assert.equal(wrongCycle.body.error.details.next_cycle, 1);

    // Revocation: each refusal, then the real one, then what follows it.
    const revoke = (offer, revocation, options = {}) =>
      exchange("revokeOffer", { params: at(offer), body: { revocation }, ...options });
    const proof = createOfferRevocation(reusable, keys.privateKeyPem, { reason: "shop closed" });
    const forged = { ...createOfferRevocation(reusable, keys.privateKeyPem), signature: createOfferRevocation(singleUse, keys.privateKeyPem).signature };
    const stale = createOfferRevocation(reusable, keys.privateKeyPem, { revoked_at: Math.floor(Date.now() / 1000) - 3600 });

    assert.equal((await revoke(reusable, forged)).code, "INVALID_REVOCATION_SIGNATURE");
    assert.equal((await revoke(reusable, stale)).code, "REVOCATION_EXPIRED");
    assert.equal((await revoke(reusable, createOfferRevocation(singleUse, keys.privateKeyPem))).code, "INVALID_REVOCATION");
    assert.equal((await revoke({ offer_id: unknownOffer }, proof)).status, 404);
    assert.equal((await exchange("revokeOffer", { params: at(reusable), raw: oversized() })).status, 413);
    const revoked = await revoke(reusable, proof);
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body.revoked, true);
    assert.equal((await revoke(reusable, proof)).status, 409);

    await refuse(reusable, { amount: "1000" }, "410 OFFER_REVOKED");
    const afterwards = await exchange("getOffer", { params: at(reusable) });
    assert.equal(afterwards.body.disabled, true);
    assert.equal((await exchange("checkReadiness", { params: at(reusable), body: { amount: "1000" } })).body.code, "OFFER_REVOKED");
  });

  // A resolver that allows two requests per window, to see the limit itself.
  await withResolver({ rateLimitMax: 2, readRateLimitMax: 2 }, async ({ baseUrl, register }) => {
    const keys = generateOfferKeyPair();
    const subscriber = generateOfferKeyPair();
    const offer = await register(keys, {
      amount_min: "2000",
      amount_max: "2000",
      recurrence: { interval: "daily", amount: "2000", cap_cycles: 5 }
    });
    const cycle = signRecurrenceRequest(offer, { amount: "2000", asset: CKB, recurrence_cycle: 1 }, subscriber.privateKeyPem);
    const routes = {
      getOffer: () => fetch(`${baseUrl}/offers/${offer.offer_id}`),
      getResolution: () => fetch(`${baseUrl}/offers/${offer.offer_id}/resolutions/res_none`),
      resolveFiberAddress: () => fetch(`${baseUrl}/.well-known/fiberoffer/nobody`),
      requestInvoice: () => post(`${baseUrl}/offers/${offer.offer_id}/invoice`, { amount: "1" }),
      checkReadiness: () => post(`${baseUrl}/offers/${offer.offer_id}/check`, { amount: "1" }),
      getSubscriptionStatus: () => fetch(`${baseUrl}/offers/${offer.offer_id}/recurrence-status?approval_id=${cycle.approval_id}`),
      revokeOffer: () => fetch(`${baseUrl}/offers/${offer.offer_id}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: "{}" })
    };
    for (const [operationId, send] of Object.entries(routes)) {
      await send();
      await send();
      const limited = await send();
      const body = await limited.json();
      const { operation } = operations.find((entry) => entry.operation.operationId === operationId);
      const described = dereference(operation.responses["429"]);

      assert.equal(limited.status, 429, operationId);
      assert.equal(problemsWith(described.content["application/json"].schema, body), undefined, operationId);
      assert.equal(body.error.code, "RATE_LIMITED");
      assert.equal(limited.headers.get("retry-after"), String(body.error.details.retry_after_seconds), operationId);
      seen.add(`${operationId} 429`);
    }
  });

  // A resolver whose rate limiter is down and which is set to refuse then.
  const brokenLimiter = { consume: () => Promise.reject(new Error("limiter down")) };
  await withResolver({ rateLimiter: brokenLimiter, rateLimitFailOpen: false, logger: silent }, async ({ baseUrl, offerId }) => {
    const routes = {
      requestInvoice: () => post(`${baseUrl}/offers/${offerId}/invoice`, { amount: "1" }),
      checkReadiness: () => post(`${baseUrl}/offers/${offerId}/check`, { amount: "1" }),
      getSubscriptionStatus: () => fetch(`${baseUrl}/offers/${offerId}/recurrence-status?approval_id=sub_${"a".repeat(40)}`),
      revokeOffer: () => fetch(`${baseUrl}/offers/${offerId}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: "{}" })
    };
    for (const [operationId, send] of Object.entries(routes)) {
      const refused = await send();
      const body = await refused.json();
      const { operation } = operations.find((entry) => entry.operation.operationId === operationId);
      const described = operation.responses["503"];

      assert.equal(refused.status, 503, operationId);
      assert.ok(described, `${operationId} can answer 503 and the document does not say so`);
      assert.equal(problemsWith(dereference(described).content["application/json"].schema, body), undefined, operationId);
      assert.equal(body.error.code, "RATE_LIMITER_UNAVAILABLE");
      seen.add(`${operationId} 503`);
    }
  });

  // Nothing the document promises went unseen, apart from what is listed.
  const promised = operations.flatMap(({ operation }) =>
    Object.keys(operation.responses).map((status) => `${operation.operationId} ${status}`)
  );
  const unseen = promised.filter((label) => !seen.has(label));
  assert.deepEqual(unseen.sort(), Object.keys(NOT_EXERCISED).sort());
});

test("the schemas refuse a response that leaves out what a wallet relies on", () => {
  const invoice = {
    offer_id: `0x${"a".repeat(64)}`,
    resolution_id: "res_1f0e",
    status: "invoice_created",
    amount: "1000",
    asset: CKB,
    invoice: "fibt1example",
    payment_hash: `0x${"b".repeat(64)}`,
    expires_at: "2027-01-15T08:15:00.000Z"
  };
  assert.equal(problems("invoice-response.schema.json", invoice), undefined);
  for (const member of Object.keys(invoice)) {
    const { [member]: _removed, ...rest } = invoice;
    assert.notEqual(problems("invoice-response.schema.json", rest), undefined, `without ${member}`);
  }
  assert.notEqual(problems("invoice-response.schema.json", { ...invoice, status: "invoice_pending" }), undefined);
  assert.notEqual(problems("invoice-response.schema.json", { ...invoice, amount: 1000 }), undefined);
  assert.notEqual(problems("error.schema.json", { error: "nope" }), undefined);
  assert.notEqual(problems("error.schema.json", { error: { code: "lower_case", message: "x" } }), undefined);
  assert.notEqual(problems("error.schema.json", { code: "AMOUNT_TOO_LOW", message: "x" }), undefined);
});

const silent = { error() {}, info() {}, warn() {} };

function oversized() {
  return JSON.stringify({ amount: "1000", padding: "x".repeat(1024 * 1024) });
}

function post(url, body, headers = {}) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
}

// A resolver with an API key. `register` signs an offer for it and stores it,
// as the merchant would.
async function withResolver(options, callback) {
  const server = createServer({
    store: new InMemoryOfferStore(),
    invoiceAdapter: options.invoiceAdapter ?? new MockInvoiceAdapter(),
    apiKey: API_KEY,
    demoMode: false,
    topologyClient: false,
    workers: false,
    rateLimitMax: options.rateLimitMax ?? 0,
    readRateLimitMax: options.readRateLimitMax,
    rateLimiter: options.rateLimiter,
    rateLimitFailOpen: options.rateLimitFailOpen,
    logger: options.logger ?? silent
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  async function register(keys, terms, username = undefined) {
    const offer = createSignedOffer(
      {
        node_id: `02${"c".repeat(64)}`,
        public_key: keys.publicKeyPem,
        resolver_url: baseUrl,
        description: "OpenAPI fixture",
        network: "testnet",
        assets: [CKB],
        ...terms
      },
      keys.privateKeyPem
    );
    const registered = await post(`${baseUrl}/offers`, { encoded_offer: encodeOffer(offer), username }, { "x-api-key": API_KEY });
    assert.equal(registered.status, 201, await registered.text());
    return offer;
  }

  try {
    const offer = await register(generateOfferKeyPair(), {});
    await callback({ baseUrl, register, offerId: offer.offer_id });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
