// scripts/running-resolver-check.js is what CI points at the Docker image and
// the Compose stack. This runs it against a resolver in this process, so that a
// change which breaks the script shows up here and not first in the image job.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { MockInvoiceAdapter } from "../src/invoice-adapter.js";
import { createServer, InMemoryOfferStore } from "../src/server.js";

const script = fileURLToPath(new URL("../../../scripts/running-resolver-check.js", import.meta.url));
const API_KEY = "running-resolver-check-key";

async function withResolver(options, run) {
  const server = createServer({ store: new InMemoryOfferStore(), invoiceAdapter: new MockInvoiceAdapter(), ...options });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// The script's result: its exit code and the JSON line or the error it printed.
async function check(url, { apiKey } = {}) {
  const args = [script, "--url", url, "--wait-seconds", "2", ...(apiKey ? ["--api-key", apiKey] : [])];
  // The key comes from the flag alone, whatever the environment of this run.
  const env = { ...process.env, RESOLVER_API_KEY: "" };
  try {
    const { stdout } = await promisify(execFile)(process.execPath, args, { env });
    return { code: 0, result: JSON.parse(stdout) };
  } catch (error) {
    return { code: error.code, stderr: error.stderr };
  }
}

test("the running-resolver check passes against a resolver without a key", async () => {
  await withResolver({}, async (url) => {
    const { code, result, stderr } = await check(url);
    assert.equal(code, 0, stderr);
    assert.equal(result.ok, true);
    assert.equal(result.store, "memory");
    assert.equal(result.api_key_enforced, false);
    assert.match(result.offer_id, /^0x[0-9a-f]{64}$/);

    // It leaves the offer it made revoked.
    const offer = await (await fetch(`${url}/offers/${result.offer_id}`)).json();
    assert.equal(offer.disabled, true);
  });
});

test("the running-resolver check passes with the key and confirms the key is enforced", async () => {
  await withResolver({ apiKey: API_KEY }, async (url) => {
    const { code, result, stderr } = await check(url, { apiKey: API_KEY });
    assert.equal(code, 0, stderr);
    assert.equal(result.api_key_enforced, true);
  });
});

test("the running-resolver check fails, and says why, when it cannot do its work", async () => {
  await withResolver({ apiKey: API_KEY }, async (url) => {
    const withoutKey = await check(url);
    assert.equal(withoutKey.code, 1);
    assert.match(withoutKey.stderr, /requires an API key/);

    const wrongKey = await check(url, { apiKey: "not-the-key" });
    assert.equal(wrongKey.code, 1);
    assert.match(wrongKey.stderr, /not its key/);
  });

  const nothingThere = await check("http://127.0.0.1:9", {});
  assert.equal(nothingThere.code, 1);
  assert.match(nothingThere.stderr, /was not healthy within 2s/);
});
