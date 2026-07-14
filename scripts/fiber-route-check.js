import { FiberNodeDiagnosticsClient, FiberPaymentClient } from "../packages/sdk/src/index.js";

const payerRpcUrl = process.env.PAYER_FIBER_RPC_URL ?? process.env.FIBER_RPC_URL ?? "http://127.0.0.1:8229";
const invoice = process.env.FIBER_INVOICE ?? process.argv[2];
const timeoutSeconds = Number(process.env.FIBER_ROUTE_TIMEOUT_SECONDS ?? 60);
const maxFeeAmount = process.env.FIBER_ROUTE_MAX_FEE_AMOUNT;
const maxFeeRate = process.env.FIBER_ROUTE_MAX_FEE_RATE;
const trampolineHops = csvList(process.env.FIBER_ROUTE_TRAMPOLINE_HOPS);

if (!invoice) {
  console.error("Fiber invoice is required");
  console.error("Example: FIBER_INVOICE=fibt1... PAYER_FIBER_RPC_URL=http://127.0.0.1:8229 npm run fiber:route-check");
  process.exit(1);
}

const diagnosticsClient = new FiberNodeDiagnosticsClient({ url: payerRpcUrl });
const paymentClient = new FiberPaymentClient({ url: payerRpcUrl });

try {
  const diagnostics = await diagnosticsClient.payerDiagnostics();
  const route = await paymentClient.checkPaymentRoute(invoice, {
    timeoutSeconds,
    ...(maxFeeAmount ? { maxFeeAmount } : {}),
    ...(maxFeeRate ? { maxFeeRate } : {}),
    ...(trampolineHops.length > 0 ? { trampolineHops } : {}),
    diagnostics
  });

  console.log(
    JSON.stringify(
      {
        ok: route.ok,
        payable: route.payable,
        payer_rpc_url: payerRpcUrl,
        payment_hash: route.payment_hash,
        fee: route.fee,
        routers: route.routers,
        failure: route.failure,
        params: route.params,
        diagnostics
      },
      null,
      2
    )
  );

  if (!route.ok) process.exit(1);
} catch (error) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        payable: false,
        payer_rpc_url: payerRpcUrl,
        error: {
          code: error.code,
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
