import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { decodeOffer, verifyOfferRevocation } from "../../../packages/protocol/src/index.js";
import { main } from "../src/index.js";

const execFileAsync = promisify(execFile);

test("CLI executes through an npm-style binary symlink", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "fiber-offers-cli-bin-"));
  const binary = join(cwd, "fiber-offers");
  const source = new URL("../src/index.js", import.meta.url);
  await symlink(source, binary);

  const { stdout } = await execFileAsync(process.execPath, [binary, "--help"]);

  assert.match(stdout, /Fiber Offers merchant CLI/);
  assert.match(stdout, /fiber-offers create/);
});

test("CLI initializes private independent-merchant configuration", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "fiber-offers-cli-init-"));
  const output = captureOutput();
  await main([
    "init",
    "--resolver-url", "https://offers.merchant.example",
    "--fiber-rpc-url", "http://127.0.0.1:9227"
  ], { cwd, stdout: output });

  const envPath = join(cwd, ".env");
  const env = await readFile(envPath, "utf8");
  assert.match(env, /RESOLVER_API_KEY=[A-Za-z0-9_-]{40,}/);
  assert.match(env, /RESOLVER_SECRET_ENCRYPTION_KEY=[A-Za-z0-9_-]{60,}/);
  assert.match(env, /POSTGRES_PASSWORD=[A-Za-z0-9_-]{40,}/);
  assert.match(env, /FIBER_RPC_PORT=9227/);
  assert.equal((await stat(envPath)).mode & 0o777, 0o600);
  assert.equal((await stat(join(cwd, ".fiber-offers/keys"))).mode & 0o777, 0o700);
  assert.equal(JSON.parse(output.value).ok, true);
  assert.doesNotMatch(output.value, /RESOLVER_API_KEY=/);
});

test("CLI checks node ownership, creates, lists, and cryptographically revokes an offer", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "fiber-offers-cli-flow-"));
  const resolverUrl = "https://resolver.example";
  const fiberRpcUrl = "http://fiber.example:8227";
  const nodeId = `02${"a".repeat(64)}`;
  let offer;
  let revocation;
  const fetchImpl = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    if (url === `${resolverUrl}/health`) {
      return response({ ok: true, dependencies: { invoice_source: { ok: true, node_id: nodeId } } });
    }
    if (url === fiberRpcUrl) {
      assert.equal(body.method, "node_info");
      return response({ jsonrpc: "2.0", id: body.id, result: { pubkey: nodeId, peers_count: "0x2", channel_count: "0x3" } });
    }
    if (url === `${resolverUrl}/offers` && options.method === "POST") {
      assert.equal(options.headers.authorization, "Bearer merchant-key");
      offer = decodeOffer(body.encoded_offer);
      assert.equal(body.username, "shop");
      return response({ offer_id: offer.offer_id, payment_link: `${resolverUrl}/pay/${offer.offer_id}`, fiber_address: "shop@resolver.example" }, 201);
    }
    if (url === `${resolverUrl}/offers` && (options.method ?? "GET") === "GET") {
      assert.equal(options.headers.authorization, "Bearer merchant-key");
      return response({ offers: [{ offer_id: offer.offer_id, description: offer.description }] });
    }
    if (offer && url === `${resolverUrl}/offers/${offer.offer_id}` && options.method === "DELETE") {
      revocation = body.revocation;
      return response({ offer_id: offer.offer_id, revoked: true, revoked_at: new Date().toISOString() });
    }
    return response({ error: { code: "NOT_FOUND", message: `unexpected ${options.method ?? "GET"} ${url}` } }, 404);
  };
  const common = [
    "--resolver-url", resolverUrl,
    "--fiber-rpc-url", fiberRpcUrl,
    "--api-key", "merchant-key"
  ];

  const doctorOutput = captureOutput();
  await main(["doctor", ...common], { cwd, stdout: doctorOutput, fetchImpl });
  assert.deepEqual(JSON.parse(doctorOutput.value), {
    ok: true,
    resolver_url: resolverUrl,
    resolver_healthy: true,
    fiber_rpc_url: fiberRpcUrl,
    fiber_node_id: nodeId,
    resolver_node_id: nodeId,
    same_node: true,
    peers: 2,
    channels: 3
  });

  const createOutput = captureOutput();
  await main([
    "create", ...common,
    "--description", "Independent merchant offer",
    "--amount", "100000000",
    "--username", "shop"
  ], { cwd, stdout: createOutput, fetchImpl });
  const created = JSON.parse(createOutput.value);
  assert.equal(created.registered, true);
  assert.equal(created.node_id, nodeId);
  assert.doesNotMatch(createOutput.value, /PRIVATE KEY/);
  assert.equal((await stat(created.key_file)).mode & 0o777, 0o600);
  const keyRecord = JSON.parse(await readFile(created.key_file, "utf8"));
  assert.match(keyRecord.offer_private_key_pem, /PRIVATE KEY/);
  assert.equal(keyRecord.username, "shop");

  const listOutput = captureOutput();
  await main(["list", ...common], { cwd, stdout: listOutput, fetchImpl });
  assert.equal(JSON.parse(listOutput.value).offers[0].offer_id, created.offer_id);

  const revokeOutput = captureOutput();
  await main(["revoke", created.offer_id, ...common, "--reason", "merchant test"], { cwd, stdout: revokeOutput, fetchImpl });
  assert.equal(JSON.parse(revokeOutput.value).revoked, true);
  assert.equal(verifyOfferRevocation(offer, revocation).ok, true);
});

function captureOutput() {
  return {
    value: "",
    write(chunk) {
      this.value += chunk;
    }
  };
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}
