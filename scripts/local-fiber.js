#!/usr/bin/env node
// Runs real Fiber nodes (fnn) on this machine for development and live tests,
// without Docker. It downloads an official release, checks its SHA-256, and
// manages a merchant node and a payer node on the CKB testnet.
//
//   node scripts/local-fiber.js install [--version v0.10.1]
//   node scripts/local-fiber.js init    [--version v0.10.1]
//   node scripts/local-fiber.js add NAME --rpc-port N --p2p-port N [--version V]
//   node scripts/local-fiber.js start   [NAME...]
//   node scripts/local-fiber.js stop    [NAME...]
//   node scripts/local-fiber.js status
//
// Everything lives under .fiber-offers/local-fiber (override with
// FIBER_LOCAL_HOME), which git ignores. The nodes are test nodes: their keys
// and key passwords are generated here and stored unencrypted beside them.
// Never fund them with mainnet assets.
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const home = resolve(process.env.FIBER_LOCAL_HOME ?? join(repoRoot, ".fiber-offers/local-fiber"));

// Official x86_64 Linux builds, pinned by the SHA-256 GitHub publishes for each
// asset. A download that does not match is discarded.
const DEFAULT_VERSION = "v0.10.1";
const RELEASES = {
  "v0.10.1": "a60206ba5f7056ba939cb889c9468f9892f9279c4e735ff3cdd555a692586bd7",
  "v0.9.1": "6425bc90ce971a5b8f10bd93667227cc932ee2e50a70f584e2c07590ce446d0d"
};
const DEFAULT_NODES = [
  { name: "merchant", rpcPort: 8227, p2pPort: 8228 },
  { name: "payer", rpcPort: 8229, p2pPort: 8230 }
];

const { values: flags, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    version: { type: "string" },
    "rpc-port": { type: "string" },
    "p2p-port": { type: "string" },
    help: { type: "boolean", short: "h", default: false }
  }
});
const [command, ...names] = positionals;

try {
  if (!command || flags.help) usage();
  else if (command === "install") await install(flags.version ?? DEFAULT_VERSION);
  else if (command === "init") await init(flags.version ?? DEFAULT_VERSION);
  else if (command === "add") await add(names[0], flags);
  else if (command === "start") await start(names);
  else if (command === "stop") await stop(names);
  else if (command === "status") await status();
  else throw new Error(`unknown command: ${command}`);
} catch (error) {
  console.error(`local-fiber: ${error.message}`);
  process.exitCode = 1;
}

function usage() {
  console.log(
    [
      "Usage: node scripts/local-fiber.js <command>",
      "  install [--version V]   download and verify a Fiber release",
      "  init    [--version V]   install, then create the merchant and payer nodes",
      "  add NAME --rpc-port N --p2p-port N [--version V]   create another node",
      "  start   [NAME...]       start nodes (all when none are named)",
      "  stop    [NAME...]       stop nodes",
      "  status                  show each node's identity, peers and funding address",
      `Releases: ${Object.keys(RELEASES).join(", ")} (default ${DEFAULT_VERSION}). Home: ${home}`
    ].join("\n")
  );
}

async function install(version) {
  const expected = RELEASES[version];
  if (!expected) throw new Error(`no pinned checksum for ${version}; known: ${Object.keys(RELEASES).join(", ")}`);
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("only x86_64 Linux builds are pinned here; install fnn yourself and point FIBER_RPC_URL at it");
  }
  const directory = releaseDirectory(version);
  if (existsSync(join(directory, "fnn"))) return directory;

  const asset = `fnn_${version}-x86_64-linux-portable.tar.gz`;
  const url = `https://github.com/nervosnetwork/fiber/releases/download/${version}/${asset}`;
  console.log(`Downloading ${url}`);
  await mkdir(directory, { recursive: true });
  const archivePath = join(directory, asset);
  await download(url, archivePath);
  const actual = createHash("sha256").update(await readFile(archivePath)).digest("hex");
  if (actual !== expected) {
    await rm(archivePath, { force: true });
    throw new Error(`checksum mismatch for ${asset}: expected ${expected}, got ${actual}`);
  }

  await execFileAsync("tar", ["-xzf", archivePath, "-C", directory]);
  await rm(archivePath);
  console.log(`Installed Fiber ${version} (sha256 verified) in ${directory}`);
  return directory;
}

