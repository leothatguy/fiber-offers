// Browser-side subscription keys for recurring offers.
//
// A recurring offer counts cycles per subscription. A subscription is a key the
// payer generates: its ID is derived from the public key, and every cycle
// request is signed with the private key. This is the browser counterpart of
// subscriptionId() and signRecurrenceRequest() in @fiber-offers/protocol, using
// Web Crypto (Ed25519). The two must produce byte-identical signing payloads;
// apps/resolver/test/demo-subscription.test.js checks that they do.
(function (root) {
  const SCHEME = "fiberoffer-recurrence-v1";
  const encoder = new TextEncoder();

  // Generates the subscription's key pair. The private key stays in this page.
  async function createSubscription() {
    const keys = await root.crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const spki = new Uint8Array(await root.crypto.subtle.exportKey("spki", keys.publicKey));
    const digest = new Uint8Array(await root.crypto.subtle.digest("SHA-256", spki));
    return {
      privateKey: keys.privateKey,
      publicKeyPem: toPem(spki),
      approval_id: `sub_${toHex(digest).slice(0, 40)}`
    };
  }

  // Returns the cycle request with its subscription proof attached.
  async function signCycle(subscription, offer, request) {
    const fields = {
      amount: String(request.amount),
      asset: normalizeAsset(request.asset),
      recurrence_cycle: request.recurrence_cycle,
      approval_id: subscription.approval_id
    };
    if (request.scheduled_for !== undefined) fields.scheduled_for = request.scheduled_for;
    const payload = canonicalStringify({ scheme: SCHEME, offer_id: offer.offer_id, ...fields });
    const signature = await root.crypto.subtle.sign({ name: "Ed25519" }, subscription.privateKey, encoder.encode(payload));
    return {
      ...request,
      ...fields,
      subscriber_public_key: subscription.publicKeyPem,
      subscriber_signature: toBase64Url(new Uint8Array(signature))
    };
  }

  // Same canonical form as the protocol package: object keys sorted, undefined
  // values dropped, no whitespace.
  function canonicalStringify(value) {
    return JSON.stringify(canonicalize(value));
  }

  function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === "object") {
      const sorted = {};
      for (const key of Object.keys(value).sort()) {
        if (value[key] !== undefined) sorted[key] = canonicalize(value[key]);
      }
      return sorted;
    }
    return value;
  }

  function normalizeAsset(asset) {
    const normalized = {
      asset_type: String(asset.asset_type).trim().toLowerCase(),
      symbol: String(asset.symbol).trim().toUpperCase()
    };
    if (asset.type_script_hash !== undefined) normalized.type_script_hash = String(asset.type_script_hash).trim().toLowerCase();
    return normalized;
  }

  function toPem(der) {
    const base64 = toBase64(der);
    const lines = base64.match(/.{1,64}/g).join("\n");
    return `-----BEGIN PUBLIC KEY-----\n${lines}\n-----END PUBLIC KEY-----\n`;
  }

  function toBase64(bytes) {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return root.btoa(binary);
  }

  function toBase64Url(bytes) {
    return toBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  }

  function toHex(bytes) {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  root.FiberOfferSubscription = { createSubscription, signCycle };
})(globalThis);
