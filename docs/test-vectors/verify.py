#!/usr/bin/env python3
"""Independent verifier for the Fiber Offers v1 conformance vectors.

    python3 docs/test-vectors/verify.py [path/to/v1.json]
    python3 docs/test-vectors/verify.py --offers < offers.jsonl
    python3 docs/test-vectors/verify.py --signed-offers < offers.jsonl

This is a second implementation of the format, written from docs/spec-v1.md and
sharing no code with @fiber-offers/protocol. If it reproduces every value in
the vector file and refuses every invalid case, the specification is complete
enough to implement in another language.

With --offers it reads one offer per line and says, for each, whether its form
is acceptable; with --signed-offers, whether it verifies. The test suite uses
both to compare the two implementations on thousands of offers the vector file
does not contain.

Requires Python 3.9+ and the "cryptography" package (for Ed25519).
"""
import base64
import hashlib
import ipaddress
import json
import re
import sys
from pathlib import Path

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

MAX_SAFE_INTEGER = 2**53 - 1
NETWORKS = {"mainnet", "testnet", "dev"}
ASSET_TYPES = {"ckb", "udt", "rgbpp"}
INTERVALS = {"daily", "weekly", "monthly", "custom_seconds"}
FORBIDDEN_KEYS = {"__proto__", "constructor", "prototype"}
KNOWN_FIELDS = {
    "scheme", "version", "network", "node_id", "public_key", "resolver_url", "description", "assets",
    "amount_min", "amount_max", "recurrence", "expiry", "single_use", "metadata", "offer_id", "signature",
}
LIMITS = {
    "offer_bytes": 4096, "description_bytes": 512, "resolver_url_length": 512, "assets": 16,
    "metadata_bytes": 2048, "extensions_bytes": 2048, "json_depth": 8,
}
LIMITS["encoded_length"] = len("fbroffer1") + -(-LIMITS["offer_bytes"] * 8 // 5) + 6
# What "white space" means for a description: ECMAScript WhiteSpace and LineTerminator.
WHITESPACE = (
    {chr(c) for c in range(0x09, 0x0E)}
    | {chr(c) for c in (0x20, 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF)}
    | {chr(c) for c in range(0x2000, 0x200B)}
)
ED25519_SPKI_PREFIX = bytes.fromhex("302a300506032b6570032100")
RESOLVER_URL = re.compile(
    r"(https?)://"
    r"((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)|\[[0-9a-f:.]+\])"
    r"(?::([1-9][0-9]{0,4}))?"
    r"((?:/[A-Za-z0-9._~-]+)*)"
)


class Refused(Exception):
    """The input is not acceptable under the specification."""


def require(condition, message):
    if not condition:
        raise Refused(message)


# --- Canonical JSON (RFC 8785) ------------------------------------------------

def canonical(value):
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, str):
        return canonical_string(value)
    if isinstance(value, list):
        return "[" + ",".join(canonical(item) for item in value) + "]"
    if isinstance(value, dict):
        # Members in order of their keys, compared by UTF-16 code unit.
        keys = sorted(value, key=lambda key: key.encode("utf-16-be", "surrogatepass"))
        return "{" + ",".join(canonical_string(key) + ":" + canonical(value[key]) for key in keys) + "}"
    raise Refused(f"{type(value).__name__} has no canonical JSON form here")


def canonical_string(text):
    try:
        text.encode("utf-8")
    except UnicodeEncodeError:
        raise Refused("strings must be well-formed Unicode")
    return json.dumps(text, ensure_ascii=False)


def utf8(text):
    """The UTF-8 bytes of a string; refused when it is not well-formed Unicode."""
    try:
        return text.encode("utf-8")
    except UnicodeEncodeError:
        raise Refused("strings must be well-formed Unicode")


def sha256_hex(text):
    return hashlib.sha256(utf8(text)).hexdigest()


# --- Bech32m (BIP-350) ----------------------------------------------------------

CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
BECH32M_CONSTANT = 0x2BC830A3


