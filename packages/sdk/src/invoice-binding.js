// Ties a Fiber invoice to the offer and resolution it was issued for.
//
// A merchant node issues invoices for many offers. Without a binding, a
// resolver could hand a payer a genuine invoice from the right node, for the
// right amount, that belongs to someone else's order, and the merchant would
// credit that order instead. The resolver therefore writes a commitment into
// the invoice description, which the node signs as part of the invoice, and the
// payer checks it against the offer it holds.
//
//   <human description> (fiberoffer:<offer_id>:<resolution_id>)
//
// The commitment is always the last thing in the description. An offer's own
// description is free text and may contain anything, so only a commitment at
// the very end counts.

// A Fiber node rejects an invoice description longer than 639 bytes of UTF-8
// (observed on v0.10.1). The commitment is never shortened; the human part is
// cut to fit, and kept short enough to read in a wallet.
export const MAX_INVOICE_DESCRIPTION_BYTES = 639;
const MAX_HUMAN_DESCRIPTION_BYTES = 300;
const BINDING_PATTERN = /fiberoffer:(0x[0-9a-f]{64})(?::(res_[A-Za-z0-9-]+))?\)?$/;
const encoder = new TextEncoder();

export function formatInvoiceDescription(offer, resolutionId = undefined) {
  const commitment = `fiberoffer:${offer.offer_id}${resolutionId ? `:${resolutionId}` : ""}`;
  const human = typeof offer.description === "string" ? offer.description.trim() : "";
  if (human.length === 0) return commitment;
  const suffix = ` (${commitment})`;
  const budget = Math.min(MAX_HUMAN_DESCRIPTION_BYTES, MAX_INVOICE_DESCRIPTION_BYTES - encoder.encode(suffix).length);
  return `${truncateToBytes(human, budget)}${suffix}`;
}

// Shortens text to at most `maxBytes` of UTF-8, on a character boundary, with
// an ellipsis when anything was removed.
function truncateToBytes(text, maxBytes) {
  if (encoder.encode(text).length <= maxBytes) return text;
  const ellipsis = "…";
  const limit = maxBytes - encoder.encode(ellipsis).length;
  let kept = "";
  let used = 0;
  for (const character of text) {
    const size = encoder.encode(character).length;
    if (used + size > limit) break;
    kept += character;
    used += size;
  }
  return `${kept.trimEnd()}${ellipsis}`;
}

// Returns { offer_id, resolution_id? } for a description that ends with a
// commitment, otherwise undefined.
export function parseInvoiceBinding(description) {
  if (typeof description !== "string") return undefined;
  const match = BINDING_PATTERN.exec(description.trim());
  if (!match) return undefined;
  return { offer_id: match[1], ...(match[2] ? { resolution_id: match[2] } : {}) };
}
