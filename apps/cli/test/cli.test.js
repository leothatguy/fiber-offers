import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { ckbScriptHash, decodeOffer, verifyOfferRevocation } from "../../../packages/protocol/src/index.js";
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
      // As the resolver does: its node is named to operators only.
      return options.headers["x-api-key"] === "merchant-key"
        ? response({ ok: true, dependencies: { invoice_source: { ok: true, node_id: nodeId } } })
        : response({ ok: true, service: "fiber-offers-resolver", invoice_mode: "fiber-rpc" });
    }
    if (url === fiberRpcUrl) {
      // The management key is for the resolver, never for the node's RPC.
      assert.equal(options.headers["x-api-key"], undefined);
      assert.equal(options.headers.authorization, undefined);
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

  // Without the key the resolver does not say which node it uses, and doctor
  // reports that it could not compare rather than claiming a match.
  const keylessOutput = captureOutput();
  await main(["doctor", "--resolver-url", resolverUrl, "--fiber-rpc-url", fiberRpcUrl], {
    cwd,
    stdout: keylessOutput,
    fetchImpl
  });
  const keyless = JSON.parse(keylessOutput.value);
  assert.equal(keyless.same_node, null);
  assert.equal(keyless.resolver_node_id, undefined);
  assert.match(keyless.note, /RESOLVER_API_KEY/);

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

test("CLI signs offers for the network its Fiber node is on", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "fiber-offers-cli-network-"));
  const fiberRpcUrl = "http://fiber.example:8227";
  const mainnetGenesis = "0x92b197aa1fba0f63633922c61c92375c9c074a93e85963554f5499fe1450d0e5";
  const fetchImpl = async (url, options = {}) => {
    const body = JSON.parse(options.body);
    assert.equal(url, fiberRpcUrl);
    return response({
      jsonrpc: "2.0",
      id: body.id,
      result: { pubkey: `03${"b".repeat(64)}`, chain_hash: mainnetGenesis }
    });
  };
  const common = ["--resolver-url", "https://resolver.example", "--fiber-rpc-url", fiberRpcUrl, "--local-only"];

  const output = captureOutput();
  await main(["create", ...common, "--description", "Mainnet offer", "--amount", "100000000"], {
    cwd,
    stdout: output,
    fetchImpl
  });
  const created = JSON.parse(output.value);
  const keyRecord = JSON.parse(await readFile(created.key_file, "utf8"));

  assert.equal(created.network, "mainnet");
  assert.equal(keyRecord.offer.network, "mainnet");
  await assert.rejects(
    () =>
      main(["create", ...common, "--description", "Wrong network", "--amount", "100000000", "--network", "testnet"], {
        cwd,
        stdout: captureOutput(),
        fetchImpl
      }),
    (error) => error.code === "OFFER_NETWORK_MISMATCH"
  );
});

test("CLI creates token and recurring offers from flags", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "fiber-offers-cli-token-"));
  const fiberRpcUrl = "http://fiber.example:8227";
  const fetchImpl = async (_url, options = {}) =>
    response({ jsonrpc: "2.0", id: JSON.parse(options.body).id, result: { pubkey: `02${"c".repeat(64)}` } });
  const script = { code_hash: `0x${"aa".repeat(32)}`, hash_type: "type", args: `0x${"01".repeat(32)}` };
  const hash = ckbScriptHash(script);
  const create = async (...flags) => {
    const output = captureOutput();
    await main(
      ["create", "--resolver-url", "https://resolver.example", "--fiber-rpc-url", fiberRpcUrl, "--local-only", ...flags],
      { cwd, stdout: output, fetchImpl }
    );
    return JSON.parse(await readFile(JSON.parse(output.value).key_file, "utf8")).offer;
  };
  const token = ["--description", "Token offer", "--amount", "1000", "--asset-type", "udt", "--symbol", "usdi"];

  const fromScript = await create(...token, "--type-script", JSON.stringify(script));
  const fromHash = await create(...token, "--type-script-hash", hash.toUpperCase().replace("0X", "0x"));
  const fromBoth = await create(...token, "--type-script", JSON.stringify(script), "--type-script-hash", hash);
  const recurring = await create(
    "--description", "Monthly plan", "--amount", "500", "--recurrence-interval", "monthly", "--cap-cycles", "12"
  );
  const custom = await create(
    "--description", "Metered", "--amount-min", "100", "--recurrence-interval", "custom_seconds",
    "--custom-seconds", "3600", "--recurrence-amount", "250", "--spending-cap-total", "10000"
  );

  const expectedAsset = { asset_type: "udt", symbol: "USDI", type_script_hash: hash };
  assert.deepEqual(fromScript.assets, [expectedAsset]);
  assert.deepEqual(fromHash.assets, [expectedAsset]);
  assert.deepEqual(fromBoth.assets, [expectedAsset]);
  assert.deepEqual(recurring.recurrence, { interval: "monthly", amount: "500", cap_cycles: 12 });
  assert.deepEqual(custom.recurrence, {
    interval: "custom_seconds",
    amount: "250",
    spending_cap_total: "10000",
    custom_seconds: 3600
  });

  const rejects = (flags, code) => assert.rejects(() => create(...flags), (error) => error.code === code);
  await rejects(token, "MISSING_TYPE_SCRIPT_HASH");
  await rejects([...token, "--type-script", JSON.stringify(script), "--type-script-hash", `0x${"9".repeat(64)}`], "TYPE_SCRIPT_HASH_MISMATCH");
  await rejects([...token, "--type-script", "{not json"], "INVALID_TYPE_SCRIPT");
  await rejects([...token, "--type-script", JSON.stringify({ ...script, hash_type: "nope" })], "INVALID_TYPE_SCRIPT");
  await rejects([...token, "--type-script-hash", "0x1234"], "INVALID_TYPE_SCRIPT_HASH");
  await rejects(
    ["--description", "No symbol", "--amount", "1000", "--asset-type", "udt", "--type-script-hash", hash],
    "MISSING_SYMBOL"
  );
  await rejects(["--description", "CKB", "--amount", "1000", "--type-script-hash", hash], "UNEXPECTED_TYPE_SCRIPT");
  await rejects(["--description", "Stray cap", "--amount", "1000", "--cap-cycles", "3"], "MISSING_RECURRENCE_INTERVAL");
  await rejects(["--description", "No cap", "--amount", "1000", "--recurrence-interval", "daily"], "RECURRENCE_CAP_REQUIRED");
  await rejects(
    ["--description", "No amount", "--amount-min", "100", "--recurrence-interval", "daily", "--cap-cycles", "3"],
    "MISSING_RECURRENCE_AMOUNT"
  );
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