def polymod(values):
    generators = [0x3B6A57B2, 0x26508E6D, 0x1EA119FA, 0x3D4233DD, 0x2A1462B3]
    checksum = 1
    for value in values:
        top = checksum >> 25
        checksum = ((checksum & 0x1FFFFFF) << 5) ^ value
        for index, generator in enumerate(generators):
            if (top >> index) & 1:
                checksum ^= generator
    return checksum


def expand_hrp(hrp):
    return [ord(c) >> 5 for c in hrp] + [0] + [ord(c) & 31 for c in hrp]


def convert_bits(values, from_bits, to_bits, pad):
    accumulator, bits, result = 0, 0, []
    for value in values:
        accumulator = ((accumulator << from_bits) | value) & 0xFFF
        bits += from_bits
        while bits >= to_bits:
            bits -= to_bits
            result.append((accumulator >> bits) & ((1 << to_bits) - 1))
    if pad:
        if bits:
            result.append((accumulator << (to_bits - bits)) & ((1 << to_bits) - 1))
    else:
        require(bits < from_bits and ((accumulator << (to_bits - bits)) & ((1 << to_bits) - 1)) == 0, "bech32m padding")
    return result


def bech32m_encode(hrp, data):
    words = convert_bits(data, 8, 5, True)
    check = polymod(expand_hrp(hrp) + words + [0] * 6) ^ BECH32M_CONSTANT
    checksum = [(check >> (5 * (5 - index))) & 31 for index in range(6)]
    return hrp + "1" + "".join(CHARSET[word] for word in words + checksum)


def bech32m_decode(text):
    require(isinstance(text, str), "an encoded offer is a string")
    lower = text.lower()
    require(text == lower or text == text.upper(), "mixed case")
    separator = lower.rfind("1")
    require(separator >= 1, "no separator")
    require(separator + 7 <= len(lower), "too short for a checksum")
    words = []
    for character in lower[separator + 1:]:
        require(character in CHARSET, "character outside the bech32 alphabet")
        words.append(CHARSET.index(character))
    hrp = lower[:separator]
    require(polymod(expand_hrp(hrp) + words) == BECH32M_CONSTANT, "checksum does not match")
    return hrp, bytes(convert_bits(words[:-6], 5, 8, False))


# --- Keys and signatures ----------------------------------------------------------

def base64url_decode_canonical(value, length):
    require(isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_-]+", value), "not base64url")
    try:
        raw = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except ValueError:
        raise Refused("not base64url")
    require(len(raw) == length, "wrong length")
    require(base64.urlsafe_b64encode(raw).decode().rstrip("=") == value, "not the canonical base64url spelling")
    return raw


def ed25519_spki_from_pem(pem, canonical_spelling):
    """The DER SubjectPublicKeyInfo of an Ed25519 key, or Refused."""
    require(isinstance(pem, str), "a public key is a PEM string")
    if canonical_spelling:
        match = re.fullmatch(r"-----BEGIN PUBLIC KEY-----\n([A-Za-z0-9+/=]+)\n-----END PUBLIC KEY-----", pem)
        require(match, "public_key is not the canonical PEM")
        body = match.group(1)
    else:
        match = re.fullmatch(r"\s*-----BEGIN PUBLIC KEY-----(.*?)-----END PUBLIC KEY-----\s*", pem, re.S)
        require(match, "not a PEM public key")
        body = "".join(match.group(1).split())
    try:
        der = base64.b64decode(body, validate=True)
    except ValueError:
        raise Refused("public key is not valid base64")
    if canonical_spelling:
        require(base64.b64encode(der).decode() == body, "public_key base64 is not canonical")
    # The only key type the format allows.
    require(len(der) == 44 and der.startswith(ED25519_SPKI_PREFIX), "public key is not an Ed25519 key")
    return der


def ed25519_verify(spki_der, message, signature):
    try:
        Ed25519PublicKey.from_public_bytes(spki_der[-32:]).verify(signature, message.encode("utf-8"))
        return True
    except InvalidSignature:
        return False


def check_signature_object(signature):
    require(isinstance(signature, dict) and set(signature) == {"scheme", "value"}, "signature must be exactly {scheme, value}")
    require(signature["scheme"] == "ed25519", "signature scheme must be ed25519")
    return base64url_decode_canonical(signature["value"], 64)


