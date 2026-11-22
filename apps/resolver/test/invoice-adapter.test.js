import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadUdtScriptsFromEnv, parseConfiguredUdtScripts } from "../src/asset-registry.js";
import { createInvoiceAdapter, FiberRpcInvoiceAdapter, MockInvoiceAdapter } from "../src/invoice-adapter.js";
import { ckbScriptHash } from "../../../packages/protocol/src/index.js";

test("live Fiber RPC is required unless mock mode is explicitly selected", () => {
  assert.throws(
    () => createInvoiceAdapter({ FIBER_INVOICE_MODE: "fiber-rpc" }),
    (error) => error.code === "FIBER_RPC_URL_REQUIRED"
  );

  const mock = createInvoiceAdapter({
    FIBER_INVOICE_MODE: "mock",
    FIBER_RPC_URL: "http://127.0.0.1:8227"
  });
  assert.equal(mock.mode, "mock");

  const live = createInvoiceAdapter({
    FIBER_RPC_URL: "http://127.0.0.1:8227"
  });
  assert.equal(live.mode, "fiber-rpc");

  const merchantAlias = createInvoiceAdapter({
    MERCHANT_FIBER_RPC_URL: "https://merchant-fiber.example/rpc",
    MERCHANT_FIBER_RPC_USERNAME: "merchant"
  });
  assert.equal(merchantAlias.mode, "fiber-rpc");
  assert.equal(merchantAlias.client.url, "https://merchant-fiber.example/rpc");
  assert.equal(merchantAlias.client.username, "merchant");
});

test("mock adapter reports mock diagnostics", async () => {
  const probe = await new MockInvoiceAdapter().probe();

  assert.equal(probe.mode, "mock");
  assert.equal(probe.configured, false);
  assert.equal(probe.status, "mock");
});

test("Fiber RPC adapter reports reachable probe diagnostics", async () => {
  const calls = [];
  const adapter = new FiberRpcInvoiceAdapter({
    probeMethod: "node_info",
    client: {
      async call(method, params) {
        calls.push({ method, params });
        return {
          node_id: "02abc",
          version: "0.0.test",
          extra: "ignored"
        };
      }
    }
  });

  const probe = await adapter.probe();

  assert.equal(probe.reachable, true);
  assert.equal(probe.method, "node_info");
  assert.deepEqual(probe.result_summary, {
    node_id: "02abc",
    version: "0.0.test"
  });
  assert.deepEqual(calls[0], { method: "node_info", params: [] });
});

test("Fiber RPC adapter summarizes peer and channel diagnostics", async () => {
  const adapter = new FiberRpcInvoiceAdapter({
    probeMethod: "node_info",
    client: {
      async call(method) {
        if (method === "node_info") {
          return {
            pubkey: "02merchant",
            version: "0.9.0",
            peers_count: "0x1",
            channel_count: "0x2"
          };
        }

        if (method === "list_peers") {
          return {
            peers: [
              {
                pubkey: "02peer1",
                address: "/ip4/127.0.0.1/tcp/8228"
              }
            ]
          };
        }

        if (method === "list_channels") {
          return {
            channels: [
              {
                pubkey: "02peer1",
                is_public: true,
                funding_udt_type_script: null,
                state: { state_name: "ChannelReady" },
                enabled: true,
                local_balance: "0x64",
                remote_balance: "0xc8",
                pending_tlcs: [{}]
              },
              {
                pubkey: "02peer2",
                is_public: false,
                funding_udt_type_script: { code_hash: "0xabc" },
                state: { state_name: "ChannelReady" },
                enabled: true,
                local_balance: "0x0",
                remote_balance: "0x32",
                pending_tlcs: []
              }
            ]
          };
        }

        throw new Error(`unexpected method ${method}`);
      }
    }
  });

  const probe = await adapter.probe();

  assert.equal(probe.status, "degraded");
  assert.equal(probe.node.pubkey, "02merchant");
  assert.equal(probe.node.peers_count, "1");
  assert.equal(probe.peers.count, 1);
  assert.equal(probe.channels.total, 2);
  assert.equal(probe.channels.enabled, 2);
  assert.equal(probe.channels.ckb, 1);
  assert.equal(probe.channels.udt, 1);
  assert.equal(probe.channels.usable_outbound, 1);
  assert.equal(probe.channels.local_balance_total, "100");
  assert.equal(probe.channels.remote_balance_total, "250");
  assert.equal(probe.channels.pending_tlc_count, 1);
  assert.deepEqual(probe.channels.offline_counterparties, ["02peer2"]);
  assert.equal(probe.channels.counterparties[0].connected, true);
  assert.equal(probe.warnings.some((warning) => warning.code === "OFFLINE_CHANNEL_COUNTERPARTIES"), true);
});

