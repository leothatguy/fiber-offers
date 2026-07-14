import { randomUUID } from "node:crypto";

export class FiberRpcClient {
  constructor(options) {
    if (!options?.url) throw new Error("FiberRpcClient requires a url");

    this.url = options.url;
    this.username = options.username;
    this.password = options.password;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;

    if (typeof this.fetchImpl !== "function") {
      throw new Error("FiberRpcClient requires a fetch implementation");
    }
  }

  async call(method, params = []) {
    const headers = {
      "content-type": "application/json",
      accept: "application/json"
    };

    if (this.username || this.password) {
      headers.authorization = `Basic ${Buffer.from(`${this.username ?? ""}:${this.password ?? ""}`).toString("base64")}`;
    }

    const response = await this.fetchImpl(this.url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: randomUUID(),
        method,
        params
      })
    });

    const body = await response.json();
    if (!response.ok || body.error) {
      const error = new Error(body.error?.message ?? `Fiber RPC failed with HTTP ${response.status}`);
      error.code = body.error?.code ?? "FIBER_RPC_ERROR";
      error.status = 502;
      error.details = body.error ?? body;
      throw error;
    }

    return body.result;
  }
}

export function toHexQuantity(value) {
  return `0x${BigInt(value).toString(16)}`;
}

export function assetToFiberCurrency(asset) {
  if (asset.asset_type === "ckb") return "Fibt";
  return asset.type_script_hash;
}