// curl when it is available (much faster than Node's fetch on some links),
// otherwise fetch. The caller verifies the checksum either way.
async function download(url, destination) {
  try {
    await execFileAsync("curl", [
      "--fail", "--location", "--silent", "--show-error",
      "--retry", "2", "--connect-timeout", "20", "--max-time", "900",
      "--output", destination, url
    ]);
    return;
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error(`download failed: ${error.stderr?.trim() || error.message}`);
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(900000) });
  if (!response.ok) throw new Error(`download failed with HTTP ${response.status}`);
  await writeFile(destination, Buffer.from(await response.arrayBuffer()));
}

async function init(version) {
  await install(version);
  for (const node of DEFAULT_NODES) await createNode({ ...node, version });
  console.log("Nodes ready. Start them with: npm run fiber:local -- start");
}

async function add(name, options) {
  if (!name || !/^[a-z0-9][a-z0-9.-]*$/.test(name)) throw new Error("add needs a lowercase node NAME");
  const rpcPort = port(options["rpc-port"], "--rpc-port");
  const p2pPort = port(options["p2p-port"], "--p2p-port");
  const version = options.version ?? DEFAULT_VERSION;
  await install(version);
  await createNode({ name, rpcPort, p2pPort, version });
}

async function createNode({ name, rpcPort, p2pPort, version }) {
  const directory = nodeDirectory(name);
  if (existsSync(join(directory, "node.json"))) {
    console.log(`${name}: already exists, left unchanged`);
    return;
  }
  const template = await readFile(join(releaseDirectory(version), "config/testnet/config.yml"), "utf8");
  // Loopback only: these nodes dial out to the testnet but accept no inbound
  // connections and do not announce an address.
  const config = replaceOnce(
    replaceOnce(
      replaceOnce(template, /listening_addr: "\/ip4\/0\.0\.0\.0\/tcp\/\d+"/, `listening_addr: "/ip4/127.0.0.1/tcp/${p2pPort}"`),
      /listening_addr: "127\.0\.0\.1:\d+"/,
      `listening_addr: "127.0.0.1:${rpcPort}"`
    ),
    /announce_listening_addr: true/,
    "announce_listening_addr: false"
  );

  await mkdir(join(directory, "ckb"), { recursive: true, mode: 0o700 });
  await writeFile(join(directory, "config.yml"), config);
  // The node's CKB key: a fresh secp256k1 private key. fnn encrypts this file
  // with the password on first start.
  await writeFile(join(directory, "ckb/key"), `${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
  await writeFile(join(directory, ".password"), `${randomBytes(24).toString("base64url")}\n`, { mode: 0o600 });
  await writeFile(join(directory, "node.json"), `${JSON.stringify({ name, version, rpcPort, p2pPort }, null, 2)}\n`);
  await chmod(directory, 0o700);
  console.log(`${name}: created (Fiber ${version}, RPC 127.0.0.1:${rpcPort}, P2P 127.0.0.1:${p2pPort})`);
}

async function start(selected) {
  for (const node of await selectNodes(selected)) {
    if (await runningPid(node)) {
      console.log(`${node.name}: already running`);
      continue;
    }
    const directory = nodeDirectory(node.name);
    const binary = join(releaseDirectory(node.version), "fnn");
    if (!existsSync(binary)) await install(node.version);
    const password = (await readFile(join(directory, ".password"), "utf8")).trim();
    const log = openSync(join(directory, "fnn.log"), "a");
    const child = spawn(binary, ["-c", "config.yml", "-d", "."], {
      cwd: directory,
      env: { ...process.env, FIBER_SECRET_KEY_PASSWORD: password, RUST_LOG: process.env.RUST_LOG ?? "info" },
      detached: true,
      stdio: ["ignore", log, log]
    });
    closeSync(log);
    child.unref();
    await writeFile(join(directory, "fnn.pid"), `${child.pid}\n`);

    const info = await waitForRpc(node, 45000);
    if (info) console.log(`${node.name}: running (pid ${child.pid}), pubkey ${info.pubkey}`);
    else console.log(`${node.name}: started (pid ${child.pid}) but RPC is not answering yet; see ${join(directory, "fnn.log")}`);
  }
}

async function stop(selected) {
  for (const node of await selectNodes(selected)) {
    const pid = await runningPid(node);
    if (!pid) {
      console.log(`${node.name}: not running`);
      continue;
    }
    process.kill(pid, "SIGTERM");
    for (let waited = 0; waited < 15000 && isAlive(pid); waited += 250) await sleep(250);
    if (isAlive(pid)) process.kill(pid, "SIGKILL");
    await rm(join(nodeDirectory(node.name), "fnn.pid"), { force: true });
    console.log(`${node.name}: stopped`);
  }
}

async function status() {
  const report = [];
  for (const node of await selectNodes([])) {
    const pid = await runningPid(node);
    const info = pid ? await rpc(node, "node_info").catch(() => undefined) : undefined;
    report.push({
      name: node.name,
      version: node.version,
      running: Boolean(pid),
      rpc_url: `http://127.0.0.1:${node.rpcPort}`,
      ...(info
        ? {
            node_version: info.version,
            pubkey: info.pubkey,
            chain_hash: info.chain_hash,
            peers: Number(info.peers_count),
            channels: Number(info.channel_count),
            // Send testnet CKB here to fund channels.
            funding_address: ckbAddress(info.default_funding_lock_script, "ckt")
          }
        : {})
    });
  }
  console.log(JSON.stringify(report, null, 2));
}