test("Fiber RPC adapter reports failed probe diagnostics", async () => {
  const adapter = new FiberRpcInvoiceAdapter({
    probeMethod: "node_info",
    client: {
      async call() {
        const error = new Error("method not found");
        error.code = -32601;
        error.details = { method: "node_info" };
        throw error;
      }
    }
  });

  const probe = await adapter.probe();

  assert.equal(probe.reachable, false);
  assert.equal(probe.status, "error");
  assert.equal(probe.error.code, -32601);
});

test("Fiber RPC adapter creates invoices using Fiber JSON-RPC shape", async () => {
  const calls = [];
  const adapter = new FiberRpcInvoiceAdapter({
    method: "new_invoice",
    client: {
      async call(method, params) {
        calls.push({ method, params });
        return {
          invoice_address: "fibt1000000001example",
          invoice: {
            data: {
              payment_hash: "0xabc123"
            }
          }
        };
      }
    }
  });

  const invoice = await adapter.createInvoice({
    offer: {
      offer_id: "0xoffer",
      network: "testnet",
      description: "test invoice"
    },
    amount: "100000000",
    asset: { asset_type: "ckb", symbol: "CKB" }
  });

  assert.deepEqual(calls[0], {
    method: "new_invoice",
    params: [
      {
        amount: "0x5f5e100",
        currency: "Fibt",
        description: "test invoice"
      }
    ]
  });
  assert.equal(invoice.invoice, "fibt1000000001example");
  assert.equal(invoice.payment_hash, "0xabc123");
  assert.equal(invoice.mocked, false);
});

test("Fiber RPC adapter uses the currency of the offer's network", async () => {
  const currencies = [];
  const adapter = new FiberRpcInvoiceAdapter({
    client: {
      async call(_method, params) {
        currencies.push(params[0].currency);
        return { invoice_address: "fib1example", invoice: { data: { payment_hash: "0xabc" } } };
      }
    }
  });
  const invoiceFor = (network) =>
    adapter.createInvoice({
      offer: { offer_id: "0xoffer", network },
      amount: "1000",
      asset: { asset_type: "ckb", symbol: "CKB" }
    });

  await invoiceFor("mainnet");
  await invoiceFor("testnet");
  await invoiceFor("dev");

  assert.deepEqual(currencies, ["Fibb", "Fibt", "Fibd"]);
  await assert.rejects(
    () => invoiceFor("signet"),
    (error) => error.code === "UNSUPPORTED_NETWORK" && error.status === 422
  );
  assert.equal(currencies.length, 3);
});

test("Fiber RPC adapter refuses a token invoice it has no type script for", async () => {
  const calls = [];
  const adapter = new FiberRpcInvoiceAdapter({
    client: {
      async call(method) {
        calls.push(method);
        return { invoice_address: "fibt1example", invoice: { data: { payment_hash: "0xabc" } } };
      }
    }
  });

  await assert.rejects(
    () =>
      adapter.createInvoice({
        offer: { offer_id: "0xoffer", network: "testnet" },
        amount: "1000",
        asset: { asset_type: "udt", symbol: "USDI", type_script_hash: "0x" + "1".repeat(64) }
      }),
    (error) => error.code === "ASSET_SCRIPT_NOT_CONFIGURED" && error.status === 422
  );
  // The node may be asked which tokens it lists, but no invoice is requested.
  assert.equal(calls.includes("new_invoice"), false);
});

