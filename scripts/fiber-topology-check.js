import { FiberTopologyClient } from "../packages/sdk/src/index.js";

const merchantRpcUrl = process.env.MERCHANT_FIBER_RPC_URL ?? process.env.FIBER_RPC_URL ?? "http://127.0.0.1:8227";
const payerRpcUrl = process.env.PAYER_FIBER_RPC_URL ?? "http://127.0.0.1:8229";
const invoice = process.env.FIBER_INVOICE ?? process.argv[2];
const strict = process.env.FIBER_TOPOLOGY_STRICT === "true";
const timeoutSeconds = Number(process.env.FIBER_ROUTE_TIMEOUT_SECONDS ?? 60);
const maxFeeAmount = process.env.FIBER_ROUTE_MAX_FEE_AMOUNT;
const maxFeeRate = process.env.FIBER_ROUTE_MAX_FEE_RATE;
const trampolineHops = csvList(process.env.FIBER_ROUTE_TRAMPOLINE_HOPS);

const topology = new FiberTopologyClient({
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

try {
  const report = invoice
    ? await topology.checkInvoiceRoute(invoice, {
        timeoutSeconds,
        ...(maxFeeAmount ? { maxFeeAmount } : {}),
        ...(maxFeeRate ? { maxFeeRate } : {}),
        ...(trampolineHops.length > 0 ? { trampolineHops } : {})
      })
    : await topology.inspectPair();

  console.log(
    JSON.stringify(
      {
        ...report,
        checked_invoice: invoice ? true : false,
        merchant_rpc_url: merchantRpcUrl,
        payer_rpc_url: payerRpcUrl
      },
      null,
      2
    )
  );

  if (strict && (!report.ok || report.route_check?.ok === false)) process.exit(1);
} catch (error) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        status: "error",
        merchant_rpc_url: merchantRpcUrl,
        payer_rpc_url: payerRpcUrl,
        error: {
          code: error.code ?? "FIBER_TOPOLOGY_CHECK_FAILED",
          message: error.message,
          details: error.details
        }
      },
      null,
      2
    )
  );
  process.exit(1);
}

function csvList(value) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
