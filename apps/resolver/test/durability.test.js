// What survives a crash, a failed write, a restart and a shutdown.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  createOfferRevocation,
  createSignedOffer,
  encodeOffer,
  generateOfferKeyPair
} from "../../../packages/protocol/src/index.js";
import { MockInvoiceAdapter } from "../src/invoice-adapter.js";
import { PostgresOfferStore } from "../src/postgres-store.js";
import { createServer, InMemoryOfferStore, JsonOfferStore } from "../src/server.js";

const serverEntry = fileURLToPath(new URL("../src/server.js", import.meta.url));
const connectionString = process.env.TEST_DATABASE_URL;

function signedOffer(overrides = {}) {
  const keys = generateOfferKeyPair();
  const offer = createSignedOffer(
    {
      node_id: `02${"d".repeat(64)}`,
      public_key: keys.publicKeyPem,
      resolver_url: "https://resolver.example",
      assets: [{ asset_type: "ckb", symbol: "CKB" }],
      ...overrides
    },
    keys.privateKeyPem
  );
  return { offer, keys };
}

async function withDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), "fiber-offers-durability-"));
  try {
    await run(directory);
  } finally {
    await chmod(directory, 0o700).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}

test("the store file is replaced whole, never caught half-written", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "offers.json");
    const store = new JsonOfferStore(path);
    const offers = Array.from({ length: 40 }, (_, index) => signedOffer({ description: `Offer ${index}` }).offer);

    // A reader hammering the file while it is rewritten 40 times.
    let reading = true;
    let reads = 0;
    const torn = [];
    const reader = (async () => {
      while (reading) {
        const text = await readFile(path, "utf8").catch((error) => (error.code === "ENOENT" ? undefined : Promise.reject(error)));
        if (text !== undefined) {
          reads += 1;
          try {
            JSON.parse(text);
          } catch {
            torn.push(text.length);
          }
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();
    await Promise.all(offers.map((offer) => store.upsertOffer(offer, encodeOffer(offer))));
    reading = false;
    await reader;

    assert.ok(reads > 0);
    assert.deepEqual(torn, [], "a reader saw a partly written file");
    assert.equal(Object.keys(JSON.parse(await readFile(path, "utf8")).offers).length, 40);
    // Nothing is left beside it, and only the resolver's user can read it.
    assert.deepEqual(await readdir(directory), ["offers.json"]);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  });
});

test("a write that fails leaves the previous file intact", { skip: process.getuid?.() === 0 ? "root ignores directory permissions" : false }, async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "offers.json");
    const store = new JsonOfferStore(path);
    const first = signedOffer({ description: "Stored before the failure" }).offer;
    const second = signedOffer({ description: "Could not be stored" }).offer;
    const third = signedOffer({ description: "Stored after it" }).offer;
    await store.upsertOffer(first, encodeOffer(first));
    const before = await readFile(path, "utf8");

    // No new file can be created here, as on a full or read-only disk.
    await chmod(directory, 0o500);
    await assert.rejects(store.upsertOffer(second, encodeOffer(second)), (error) => ["EACCES", "EPERM"].includes(error.code));
    assert.equal(await readFile(path, "utf8"), before);

    // Once the disk is usable again the store carries on, with everything it
    // was given.
    await chmod(directory, 0o700);
    await store.upsertOffer(third, encodeOffer(third));
    const reopened = new JsonOfferStore(path);
    assert.deepEqual(
      (await reopened.listOffers()).map((entry) => entry.offer.description).sort(),
      ["Could not be stored", "Stored after it", "Stored before the failure"]
    );
    assert.deepEqual(await readdir(directory), ["offers.json"]);
  });
});

test("a damaged store file stops the resolver instead of being overwritten", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "offers.json");
    const damaged = '{"offers": {"0xabc": {"offer": ';
    await writeFile(path, damaged);
    const store = new JsonOfferStore(path);
    const { offer } = signedOffer();

    await assert.rejects(store.listOffers(), { code: "STORE_FILE_CORRUPT" });
    await assert.rejects(store.upsertOffer(offer, encodeOffer(offer)), { code: "STORE_FILE_CORRUPT" });
    // Still there to be repaired or restored from.
    assert.equal(await readFile(path, "utf8"), damaged);
  });
});

test("a temporary file left by a crash is cleared on the next start", async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, "offers.json");
    const { offer } = signedOffer();
    await new JsonOfferStore(path).upsertOffer(offer, encodeOffer(offer));
    await writeFile(join(directory, "offers.json.4242.interrupted.tmp"), '{"offers": {');
    await writeFile(join(directory, "unrelated.tmp"), "kept");

    const restarted = new JsonOfferStore(path);
    assert.equal((await restarted.listOffers()).length, 1);
    assert.deepEqual((await readdir(directory)).sort(), ["offers.json", "unrelated.tmp"]);
  });
});

test("registering a revoked offer again keeps it revoked, with its proof", async () => {
  await withDirectory(async (directory) => {
    const stores = {
      memory: new InMemoryOfferStore(),
      json: new JsonOfferStore(join(directory, "offers.json")),
      ...(connectionString ? { postgresql: new PostgresOfferStore({ connectionString }) } : {})
    };
    try {
      for (const [name, store] of Object.entries(stores)) {
        const { offer, keys } = signedOffer({ description: `Revoked in ${name}` });
        const revocation = createOfferRevocation(offer, keys.privateKeyPem, { reason: "key rotated" });
        await store.upsertOffer(offer, encodeOffer(offer));
        const revoked = await store.revokeOffer(offer.offer_id, revocation);

        const again = await store.upsertOffer(offer, encodeOffer(offer));
        const stored = await store.getOffer(offer.offer_id);
        for (const entry of [again, stored]) {
          assert.equal(entry.disabled, true, name);
          assert.equal(entry.revoked_at, revoked.revoked_at, name);
          assert.deepEqual(entry.revocation, revocation, name);
        }
        if (name === "postgresql") await store.pool.query("DELETE FROM fiber_offers WHERE offer_id=$1", [offer.offer_id]);
      }
      // And across a restart of the file store.
      const reopened = new JsonOfferStore(join(directory, "offers.json"));
      const [entry] = await reopened.listOffers();
      assert.equal(entry.disabled, true);
      assert.equal(entry.revocation.reason, "key rotated");
    } finally {
      await stores.postgresql?.close();
    }
  });
});

