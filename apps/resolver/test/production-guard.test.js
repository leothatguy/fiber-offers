import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { assertProductionConfiguration, productionConfigurationProblems } from "../src/production-guard.js";

const execFileAsync = promisify(execFile);
const serverEntry = fileURLToPath(new URL("../src/server.js", import.meta.url));

const safe = {
  NODE_ENV: "production",
  RESOLVER_API_KEY: "k".repeat(32),
  RESOLVER_SECRET_ENCRYPTION_KEY: "e".repeat(48),
  RESOLVER_PUBLIC_URL: "https://offers.merchant.example",
  DATABASE_URL: "postgresql://fiber_offers:a-long-generated-password@postgres:5432/fiber_offers"
};
const settingsWithProblems = (env) => productionConfigurationProblems(env).map((problem) => problem.setting);

test("production configuration is accepted when every secret is real", () => {
  assert.deepEqual(productionConfigurationProblems(safe), []);
  assert.doesNotThrow(() => assertProductionConfiguration(safe));
  // Outside production nothing is enforced, however bare the environment.
  assert.deepEqual(productionConfigurationProblems({ NODE_ENV: "development" }), []);
  assert.deepEqual(productionConfigurationProblems({}), []);
});

test("production refuses missing, short and published-example secrets", () => {
  assert.deepEqual(settingsWithProblems({ NODE_ENV: "production" }), [
    "RESOLVER_API_KEY",
    "RESOLVER_SECRET_ENCRYPTION_KEY",
    "RESOLVER_PUBLIC_URL",
    "DATABASE_URL"
  ]);
  // The values the bundled Compose file falls back to.
  assert.deepEqual(
    settingsWithProblems({
      ...safe,
      RESOLVER_API_KEY: "local-dev-api-key",
      RESOLVER_SECRET_ENCRYPTION_KEY: "local-dev-encryption-key-change-me",
      DATABASE_URL: "postgresql://fiber_offers:fiber_offers_dev@postgres:5432/fiber_offers"
    }),
    ["RESOLVER_API_KEY", "RESOLVER_SECRET_ENCRYPTION_KEY", "DATABASE_URL"]
  );
  assert.deepEqual(settingsWithProblems({ ...safe, RESOLVER_API_KEY: "short" }), ["RESOLVER_API_KEY"]);
  assert.deepEqual(settingsWithProblems({ ...safe, RESOLVER_SECRET_ENCRYPTION_KEY: "x".repeat(16) }), [
    "RESOLVER_SECRET_ENCRYPTION_KEY"
  ]);
  assert.deepEqual(settingsWithProblems({ ...safe, RESOLVER_PUBLIC_URL: "http://offers.merchant.example" }), [
    "RESOLVER_PUBLIC_URL"
  ]);
  assert.deepEqual(settingsWithProblems({ ...safe, RESOLVER_PUBLIC_URL: "http://localhost:8787" }), []);
});

test("production needs a database unless the JSON store is explicitly accepted", () => {
  const withoutDatabase = { ...safe, DATABASE_URL: undefined };
  assert.deepEqual(settingsWithProblems(withoutDatabase), ["DATABASE_URL"]);
  assert.deepEqual(settingsWithProblems({ ...withoutDatabase, RESOLVER_ALLOW_JSON_STORE: "true" }), []);
});

test("the error names every problem and how to fix it", () => {
  assert.throws(
    () => assertProductionConfiguration({ NODE_ENV: "production" }),
    (error) =>
      error.code === "INSECURE_PRODUCTION_CONFIGURATION" &&
      error.problems.length === 4 &&
      /RESOLVER_API_KEY is not set/.test(error.message) &&
      /fiber-offers init/.test(error.message)
  );
});

test("the resolver process exits instead of starting with unsafe production settings", async () => {
  const run = execFileAsync(process.execPath, [serverEntry], {
    env: { PATH: process.env.PATH, NODE_ENV: "production", FIBER_INVOICE_MODE: "mock", PORT: "0" },
    timeout: 20000
  });
  await assert.rejects(run, (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /Refusing to start: unsafe production configuration/);
    assert.match(error.stderr, /RESOLVER_SECRET_ENCRYPTION_KEY is not set/);
    return true;
  });
});
