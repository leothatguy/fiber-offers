// A PostgreSQL store in a schema of its own, for tests that run queries across
// every offer (the background passes). In the shared test schema such a query
// would pick up, and act on, rows that belong to other test files.
import { randomBytes } from "node:crypto";
import pg from "pg";
import { runMigrations } from "../../src/migrate.js";
import { PostgresOfferStore } from "../../src/postgres-store.js";

export async function isolatedPostgresStore(connectionString, options = {}) {
  const schema = `test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Pool({ connectionString, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  // Every connection of this pool sees only the new schema.
  const pool = new pg.Pool({ connectionString, max: options.maxConnections ?? 10, options: `-c search_path=${schema}` });
  await runMigrations({ pool });
  const store = new PostgresOfferStore({ pool, encryptionKey: options.encryptionKey });
  return {
    store,
    pool,
    schema,
    // A second store on the same schema, as another replica or worker would be.
    another: () => new PostgresOfferStore({ pool, encryptionKey: options.encryptionKey }),
    async close() {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  };
}