# --- Offer rules ---------------------------------------------------------------------

def is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def check_amount(value, field):
    require(isinstance(value, str) and re.fullmatch(r"[1-9][0-9]*", value), f"{field} must be a positive decimal string")
    return int(value)


def check_positive_integer(value, field):
    require(is_int(value) and 1 <= value <= MAX_SAFE_INTEGER, f"{field} must be a positive JSON integer")
    return value


def check_resolver_url(url, network):
    require(isinstance(url, str) and len(url) <= LIMITS["resolver_url_length"], "resolver_url must be a string within the limit")
    match = RESOLVER_URL.fullmatch(url)
    require(match, "resolver_url is not in canonical form")
    scheme, host, port, path = match.groups()
    if port is not None:
        require(int(port) <= 65535, "port out of range")
        require(int(port) != {"https": 443, "http": 80}[scheme], "the default port is left out")
    require(not any(segment in (".", "..") for segment in path.split("/")), "dot segments are not canonical")

    loopback = host == "localhost" or host.endswith(".localhost")
    if host.startswith("["):
        try:
            address = ipaddress.IPv6Address(host[1:-1])
        except ValueError:
            raise Refused("invalid IPv6 literal")
        require(address.compressed == host[1:-1], "IPv6 literal is not canonical")
        loopback = address == ipaddress.IPv6Address("::1")
    elif re.fullmatch(r"0x[0-9a-f]*|[0-9]+", host.split(".")[-1]):
        # A host whose last label is a number is an IPv4 address, in dotted-quad form.
        try:
            address = ipaddress.IPv4Address(host)
        except ValueError:
            raise Refused("a numeric host must be a dotted-quad IPv4 address")
        require(str(address) == host, "IPv4 address is not canonical")
        loopback = address in ipaddress.IPv4Network("127.0.0.0/8")
    if scheme == "http":
        require(network == "dev" or loopback, "http is allowed only on the dev network or for a loopback address")


def check_asset(asset):
    require(isinstance(asset, dict), "an asset is an object")
    asset_type = asset.get("asset_type")
    require(isinstance(asset_type, str) and asset_type in ASSET_TYPES, "unknown asset_type")
    symbol = asset.get("symbol")
    require(isinstance(symbol, str) and re.fullmatch(r"[A-Z0-9][A-Z0-9._-]{0,15}", symbol), "symbol is not in canonical form")
    if asset_type == "ckb":
        require(set(asset) == {"asset_type", "symbol"} and symbol == "CKB", "a ckb asset is exactly {asset_type: ckb, symbol: CKB}")
        return ("ckb", "")
    require(set(asset) == {"asset_type", "symbol", "type_script_hash"}, "a token asset has asset_type, symbol and type_script_hash")
    script_hash = asset["type_script_hash"]
    require(isinstance(script_hash, str) and re.fullmatch(r"0x[0-9a-f]{64}", script_hash), "type_script_hash is not canonical")
    return (asset_type, script_hash)


def check_signable_json(fields, sized, limit, what):
    """Free-form signed content. Each of `fields` (the value of `metadata`, of
    `extensions` or of an `x_...` field) is at depth 0, and what it holds is
    one deeper at each step. `sized` is what the byte limit applies to."""
    def walk(node, depth):
        require(depth <= LIMITS["json_depth"], f"{what} is nested too deeply")
        if isinstance(node, float):
            raise Refused(f"{what} may contain whole numbers only")
        if is_int(node):
            require(abs(node) <= MAX_SAFE_INTEGER, f"{what} contains a number that is too large")
        if isinstance(node, list):
            for item in node:
                walk(item, depth + 1)
        elif isinstance(node, dict):
            for key, member in node.items():
                require(key not in FORBIDDEN_KEYS, f"{key} is not allowed as a key")
                walk(member, depth + 1)
    for field in fields:
        walk(field, 0)
    require(len(utf8(canonical(sized))) <= limit, f"{what} is too large")


