// The resolver uses the SDK's JSON-RPC client so timeouts and error
// classification are implemented once.
export { FiberRpcClient } from "../../../packages/sdk/src/fiber-rpc.js";

export function toHexQuantity(value) {
  return `0x${BigInt(value).toString(16)}`;
}

export function assetToFiberCurrency(asset) {
  if (asset.asset_type === "ckb") return "Fibt";
  return asset.type_script_hash;
}
