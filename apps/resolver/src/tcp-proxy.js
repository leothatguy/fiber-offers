import { createConnection, createServer } from "node:net";
import { unlinkSync } from "node:fs";

const listenPath = process.env.PROXY_LISTEN_PATH;
const listenHost = process.env.PROXY_LISTEN_HOST ?? "127.0.0.1";
const listenPort = port(process.env.PROXY_LISTEN_PORT, 18227);
const targetPath = process.env.PROXY_TARGET_PATH;
const targetHost = process.env.PROXY_TARGET_HOST ?? "127.0.0.1";
const targetPort = port(process.env.PROXY_TARGET_PORT, 8227);

if (listenPath) unlinkIfPresent(listenPath);

const server = createServer((client) => {
  const target = targetPath ? createConnection(targetPath) : createConnection(targetPort, targetHost);
  client.pipe(target);
  target.pipe(client);
  client.on("error", () => target.destroy());
  target.on("error", () => client.destroy());
});

server.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});

server.listen(listenPath ?? { port: listenPort, host: listenHost }, () => {
  console.info(JSON.stringify({
    event: "tcp_proxy_started",
    listen: listenPath ?? `${listenHost}:${listenPort}`,
    target: targetPath ?? `${targetHost}:${targetPort}`
  }));
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close(() => {
    if (listenPath) unlinkIfPresent(listenPath);
    process.exit(0);
  }));
}

function port(value, fallback) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error("proxy ports must be integers between 1 and 65535");
  }
  return parsed;
}

function unlinkIfPresent(path) {
  try {
    unlinkSync(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
