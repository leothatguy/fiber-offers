import { createInvoiceAdapter } from "../apps/resolver/src/invoice-adapter.js";

if (!process.env.FIBER_RPC_URL) {
  console.error("FIBER_RPC_URL is required for a live Fiber invoice check");
  console.error("Example: FIBER_RPC_URL=http://127.0.0.1:8227 npm run fiber:invoice-check");
  process.exit(1);
}

const amount = process.env.FIBER_CHECK_AMOUNT ?? "100000000";
const description =
  process.env.FIBER_CHECK_DESCRIPTION ?? `Fiber Offers live invoice check ${new Date().toISOString()}`;
const getInvoiceMethod = process.env.FIBER_RPC_GET_INVOICE_METHOD ?? "get_invoice";
const adapter = createInvoiceAdapter(process.env);

let stage = "probe";

try {
  const probe = await adapter.probe();
  if (!probe.reachable) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          stage,
          probe
        },
        null,
        2
      )
    );
    process.exit(1);
  }

  stage = "new_invoice";
  const invoice = await adapter.createInvoice({
    offer: {
      offer_id: "live-fiber-invoice-check",
      description
    },
    amount,
    asset: { asset_type: "ckb", symbol: "CKB" }
  });

  if (!invoice.payment_hash) {
    throw liveCheckError("Fiber invoice response did not include a payment_hash", {
      invoice
    });
  }

  stage = "get_invoice";
  const fiberInvoice = await adapter.client.call(getInvoiceMethod, [
    {
      payment_hash: invoice.payment_hash
    }
  ]);

  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: invoice.mode,
        mocked: invoice.mocked,
        rpc_url: process.env.FIBER_RPC_URL,
        amount,
        invoice_prefix: invoice.invoice.slice(0, 24),
        invoice_length: invoice.invoice.length,
        payment_hash: invoice.payment_hash,
        get_invoice_method: getInvoiceMethod,
        fiber_invoice_status: fiberInvoice.status,
        fiber_amount: fiberInvoice.invoice?.amount,
        fiber_currency: fiberInvoice.invoice?.currency
      },
      null,
      2
    )
  );
} catch (error) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        stage,
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

function liveCheckError(message, details) {
  const error = new Error(message);
  error.code = "LIVE_FIBER_INVOICE_CHECK_FAILED";
  error.details = details;
  return error;
}
