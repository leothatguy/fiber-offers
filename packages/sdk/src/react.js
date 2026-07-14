import React from "react";

export function OfferQR({ offerId, resolverUrl, payload = "link", paymentLink, size = 200, className }) {
  const qrUrl = offerQrUrl(offerId, resolverUrl, payload);
  const link = paymentLink ?? `${String(resolverUrl).replace(/\/$/, "")}/pay/${offerId}`;
  const copy = () => globalThis.navigator?.clipboard?.writeText(link);
  return React.createElement(
    "figure",
    { className },
    React.createElement("img", { src: qrUrl, width: size, height: size, alt: "Fiber Offer QR code" }),
    React.createElement(
      "figcaption",
      null,
      React.createElement("a", { href: link }, link),
      React.createElement("button", { type: "button", onClick: copy, "aria-label": "Copy Fiber Offer payment link" }, "Copy")
    )
  );
}

function offerQrUrl(offerId, resolverUrl, payload) {
  if (!/^0x[0-9a-f]{64}$/.test(offerId)) throw new Error("offerId must be a canonical Fiber Offer ID");
  return `${String(resolverUrl).replace(/\/$/, "")}/offers/${offerId}/qr.svg?payload=${payload === "offer" ? "offer" : "link"}`;
}

export function RecurringApproval({ offer, onApprove, onRevoke, approved = false, className }) {
  const terms = offer?.recurrence;
  if (!terms) throw new Error("RecurringApproval requires an offer with recurrence terms");
  const cap = recurrenceCapLabel(terms);
  return React.createElement(
    "section",
    { className, "aria-label": "Recurring payment approval" },
    React.createElement("h2", null, offer.description ?? "Recurring Fiber payment"),
    React.createElement("dl", null,
      fact("Amount per cycle", `${terms.amount} ${offer.assets?.[0]?.symbol ?? ""}`.trim()),
      fact("Interval", terms.interval === "custom_seconds" ? `Every ${terms.custom_seconds} seconds` : terms.interval),
      fact("Spending cap", cap ?? "Required")
    ),
    approved
      ? React.createElement("button", { type: "button", onClick: onRevoke }, "Revoke approval")
      : React.createElement("button", { type: "button", onClick: onApprove, disabled: !cap }, "Approve recurring payment")
  );
}

function fact(label, value) {
  return React.createElement(React.Fragment, { key: label }, React.createElement("dt", null, label), React.createElement("dd", null, value));
}

function recurrenceCapLabel(terms) {
  const caps = [];
  if (terms.cap_cycles !== undefined) caps.push(`${terms.cap_cycles} cycles`);
  if (terms.spending_cap_total !== undefined) caps.push(`${terms.spending_cap_total} total`);
  return caps.length > 0 ? caps.join(" / ") : undefined;
}
