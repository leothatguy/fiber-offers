import {
  FiberRpcClient,
  FiberTopologyClient,
  fiberNodeError,
  planDirectChannelFixture
} from "../packages/sdk/src/index.js";

const merchantRpcUrl = process.env.MERCHANT_FIBER_RPC_URL ?? process.env.FIBER_RPC_URL ?? "http://127.0.0.1:8227";
const payerRpcUrl = process.env.PAYER_FIBER_RPC_URL ?? "http://127.0.0.1:8229";
const execute = process.env.FIBER_FIXTURE_OPEN_DIRECT_CHANNEL === "true";
const fundingAmount = process.env.FIBER_DIRECT_CHANNEL_FUNDING_AMOUNT;
const merchantPeerAddress = process.env.FIBER_MERCHANT_PEER_ADDRESS;
const publicChannel = envBoolean("FIBER_DIRECT_CHANNEL_PUBLIC", false);
const oneWay = envBoolean("FIBER_DIRECT_CHANNEL_ONE_WAY", false);

const topologyClient = new FiberTopologyClient({
  merchant: {
    url: merchantRpcUrl,
    username: process.env.MERCHANT_FIBER_RPC_USERNAME ?? process.env.FIBER_RPC_USERNAME,
    password: process.env.MERCHANT_FIBER_RPC_PASSWORD ?? process.env.FIBER_RPC_PASSWORD
  },
  payer: {
    url: payerRpcUrl,
    username: process.env.PAYER_FIBER_RPC_USERNAME ?? process.env.FIBER_RPC_USERNAME,
    password: process.env.PAYER_FIBER_RPC_PASSWORD ?? process.env.FIBER_RPC_PASSWORD
  }
});

const payerRpc = new FiberRpcClient({
  url: payerRpcUrl,
  username: process.env.PAYER_FIBER_RPC_USERNAME ?? process.env.FIBER_RPC_USERNAME,
  password: process.env.PAYER_FIBER_RPC_PASSWORD ?? process.env.FIBER_RPC_PASSWORD
});
const merchantRpc = new FiberRpcClient({
  url: merchantRpcUrl,
  username: process.env.MERCHANT_FIBER_RPC_USERNAME ?? process.env.FIBER_RPC_USERNAME,
  password: process.env.MERCHANT_FIBER_RPC_PASSWORD ?? process.env.FIBER_RPC_PASSWORD
});

try {
  const before = await topologyClient.inspectPair();
  const plan = planDirectChannelFixture(before, {
    merchantRpcUrl,
    payerRpcUrl,
    fundingAmount,
    merchantPeerAddress,
    publicChannel,
    oneWay
  });

  if (!execute || !["ready_to_execute", "ready_to_accept"].includes(plan.status)) {
    printResult({
      ok: plan.status !== "missing_input",
      mode: "plan",
      execute_required: plan.execute_guard,
      plan,
      topology: before
    });
    process.exit(plan.status === "missing_input" ? 1 : 0);
  }

  const executed = [];
  for (const step of plan.steps) {
    const rpc = step.rpc_url === merchantRpcUrl ? merchantRpc : payerRpc;
    executed.push({
      id: step.id,
      rpc_url: step.rpc_url,
      rpc_method: step.rpc_method,
      rpc_params: step.rpc_params,
      result: await callWhenPeerIsReady(rpc, step)
    });
  }

  const after = await topologyClient.inspectPair();
  printResult({
    ok: true,
    mode: "executed",
    executed,
    plan,
    topology_before: before,
    topology_after: after
  });
} catch (error) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        mode: execute ? "executed" : "plan",
        error: {
          code: error.code ?? "FIBER_DIRECT_CHANNEL_FIXTURE_FAILED",
          message: error.message,
          fiber_error: fiberNodeError(error)
        }
      },
      null,
      2
    )
  );
  process.exit(1);
}

// connect_peer returns before the two nodes have exchanged their Init
// messages, and until they have, the node refuses open_channel for that peer
// ("waiting for peer to send Init message"). Observed on Fiber v0.10.1. Channel
// steps are therefore retried for a short while on exactly that answer.
async function callWhenPeerIsReady(rpc, step) {
  const deadline = Date.now() + 30000;
  for (;;) {
    try {
      return await rpc.call(step.rpc_method, [step.rpc_params]);
    } catch (error) {
      const peerNotReady = /waiting for peer to send Init message|feature not found/i.test(error.message ?? "");
      if (!peerNotReady || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

function printResult(result) {
  console.log(JSON.stringify(result, null, 2));
}

function envBoolean(name, fallback) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}
