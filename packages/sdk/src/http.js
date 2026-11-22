// Runs a fetch and reads the whole body under one deadline. The timer stays
// armed until the body has been read, because a peer can send headers promptly
// and then stall. Uses AbortController rather than AbortSignal.timeout so it
// works in runtimes that lack the latter (older React Native engines).
export async function fetchText(fetchImpl, url, init = {}, timeoutMs = 0) {
  if (!timeoutMs) {
    const response = await fetchImpl(url, init);
    return { response, text: await response.text() };
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await raceAbort(fetchImpl(url, { ...init, signal: controller.signal }), controller.signal);
    const text = await raceAbort(response.text(), controller.signal);
    return { response, text };
  } catch (error) {
    if (!timedOut) throw error;
    const timeout = new Error(`request timed out after ${timeoutMs}ms`);
    timeout.code = "REQUEST_TIMEOUT";
    timeout.kind = "timeout";
    timeout.cause = error;
    throw timeout;
  } finally {
    clearTimeout(timer);
  }
}

export function normalizeTimeoutMs(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

// A fetch implementation that ignores the abort signal would otherwise hang
// forever, so the deadline is also enforced here.
function raceAbort(promise, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error("request aborted"));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}