def check_recurrence(recurrence, offer):
    require(isinstance(recurrence, dict), "recurrence is an object")
    require(set(recurrence) <= {"interval", "amount", "cap_cycles", "spending_cap_total", "custom_seconds"}, "unknown recurrence member")
    interval = recurrence.get("interval")
    require(isinstance(interval, str) and interval in INTERVALS, "unknown recurrence interval")
    amount = check_amount(recurrence.get("amount"), "recurrence.amount")
    if "cap_cycles" in recurrence:
        check_positive_integer(recurrence["cap_cycles"], "recurrence.cap_cycles")
    if "spending_cap_total" in recurrence:
        require(check_amount(recurrence["spending_cap_total"], "recurrence.spending_cap_total") >= amount, "spending cap below one cycle")
    require("cap_cycles" in recurrence or "spending_cap_total" in recurrence, "a recurring offer needs a cap")
    if interval == "custom_seconds":
        check_positive_integer(recurrence.get("custom_seconds"), "recurrence.custom_seconds")
    else:
        require("custom_seconds" not in recurrence, "custom_seconds only with the custom_seconds interval")
    require(offer["single_use"] is False, "an offer is not both single_use and recurring")
    if "amount_min" in offer:
        require(amount >= int(offer["amount_min"]), "recurrence amount below amount_min")
    if "amount_max" in offer:
        require(amount <= int(offer["amount_max"]), "recurrence amount above amount_max")


def check_offer_form(offer):
    """Everything about a signed offer except its ID and signature."""
    require(isinstance(offer, dict), "an offer is an object")
    for field in offer:
        require(field not in FORBIDDEN_KEYS, f"{field} is not allowed as a field name")
        require(field in KNOWN_FIELDS or field == "extensions" or field.startswith("x_"), f"unknown field {field}")
    require(offer.get("scheme") == "fiberoffer-v1", "scheme")
    require(is_int(offer.get("version")) and offer["version"] == 1, "version")
    require(isinstance(offer.get("network"), str) and offer["network"] in NETWORKS, "network")
    require(isinstance(offer.get("single_use"), bool), "single_use must be a boolean")
    require(isinstance(offer.get("node_id"), str) and re.fullmatch(r"0[23][0-9a-f]{64}", offer["node_id"]), "node_id is not canonical")
    ed25519_spki_from_pem(offer.get("public_key"), canonical_spelling=True)
    check_resolver_url(offer.get("resolver_url"), offer["network"])

    if "description" in offer:
        description = offer["description"]
        require(isinstance(description, str) and description != "", "description must be a non-empty string")
        require(description[0] not in WHITESPACE and description[-1] not in WHITESPACE, "description is not trimmed")
        require(len(utf8(description)) <= LIMITS["description_bytes"], "description is too long")

    assets = offer.get("assets")
    require(isinstance(assets, list) and 1 <= len(assets) <= LIMITS["assets"], "assets must list 1 to 16 assets")
    identities = [check_asset(asset) for asset in assets]
    require(len(set(identities)) == len(identities), "the same asset is listed twice")

    for field in ("amount_min", "amount_max"):
        if field in offer:
            check_amount(offer[field], field)
    if "amount_min" in offer and "amount_max" in offer:
        require(int(offer["amount_min"]) <= int(offer["amount_max"]), "amount_min above amount_max")
    if "expiry" in offer:
        check_positive_integer(offer["expiry"], "expiry")
    if "recurrence" in offer:
        check_recurrence(offer["recurrence"], offer)
    if "metadata" in offer:
        require(isinstance(offer["metadata"], dict), "metadata is an object")
        check_signable_json([offer["metadata"]], offer["metadata"], LIMITS["metadata_bytes"], "metadata")
    extensions = {field: value for field, value in offer.items() if field == "extensions" or field.startswith("x_")}
    if "extensions" in extensions:
        require(isinstance(extensions["extensions"], dict), "extensions is an object")
    for value in extensions.values():
        require(value is not None, "an absent field is left out, not null")
    check_signable_json(extensions.values(), extensions, LIMITS["extensions_bytes"], "extension fields")

    require(isinstance(offer.get("offer_id"), str) and re.fullmatch(r"0x[0-9a-f]{64}", offer["offer_id"]), "offer_id")
    check_signature_object(offer.get("signature"))
    require(len(utf8(canonical(offer))) <= LIMITS["offer_bytes"], "offer is too large")


