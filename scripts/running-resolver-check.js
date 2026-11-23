// Checks a resolver that is already running, from the outside, the way a
// merchant and a wallet use it: over HTTP, through the SDK, with an offer
// signed here. It is how CI proves the Docker image and the Compose stack
// work, and it can be pointed at any deployment that issues mock invoices.
//
//   node scripts/running-resolver-check.js --url http://127.0.0.1:8787 [--api-key KEY]
//
// The resolver must run with FIBER_INVOICE_MODE=mock: the offer made here names
// a node that does not exist, which a resolver with a real node refuses.
// Prints one line of JSON describing what was checked. Exits 1 on a failure.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import {
  createOfferRevocation,
  createSignedOffer,
  generateOfferKeyPair,
  verifyOffer
} from "../packages/protocol/src/index.js";
import { FiberOffersClient } from "../packages/sdk/src/index.js";

const { values: flags } = parseArgs({
  options: {
    url: { type: "string" },
    "api-key": { type: "string" },
    "wait-seconds": { type: "string", default: "60" }
  }
});
if (!flags.url) {
  console.error("usage: running-resolver-check.js --url URL [--api-key KEY] [--wait-seconds N]");
  process.exit(2);
}

const resolverUrl = flags.url.replace(/\/+$/, "");
const apiKey = flags["api-key"] ?? process.env.RESOLVER_API_KEY;
const merchant = new FiberOffersClient({ resolverUrl, apiKey });
const wallet = new FiberOffersClient({ resolverUrl });
const ckb = { asset_type: "ckb", symbol: "CKB" };

try {
  const health = await waitUntilHealthy(Number(flags["wait-seconds"]));
  assert.equal(health.invoice_mode, "mock", "this check needs a resolver that issues mock invoices (FIBER_INVOICE_MODE=mock)");
  // Only an operator is told whether a key is required; others get no answer.
  if (apiKey) assert.equal(health.auth_required, true, "the resolver has no API key configured, or --api-key is not its key");
  else assert.equal(health.auth_required, false, "the resolver requires an API key: pass --api-key");

  // The merchant signs an offer with a key the resolver never sees.
  const keys = generateOfferKeyPair();
  const offer = createSignedOffer(
    {
      node_id: `02${randomBytes(32).toString("hex")}`,
      public_key: keys.publicKeyPem,
      resolver_url: resolverUrl,
      description: "Running resolver check",
      network: "testnet",
      assets: [ckb],
      amount_min: "1000",
      amount_max: "5000"
    },
    keys.privateKeyPem
  );
  const username = `check-${randomBytes(4).toString("hex")}`;

  if (apiKey) {
    // With a key configured, a caller without it cannot register or list.
    await refused(() => wallet.registerOffer(offer), 401, "registering an offer without the key");
    await refused(() => wallet.listOffers(), 401, "listing offers without the key");
  }
  const registered = await merchant.registerOffer(offer, { username });
  assert.equal(registered.offer.offer_id, offer.offer_id);
  const listed = await merchant.listOffers();
  assert.ok(listed.offers.some((item) => item.offer_id === offer.offer_id), "the registered offer is not in the list");

  // The wallet finds it by address and by ID, and checks it itself.
  const host = new URL(resolverUrl).host;
  const byAddress = await wallet.resolveFiberAddress(`${username}@${host}`);
  assert.equal(byAddress.offer.offer_id, offer.offer_id);
  const fetched = await wallet.getOffer(offer.offer_id);
  assert.deepEqual(fetched.offer, offer);
  assert.equal(verifyOffer(fetched.offer).ok, true);

  // Each request gets its own invoice. A retry with the same key gets the same one.
  const first = await wallet.requestInvoice(offer.offer_id, { amount: "1200", asset: ckb }, { idempotencyKey: "check-retry-1" });
  const retried = await wallet.requestInvoice(offer.offer_id, { amount: "1200", asset: ckb }, { idempotencyKey: "check-retry-1" });
  const second = await wallet.requestInvoice(offer.offer_id, { amount: "1200", asset: ckb });
  assert.equal(retried.invoice, first.invoice, "a retry with the same idempotency key got another invoice");
  assert.equal(retried.resolution_id, first.resolution_id);
  assert.notEqual(second.invoice, first.invoice, "two requests got the same invoice");
  assert.notEqual(second.payment_hash, first.payment_hash);
  await refused(() => wallet.requestInvoice(offer.offer_id, { amount: "9000", asset: ckb }), 422, "an amount above amount_max");

  const resolution = await wallet.getResolution(offer.offer_id, first.resolution_id);
  assert.equal(resolution.invoice.payment_hash, first.payment_hash);

  // The offer key alone revokes it, and no invoice is issued afterwards.
  const revoked = await wallet.revokeOffer(offer.offer_id, createOfferRevocation(offer, keys.privateKeyPem, { reason: "check finished" }));
  assert.equal(revoked.revoked, true);
  await refused(() => wallet.requestInvoice(offer.offer_id, { amount: "1200", asset: ckb }), 410, "an invoice for a revoked offer");

  console.log(
    JSON.stringify({
      ok: true,
      resolver: resolverUrl,
      store: health.dependencies?.store?.backend,
      rate_limiter: health.dependencies?.rate_limiter?.backend,
      offer_id: offer.offer_id,
      fiber_address: `${username}@${host}`,
      resolution_id: first.resolution_id,
      invoices: 2,
      api_key_enforced: Boolean(apiKey)
    })
  );
} catch (error) {
  console.error(`running resolver check failed: ${error.stack ?? error}`);
  if (error.status) console.error(`  HTTP ${error.status} ${error.code ?? ""}`);
  process.exit(1);
}

// A container takes a moment to accept connections after it starts.
async function waitUntilHealthy(seconds) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    try {
      const response = await fetch(`${resolverUrl}/health`, {
        headers: apiKey ? { "x-api-key": apiKey } : {},
        signal: AbortSignal.timeout(3000)
      });
      if (response.ok) return await response.json();
      throw new Error(`/health answered ${response.status}`);
    } catch (error) {
      if (Date.now() >= deadline) throw new Error(`the resolver at ${resolverUrl} was not healthy within ${seconds}s: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

async function refused(call, status, what) {
  try {
    await call();
  } catch (error) {
    assert.equal(error.status, status, `${what}: expected HTTP ${status}, got ${error.status ?? error.message}`);
    return;
  }
  assert.fail(`${what} was accepted`);
}
