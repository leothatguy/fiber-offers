// The stores a store-level test runs against: the in-memory one always, and
// PostgreSQL, in a schema of its own, when TEST_DATABASE_URL is set.
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createSignedOffer, encodeOffer, generateOfferKeyPair } from "../../../../packages/protocol/src/index.js";
import { InMemoryOfferStore } from "../../src/store.js";
import { isolatedPostgresStore } from "./isolated-postgres.js";

export const connectionString = process.env.TEST_DATABASE_URL;
export const postgresSkip = connectionString ? false : "TEST_DATABASE_URL is not set";
export const ckb = { asset_type: "ckb", symbol: "CKB" };

export const storeBackends = [
  {
    name: "memory",
    async open() {
      const store = new InMemoryOfferStore();
      return {
        store,
        another: () => store,
        async expireReservation(offerId, resolutionId) {
          store.state.resolutions[offerId].find((record) => record.id === resolutionId).reservation_expires_at =
            new Date(Date.now() - 1000).toISOString();
        },
        async close() {}
      };
    }
  },
  {
    name: "postgresql",
    skip: postgresSkip,
    async open() {
      const database = await isolatedPostgresStore(connectionString);
      return {
        ...database,
        async expireReservation(_offerId, resolutionId) {
          await database.pool.query(
            "UPDATE fiber_resolutions SET reservation_expires_at = now() - interval '1 second' WHERE resolution_id = $1",
            [resolutionId]
          );
        }
      };
    }
  }
];

// Declares `name` once per backend. `run` gets { store, another, ... } and
// the store is closed afterwards.
export function eachBackend(name, run) {
  for (const backend of storeBackends) {
    test(`${backend.name}: ${name}`, { skip: backend.skip }, async () => {
      const harness = await backend.open();
      try {
        await run(harness);
      } finally {
        await harness.close();
      }
    });
  }
}

// The stores order by creation time, which the in-memory one keeps to the
// millisecond. Where a test depends on the order, creations are spaced apart.
export const tick = () => new Promise((resolve) => setTimeout(resolve, 2));

export async function registerOffer(store, terms = {}) {
  await tick();
  const keys = generateOfferKeyPair();
  const offer = createSignedOffer(
    {
      node_id: `02${randomUUID().replaceAll("-", "").padEnd(64, "0")}`,
      public_key: keys.publicKeyPem,
      resolver_url: "https://resolver.example",
      assets: [ckb],
      amount_min: "1000",
      amount_max: "5000",
      ...terms
    },
    keys.privateKeyPem
  );
  await store.upsertOffer(offer, encodeOffer(offer));
  return offer;
}

// An issued invoice, as the resolver stores one.
export async function invoice(store, offer, label, extra = {}) {
  await tick();
  return store.addResolution(offer.offer_id, {
    amount: "1000",
    asset: ckb,
    invoice: { invoice: `fibt_${label}`, payment_hash: `0x${Buffer.from(label).toString("hex").padEnd(64, "0")}`, mode: "fiber-rpc" },
    ...extra
  });
}
