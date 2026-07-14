import React from "react";
import { Image, Pressable, Text, View } from "react-native";

export function OfferQR({ offerId, resolverUrl, payload = "link", paymentLink, size = 200, onCopy }) {
  const qrUrl = offerQrUrl(offerId, resolverUrl, payload);
  const link = paymentLink ?? `${String(resolverUrl).replace(/\/$/, "")}/pay/${offerId}`;
  return React.createElement(View, null,
    React.createElement(Image, { source: { uri: qrUrl }, style: { width: size, height: size }, accessibilityLabel: "Fiber Offer QR code" }),
    React.createElement(Text, { selectable: true }, link),
    React.createElement(Pressable, { onPress: () => onCopy?.(link), accessibilityRole: "button" }, React.createElement(Text, null, "Copy"))
  );
}

function offerQrUrl(offerId, resolverUrl, payload) {
  if (!/^0x[0-9a-f]{64}$/.test(offerId)) throw new Error("offerId must be a canonical Fiber Offer ID");
  return `${String(resolverUrl).replace(/\/$/, "")}/offers/${offerId}/qr.svg?payload=${payload === "offer" ? "offer" : "link"}`;
}

export function RecurringApproval({ offer, onApprove, onRevoke, approved = false }) {
  const terms = offer?.recurrence;
  if (!terms) throw new Error("RecurringApproval requires an offer with recurrence terms");
  const caps = [
    terms.cap_cycles === undefined ? undefined : `${terms.cap_cycles} cycles`,
    terms.spending_cap_total === undefined ? undefined : `${terms.spending_cap_total} total`
  ].filter(Boolean);
  const cap = caps.join(" / ");
  return React.createElement(View, { accessibilityLabel: "Recurring payment approval" },
    React.createElement(Text, null, offer.description ?? "Recurring Fiber payment"),
    React.createElement(Text, null, `${terms.amount} ${offer.assets?.[0]?.symbol ?? ""} per ${terms.interval}`),
    React.createElement(Text, null, `Spending cap: ${cap || "Required"}`),
    React.createElement(
      Pressable,
      { onPress: approved ? onRevoke : onApprove, disabled: !approved && !cap, accessibilityRole: "button" },
      React.createElement(Text, null, approved ? "Revoke approval" : "Approve recurring payment")
    )
  );
}
