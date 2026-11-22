// Maps an offer's `type_script_hash` to the full CKB type script a Fiber node
// needs in `new_invoice.udt_type_script`. An offer carries only the hash, so the
// resolver has to know the script, and it verifies every script it is given by
// recomputing the hash: a mistyped entry can never mint invoices for a
// different token than the one an offer signed.
import { readFileSync } from "node:fs";
import { ckbScriptHash, normalizeCkbScript } from "../../../packages/protocol/src/index.js";

// Reads operator configuration: a JSON array (or a JSON string of one) of
//   { "name": "USDI", "code_hash": "0x…", "hash_type": "type", "args": "0x…" }
// The script may also be nested under "script", as Fiber's own UDT whitelist
// does. An optional "type_script_hash" is checked against the computed hash.
// Throws on any invalid entry so a bad configuration stops the resolver at
// startup instead of failing a payment later.
export function parseConfiguredUdtScripts(value, source = "config") {
  const registry = new Map();
  if (value === undefined || value === null || value === "") return registry;

  let entries = value;
  if (typeof value === "string") {
    try {
      entries = JSON.parse(value);
    } catch (error) {
      throw configError("INVALID_UDT_SCRIPTS", `UDT script configuration is not valid JSON: ${error.message}`);
    }
  }
  if (!Array.isArray(entries)) {
    throw configError("INVALID_UDT_SCRIPTS", "UDT script configuration must be a JSON array of scripts");
  }

  entries.forEach((entry, index) => {
    const label = entry?.name ? `"${entry.name}"` : `#${index + 1}`;
    let script;
    let hash;
    try {
      script = normalizeCkbScript(entry?.script ?? entry);
      hash = ckbScriptHash(script);
    } catch (error) {
      throw configError("INVALID_UDT_SCRIPTS", `UDT script ${label} is invalid: ${error.message}`);
    }
    const declared = entry.type_script_hash;
    if (declared !== undefined && String(declared).toLowerCase() !== hash) {
      throw configError(
        "UDT_SCRIPT_HASH_MISMATCH",
        `UDT script ${label} declares type_script_hash ${declared} but its script hashes to ${hash}`
      );
    }
    registry.set(hash, registryEntry(script, hash, entry.name, source));
  });

  return registry;
}

export function loadUdtScriptsFromEnv(env = process.env) {
  const registry = parseConfiguredUdtScripts(env.FIBER_UDT_SCRIPTS, "FIBER_UDT_SCRIPTS");
  if (env.FIBER_UDT_SCRIPTS_FILE) {
    let contents;
    try {
      contents = readFileSync(env.FIBER_UDT_SCRIPTS_FILE, "utf8");
    } catch (error) {
      throw configError("INVALID_UDT_SCRIPTS", `FIBER_UDT_SCRIPTS_FILE could not be read: ${error.message}`);
    }
    for (const [hash, entry] of parseConfiguredUdtScripts(contents, "FIBER_UDT_SCRIPTS_FILE")) {
      registry.set(hash, entry);
    }
  }
  return registry;
}

// Scripts the node itself accepts (`node_info.udt_cfg_infos`). The node's
// whitelist may describe `args` as a pattern covering many tokens; only entries
// that spell out one exact script can be hashed, so only those are used.
export function udtScriptsFromNodeInfo(nodeInfo) {
  const registry = new Map();
  const infos = nodeInfo?.udt_cfg_infos;
  const entries = Array.isArray(infos) ? infos : Array.isArray(infos?.udt_cfg_infos) ? infos.udt_cfg_infos : [];

  for (const entry of entries) {
    try {
      const script = normalizeCkbScript(entry?.script);
      const hash = ckbScriptHash(script);
      registry.set(hash, registryEntry(script, hash, entry.name, "node_info"));
    } catch {
      // A pattern or malformed entry: not a single script, so not usable here.
    }
  }

  return registry;
}

export function publicRegistryEntries(registry) {
  return [...registry.values()].map(({ type_script_hash, name, source }) => ({ type_script_hash, name, source }));
}

function registryEntry(script, hash, name, source) {
  return {
    type_script_hash: hash,
    script,
    ...(typeof name === "string" && name.length > 0 ? { name } : {}),
    source
  };
}

function configError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
