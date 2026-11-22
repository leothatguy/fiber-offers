// Payer-side check that a Fiber invoice is the one a signed offer entitles the
// payer to. A resolver is an untrusted intermediary: it hands back an invoice
// string, and nothing but this check stops a hostile or compromised resolver
// from substituting an invoice that pays someone else, a different amount, a
// different asset, or a different network.
//
// The input is the payer's own node's reading of the invoice (`parse_invoice`),
// never the resolver's description of it.
import { ckbScriptHash, parseCkbScript, validateResolutionRequest } from "@fiber-offers/protocol";
import { fiberCurrencyForNetwork } from "./fiber-network.js";

// Returns { ok, checks, failure?, invoice } where `invoice` is the normalized
// reading (payee, amount, currency, asset script hash, expiry).
export function verifyInvoiceForOffer({ offer, request, parsed, expectedPaymentHash, now = Date.now() }) {
  const checks = [];
  const fail = (id, code, summary, details) => {
    checks.push({ id, status: "fail", code, message: summary, ...(details ? { details } : {}) });
  };
  const pass = (id, message) => checks.push({ id, status: "pass", message });

  const invoice = normalizeParsedInvoice(parsed);
  if (!invoice) {
    fail("invoice_format", "INVOICE_UNPARSEABLE", "The payer node did not return a readable invoice.");
    return result(checks, undefined);
  }

  // Validates the request against the signed offer and normalizes the asset.
  const expected = validateResolutionRequest(offer, request);

  // Payee: the invoice must pay the node the offer was signed for.
  const offerNode = String(offer.node_id).toLowerCase();
  if (!invoice.payee_public_key) {
    fail(
      "payee",
      "INVOICE_PAYEE_MISSING",
      "The invoice does not state which node it pays, so it cannot be matched to the offer."
    );
  } else if (invoice.payee_public_key !== offerNode) {
    fail("payee", "INVOICE_PAYEE_MISMATCH", "The invoice pays a different node than the offer names.", {
      offer_node_id: offerNode,
      invoice_payee: invoice.payee_public_key
    });
  } else {
    pass("payee", "Invoice pays the node named in the offer");
  }

  // Amount: exactly what was requested.
  if (invoice.amount === undefined) {
    fail("amount", "INVOICE_AMOUNT_MISSING", "The invoice does not fix an amount.");
  } else if (invoice.amount !== BigInt(expected.amount)) {
    fail("amount", "INVOICE_AMOUNT_MISMATCH", "The invoice amount differs from the requested amount.", {
      requested_amount: expected.amount,
      invoice_amount: invoice.amount.toString()
    });
  } else {
    pass("amount", "Invoice amount equals the requested amount");
  }

  // Network: the currency code of the offer's signed network.
  const expectedCurrency = fiberCurrencyForNetwork(offer.network);
  if (invoice.currency !== expectedCurrency) {
    fail("currency", "INVOICE_CURRENCY_MISMATCH", "The invoice is for a different network than the offer.", {
      offer_network: offer.network,
      expected_currency: expectedCurrency,
      invoice_currency: invoice.currency
    });
  } else {
    pass("currency", "Invoice is on the offer's network");
  }

  // Asset: plain CKB carries no token script; a token invoice must carry the
  // script whose hash the offer signed.
  if (expected.asset.asset_type === "ckb") {
    if (invoice.udt_script_hash !== undefined || invoice.udt_script_error) {
      fail("asset", "INVOICE_ASSET_MISMATCH", "A CKB payment was requested but the invoice is for a token.", {
        invoice_type_script_hash: invoice.udt_script_hash
      });
    } else {
      pass("asset", "Invoice is a CKB invoice");
    }
  } else if (invoice.udt_script_error) {
    fail("asset", "INVOICE_ASSET_MISMATCH", "The invoice's token script could not be read.", {
      cause: invoice.udt_script_error
    });
  } else if (invoice.udt_script_hash !== expected.asset.type_script_hash) {
    fail("asset", "INVOICE_ASSET_MISMATCH", "The invoice is not for the requested token.", {
      requested_type_script_hash: expected.asset.type_script_hash,
      invoice_type_script_hash: invoice.udt_script_hash
    });
  } else {
    pass("asset", "Invoice is for the requested token");
  }

  // Expiry: do not pay an invoice the node will already refuse.
  if (invoice.expires_at_ms !== undefined && invoice.expires_at_ms <= now) {
    fail("expiry", "INVOICE_EXPIRED", "The invoice has already expired.", {
      expires_at: new Date(invoice.expires_at_ms).toISOString()
    });
  } else {
    pass("expiry", invoice.expires_at_ms === undefined ? "Invoice states no expiry" : "Invoice has not expired");
  }

  // The payment hash the resolver reported must be the invoice's own.
  if (expectedPaymentHash && invoice.payment_hash && !sameHex(expectedPaymentHash, invoice.payment_hash)) {
    fail(
      "payment_hash",
      "INVOICE_PAYMENT_HASH_MISMATCH",
      "The resolver reported a different payment hash than the invoice contains.",
      { reported_payment_hash: expectedPaymentHash, invoice_payment_hash: invoice.payment_hash }
    );
  }

  return result(checks, invoice);
}

