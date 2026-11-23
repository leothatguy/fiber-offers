// Bech32m (BIP-350) for encoded offers.
//
// Case follows BIP-173: a string is all lowercase or all uppercase, never
// mixed. The uppercase form matters because a QR code stores uppercase letters
// and digits in its compact alphanumeric mode.
//
// decodeBech32m throws an Error whose `reason` says what was wrong:
// "mixed_case", "length", "separator", "character", "checksum" or "padding".
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32M_CONSTANT = 0x2bc830a3;
const CHECKSUM_LENGTH = 6;

export function encodeBech32m(hrp, bytes) {
  const words = convertBits(bytes, 8, 5, true);
  const checksum = createChecksum(hrp, words);
  return `${hrp}1${[...words, ...checksum].map((word) => CHARSET[word]).join("")}`;
}

export function decodeBech32m(value) {
  if (typeof value !== "string") throw failure("length", "a bech32m string is required");
  const lower = value.toLowerCase();
  if (value !== lower && value !== value.toUpperCase()) {
    throw failure("mixed_case", "a bech32m string must be all lowercase or all uppercase");
  }

  const separator = lower.lastIndexOf("1");
  if (separator < 1) throw failure("separator", "missing bech32m separator");
  if (separator + 1 + CHECKSUM_LENGTH > lower.length) throw failure("length", "bech32m checksum is missing");

  const hrp = lower.slice(0, separator);
  const words = [];
  for (const character of lower.slice(separator + 1)) {
    const index = CHARSET.indexOf(character);
    if (index === -1) throw failure("character", `"${character}" is not a bech32m character`);
    words.push(index);
  }
  if (polymod([...expandHrp(hrp), ...words]) !== BECH32M_CONSTANT) {
    throw failure("checksum", "bech32m checksum does not match");
  }
  return { hrp, bytes: Uint8Array.from(convertBits(words.slice(0, -CHECKSUM_LENGTH), 5, 8, false)) };
}

function createChecksum(hrp, words) {
  const value = polymod([...expandHrp(hrp), ...words, 0, 0, 0, 0, 0, 0]) ^ BECH32M_CONSTANT;
  return Array.from({ length: CHECKSUM_LENGTH }, (_, index) => (value >>> (5 * (5 - index))) & 31);
}

function expandHrp(hrp) {
  const codes = [...hrp].map((character) => character.charCodeAt(0));
  return [...codes.map((code) => code >>> 5), 0, ...codes.map((code) => code & 31)];
}

function polymod(values) {
  const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let checksum = 1;
  for (const value of values) {
    const top = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    for (let index = 0; index < generators.length; index += 1) {
      if ((top >>> index) & 1) checksum ^= generators[index];
    }
  }
  return checksum >>> 0;
}

function convertBits(values, fromBits, toBits, pad) {
  let accumulator = 0;
  let bitCount = 0;
  const result = [];
  const maxValue = (1 << toBits) - 1;
  for (const value of values) {
    if (value < 0 || value >>> fromBits !== 0) throw failure("character", "value out of range");
    accumulator = ((accumulator << fromBits) | value) & 0xfff;
    bitCount += fromBits;
    while (bitCount >= toBits) {
      bitCount -= toBits;
      result.push((accumulator >>> bitCount) & maxValue);
    }
  }
  if (pad) {
    if (bitCount > 0) result.push((accumulator << (toBits - bitCount)) & maxValue);
  } else if (bitCount >= fromBits || ((accumulator << (toBits - bitCount)) & maxValue) !== 0) {
    // Leftover bits must be fewer than one input group and all zero, so each
    // payload has exactly one encoding.
    throw failure("padding", "bech32m padding is not canonical");
  }
  return result;
}

function failure(reason, message) {
  const error = new Error(message);
  error.reason = reason;
  return error;
}
