import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";

const currentDir = dirname(fileURLToPath(import.meta.url));
const defaultMigrationsDir = resolve(currentDir, "../migrations");

export async function runMigrations(options = {}) {
  const pool = options.pool ?? new pg.Pool({ connectionString: options.connectionString ?? process.env.DATABASE_URL });
  const ownsPool = !options.pool;
  const migrationsDir = options.migrationsDir ?? defaultMigrationsDir;
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('fiber-offers-migrations'))");
    await client.query(`
      CREATE TABLE IF NOT EXISTS fiber_schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const appliedRows = await client.query("SELECT name FROM fiber_schema_migrations");
    const applied = new Set(appliedRows.rows.map((row) => row.name));
    const files = (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort();
    const executed = [];
    for (const name of files) {
      if (applied.has(name)) continue;
      const sql = await readFile(join(migrationsDir, name), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO fiber_schema_migrations (name) VALUES ($1)", [name]);
        await client.query("COMMIT");
        executed.push(name);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    return { applied: executed, current: files };
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('fiber-offers-migrations'))").catch(() => {});
    client.release();
    if (ownsPool) await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const result = await runMigrations();
  console.log(JSON.stringify(result, null, 2));
}