def verify_offer(offer):
    check_offer_form(offer)
    content = {field: value for field, value in offer.items() if field not in ("offer_id", "signature")}
    require(offer["offer_id"] == "0x" + sha256_hex(canonical(content)), "offer_id does not match the content")
    signed = {field: value for field, value in offer.items() if field != "signature"}
    spki = ed25519_spki_from_pem(offer["public_key"], canonical_spelling=True)
    require(ed25519_verify(spki, canonical(signed), check_signature_object(offer["signature"])), "signature is invalid")


def decode_offer(encoded):
    require(isinstance(encoded, str) and encoded.lower().startswith("fbroffer1"), "prefix")
    require(len(encoded) <= LIMITS["encoded_length"], "too long")
    hrp, data = bech32m_decode(encoded)
    require(hrp == "fbroffer", "prefix")
    try:
        text = data.decode("utf-8")
        offer = json.loads(text)
    except ValueError:
        raise Refused("body is not JSON")
    check_offer_form(offer)
    require(canonical(offer) == text, "body is not the canonical JSON")
    return offer


def encode_offer(offer):
    return bech32m_encode("fbroffer", canonical(offer).encode("utf-8"))


# --- Requests, revocations, subscriptions ----------------------------------------------

def normalize_request_asset(asset):
    require(isinstance(asset, dict), "asset is an object")
    asset_type = str(asset.get("asset_type", "")).strip().lower()
    normalized = {"asset_type": asset_type, "symbol": str(asset.get("symbol", "")).strip().upper()}
    if asset_type != "ckb":
        normalized["type_script_hash"] = str(asset.get("type_script_hash", "")).strip().lower()
    return normalized


def validate_request(offer, request, now):
    """What a request for an invoice resolves to, or Refused."""
    amount_text = str(request.get("amount", "")).strip()
    require(re.fullmatch(r"[0-9]+", amount_text) and int(amount_text) > 0, "amount must be a positive integer")
    amount = int(amount_text)
    asset = normalize_request_asset(request["asset"]) if request.get("asset") is not None else offer["assets"][0]
    require(asset in offer["assets"], "the offer does not accept this asset")
    low = int(offer["amount_min"]) if "amount_min" in offer else None
    high = int(offer["amount_max"]) if "amount_max" in offer else None
    require(low is None or amount >= low, "below the minimum")
    require(high is None or amount <= high, "above the maximum")
    require("expiry" not in offer or now <= offer["expiry"], "the offer has expired")

    terms = offer.get("recurrence")
    cycle = request.get("recurrence_cycle")
    if terms is None:
        require(cycle is None, "the offer is not recurring")
    else:
        require(amount == int(terms["amount"]), "a cycle pays exactly the cycle amount")
        if cycle is not None:
            require(is_int(cycle) and cycle >= 1, "recurrence_cycle must be a positive integer")
            require("cap_cycles" not in terms or cycle <= terms["cap_cycles"], "cycle cap reached")
            require("spending_cap_total" not in terms or cycle * amount <= int(terms["spending_cap_total"]), "spending cap reached")
    return {"amount": str(amount), "asset": asset}


def verify_revocation(offer, revocation, now):
    require(isinstance(revocation, dict), "a revocation is an object")
    require(revocation.get("scheme") == "fiberoffer-revocation-v1", "scheme")
    require(revocation.get("offer_id") == offer["offer_id"] and revocation.get("node_id") == offer["node_id"], "not for this offer")
    revoked_at = check_positive_integer(revocation.get("revoked_at"), "revoked_at")
    require(abs(now - revoked_at) <= 300, "outside the accepted time window")
    signature = check_signature_object(revocation.get("signature"))
    payload = {field: value for field, value in revocation.items() if field != "signature"}
    spki = ed25519_spki_from_pem(offer["public_key"], canonical_spelling=True)
    require(ed25519_verify(spki, canonical(payload), signature), "signature is invalid")


