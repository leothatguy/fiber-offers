// How a Fiber Offer's `network` relates to what a Fiber node reports and to the
// currency code inside the invoices it issues.

// Fiber invoice currency codes: one per CKB chain, for every asset. A UDT
// invoice uses the same code and names its token in `udt_type_script`.
export const FIBER_CURRENCIES = Object.freeze({
  mainnet: "Fibb",
  testnet: "Fibt",
  dev: "Fibd"
});

// Genesis block hashes of the public CKB chains. A Fiber node reports the chain
// it follows as `node_info.chain_hash`.
const KNOWN_CHAIN_HASHES = Object.freeze({
  "0x92b197aa1fba0f63633922c61c92375c9c074a93e85963554f5499fe1450d0e5": "mainnet",
  "0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606": "testnet"
});

export function fiberCurrencyForNetwork(network) {
  const currency = FIBER_CURRENCIES[network];
  if (!currency) {
    const error = new Error("network must be mainnet, testnet, or dev");
    error.code = "UNSUPPORTED_NETWORK";
    throw error;
  }
  return currency;
}

export function networkForFiberCurrency(currency) {
  return Object.keys(FIBER_CURRENCIES).find((network) => FIBER_CURRENCIES[network] === currency);
}

// Returns "mainnet" or "testnet" for a recognised chain, otherwise undefined.
// An unrecognised hash is a private or development chain; it is reported as
// unknown rather than assumed to be "dev", so a caller only acts on a mismatch
// it can actually prove.
export function networkForChainHash(chainHash) {
  if (typeof chainHash !== "string" || chainHash.length === 0) return undefined;
  const normalized = chainHash.toLowerCase();
  return KNOWN_CHAIN_HASHES[normalized.startsWith("0x") ? normalized : `0x${normalized}`];
}

// The network a node serves: an explicit setting wins, otherwise it is read
// from the node's chain hash when that is a public chain.
export function fiberNodeNetwork(nodeInfo, configuredNetwork = undefined) {
  if (configuredNetwork) {
    fiberCurrencyForNetwork(configuredNetwork);
    return { network: configuredNetwork, source: "config" };
  }
  const network = networkForChainHash(nodeInfo?.chain_hash);
  return network ? { network, source: "chain_hash" } : { network: undefined, source: undefined };
}
