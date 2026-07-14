import {
  FiberOffersClient,
  FiberPaymentClient,
  FiberPaymentFlowClient,
  FiberRecurringPaymentScheduler,
  JsonFileRecurringApprovalStore
} from "@fiber-offers/sdk/node";

const resolverUrl = requiredEnv("RESOLVER_URL");
const payerRpcUrl = requiredEnv("PAYER_FIBER_RPC_URL");
const store = new JsonFileRecurringApprovalStore(
  process.env.FIBER_RECURRING_APPROVAL_STORE ?? ".fiber-offers/payer-approvals.json"
);
const resolver = new FiberOffersClient({ resolverUrl });
const paymentClient = new FiberPaymentClient({
  url: payerRpcUrl,
  username: process.env.PAYER_FIBER_RPC_USERNAME,
  password: process.env.PAYER_FIBER_RPC_PASSWORD
});
const paymentFlow = new FiberPaymentFlowClient({ resolverClient: resolver, paymentClient });
const scheduler = new FiberRecurringPaymentScheduler({
  resolverClient: resolver,
  paymentFlow,
  store,
  intervalMs: numberEnv("FIBER_RECURRING_POLL_MS", 1000),
  retryDelayMs: numberEnv("FIBER_RECURRING_RETRY_MS", 30000),
  maxConsecutiveFailures: numberEnv("FIBER_RECURRING_MAX_FAILURES", 8),
  onEvent(event) {
    console.info(JSON.stringify(event));
  }
});

const offer = process.env.FIBER_RECURRING_OFFER;
const approvals = await store.list();
if (offer && approvals.every((approval) => approval.offer_id !== offer && approval.offer?.offer_id !== offer)) {
  const approval = await scheduler.approve(offer, {
    startAt: process.env.FIBER_RECURRING_START_AT
  });
  console.info(JSON.stringify({ event: "approval.created", approval_id: approval.id, offer_id: approval.offer_id }));
}

if ((await store.list()).length === 0) {
  throw new Error("no recurring approvals found; set FIBER_RECURRING_OFFER for the first run");
}

scheduler.start();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    scheduler.stop();
    console.info(JSON.stringify({ event: "recurrence_worker.stopped", signal }));
    process.exit(0);
  });
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}