def subscription_id(spki_der):
    return "sub_" + hashlib.sha256(spki_der).hexdigest()[:40]


def verify_recurrence_request(offer, request, now):
    require("recurrence" in offer, "the offer is not recurring")
    for field in ("approval_id", "subscriber_public_key", "subscriber_signature", "recurrence_cycle"):
        require(request.get(field) not in (None, ""), f"{field} is required")
    validated = validate_request(offer, request, now)
    spki = ed25519_spki_from_pem(request["subscriber_public_key"], canonical_spelling=False)
    require(subscription_id(spki) == request["approval_id"], "approval_id does not belong to this key")
    payload = {
        "scheme": "fiberoffer-recurrence-v1",
        "offer_id": offer["offer_id"],
        "approval_id": request["approval_id"],
        "recurrence_cycle": request["recurrence_cycle"],
        "amount": validated["amount"],
        "asset": validated["asset"],
    }
    if "scheduled_for" in request:
        payload["scheduled_for"] = request["scheduled_for"]
    signature = base64url_decode_canonical(request["subscriber_signature"], 64)
    require(ed25519_verify(spki, canonical(payload), signature), "subscriber signature is invalid")
    return canonical(payload)


# --- CKB type script hash -----------------------------------------------------------------

def type_script_hash(script):
    """blake2b-256, personalized "ckb-default-hash", over the molecule-encoded Script."""
    code_hash = bytes.fromhex(script["code_hash"][2:])
    hash_type = {"data": 0, "type": 1, "data1": 2, "data2": 4}[script["hash_type"]]
    args = bytes.fromhex(script["args"][2:])
    fields = [code_hash, bytes([hash_type]), len(args).to_bytes(4, "little") + args]
    header_size = 4 + 4 * len(fields)
    offsets, position = [], header_size
    for field in fields:
        offsets.append(position)
        position += len(field)
    encoded = position.to_bytes(4, "little") + b"".join(offset.to_bytes(4, "little") for offset in offsets) + b"".join(fields)
    return "0x" + hashlib.blake2b(encoded, digest_size=32, person=b"ckb-default-hash").hexdigest()


# --- Running the vectors ---------------------------------------------------------------------

class Report:
    def __init__(self):
        self.passed = 0
        self.failures = []

    def check(self, section, name, condition, detail=""):
        if condition:
            self.passed += 1
        else:
            self.failures.append(f"{section}: {name}{' - ' + detail if detail else ''}")

    def refused(self, section, name, run):
        try:
            run()
        except Refused:
            self.passed += 1
        except Exception as error:  # a crash is not a refusal
            self.failures.append(f"{section}: {name} - crashed with {type(error).__name__}: {error}")
        else:
            self.failures.append(f"{section}: {name} - accepted, but must be refused")

    def accepted(self, section, name, run):
        try:
            return run()
        except Refused as error:
            self.failures.append(f"{section}: {name} - refused ({error}), but is valid")
        except Exception as error:
            self.failures.append(f"{section}: {name} - crashed with {type(error).__name__}: {error}")
        else:
            self.passed += 1


