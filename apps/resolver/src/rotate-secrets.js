#!/usr/bin/env node
// Re-encrypts every stored secret under the current RESOLVER_SECRET_ENCRYPTION_KEY.
//
//   npm run secrets:rotate
//
// To change the key:
//   1. Set RESOLVER_SECRET_ENCRYPTION_KEY to the new key and
//      RESOLVER_SECRET_ENCRYPTION_KEY_PREVIOUS to the old one on every API and
//      worker replica, and restart them. They now read secrets under either
//      key and write under the new one.
//   2. Run this command with the same two variables (and DATABASE_URL, if the
//      resolver uses PostgreSQL).
//   3. Remove RESOLVER_SECRET_ENCRYPTION_KEY_PREVIOUS and restart.
//
// Run without a previous key, it rewrites secrets stored in an older format
// (or as plaintext, from before a key was configured) in the current one.
// It can be run again safely. On failure nothing is changed in PostgreSQL.
import { createStoreFromEnv } from "./server.js";

if (!process.env.RESOLVER_SECRET_ENCRYPTION_KEY) {
  console.error("RESOLVER_SECRET_ENCRYPTION_KEY must be set to the key the secrets should be encrypted with.");
  process.exit(1);
}

const store = createStoreFromEnv(process.env);
try {
  const result = await store.reencryptSecrets();
  console.log(
    JSON.stringify(
      {
        ok: true,
        ...result,
        previous_key_configured: Boolean(process.env.RESOLVER_SECRET_ENCRYPTION_KEY_PREVIOUS),
        next: process.env.RESOLVER_SECRET_ENCRYPTION_KEY_PREVIOUS
          ? "Remove RESOLVER_SECRET_ENCRYPTION_KEY_PREVIOUS from every replica and restart."
          : "Nothing further."
      },
      null,
      2
    )
  );
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: { code: error.code, message: error.message } }, null, 2));
  process.exitCode = 1;
} finally {
  await store.close?.();
}