test("shutdown answers requests in progress, then closes the store once", async () => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const invoiceAdapter = new MockInvoiceAdapter();
  const createInvoice = invoiceAdapter.createInvoice.bind(invoiceAdapter);
  invoiceAdapter.createInvoice = async (input) => {
    await held;
    return createInvoice(input);
  };
  const store = new InMemoryOfferStore();
  let closes = 0;
  store.close = async () => {
    closes += 1;
  };

  const server = createServer({ store, invoiceAdapter, demoMode: true, topologyClient: false, workers: false, logger: { error() {}, info() {} } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body) =>
    fetch(`${baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const offer = await post("/demo/offers", { amount: "1000" }).then((response) => response.json());
  const inProgress = post(`/offers/${offer.offer_id}/invoice`, { amount: "1000", asset: { asset_type: "ckb", symbol: "CKB" } });
  await new Promise((resolve) => setTimeout(resolve, 50));

  let finished = false;
  const stopping = server.shutdown({ timeoutMs: 5000 }).then(() => {
    finished = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  // Still waiting on the request; nobody new gets in.
  assert.equal(finished, false);
  assert.equal(closes, 0);
  await assert.rejects(fetch(`${baseUrl}/health`));

  release();
  const response = await inProgress;
  assert.equal(response.status, 201);
  assert.match((await response.json()).resolution_id, /^res_/);
  await stopping;
  assert.equal(closes, 1);
  // Closing again, by either route, does not close the store twice.
  await server.shutdown();
  assert.equal(closes, 1);
});

test("shutdown gives up on a request that never finishes", async () => {
  const invoiceAdapter = new MockInvoiceAdapter();
  invoiceAdapter.createInvoice = () => new Promise(() => {});
  const server = createServer({
    store: new InMemoryOfferStore(),
    invoiceAdapter,
    demoMode: true,
    topologyClient: false,
    workers: false,
    logger: { error() {}, info() {} }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const offer = await fetch(`${baseUrl}/demo/offers`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ amount: "1000" })
  }).then((response) => response.json());
  const stuck = fetch(`${baseUrl}/offers/${offer.offer_id}/invoice`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ amount: "1000", asset: { asset_type: "ckb", symbol: "CKB" } })
  });
  stuck.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 50));

  const startedAt = Date.now();
  await server.shutdown({ timeoutMs: 200 });
  assert.ok(Date.now() - startedAt < 2000);
  await assert.rejects(stuck);
});

test("shutdown waits for a background pass before closing the store", async () => {
  const events = [];
  const store = new InMemoryOfferStore();
  const claimOpenResolutions = store.claimOpenResolutions.bind(store);
  store.claimOpenResolutions = async (...args) => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    events.push("pass finished");
    return claimOpenResolutions(...args);
  };
  store.close = async () => {
    events.push("store closed");
  };
  const invoiceAdapter = { mode: "fiber-rpc", async syncInvoice() {}, async probe() { return { mode: "fiber-rpc", reachable: true }; } };
  const server = createServer({ store, invoiceAdapter, topologyClient: false, workers: false, enforceNodeOwnership: false, logger: { error() {}, info() {} } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const pass = server.backgroundWorkers.runSettlementSyncPass();
  await server.shutdown();
  await pass;
  assert.deepEqual(events, ["pass finished", "store closed"]);
});

test("SIGTERM stops a running resolver cleanly, with its data on disk", async () => {
  await withDirectory(async (directory) => {
    const dataPath = join(directory, "offers.json");
    const port = await freePort();
    const child = spawn(process.execPath, [serverEntry], {
      env: {
        PATH: process.env.PATH,
        PORT: String(port),
        FIBER_INVOICE_MODE: "mock",
        RESOLVER_DEMO_MODE: "true",
        RESOLVER_DATA_PATH: dataPath,
        RESOLVER_WORKERS_ENABLED: "false"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));

    try {
      const baseUrl = `http://127.0.0.1:${port}`;
      await waitFor(() => fetch(`${baseUrl}/health`).then((response) => response.ok, () => false), `the resolver to start:\n${output}`);
      const created = await fetch(`${baseUrl}/demo/offers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amount: "1000", description: "Written before SIGTERM" })
      }).then((response) => response.json());

      child.kill("SIGTERM");
      let timer;
      const result = await Promise.race([
        exited,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve("still running after 8 seconds"), 8000);
        })
      ]);
      clearTimeout(timer);

      assert.deepEqual(result, { code: 0, signal: null }, output);
      assert.match(output, /SIGTERM received/);
      const stored = JSON.parse(await readFile(dataPath, "utf8"));
      assert.equal(stored.offers[created.offer_id].offer.description, "Written before SIGTERM");
      assert.deepEqual(await readdir(directory), ["offers.json"]);
    } finally {
      child.kill("SIGKILL");
    }
  });
});

async function freePort() {
  const probe = createNetServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function waitFor(condition, what, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`timed out waiting for ${what}`);
}
