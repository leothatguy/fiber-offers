import { FiberOffersClient, FiberPaymentClient, FiberPaymentFlowClient } from "@fiber-offers/sdk";

const resolverUrl = process.env.RESOLVER_URL ?? "http://127.0.0.1:8787";
const payerRpcUrl = process.env.PAYER_FIBER_RPC_URL;

const resolver = new FiberOffersClient({ resolverUrl });
const paymentClient = payerRpcUrl ? new FiberPaymentClient({ url: payerRpcUrl }) : undefined;
const flow = new FiberPaymentFlowClient({ resolverClient: resolver, paymentClient });

const offer = await resolver.demoCreateOffer({
  username: "wallet-example",
  description: "Wallet SDK example",
  amount_min: "1000",
  amount_max: "50000000"
});

const request = {
  amount: process.env.FIBER_PAYMENT_AMOUNT ?? "1200",
  asset: { asset_type: "ckb", symbol: "CKB" },
  payer_note: "wallet example dry-run"
};

const prepared = await flow.preparePayment(offer.offer_id, request, {
  timeoutSeconds: 60,
  maxFeeAmount: process.env.FIBER_MAX_FEE_AMOUNT ?? "100000"
});

console.log(
  JSON.stringify(
    {
      resolver_url: resolverUrl,
      offer_id: offer.offer_id,
      payment_link: offer.payment_link,
      status: prepared.status,
      ready: prepared.readiness?.ready,
      payable: prepared.readiness?.payable,
      confidence: prepared.readiness?.confidence,
      next_action: prepared.next_action,
      resolution_id: prepared.invoice?.resolution_id,
      payment_hash: prepared.route_check?.payment_hash,
      failure: prepared.failure
    },
    null,
    2
  )
);

if (!payerRpcUrl) {
  console.log("Set PAYER_FIBER_RPC_URL to let the example run a payer-side Fiber dry-run.");
}
