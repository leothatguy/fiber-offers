// Offers to compare implementations over: valid offers changed in one place,
// and offers produced from random terms. Used to hold the JSON Schema and the
// independent Python verifier to this package on far more cases than the
// fixed conformance vectors list.

// Offers one change away from a valid one. Most are wrong; some are another
// valid offer (an optional field removed, a different amount).
export function* mutations(offer) {
  const replacements = [
    null, true, false, 0, 1, -1, 1.5, 2 ** 53, "", " ", "0", "1", "01", "abc", "ABC", [], {}, [1], { a: 1 },
    "9".repeat(40)
  ];
  const clone = () => structuredClone(offer);
  const change = (edit) => {
    const copy = clone();
    edit(copy);
    return copy;
  };

  for (const path of pathsOf(offer)) {
    const label = path.join(".");
    yield [`${label} removed`, change((copy) => removeAt(copy, path))];
    for (const replacement of replacements) {
      yield [`${label} = ${JSON.stringify(replacement)}`, change((copy) => setAt(copy, path, replacement))];
    }
    const value = getAt(offer, path);
    if (typeof value === "string") {
      for (const [how, text] of [
        ["upper case", value.toUpperCase()],
        ["lower case", value.toLowerCase()],
        ["leading space", ` ${value}`],
        ["trailing space", `${value} `],
        ["trailing line break", `${value}\n`],
        ["trailing slash", `${value}/`],
        ["one character short", value.slice(0, -1)],
        ["one character more", `${value}0`],
        ["doubled", value + value],
        ["CRLF line ends", value.replaceAll("\n", "\r\n")]
      ]) {
        if (text !== value) yield [`${label} with ${how}`, change((copy) => setAt(copy, path, text))];
      }
    }
    if (typeof value === "number") {
      yield [`${label} as a string`, change((copy) => setAt(copy, path, String(value)))];
      yield [`${label} + 1`, change((copy) => setAt(copy, path, value + 1))];
    }
    // A list with a named member is not something JSON can carry.
    if (value && typeof value === "object" && !Array.isArray(value)) {
      yield [`${label} with an unknown member`, change((copy) => setAt(copy, [...path, "unexpected"], "x"))];
      yield [`${label} with a constructor member`, change((copy) => setAt(copy, [...path, "constructor"], "x"))];
    }
  }

  // Terms that are well formed one by one and wrong together, or over a size limit.
  const whole = [
    ["an unknown field", (copy) => (copy.unexpected = true)],
    ["an x_ field", (copy) => (copy.x_note = { a: [1, "two", null, true] })],
    ["an x_ field holding null", (copy) => (copy.x_note = null)],
    ["an x_ field holding a fraction", (copy) => (copy.x_note = 0.5)],
    ["extensions as a list", (copy) => (copy.extensions = [])],
    // `nested(n)` puts its leaf at depth n, counting the field's own value as 0.
    ...["metadata", "extensions", "x_deep"].flatMap((field) => [
      [`${field} reaching depth 8`, (copy) => (copy[field] = nested(8))],
      [`${field} reaching depth 9`, (copy) => (copy[field] = nested(9))],
      [`${field} with an empty list at depth 8`, (copy) => (copy[field] = nested(8, []))],
      [`${field} with a list of one at depth 8`, (copy) => (copy[field] = nested(8, [1]))],
      [`${field} with an empty object at depth 8`, (copy) => (copy[field] = nested(8, {}))]
    ]),
    ["metadata over 2,048 bytes", (copy) => (copy.metadata = { note: "x".repeat(2100) })],
    ["metadata with a forbidden key far down", (copy) => (copy.metadata = { a: [{ b: { prototype: 1 } }] })],
    ["an offer over 4,096 bytes", (copy) => Object.assign(copy, { metadata: { a: "x".repeat(2000) }, extensions: { a: "x".repeat(2000) } })],
    ["a description of 512 two-byte characters", (copy) => (copy.description = "é".repeat(512))],
    ["a description of 512 one-byte characters", (copy) => (copy.description = "e".repeat(512))],
    ["a description that is not well-formed Unicode", (copy) => (copy.description = "broken \ud800 text")],
    // Every character the format counts as white space, at each end, and some
    // that look like white space and are not.
    ...[0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2000, 0x2005, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff, 0x1c, 0x1f, 0x85, 0x180e, 0x200b, 0x2060].flatMap(
      (codePoint) => {
        const name = `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
        const character = String.fromCodePoint(codePoint);
        return [
          [`a description beginning with ${name}`, (copy) => (copy.description = `${character}text`)],
          [`a description ending with ${name}`, (copy) => (copy.description = `text${character}`)],
          [`a description with ${name} inside`, (copy) => (copy.description = `te${character}xt`)]
        ];
      }
    ),
    ["amount_min above amount_max", (copy) => Object.assign(copy, { amount_min: "10", amount_max: "9" })],
    ["amount_min equal to amount_max", (copy) => Object.assign(copy, { amount_min: "10", amount_max: "10" })],
    ["a cycle amount above amount_max", (copy) => Object.assign(copy, { single_use: false, amount_max: "5", recurrence: { interval: "daily", amount: "6", cap_cycles: 1 } })],
    ["a spending cap below one cycle", (copy) => Object.assign(copy, { single_use: false, amount_min: undefined, amount_max: undefined, recurrence: { interval: "daily", amount: "6", spending_cap_total: "5" } })],
    ["custom_seconds on a daily interval", (copy) => Object.assign(copy, { single_use: false, recurrence: { interval: "daily", amount: "6", cap_cycles: 1, custom_seconds: 60 } })],
    ["a custom interval without custom_seconds", (copy) => Object.assign(copy, { single_use: false, recurrence: { interval: "custom_seconds", amount: "6", cap_cycles: 1 } })],
    ["the same token under two symbols", (copy) => (copy.assets = [token("AAA", "1"), token("BBB", "1")])],
    ["two tokens", (copy) => (copy.assets = [token("AAA", "1"), token("AAA", "2")])],
    ["seventeen assets", (copy) => (copy.assets = Array.from({ length: 17 }, (_unused, index) => token("T", index.toString(16))))],
    ["sixteen assets", (copy) => (copy.assets = Array.from({ length: 16 }, (_unused, index) => token("T", index.toString(16))))],
    ["a ckb asset with a type script hash", (copy) => (copy.assets = [{ asset_type: "ckb", symbol: "CKB", type_script_hash: token("T", "1").type_script_hash }])],
    ["the default https port", (copy) => (copy.resolver_url = "https://offers.merchant.example:443")],
    ["another port", (copy) => (copy.resolver_url = "https://offers.merchant.example:8443")],
    ["a port with a leading zero", (copy) => (copy.resolver_url = "https://offers.merchant.example:08443")],
    ["a dot segment", (copy) => (copy.resolver_url = "https://offers.merchant.example/a/../b")],
    ["an empty segment", (copy) => (copy.resolver_url = "https://offers.merchant.example//a")],
    ["a percent-encoded segment", (copy) => (copy.resolver_url = "https://offers.merchant.example/a%20b")],
    ["a query", (copy) => (copy.resolver_url = "https://offers.merchant.example?x=1")],
    ["a fragment", (copy) => (copy.resolver_url = "https://offers.merchant.example#x")],
    ["an upper-case host", (copy) => (copy.resolver_url = "https://Offers.Merchant.Example")],
    ["an IPv4 host", (copy) => (copy.resolver_url = "https://203.0.113.7/offers")],
    ["an IPv6 host", (copy) => (copy.resolver_url = "https://[2001:db8::1]")],
    ["an IPv6 host written out in full", (copy) => (copy.resolver_url = "https://[2001:0db8:0000:0000:0000:0000:0000:0001]")],
    ["http to a public host", (copy) => (copy.resolver_url = "http://offers.merchant.example")],
    ["http to localhost", (copy) => (copy.resolver_url = "http://localhost:8080")],
    ["http to a name under localhost", (copy) => (copy.resolver_url = "http://shop.localhost")],
    ["http to a loopback address", (copy) => (copy.resolver_url = "http://127.0.0.1:8080/offers")],
    ["http to the IPv6 loopback address", (copy) => (copy.resolver_url = "http://[::1]:8080")],
    ["http to a host that only begins with 127", (copy) => (copy.resolver_url = "http://127.example.com")],
    ["another scheme", (copy) => (copy.resolver_url = "ftp://offers.merchant.example")],
    ...[
      ["the highest port", "https://offers.merchant.example:65535"],
      ["a port above 65535", "https://offers.merchant.example:65536"],
      ["the default http port", "http://localhost:80"],
      ["an empty port", "https://offers.merchant.example:"],
      ["a host ending in a number", "https://offers.merchant.123"],
      ["an IPv4 address of three parts", "https://203.0.113"],
      ["an IPv4 address with a leading zero", "https://203.0.113.07"],
      ["an IPv4 address out of range", "https://203.0.113.256"],
      ["an IPv4 address written as one number", "https://3405803783"],
      ["a host written as a hexadecimal number", "https://0xcb007107"],
      ["a host ending in a hexadecimal number", "https://offers.merchant.0x10"],
      ["a host ending in a label that only begins with a digit", "https://offers.merchant.1a"],
      ["an IPv6 host in upper case", "https://[2001:DB8::1]"],
      ["an IPv6 host with an IPv4 tail", "https://[::ffff:192.0.2.1]"],
      ["an IPv6 host with the shorter zero run compressed", "https://[2001:db8::1:0:0:0:1]"],
      ["an IPv6 host with the longer zero run compressed", "https://[2001:db8:0:1::1]"],
      ["an IPv6 host with one zero group compressed", "https://[2001:db8::1:1:1:1:1]"],
      ["an IPv6 host with one zero group written out", "https://[2001:db8:0:1:1:1:1:1]"],
      ["an IPv6 host with leading zeros in a group", "https://[2001:db8::01]"],
      ["an IPv6 host with nine groups", "https://[1:2:3:4:5:6:7:8:9]"],
      ["an IPv6 host with a zone", "https://[fe80::1%25eth0]"],
      ["the unspecified IPv6 address", "https://[::]"],
      ["an IPv6 host without brackets", "https://2001:db8::1"],
      ["http to the IPv6 loopback address written out", "http://[0:0:0:0:0:0:0:1]"],
      ["http to a short loopback address", "http://127.1"],
      ["http to a loopback address out of range", "http://127.0.0.256"],
      ["http to a host that ends in localhost without a dot", "http://notlocalhost"],
      ["a label ending in a hyphen", "https://offers-.merchant.example"],
      ["a label beginning with a hyphen", "https://-offers.merchant.example"],
      ["an underscore in the host", "https://my_shop.merchant.example"],
      ["a host ending in a dot", "https://offers.merchant.example."],
      ["an empty label", "https://offers..merchant.example"],
      ["no host", "https://"],
      ["a host of one label", "https://offers"],
      ["a host in its xn-- form", "https://xn--80ak6aa92e.example"],
      ["a host not in its xn-- form", "https://\u043e\u0444\u0444\u0435\u0440.example"],
      ["a tilde segment", "https://offers.merchant.example/~shop"],
      ["a segment of three dots", "https://offers.merchant.example/..."],
      ["a path ending in a dot segment", "https://offers.merchant.example/a/."],
      ["a percent-encoded dot segment", "https://offers.merchant.example/%2e%2e"],
      ["a backslash in the path", "https://offers.merchant.example/a\\b"],
      ["a space in the path", "https://offers.merchant.example/a b"],
      ["a tab inside the URL", "https://offers.merchant\t.example"],
      ["an upper-case scheme", "HTTPS://offers.merchant.example"],
      ["one slash after the scheme", "https:/offers.merchant.example"],
      ["an at sign and no user", "https://@offers.merchant.example"],
      ["a non-ASCII segment", "https://offers.merchant.example/caf\u00e9"]
    ].map(([label, url]) => [label, (copy) => (copy.resolver_url = url)]),
    ["a URL of 513 characters", (copy) => (copy.resolver_url = `https://offers.merchant.example/${"a".repeat(481)}`)],
    ["a URL of 512 characters", (copy) => (copy.resolver_url = `https://offers.merchant.example/${"a".repeat(480)}`)]
  ];
  for (const network of ["mainnet", "testnet", "dev"]) {
    for (const [label, edit] of whole) {
      yield [`${label}, on ${network}`, change((copy) => {
        copy.network = network;
        edit(copy);
        for (const field of Object.keys(copy)) if (copy[field] === undefined) delete copy[field];
      })];
    }
  }
}

function token(symbol, digit) {
  return { asset_type: "udt", symbol, type_script_hash: `0x${digit.repeat(64).slice(0, 64)}` };
}

function nested(depth, leaf = "leaf") {
  let value = leaf;
  for (let level = depth - 1; level >= 0; level -= 1) value = level % 2 === 0 ? { a: value } : [value];
  return value;
}

// Every position in a JSON value, as a list of keys, the root excluded.
function pathsOf(value, prefix = []) {
  if (!value || typeof value !== "object") return [];
  return Object.keys(value).flatMap((key) => {
    const path = [...prefix, Array.isArray(value) ? Number(key) : key];
    return [path, ...pathsOf(value[key], path)];
  });
}

function getAt(value, path) {
  return path.reduce((node, key) => node[key], value);
}

function setAt(value, path, replacement) {
  getAt(value, path.slice(0, -1))[path.at(-1)] = replacement;
}

function removeAt(value, path) {
  const parent = getAt(value, path.slice(0, -1));
  if (Array.isArray(parent)) parent.splice(path.at(-1), 1);
  else delete parent[path.at(-1)];
}

// A repeatable stream of numbers in [0, 1), so a failure can be reproduced.
export function sequence(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomOfferInput(random, publicKeyPem, now) {
  const pick = (list) => list[Math.floor(random() * list.length)];
  const maybe = (chance, make) => (random() < chance ? make() : undefined);
  const digits = (length) => Array.from({ length }, () => Math.floor(random() * 10)).join("");
  const amount = () => String(BigInt(`${1 + Math.floor(random() * 9)}${digits(Math.floor(random() * 24))}`));
  const hex = (length) => Array.from({ length }, () => pick([..."0123456789abcdef"])).join("");
  const word = (alphabet, length) => Array.from({ length: 1 + Math.floor(random() * length) }, () => pick([...alphabet])).join("");

  const network = pick(["mainnet", "testnet", "dev"]);
  const host = pick([
    () => `${word("abcdefghijklmnopqrstuvwxyz0123456789", 12)}.${pick(["example", "test", "xn--80ak6aa92e.com", "co.uk"])}`,
    () => `${1 + Math.floor(random() * 222)}.${Math.floor(random() * 256)}.${Math.floor(random() * 256)}.${Math.floor(random() * 256)}`,
    () => "[2001:db8::1]",
    () => "localhost",
    () => "shop.localhost",
    () => "127.0.0.1",
    () => "[::1]"
  ])();
  const scheme = pick(["https", "https", "https", "http"]);
  const port = maybe(0.4, () => `:${1024 + Math.floor(random() * 60000)}`) ?? "";
  const path = Array.from({ length: Math.floor(random() * 4) }, () => `/${word("abcXYZ019-._~", 10)}`).join("");

  const assets = [];
  if (random() < 0.8) assets.push({ asset_type: "ckb", symbol: "CKB" });
  for (let count = Math.floor(random() * 4); count > 0 || assets.length === 0; count -= 1) {
    assets.push({
      asset_type: pick(["udt", "rgbpp"]),
      symbol: `${pick([..."ABCXYZ0189"])}${word("ABCXYZ019._-", 15).slice(1)}`,
      type_script_hash: `0x${hex(64)}`
    });
  }

  const recurring = random() < 0.35;
  const minimum = maybe(0.6, amount);
  const maximum = maybe(0.6, () => (minimum && random() < 0.5 ? minimum : amount()));
  const interval = pick(["daily", "weekly", "monthly", "custom_seconds"]);
  const cycleAmount = minimum ?? maximum ?? amount();
  const recurrence = recurring
    ? {
        interval,
        amount: cycleAmount,
        cap_cycles: maybe(0.7, () => 1 + Math.floor(random() * 500)),
        spending_cap_total: maybe(0.6, () => String(BigInt(cycleAmount) * BigInt(1 + Math.floor(random() * 50)))),
        custom_seconds: interval === "custom_seconds" ? 1 + Math.floor(random() * 10_000_000) : undefined
      }
    : undefined;

  const text = () => word("abc xyz ÅéΩ日本語🙂\t\"\\<&'", 40).trim() || "x";
  const json = (depth) =>
    pick([
      () => text(),
      () => Math.floor(random() * 2_000_000) - 1_000_000,
      () => random() < 0.5,
      () => null,
      () => (depth > 3 ? [] : Array.from({ length: Math.floor(random() * 3) }, () => json(depth + 1))),
      () => (depth > 3 ? {} : Object.fromEntries(Array.from({ length: Math.floor(random() * 3) }, () => [word("ab10_é", 6), json(depth + 1)])))
    ])();
  const object = () => Object.fromEntries(Array.from({ length: Math.floor(random() * 4) }, () => [word("ab10_é", 6), json(1)]));

  return {
    network,
    node_id: `${pick(["02", "03"])}${hex(64)}`,
    public_key: publicKeyPem,
    resolver_url: `${scheme}://${host}${port}${path}`,
    description: maybe(0.7, text),
    assets,
    amount_min: minimum,
    amount_max: maximum,
    recurrence,
    expiry: maybe(0.4, () => now + 1 + Math.floor(random() * 100_000_000)),
    single_use: !recurring && random() < 0.3,
    metadata: maybe(0.4, object),
    extensions: maybe(0.3, object),
    ...(random() < 0.3 ? { [`x_${word("abc_", 6)}`]: json(1) ?? "x" } : {})
  };
}
