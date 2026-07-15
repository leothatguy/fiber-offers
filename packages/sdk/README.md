# @fiber-offers/sdk

JavaScript SDK for Fiber Offers on the Nervos Fiber Network.

Use it to create and register offers, resolve stable offers into fresh Fiber
invoices, pay invoices through a Fiber node, inspect payment readiness and
topology, synchronize settlement, and run payer-owned recurring approvals.

## Install

```sh
npm install @fiber-offers/sdk
```

Node.js 20 or newer is required for the core cryptographic offer operations.

## Resolver client

```js
import { FiberOffersClient } from "@fiber-offers/sdk";

const client = new FiberOffersClient({
  resolverUrl: "https://fiber-offers.example.com",
  apiKey: process.env.FIBER_OFFERS_API_KEY
});

const offers = await client.listOffers();
```

## Pay through a Fiber node

```js
import { FiberPaymentClient } from "@fiber-offers/sdk";

const payer = new FiberPaymentClient({
  url: "http://127.0.0.1:8227"
});

const readiness = await payer.checkPaymentRoute(invoice);
if (readiness.payable) {
  const result = await payer.sendPayment(invoice);
  console.log(result);
}
```

The SDK coordinates Fiber Offers but does not replace a Fiber node. Creating a
real merchant invoice or sending a real payment requires access to a compatible
Fiber node or wallet provider.

Additional entry points are available for Node recurrence persistence, React,
and React Native:

```js
import { JsonFileRecurringApprovalStore } from "@fiber-offers/sdk/node";
import { OfferQR } from "@fiber-offers/sdk/react";
```

See the [complete SDK guide](https://github.com/leothatguy/fiber-offers/blob/main/docs/sdk.md)
and [examples](https://github.com/leothatguy/fiber-offers/tree/main/examples).

## License

MIT