test("token script configuration is verified by hash when it is loaded", async () => {
  const script = { code_hash: "0x" + "aa".repeat(32), hash_type: "type", args: "0x" + "01".repeat(32) };
  const hash = ckbScriptHash(script);
  const directory = await mkdtemp(join(tmpdir(), "fiber-offers-udt-"));
  const file = join(directory, "udt-scripts.json");
  await writeFile(file, JSON.stringify([{ name: "FILE", script: { ...script, args: "0x02" } }]));

  try {
    const fromEnv = loadUdtScriptsFromEnv({
      FIBER_UDT_SCRIPTS: JSON.stringify([{ name: "USDI", type_script_hash: hash.toUpperCase().replace("0X", "0x"), ...script }]),
      FIBER_UDT_SCRIPTS_FILE: file
    });
    const adapter = createInvoiceAdapter({
      FIBER_RPC_URL: "http://127.0.0.1:8227",
      FIBER_UDT_SCRIPTS: JSON.stringify([script])
    });

    assert.deepEqual(fromEnv.get(hash), { type_script_hash: hash, script, name: "USDI", source: "FIBER_UDT_SCRIPTS" });
    assert.equal(fromEnv.size, 2);
    assert.equal([...fromEnv.values()][1].source, "FIBER_UDT_SCRIPTS_FILE");
    assert.equal(adapter.udtScripts.has(hash), true);
    assert.equal(parseConfiguredUdtScripts(undefined).size, 0);

    // A hash copied from the wrong token must not be accepted.
    assert.throws(
      () => parseConfiguredUdtScripts([{ ...script, type_script_hash: "0x" + "9".repeat(64) }]),
      (error) => error.code === "UDT_SCRIPT_HASH_MISMATCH"
    );
    for (const invalid of ["{not json", { not: "an array" }, [{ ...script, hash_type: "nope" }], [{ ...script, args: "0x.*" }]]) {
      assert.throws(() => parseConfiguredUdtScripts(invalid), (error) => error.code === "INVALID_UDT_SCRIPTS");
    }
    assert.throws(
      () => loadUdtScriptsFromEnv({ FIBER_UDT_SCRIPTS_FILE: join(directory, "missing.json") }),
      (error) => error.code === "INVALID_UDT_SCRIPTS"
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Fiber RPC adapter reports which network its node is on", async () => {
  const mainnetGenesis = "0x92b197aa1fba0f63633922c61c92375c9c074a93e85963554f5499fe1450d0e5";
  const testnetGenesis = "0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606";
  const pubkey = "02" + "a".repeat(64);
  const identityFor = (nodeInfo, options = {}) =>
    new FiberRpcInvoiceAdapter({ ...options, client: { call: async () => ({ pubkey, ...nodeInfo }) } }).getNodeIdentity();

  const mainnet = await identityFor({ chain_hash: mainnetGenesis });
  const testnet = await identityFor({ chain_hash: testnetGenesis.toUpperCase().replace("0X", "0x") });
  const privateChain = await identityFor({ chain_hash: "0x" + "7".repeat(64) });
  const configured = await identityFor({ chain_hash: "0x" + "7".repeat(64) }, { network: "dev" });
  const noChainHash = await identityFor({});

  assert.deepEqual([mainnet.network, mainnet.network_source], ["mainnet", "chain_hash"]);
  assert.equal(testnet.network, "testnet");
  // An unrecognised chain is unknown, not assumed to be "dev".
  assert.equal(privateChain.network, undefined);
  assert.deepEqual([configured.network, configured.network_source], ["dev", "config"]);
  assert.equal(noChainHash.network, undefined);
  assert.throws(
    () => new FiberRpcInvoiceAdapter({ network: "signet", client: { call: async () => ({}) } }),
    (error) => error.code === "INVALID_FIBER_NETWORK"
  );
});

test("Fiber RPC adapter syncs invoice status with get_invoice", async () => {
  const calls = [];
  const adapter = new FiberRpcInvoiceAdapter({
    getInvoiceMethod: "get_invoice",
    client: {
      async call(method, params) {
        calls.push({ method, params });
        return {
          invoice_address: "fibt1000000001example",
          invoice: {
            amount: "0x5f5e100",
            currency: "Fibt"
          },
          status: "Received"
        };
      }
    }
  });

  const sync = await adapter.syncInvoice("0xabc123");

  assert.deepEqual(calls[0], {
    method: "get_invoice",
    params: [{ payment_hash: "0xabc123" }]
  });
  assert.equal(sync.status, "invoice_received");
  assert.equal(sync.fiber_status, "Received");
  assert.equal(sync.invoice, "fibt1000000001example");
  assert.equal(sync.amount, "0x5f5e100");
  assert.equal(sync.currency, "Fibt");
});