// Reduces a `parse_invoice` result to the fields that matter here. Fiber lists
// optional invoice fields as `data.attrs`, an array of single-key objects such
// as { "payee_public_key": "02…" }.
export function normalizeParsedInvoice(parsed) {
  const invoice = parsed?.invoice ?? parsed;
  if (!invoice || typeof invoice !== "object" || !invoice.data || typeof invoice.data !== "object") return undefined;

  const attrs = collectAttributes(invoice.data.attrs);
  const timestampMs = toBigInt(invoice.data.timestamp);
  const expirySeconds = durationSeconds(attrs.expirytime);
  const payee = typeof attrs.payeepublickey === "string" ? stripHexPrefix(attrs.payeepublickey).toLowerCase() : undefined;

  let udtScriptHash;
  let udtScriptError;
  if (attrs.udtscript !== undefined) {
    try {
      const script = typeof attrs.udtscript === "string" ? parseCkbScript(attrs.udtscript) : attrs.udtscript;
      udtScriptHash = ckbScriptHash(script);
    } catch (error) {
      udtScriptError = error.message;
    }
  }

  return {
    currency: invoice.currency,
    amount: toBigInt(invoice.amount),
    payment_hash: typeof invoice.data.payment_hash === "string" ? invoice.data.payment_hash : undefined,
    payee_public_key: payee,
    description: typeof attrs.description === "string" ? attrs.description : undefined,
    udt_script_hash: udtScriptHash,
    udt_script_error: udtScriptError,
    expires_at_ms:
      timestampMs !== undefined && expirySeconds !== undefined
        ? Number(timestampMs) + expirySeconds * 1000
        : undefined
  };
}

function result(checks, invoice) {
  const failed = checks.find((check) => check.status === "fail");
  return {
    ok: !failed,
    checks,
    invoice: invoice ? publicInvoice(invoice) : undefined,
    ...(failed
      ? {
          failure: {
            code: failed.code,
            summary: failed.message,
            details: failed.details,
            next_actions: [
              "Do not pay this invoice.",
              "Request a new invoice, and stop using this resolver if the mismatch repeats."
            ]
          }
        }
      : {})
  };
}

function publicInvoice(invoice) {
  return {
    currency: invoice.currency,
    amount: invoice.amount?.toString(),
    payment_hash: invoice.payment_hash,
    payee_public_key: invoice.payee_public_key,
    description: invoice.description,
    type_script_hash: invoice.udt_script_hash,
    expires_at: invoice.expires_at_ms !== undefined ? new Date(invoice.expires_at_ms).toISOString() : undefined
  };
}

// Attribute names are matched without regard to case or underscores, so both
// `payee_public_key` and `PayeePublicKey` are understood.
function collectAttributes(attrs) {
  const collected = {};
  if (!Array.isArray(attrs)) return collected;
  for (const attribute of attrs) {
    if (!attribute || typeof attribute !== "object") continue;
    for (const [name, value] of Object.entries(attribute)) {
      collected[name.toLowerCase().replaceAll("_", "")] = value;
    }
  }
  return collected;
}

// A duration may arrive as seconds (number or hex string) or as { secs, nanos }.
function durationSeconds(value) {
  if (value === undefined || value === null) return undefined;
  const seconds = toBigInt(typeof value === "object" ? value.secs ?? value.seconds : value);
  return seconds === undefined ? undefined : Number(seconds);
}

function toBigInt(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : undefined;
  if (typeof value !== "string" || value.length === 0) return undefined;
  try {
    return BigInt(value);
  } catch {
    return undefined;
  }
}

function sameHex(left, right) {
  return stripHexPrefix(String(left)).toLowerCase() === stripHexPrefix(String(right)).toLowerCase();
}

function stripHexPrefix(value) {
  return value.startsWith("0x") || value.startsWith("0X") ? value.slice(2) : value;
}
