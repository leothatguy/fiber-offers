# @fiber-offers/protocol

Signed reusable payment offers for the Nervos Fiber Network.

The package implements the canonical Fiber Offer document, Ed25519 lifecycle
signatures, deterministic offer IDs, Bech32m `fbroffer1...` encoding, amount
and asset validation, recurrence policy, and signed revocations.

## Install

```sh
npm install @fiber-offers/protocol
```

Node.js 20 or newer is required.

## Example

```js
import {
  createSignedOffer,
  encodeOffer,
  generateOfferKeyPair,
  verifyOffer
} from "@fiber-offers/protocol";

const keys = generateOfferKeyPair();
const offer = createSignedOffer(
  {
    node_id: "03" + "00".repeat(32),
    network: "testnet",
    resolver_url: "https://fiber-offers.example.com",
    description: "Coffee",
    amount_min: "100000000",
    amount_max: "100000000",
    assets: [{ asset_type: "ckb", symbol: "CKB" }],
    single_use: false,
    public_key: keys.publicKeyPem
  },
  keys.privateKeyPem
);

console.log(verifyOffer(offer));
console.log(encodeOffer(offer));
```

Amounts are integer base units. One CKB is `100000000` shannons.

See the [complete protocol guide](https://github.com/leothatguy/fiber-offers/blob/main/docs/protocol.md)
and [V1 specification](https://github.com/leothatguy/fiber-offers/blob/main/docs/spec-v1.md)
for field rules, revocation, recurrence, security boundaries, and complete examples.

## License

MIT
