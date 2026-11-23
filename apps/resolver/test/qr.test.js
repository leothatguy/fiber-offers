import assert from "node:assert/strict";
import test from "node:test";
import QRCode from "qrcode";
import { createSignedOffer, decodeOffer, encodeOffer, generateOfferKeyPair } from "../../../packages/protocol/src/index.js";
import { renderOfferQrSvg } from "../src/qr.js";

test("an offer QR code carries the uppercase form, which makes it smaller", async () => {
  const keys = generateOfferKeyPair();
  const offer = createSignedOffer(
    {
      node_id: `02${"a".repeat(64)}`,
      public_key: keys.publicKeyPem,
      resolver_url: "https://offers.merchant.example",
      description: "Coffee checkout",
      amount_min: "100000000",
      amount_max: "100000000",
      assets: [{ asset_type: "ckb", symbol: "CKB" }]
    },
    keys.privateKeyPem
  );
  const entry = { offer, encoded_offer: encodeOffer(offer) };

  const rendered = await renderOfferQrSvg(entry, "https://offers.merchant.example", "offer");
  assert.equal(rendered.payload, entry.encoded_offer.toUpperCase());
  // A wallet that scans it gets the same offer back.
  assert.deepEqual(decodeOffer(rendered.payload), offer);

  // Uppercase letters and digits use the QR alphanumeric mode: 5.5 bits a
  // character instead of 8.
  const options = { errorCorrectionLevel: "M" };
  const lowercase = QRCode.create(entry.encoded_offer, options);
  const uppercase = QRCode.create(rendered.payload, options);
  assert.equal(uppercase.segments[0].mode.id, "Alphanumeric");
  assert.ok(
    uppercase.version < lowercase.version,
    `uppercase is version ${uppercase.version}, lowercase is version ${lowercase.version}`
  );
  console.log(`  offer QR: version ${lowercase.version} in lowercase, version ${uppercase.version} in uppercase`);

  // The link QR is unchanged.
  const link = await renderOfferQrSvg(entry, "https://offers.merchant.example", "link");
  assert.equal(link.payload, `https://offers.merchant.example/pay/${offer.offer_id}`);
});
