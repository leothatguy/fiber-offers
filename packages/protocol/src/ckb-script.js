// CKB script hashing. An offer names a token by `type_script_hash`: the hash of
// the token's CKB type script. Anyone holding the full script (a resolver about
// to mint an invoice, a wallet reading one) must be able to recompute that hash
// and get the same 32 bytes, so the definition lives here, once.
//
//   type_script_hash = blake2b-256(molecule(Script), personalization = "ckb-default-hash")
//
// Runs on Uint8Array only, with no Node built-ins, so it works in browsers.
import { blake2b } from "@noble/hashes/blake2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { FiberOfferError } from "./errors.js";

const CKB_HASH_PERSONALIZATION = new TextEncoder().encode("ckb-default-hash");

// Molecule encodes `hash_type` as one byte.
const HASH_TYPE_BYTES = Object.freeze({ data: 0, type: 1, data1: 2, data2: 4 });
const HASH_TYPE_NAMES = Object.freeze(
  Object.fromEntries(Object.entries(HASH_TYPE_BYTES).map(([name, byte]) => [byte, name]))
);

// A Script is a molecule table of three fields: a 4-byte total size, one 4-byte
// offset per field, then code_hash (32 bytes), hash_type (1 byte) and args (a
// 4-byte length followed by the bytes). All integers are little-endian.
const SCRIPT_HEADER_SIZE = 16;
const CODE_HASH_OFFSET = SCRIPT_HEADER_SIZE;
const HASH_TYPE_OFFSET = CODE_HASH_OFFSET + 32;
const ARGS_OFFSET = HASH_TYPE_OFFSET + 1;

export function ckbHash(bytes) {
  return blake2b(bytes, { dkLen: 32, personalization: CKB_HASH_PERSONALIZATION });
}

// Returns the script in canonical form: lowercase 0x-prefixed hex and a known
// hash_type. Throws INVALID_CKB_SCRIPT otherwise.
export function normalizeCkbScript(script) {
  if (!script || typeof script !== "object" || Array.isArray(script)) {
    throw invalidScript("script must be an object with code_hash, hash_type and args");
  }
  const code_hash = hexField(script.code_hash, "code_hash");
  if (code_hash.length !== 66) throw invalidScript("script code_hash must be 32 bytes");
  if (typeof script.hash_type !== "string" || !(script.hash_type in HASH_TYPE_BYTES)) {
    throw invalidScript("script hash_type must be data, type, data1, or data2");
  }
  return { code_hash, hash_type: script.hash_type, args: hexField(script.args, "args") };
}

export function serializeCkbScript(script) {
  const normalized = normalizeCkbScript(script);
  const codeHash = hexToBytes(normalized.code_hash.slice(2));
  const args = hexToBytes(normalized.args.slice(2));
  const total = ARGS_OFFSET + 4 + args.length;
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, total, true);
  view.setUint32(4, CODE_HASH_OFFSET, true);
  view.setUint32(8, HASH_TYPE_OFFSET, true);
  view.setUint32(12, ARGS_OFFSET, true);
  bytes.set(codeHash, CODE_HASH_OFFSET);
  bytes[HASH_TYPE_OFFSET] = HASH_TYPE_BYTES[normalized.hash_type];
  view.setUint32(ARGS_OFFSET, args.length, true);
  bytes.set(args, ARGS_OFFSET + 4);
  return bytes;
}

// Reads a molecule-encoded Script, given as bytes or 0x-prefixed hex. Fiber
// invoices carry a token's type script in this form. Only the exact canonical
// layout is accepted, so every script has a single encoding and a single hash.
export function parseCkbScript(encoded) {
  const bytes = typeof encoded === "string" ? hexToBytes(hexField(encoded, "script").slice(2)) : encoded;
  if (!(bytes instanceof Uint8Array) || bytes.length < ARGS_OFFSET + 4) {
    throw invalidScript("encoded script is too short");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const argsLength = view.getUint32(ARGS_OFFSET, true);
  if (
    view.getUint32(0, true) !== bytes.length ||
    view.getUint32(4, true) !== CODE_HASH_OFFSET ||
    view.getUint32(8, true) !== HASH_TYPE_OFFSET ||
    view.getUint32(12, true) !== ARGS_OFFSET ||
    ARGS_OFFSET + 4 + argsLength !== bytes.length
  ) {
    throw invalidScript("encoded script is not a canonical molecule Script");
  }
  const hash_type = HASH_TYPE_NAMES[bytes[HASH_TYPE_OFFSET]];
  if (!hash_type) throw invalidScript("encoded script has an unknown hash_type");
  return {
    code_hash: `0x${bytesToHex(bytes.subarray(CODE_HASH_OFFSET, HASH_TYPE_OFFSET))}`,
    hash_type,
    args: `0x${bytesToHex(bytes.subarray(ARGS_OFFSET + 4))}`
  };
}

// The value an offer carries as `type_script_hash` for this script.
export function ckbScriptHash(script) {
  return `0x${bytesToHex(ckbHash(serializeCkbScript(script)))}`;
}

function hexField(value, field) {
  if (typeof value !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(value)) {
    throw invalidScript(`script ${field} must be 0x-prefixed hex with an even number of digits`);
  }
  return value.toLowerCase();
}

function invalidScript(message) {
  return new FiberOfferError(message, "INVALID_CKB_SCRIPT");
}
