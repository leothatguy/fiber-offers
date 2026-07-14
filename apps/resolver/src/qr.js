import QRCode from "qrcode";

const validPayloads = new Set(["link", "offer"]);

export async function renderOfferQrSvg(entry, origin, payloadType = "link") {
  const normalizedPayloadType = validPayloads.has(payloadType) ? payloadType : "link";
  const payload =
    normalizedPayloadType === "offer" ? entry.encoded_offer : `${origin}/pay/${entry.offer.offer_id}`;

  const svg = await QRCode.toString(payload, {
    type: "svg",
    errorCorrectionLevel: normalizedPayloadType === "offer" ? "M" : "Q",
    margin: 2,
    width: 256,
    color: {
      dark: "#15201cff",
      light: "#ffffffff"
    }
  });

  return {
    svg,
    payload,
    payload_type: normalizedPayloadType
  };
}
