import { normalizeFiberPaymentFailure } from "./failures.js";

export class FiberRpcClient {
  constructor(options = {}) {
    if (!options.url) throw new Error("FiberRpcClient requires a url");

    this.url = trimTrailingSlash(options.url);
    this.username = options.username;
    this.password = options.password;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;

    if (typeof this.fetchImpl !== "function") {
      throw new Error("FiberRpcClient requires a fetch implementation");
    }
  }

  async call(method, params = []) {
    const response = await this.fetchImpl(this.url, {
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
    });
    const text = await response.text();
    const body = text ? JSON.parse(text) : undefined;

    if (!response.ok || body?.error) {
      const error = new Error(body?.error?.message ?? `Fiber RPC ${method} failed with HTTP ${response.status}`);
      error.code = body?.error?.code ?? "FIBER_RPC_ERROR";
      error.status = 502;
      error.details = {
        method,
        url: this.url,
        error: body?.error ?? body
      };
      throw error;
    }

    return body?.result;
  }
}

export class FiberPaymentClient {
  constructor(options = {}) {
    this.rpc = options.rpc ?? new FiberRpcClient(options);
  }

  async sendPayment(invoice, options = {}) {
    return this.rpc.call("send_payment", [fiberSendPaymentParams(invoice, options)]);
  }

  async dryRunPayment(invoice, options = {}) {
    return this.sendPayment(invoice, {
      ...options,
      dryRun: true
    });
  }

  async checkPaymentRoute(invoice, options = {}) {
    const stage = options.stage ?? "dry_run_payment";
    const params = fiberSendPaymentParams(invoice, {
      ...options,
      dryRun: true
    });

    try {
      const dryRun = await this.rpc.call("send_payment", [params]);
      return {
        ok: true,
        payable: true,
        stage,
        params,
        dry_run: dryRun,
        payment_hash: dryRun?.payment_hash,
        fee: dryRun?.fee,
        routers: dryRun?.routers
      };
    } catch (error) {
      return {
        ok: false,
        payable: false,
        stage,
        params,
        failure: normalizeFiberPaymentFailure(error, {
          stage,
          diagnostics: options.diagnostics
        })
      };
    }
  }

  async getPayment(paymentHash) {
    if (!paymentHash) throw new Error("payment_hash is required");
    return this.rpc.call("get_payment", [{ payment_hash: paymentHash }]);
  }
}

export function fiberSendPaymentParams(invoice, options = {}) {
  if (typeof invoice !== "string" || invoice.length === 0) {
    throw new Error("invoice is required");
  }

  return cleanUndefined({
    invoice,
    timeout: quantityOption(options, "timeout", "timeoutSeconds"),
    max_fee_amount: quantityOption(options, "max_fee_amount", "maxFeeAmount"),
    max_fee_rate: quantityOption(options, "max_fee_rate", "maxFeeRate"),
    max_parts: quantityOption(options, "max_parts", "maxParts"),
    trampoline_hops: arrayOption(options, "trampoline_hops", "trampolineHops"),
    hop_hints: options.hop_hints ?? options.hopHints,
    keysend: options.keysend,
    udt_type_script: options.udt_type_script ?? options.udtTypeScript,
    allow_self_payment: options.allow_self_payment ?? options.allowSelfPayment,
    custom_records: options.custom_records ?? options.customRecords,
    dry_run: options.dry_run ?? options.dryRun
  });
}

export function toFiberHexQuantity(value) {
  const text = String(value).trim();
  return text.startsWith("0x") ? text : `0x${BigInt(text).toString(16)}`;
}

export function toFiberDecimalQuantity(value) {
  const text = String(value).trim();
  return BigInt(text).toString(10);
}

function quantityOption(options, snakeKey, camelKey) {
  const value = options[snakeKey] ?? options[camelKey];
  return value === undefined || value === null ? undefined : toFiberHexQuantity(value);
}

function arrayOption(options, snakeKey, camelKey) {
  const value = options[snakeKey] ?? options[camelKey];
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value;
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function cleanUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
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
