// Refuses to start a production resolver with configuration that is known to
// be unsafe. A resolver that silently runs with a published default API key, no
// encryption key, or a throwaway JSON file as its database looks healthy until
// someone finds it, so these are startup errors rather than warnings.
//
// Applies only when NODE_ENV=production. Development and test runs are not
// affected.

// Values that ship in this repository's examples and Compose defaults.
const KNOWN_DEFAULT_API_KEYS = new Set(["local-dev-api-key", "change-me"]);
const KNOWN_DEFAULT_ENCRYPTION_KEYS = new Set([
  "local-dev-encryption-key-change-me",
  "replace-with-a-long-random-secret"
]);
const KNOWN_DEFAULT_DATABASE_PASSWORDS = new Set(["fiber_offers_dev", "change-me", "secret"]);

const MIN_API_KEY_LENGTH = 24;
const MIN_ENCRYPTION_KEY_LENGTH = 32;

// Returns a list of { setting, problem } for an unsafe production environment,
// empty when it is acceptable or when not in production.
export function productionConfigurationProblems(env = process.env) {
  if (String(env.NODE_ENV ?? "").trim().toLowerCase() !== "production") return [];
  const problems = [];
  const add = (setting, problem) => problems.push({ setting, problem });

  const apiKey = env.RESOLVER_API_KEY ?? "";
  if (apiKey === "") {
    add("RESOLVER_API_KEY", "is not set, so every operator endpoint would be open to anyone");
  } else if (KNOWN_DEFAULT_API_KEYS.has(apiKey)) {
    add("RESOLVER_API_KEY", "is a published example value");
  } else if (apiKey.length < MIN_API_KEY_LENGTH) {
    add("RESOLVER_API_KEY", `is shorter than ${MIN_API_KEY_LENGTH} characters`);
  }

  const encryptionKey = env.RESOLVER_SECRET_ENCRYPTION_KEY ?? "";
  if (encryptionKey === "") {
    add("RESOLVER_SECRET_ENCRYPTION_KEY", "is not set, so webhook signing secrets would be stored in plaintext");
  } else if (KNOWN_DEFAULT_ENCRYPTION_KEYS.has(encryptionKey)) {
    add("RESOLVER_SECRET_ENCRYPTION_KEY", "is a published example value");
  } else if (encryptionKey.length < MIN_ENCRYPTION_KEY_LENGTH) {
    add("RESOLVER_SECRET_ENCRYPTION_KEY", `is shorter than ${MIN_ENCRYPTION_KEY_LENGTH} characters`);
  }

  const publicUrl = env.RESOLVER_PUBLIC_URL ?? "";
  if (publicUrl === "") {
    add("RESOLVER_PUBLIC_URL", "is not set, so links in responses would follow request headers");
  } else {
    try {
      const parsed = new URL(publicUrl);
      const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
      if (parsed.protocol !== "https:" && !local) add("RESOLVER_PUBLIC_URL", "must use https");
    } catch {
      add("RESOLVER_PUBLIC_URL", "is not a valid URL");
    }
  }

  const databaseUrl = env.DATABASE_URL ?? "";
  if (databaseUrl === "") {
    if (!isTrue(env.RESOLVER_ALLOW_JSON_STORE)) {
      add(
        "DATABASE_URL",
        "is not set, so data would live in a single local JSON file (set RESOLVER_ALLOW_JSON_STORE=true to accept that for a single-process deployment)"
      );
    }
  } else {
    let password;
    try {
      password = decodeURIComponent(new URL(databaseUrl).password);
    } catch {
      password = undefined;
    }
    if (password !== undefined && KNOWN_DEFAULT_DATABASE_PASSWORDS.has(password)) {
      add("DATABASE_URL", "uses a published example database password");
    }
  }

  return problems;
}

export function assertProductionConfiguration(env = process.env) {
  const problems = productionConfigurationProblems(env);
  if (problems.length === 0) return;
  const error = new Error(
    [
      "Refusing to start: unsafe production configuration.",
      ...problems.map(({ setting, problem }) => `  - ${setting} ${problem}.`),
      "Fix these settings (fiber-offers init generates strong values), or run with NODE_ENV=development for local use."
    ].join("\n")
  );
  error.code = "INSECURE_PRODUCTION_CONFIGURATION";
  error.problems = problems;
  throw error;
}

function isTrue(value) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}
