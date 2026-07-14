import { createInvoiceAdapter } from "../apps/resolver/src/invoice-adapter.js";

if (!process.env.FIBER_RPC_URL) {
  console.error("FIBER_RPC_URL is required for a live Fiber RPC check");
  console.error("Example: FIBER_RPC_URL=http://127.0.0.1:8227 npm run fiber:check");
  process.exit(1);
}

const adapter = createInvoiceAdapter(process.env);
const probe = await adapter.probe();

console.log(JSON.stringify(probe, null, 2));

if (!probe.reachable) {
  process.exit(1);
}
