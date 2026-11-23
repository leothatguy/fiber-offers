// Where a webhook may be sent.
//
// A webhook URL is supplied by whoever holds operator access, and the resolver
// then makes requests to it from inside the deployment's network. Unless
// private targets are explicitly allowed, a delivery must never reach an
// address that is not on the public internet: the resolver's own host, the
// database, the Fiber node's RPC, a cloud metadata service.
//
// A check on the URL's text is not enough, because a public-looking name can
// resolve to a private address, and can resolve differently the second time it
// is asked. So the check is made on the addresses the name resolves to, at the
// moment of delivery, inside the lookup the connection itself uses: the socket
// can only be opened to an address that passed.
import { lookup as dnsLookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";

const IPV4_NOT_PUBLIC = [
  ["0.0.0.0", 8], // "this network", including the unspecified address
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, where cloud metadata services live
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay anycast (deprecated)
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4] // reserved, including broadcast
];

const IPV6_NOT_PUBLIC = [
  ["::", 96], // unspecified, loopback, and the deprecated IPv4-compatible form
  ["64:ff9b:1::", 48], // local-use NAT64
  ["100::", 64], // discard
  ["2001::", 23], // IETF protocol assignments, including Teredo
  ["2001:db8::", 32], // documentation
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8] // multicast
];

const ipv4NotPublic = new BlockList();
for (const [network, prefix] of IPV4_NOT_PUBLIC) ipv4NotPublic.addSubnet(network, prefix, "ipv4");
const ipv6NotPublic = new BlockList();
for (const [network, prefix] of IPV6_NOT_PUBLIC) ipv6NotPublic.addSubnet(network, prefix, "ipv6");

// Names that are never on the public internet, refused when a webhook is
// registered so the operator hears about it then rather than at delivery.
const INTERNAL_NAME_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".intranet", ".corp"];

// True unless `address` is a public unicast IP address.
export function isNonPublicAddress(address) {
  const text = String(address ?? "").replace(/%.*$/, ""); // drop an IPv6 zone
  const family = isIP(text);
  if (family === 4) return ipv4NotPublic.check(text, "ipv4");
  if (family !== 6) return true; // not an address at all

  if (ipv6NotPublic.check(text, "ipv6")) return true;
  // Forms that carry an IPv4 address are judged by that address.
  const embedded = embeddedIpv4(text);
  return embedded ? ipv4NotPublic.check(embedded, "ipv4") : false;
}

// Checks a webhook URL as far as its text allows and returns it parsed.
// Throws an error with `code` when it is refused.
export function assertWebhookUrlAllowed(value, options = {}) {
  let url;
  try {
    url = new URL(String(value).trim());
  } catch {
    throw targetError("WEBHOOK_URL_INVALID", "webhook url is not a valid URL");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw targetError("WEBHOOK_URL_INVALID", "webhook url must use http or https");
  }
  if (url.username || url.password) {
    throw targetError("WEBHOOK_URL_INVALID", "credentials are not allowed in webhook URLs");
  }
  if (options.allowPrivateTargets) return url;

  const host = hostOf(url);
  if (isIP(host)) {
    if (isNonPublicAddress(host)) {
      throw targetError("WEBHOOK_TARGET_PRIVATE", `webhook target ${host} is not a public address`);
    }
    return url;
  }
  const name = host.toLowerCase().replace(/\.$/, "");
  // A name without a dot is resolved by the local network: another container,
  // a host on the LAN.
  if (name === "localhost" || !name.includes(".") || INTERNAL_NAME_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
    throw targetError("WEBHOOK_TARGET_PRIVATE", `webhook target ${host} is not a public host name`);
  }
  return url;
}