async function selectNodes(selected) {
  const directory = join(home, "nodes");
  const all = [];
  for (const name of existsSync(directory) ? await readdir(directory) : []) {
    const file = join(directory, name, "node.json");
    if (existsSync(file)) all.push(JSON.parse(await readFile(file, "utf8")));
  }
  if (all.length === 0) throw new Error("no nodes yet; run: npm run fiber:local -- init");
  if (selected.length === 0) return all.sort((left, right) => left.rpcPort - right.rpcPort);
  return selected.map((name) => {
    const node = all.find((candidate) => candidate.name === name);
    if (!node) throw new Error(`unknown node: ${name}`);
    return node;
  });
}

async function runningPid(node) {
  try {
    const pid = Number((await readFile(join(nodeDirectory(node.name), "fnn.pid"), "utf8")).trim());
    return Number.isInteger(pid) && isAlive(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForRpc(node, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = await rpc(node, "node_info").catch(() => undefined);
    if (info) return info;
    await sleep(500);
  }
  return undefined;
}

async function rpc(node, method, params = []) {
  const response = await fetch(`http://127.0.0.1:${node.rpcPort}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(5000)
  });
  const body = await response.json();
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

// CKB full-format address (bech32m) of a lock script.
function ckbAddress(script, prefix) {
  if (!script?.code_hash) return undefined;
  const hashType = { data: 0, type: 1, data1: 2, data2: 4 }[script.hash_type];
  const payload = [0x00, ...hexBytes(script.code_hash), hashType, ...hexBytes(script.args)];
  const words = convertBits(payload, 8, 5);
  const charset = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  const expanded = [...prefix].map((c) => c.charCodeAt(0) >> 5).concat(0, [...prefix].map((c) => c.charCodeAt(0) & 31));
  const polymod = bech32Polymod([...expanded, ...words, 0, 0, 0, 0, 0, 0]) ^ 0x2bc830a3;
  const checksum = Array.from({ length: 6 }, (_, index) => (polymod >>> (5 * (5 - index))) & 31);
  return `${prefix}1${[...words, ...checksum].map((word) => charset[word]).join("")}`;
}

function bech32Polymod(values) {
  const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let checksum = 1;
  for (const value of values) {
    const top = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    for (let index = 0; index < 5; index += 1) if ((top >>> index) & 1) checksum ^= generators[index];
  }
  return checksum >>> 0;
}

function convertBits(values, fromBits, toBits) {
  let accumulator = 0;
  let bits = 0;
  const result = [];
  for (const value of values) {
    accumulator = (accumulator << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      result.push((accumulator >>> bits) & ((1 << toBits) - 1));
    }
    accumulator &= (1 << bits) - 1;
  }
  if (bits > 0) result.push((accumulator << (toBits - bits)) & ((1 << toBits) - 1));
  return result;
}

function hexBytes(hex) {
  return [...Buffer.from(hex.replace(/^0x/, ""), "hex")];
}

function replaceOnce(text, pattern, replacement) {
  if (!pattern.test(text)) throw new Error(`release config no longer contains ${pattern}; update scripts/local-fiber.js`);
  return text.replace(pattern, replacement);
}

function port(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) throw new Error(`${flag} must be a port between 1024 and 65535`);
  return parsed;
}

function releaseDirectory(version) {
  return join(home, "releases", version);
}

function nodeDirectory(name) {
  return join(home, "nodes", name);
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
