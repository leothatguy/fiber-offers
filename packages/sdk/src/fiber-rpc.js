import { fetchText, normalizeTimeoutMs } from "./http.js";

export const DEFAULT_FIBER_RPC_TIMEOUT_MS = 15000;

// The one JSON-RPC client used by the SDK and the resolver. Every failure is
// thrown as an Error carrying:
//   kind       "transport" | "timeout" | "http" | "rpc" | "invalid_response"
//   retryable  whether repeating the same call could succeed
//   code       the node's JSON-RPC error code for kind "rpc", otherwise a
//              FIBER_RPC_* string
// so callers can tell "the node is unreachable, try again" apart from "the node
// refused this request".
export class FiberRpcClient {
  constructor(options = {}) {
    if (!options.url) throw new Error("FiberRpcClient requires a url");

    this.url = trimTrailingSlash(options.url);
    this.username = options.username;
    this.password = options.password;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = normalizeTimeoutMs(options.timeoutMs, DEFAULT_FIBER_RPC_TIMEOUT_MS);

    if (typeof this.fetchImpl !== "function") {
      throw new Error("FiberRpcClient requires a fetch implementation");
    }
  }

  async call(method, params = []) {
    let response;
    let text;
    try {
      ({ response, text } = await fetchText(
        this.fetchImpl,
        this.url,
        {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            ...authHeaders(this.username, this.password)
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: requestId(),
            method,
            params
          })
        },
        this.timeoutMs
      ));
    } catch (error) {
      const timedOut = error?.kind === "timeout";
      throw this.#failure(method, {
        kind: timedOut ? "timeout" : "transport",
        code: timedOut ? "FIBER_RPC_TIMEOUT" : "FIBER_RPC_UNREACHABLE",
        message: timedOut
          ? `Fiber RPC ${method} timed out after ${this.timeoutMs}ms`
          : `Fiber RPC ${method} could not reach the node: ${error?.message ?? "request failed"}`,
        retryable: true,
        cause: error,
        details: { cause_code: error?.cause?.code ?? error?.code }
      });
    }

    let body;
    let parsed = true;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = false;
    }

    if (body?.error) {
      throw this.#failure(method, {
        kind: "rpc",
        code: body.error.code ?? "FIBER_RPC_ERROR",
        message: body.error.message ?? `Fiber RPC ${method} returned an error`,
        retryable: false,
        details: { error: body.error }
      });
    }

    if (!response.ok) {
      throw this.#failure(method, {
        kind: "http",
        code: "FIBER_RPC_HTTP_ERROR",
        message: `Fiber RPC ${method} failed with HTTP ${response.status}`,
        retryable: response.status >= 500 || response.status === 429,
        httpStatus: response.status,
        details: { http_status: response.status, error: body }
      });
    }

    if (!parsed || body === null || typeof body !== "object" || !("result" in body)) {
      throw this.#failure(method, {
        kind: "invalid_response",
        code: "FIBER_RPC_INVALID_RESPONSE",
        message: `Fiber RPC ${method} did not return a JSON-RPC result`,
        retryable: false,
        details: {}
      });
    }

    return body.result;
  }

  #failure(method, fields) {
    const error = new Error(fields.message);
    error.name = "FiberRpcError";
    error.kind = fields.kind;
    error.code = fields.code;
    error.retryable = fields.retryable;
    // 502 keeps the long-standing "bad gateway" meaning for servers that
    // surface this error directly.
    error.status = 502;
    if (fields.httpStatus !== undefined) error.http_status = fields.httpStatus;
    if (fields.cause) error.cause = fields.cause;
    error.details = { method, url: this.url, ...fields.details };
    return error;
  }
}

function authHeaders(username, password) {
  if (!username && !password) return {};
  return {
    authorization: `Basic ${base64Encode(`${username ?? ""}:${password ?? ""}`)}`
  };
}

function trimTrailingSlash(value) {
  return String(value).replace(/\/+$/, "");
}

function requestId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function base64Encode(value) {
  if (typeof globalThis.btoa === "function") return globalThis.btoa(value);
  if (typeof globalThis.Buffer?.from === "function") return globalThis.Buffer.from(value).toString("base64");
  throw new Error("base64 encoding is not available in this runtime");
}