// A DNS lookup for http(s).request that hands back only addresses a webhook may
// be sent to. If any address the name resolves to is not public the whole
// lookup fails: a name answering with both a public and a private address is
// how DNS rebinding gets a request past a check made earlier.
export function createGuardedLookup(options = {}) {
  const lookup = options.lookup ?? dnsLookup;
  return function guardedLookup(hostname, lookupOptions, callback) {
    const done = typeof lookupOptions === "function" ? lookupOptions : callback;
    const requested = typeof lookupOptions === "object" && lookupOptions !== null ? lookupOptions : {};
    lookup(hostname, { ...requested, all: true }, (error, result) => {
      if (error) return done(error);
      const addresses = (Array.isArray(result) ? result : [{ address: result, family: isIP(result) }]).filter(
        (entry) => entry?.address
      );
      if (addresses.length === 0) {
        return done(targetError("WEBHOOK_TARGET_UNRESOLVED", `webhook target ${hostname} did not resolve to an address`));
      }
      if (!options.allowPrivateTargets) {
        const refused = addresses.find((entry) => isNonPublicAddress(entry.address));
        if (refused) {
          return done(
            targetError(
              "WEBHOOK_TARGET_PRIVATE",
              `webhook target ${hostname} resolves to ${refused.address}, which is not a public address`
            )
          );
        }
      }
      if (requested.all) return done(null, addresses);
      return done(null, addresses[0].address, addresses[0].family);
    });
  };
}

// Sends one webhook and resolves with the status code of the answer.
//
// - The connection is made only to an address the guarded lookup accepted.
// - A redirect is not followed; the caller sees its 3xx status.
// - The response body is never read, so a webhook cannot be used to read what
//   another service answers.
export function postWebhook(target, options = {}) {
  return new Promise((resolvePost, rejectPost) => {
    let url;
    try {
      url = assertWebhookUrlAllowed(target, options);
    } catch (error) {
      rejectPost(error);
      return;
    }

    const body = options.body ?? "";
    const timeoutMs = options.timeoutMs ?? 10000;
    let settled = false;
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      settle(value);
    };

    const request = (url.protocol === "https:" ? https : http).request(
      url,
      {
        method: "POST",
        headers: { ...(options.headers ?? {}), "content-length": Buffer.byteLength(body) },
        // A connection per delivery, closed afterwards: nothing is reused
        // across targets.
        agent: false,
        lookup: createGuardedLookup(options)
      },
      (response) => {
        const status = response.statusCode;
        response.destroy();
        finish(resolvePost, { status });
      }
    );
    const deadline = setTimeout(() => {
      const error = targetError("WEBHOOK_DELIVERY_TIMEOUT", `webhook delivery timed out after ${timeoutMs}ms`);
      request.destroy(error);
      finish(rejectPost, error);
    }, timeoutMs);
    request.on("error", (error) => finish(rejectPost, error));
    request.end(body);
  });
}

function hostOf(url) {
  return url.hostname.replace(/^\[|\]$/g, "");
}

// The IPv4 address inside an IPv4-mapped (::ffff:a.b.c.d), NAT64
// (64:ff9b::a.b.c.d) or 6to4 (2002:AABB:CCDD::) address.
function embeddedIpv4(address) {
  const bytes = ipv6Bytes(address);
  if (!bytes) return undefined;
  const zero = (from, to) => bytes.slice(from, to).every((byte) => byte === 0);
  const dotted = (offset) => bytes.slice(offset, offset + 4).join(".");

  if (zero(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) return dotted(12);
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && zero(4, 12)) return dotted(12);
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return dotted(2);
  return undefined;
}

function ipv6Bytes(address) {
  let text = address;
  // A dotted-quad tail is the last 32 bits.
  const tail = text.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (tail) {
    const [a, b, c, d] = tail.slice(1).map(Number);
    text = `${text.slice(0, tail.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, rest] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = rest ? rest.split(":") : [];
  const missing = 8 - left.length - right.length;
  if (rest === undefined ? left.length !== 8 : missing < 0) return undefined;
  const groups = rest === undefined ? left : [...left, ...Array(missing).fill("0"), ...right];
  const bytes = [];
  for (const group of groups) {
    const value = Number.parseInt(group, 16);
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) return undefined;
    bytes.push(value >> 8, value & 0xff);
  }
  return bytes;
}

function targetError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
