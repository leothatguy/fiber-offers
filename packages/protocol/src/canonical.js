// Canonical JSON: the exact text that is hashed for an offer ID and signed.
//
// Two implementations must produce the same bytes for the same value, so the
// form is fixed and follows RFC 8785 (JSON Canonicalization Scheme):
//
//   - object members in order of their keys, compared by UTF-16 code unit
//   - no whitespace
//   - strings and numbers written as ECMAScript's JSON.stringify writes them
//   - members whose value is undefined are left out
//
// The text is built directly. Building a sorted object and stringifying that
// does not work in JavaScript: an object lists integer-like keys ("2", "10")
// first and in numeric order whatever order they were added in, and assigning
// to the key "__proto__" sets the prototype instead of adding a member, so that
// member would silently drop out of the signed bytes.
import { FiberOfferError } from "./errors.js";

const MAX_DEPTH = 32;

export function canonicalStringify(value) {
  return serialize(value, 0);
}

// A copy of `value` with every object's members sorted. Useful for display.
// The bytes to hash or sign always come from canonicalStringify.
export function canonicalize(value) {
  const text = canonicalStringify(value);
  return text === undefined ? undefined : JSON.parse(text);
}

function serialize(value, depth) {
  if (depth > MAX_DEPTH) throw notCanonical("value is nested too deeply");
  if (value === null) return "null";

  switch (typeof value) {
    case "undefined":
      return undefined;
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return serializeString(value);
    case "number":
      if (!Number.isFinite(value)) throw notCanonical("numbers must be finite");
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw notCanonical(`a ${typeof value} cannot be written as JSON`);
  }

  if (Array.isArray(value)) {
    const items = [];
    for (let index = 0; index < value.length; index += 1) {
      const item = serialize(value[index], depth + 1);
      if (item === undefined) throw notCanonical("an array cannot contain undefined");
      items.push(item);
    }
    return `[${items.join(",")}]`;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw notCanonical("only plain objects and arrays can be written as canonical JSON");
  }
  const members = [];
  for (const key of Object.keys(value).sort()) {
    const member = serialize(value[key], depth + 1);
    if (member !== undefined) members.push(`${serializeString(key)}:${member}`);
  }
  return `{${members.join(",")}}`;
}

function serializeString(value) {
  // An unpaired surrogate has no UTF-8 encoding, so it cannot be hashed.
  if (typeof value.isWellFormed === "function" && !value.isWellFormed()) {
    throw notCanonical("strings must be well-formed Unicode");
  }
  return JSON.stringify(value);
}

function notCanonical(message) {
  return new FiberOfferError(message, "INVALID_CANONICAL_VALUE");
}