def run(vectors):
    report = Report()
    now = vectors["now"]

    for vector in vectors["canonical_json"]:
        report.check("canonical_json", vector["name"], canonical(json.loads(vector["input_json"])) == vector["canonical"])

    for vector in vectors["type_script_hashes"]:
        report.check("type_script_hashes", vector["name"], type_script_hash(vector["script"]) == vector["type_script_hash"])

    for key in vectors["keys"].values():
        spki = ed25519_spki_from_pem(key["public_key_pem"], canonical_spelling=True)
        report.check("keys", key["seed_label"], spki[-32:].hex() == key["public_key_hex"])
        report.check("keys", key["seed_label"] + " seed", hashlib.sha256(key["seed_label"].encode()).hexdigest() == key["seed_hex"])
    subscriber = vectors["keys"]["subscriber"]
    subscriber_spki = ed25519_spki_from_pem(subscriber["public_key_pem"], canonical_spelling=True)
    report.check("keys", "subscription id", subscription_id(subscriber_spki) == subscriber["subscription_id"])

    offers = {}
    for vector in vectors["valid_offers"]:
        name, offer = vector["name"], vector["offer"]
        offers[vector["offer_id"]] = offer
        content = {field: value for field, value in offer.items() if field not in ("offer_id", "signature")}
        signed = {field: value for field, value in offer.items() if field != "signature"}
        report.check("valid_offers", name + " id preimage", canonical(content) == vector["id_preimage"])
        report.check("valid_offers", name + " offer id", "0x" + sha256_hex(vector["id_preimage"]) == vector["offer_id"])
        report.check("valid_offers", name + " signing payload", canonical(signed) == vector["signing_payload"])
        report.check("valid_offers", name + " canonical json", canonical(offer) == vector["canonical_json"])
        report.accepted("valid_offers", name + " verifies", lambda: verify_offer(offer))
        report.check("valid_offers", name + " encodes", encode_offer(offer) == vector["encoded"])
        for form in ("encoded", "encoded_uppercase"):
            decoded = report.accepted("valid_offers", f"{name} decodes from {form}", lambda: decode_offer(vector[form]))
            report.check("valid_offers", f"{name} round trip from {form}", decoded == offer)

    for vector in vectors["invalid_offers"]:
        offer = json.loads(vector["offer_json"]) if "offer_json" in vector else vector["offer"]
        report.refused("invalid_offers", vector["name"], lambda: verify_offer(offer))

    for vector in vectors["invalid_encoded_offers"]:
        report.refused("invalid_encoded_offers", vector["name"], lambda: verify_offer(decode_offer(vector["encoded"])))
        if vector["decodes"]:
            report.accepted("invalid_encoded_offers", vector["name"] + " still decodes", lambda: decode_offer(vector["encoded"]))

    for vector in vectors["resolution_requests"]:
        validate = lambda: validate_request(vector["offer"], vector["request"], vector["now"])
        if "error" in vector:
            report.refused("resolution_requests", vector["name"], validate)
        else:
            report.check("resolution_requests", vector["name"], report.accepted("resolution_requests", vector["name"] + " accepted", validate) == vector["result"])

    for vector in vectors["revocations"]:
        verify = lambda: verify_revocation(offers[vector["offer_id"]], vector["revocation"], vector["now"])
        (report.accepted if vector["valid"] else report.refused)("revocations", vector["name"], verify)
    proof = vectors["revocation_signing_payload"]
    payload = {field: value for field, value in proof["revocation"].items() if field != "signature"}
    report.check("revocations", "signing payload", canonical(payload) == proof["signing_payload"])

    for vector in vectors["recurrence_requests"]:
        verify = lambda: verify_recurrence_request(offers[vector["offer_id"]], vector["request"], now)
        if vector["valid"]:
            report.check("recurrence_requests", vector["name"], report.accepted("recurrence_requests", vector["name"] + " accepted", verify) == vector["signing_payload"])
        else:
            report.refused("recurrence_requests", vector["name"], verify)

    return report


def judge_offers(lines, out, check):
    """Reads one offer per line as JSON and writes one verdict per line:
    "accept", or "refuse" and why."""
    for line in lines:
        try:
            check(json.loads(line))
            verdict = "accept"
        except Refused as refusal:
            verdict = f"refuse\t{refusal}"
        out.write(verdict + "\n")


def main():
    # --offers judges only an offer's form (everything of specification 4.3 but
    # the ID and the signature), so that two implementations can be compared
    # on offers nobody has signed. --signed-offers verifies in full.
    modes = {"--offers": check_offer_form, "--signed-offers": verify_offer}
    if len(sys.argv) == 2 and sys.argv[1] in modes:
        judge_offers(sys.stdin, sys.stdout, modes[sys.argv[1]])
        return 0
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).with_name("v1.json")
    vectors = json.loads(path.read_text(encoding="utf-8"))
    report = run(vectors)
    for failure in report.failures:
        print("FAIL ", failure)
    print(f"{report.passed} checks passed, {len(report.failures)} failed ({path.name}, format {vectors['format']})")
    return 1 if report.failures else 0


if __name__ == "__main__":
    sys.exit(main())
