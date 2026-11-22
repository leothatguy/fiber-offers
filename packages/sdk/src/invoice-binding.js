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

const MAX_HUMAN_DESCRIPTION_LENGTH = 200;
const BINDING_PATTERN = /fiberoffer:(0x[0-9a-f]{64})(?::(res_[A-Za-z0-9-]+))?\)?$/;

export function formatInvoiceDescription(offer, resolutionId = undefined) {
  const commitment = `fiberoffer:${offer.offer_id}${resolutionId ? `:${resolutionId}` : ""}`;
  const human = typeof offer.description === "string" ? offer.description.trim() : "";
  if (human.length === 0) return commitment;
  const shown =
    human.length > MAX_HUMAN_DESCRIPTION_LENGTH ? `${human.slice(0, MAX_HUMAN_DESCRIPTION_LENGTH - 1)}…` : human;
  return `${shown} (${commitment})`;
}

// Returns { offer_id, resolution_id? } for a description that ends with a
// commitment, otherwise undefined.
export function parseInvoiceBinding(description) {
  if (typeof description !== "string") return undefined;
  const match = BINDING_PATTERN.exec(description.trim());
  if (!match) return undefined;
  return { offer_id: match[1], ...(match[2] ? { resolution_id: match[2] } : {}) };
}
