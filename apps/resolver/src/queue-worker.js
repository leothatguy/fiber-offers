import { Queue, Worker } from "bullmq";
import Redis from "ioredis";
import { createServer } from "./server.js";

const queueName = process.env.RESOLVER_QUEUE_NAME ?? "fiber-offers-maintenance";
const redisUrl = process.env.REDIS_URL;

if (!redisUrl) throw new Error("REDIS_URL is required for the resolver queue worker");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for the resolver queue worker");

const connectionOptions = { maxRetriesPerRequest: null, enableReadyCheck: true };
const queueConnection = new Redis(redisUrl, connectionOptions);
const workerConnection = new Redis(redisUrl, connectionOptions);
const server = createServer({
  workers: false,
  rateLimiter: {
    take: async () => ({ allowed: true }),
    healthCheck: async () => ({ ok: true, backend: "worker-not-used" })
  }
});
const queue = new Queue(queueName, {
  connection: queueConnection,
  prefix: process.env.REDIS_KEY_PREFIX ?? "fiber-offers"
});

await Promise.all([
  queue.upsertJobScheduler(
    "settlement-sync",
    { every: interval("RESOLVER_SETTLEMENT_SYNC_INTERVAL_MS", 30000) },
    { name: "settlement-sync", opts: jobOptions() }
  ),
  queue.upsertJobScheduler(
    "webhook-delivery",
    { every: interval("RESOLVER_WEBHOOK_RETRY_INTERVAL_MS", 30000) },
    { name: "webhook-delivery", opts: jobOptions() }
  )
]);

const worker = new Worker(
  queueName,
  async (job) => {
    let result;
    if (job.name === "settlement-sync") result = await server.backgroundWorkers.runSettlementSyncPass();
    else if (job.name === "webhook-delivery") result = await server.backgroundWorkers.runWebhookDeliveryPass();
    else throw new Error(`unknown maintenance job: ${job.name}`);
    if (result?.failed === true && result.error) {
      const error = new Error(result.error.message);
      error.code = result.error.code;
      error.details = result.error.details;
      throw error;
    }
    return summarizeJobResult(job.name, result);
  },
  {
    connection: workerConnection,
    prefix: process.env.REDIS_KEY_PREFIX ?? "fiber-offers",
    concurrency: Number(process.env.RESOLVER_WORKER_CONCURRENCY ?? 2)
  }
);

worker.on("completed", (job, result) => {
  console.info(JSON.stringify({ event: "maintenance_job_completed", job: job.name, job_id: job.id, result }));
});
worker.on("failed", (job, error) => {
  console.error(JSON.stringify({ event: "maintenance_job_failed", job: job?.name, job_id: job?.id, error: error.message }));
});
worker.on("error", (error) => console.error(error));

console.info(JSON.stringify({ event: "queue_worker_started", queue: queueName }));

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.info(JSON.stringify({ event: "queue_worker_stopping", signal }));
  await worker.close();
  await queue.close();
  await server.store.close?.();
  await Promise.all([queueConnection.quit(), workerConnection.quit()]);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    shutdown(signal).then(() => process.exit(0), (error) => {
      console.error(error);
      process.exit(1);
    });
  });
}

function interval(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1000) throw new Error(`${name} must be an integer of at least 1000ms`);
  return value;
}

function jobOptions() {
  return {
    attempts: Number(process.env.RESOLVER_JOB_ATTEMPTS ?? 3),
    backoff: { type: "exponential", delay: 1000 },
    removeOnComplete: 100,
    removeOnFail: 500
  };
}

function summarizeJobResult(name, result) {
  if (name === "settlement-sync") {
    return pick(result, ["offers", "checked", "changed", "skipped", "failed", "reason", "invoice_mode"]);
  }
  if (name === "webhook-delivery") {
    return pick(result, ["offers", "attempted", "delivered", "failed"]);
  }
  return { ok: true };
}

function pick(value, keys) {
  return Object.fromEntries(keys.filter((key) => value?.[key] !== undefined).map((key) => [key, value[key]]));
}
