import {
  FiberTopologyClient,
  analyzePaymentReadiness,
  planDirectChannelFixture
} from "@fiber-offers/sdk";

const merchant = process.env.MERCHANT_FIBER_RPC_URL;
const payer = process.env.PAYER_FIBER_RPC_URL;

if (!merchant || !payer) {
  throw new Error("Set MERCHANT_FIBER_RPC_URL and PAYER_FIBER_RPC_URL before running this read-only example.");
}

const topologyClient = new FiberTopologyClient({ merchant, payer });
const topology = await topologyClient.inspectPair();
const readiness = analyzePaymentReadiness({
  amount: process.env.FIBER_PAYMENT_AMOUNT ?? "1200",
  asset: { asset_type: "ckb", symbol: "CKB" },
  topology
});
const fixture = planDirectChannelFixture(topology, {
  fundingAmount: process.env.FIBER_FIXTURE_FUNDING_AMOUNT
});

console.log(
  JSON.stringify(
    {
      topology: {
        status: topology.status,
        summary: topology.summary,
        direct_channel_ready: topology.readiness.direct_channel_ready,
        shared_online_counterparty_count: topology.readiness.shared_online_counterparty_count,
        blockers: topology.blockers,
        warnings: topology.warnings
      },
      readiness: {
        ready: readiness.ready,
        payable: readiness.payable,
        confidence: readiness.confidence,
        next_action: readiness.next_action,
        next_actions: readiness.next_actions
      },
      direct_channel_fixture: {
        status: fixture.status,
        summary: fixture.summary,
        missing: fixture.missing,
        steps: fixture.steps
      }
    },
    null,
    2
  )
);
