# Security Policy

Fiber Offers moves real value: the resolver hands payers invoices for a
merchant's Fiber node, and the SDK decides whether a wallet pays them. Reports
of anything that could misdirect a payment, expose a merchant's data, or reach
the node behind a resolver are taken seriously.

## Reporting a vulnerability

Report privately through GitHub: open
<https://github.com/leothatguy/fiber-offers/security/advisories/new>
("Security" tab, then "Report a vulnerability").

Please do not open a public issue, pull request or discussion for a suspected
vulnerability, and do not test against a deployment you do not operate.

A useful report says:

- what an attacker can do, and what they need to start (a payment link, an
  offer, operator access, a position on the network);
- the affected component (`@fiber-offers/protocol`, `@fiber-offers/sdk`,
  `@fiber-offers/cli`, the resolver) and its version or commit;
- steps or a script that reproduce it. A local resolver in mock mode
  (`npm run dev:mock`) is enough for most resolver issues.

What to expect:

- an acknowledgement within 3 days;
- an assessment, and a plan if it is confirmed, within 10 days;
- a fix released before the details are published, and credit in the release
  notes unless you ask otherwise.

## Supported versions

| Version | Supported |
| --- | --- |
| `main` branch | Yes |
| Latest release of `@fiber-offers/protocol`, `@fiber-offers/sdk` and `@fiber-offers/cli` on npm | Yes |
| Earlier releases | No. Upgrade to the latest release. |

The project is pre-1.0. Fixes are made on `main` and shipped in the next
release; they are not backported.

## What is in scope

- Accepting an offer, invoice or revocation that should fail verification, or
  paying the wrong node, amount, asset or network.
- Reading or changing a merchant's offers, payment history, webhooks or node
  diagnostics without the resolver's API key.
- Making the resolver send requests to private addresses, or call Fiber RPC
  methods beyond the ones it needs.
- Exhausting a single-use offer or a recurring subscription without paying.
- Recovering stored webhook secrets or an offer's private key.

## What is not a vulnerability

- A resolver started with `RESOLVER_DEMO_MODE=true`. Demo mode deliberately
  signs offers on the server and can give every visitor operator access. It is
  off by default and must not be used with real funds.
- A resolver run without `NODE_ENV=production`, which permits a missing API key
  and private webhook targets for local development.
- Anything requiring the resolver's API key, the offer's private key, or access
  to the merchant's Fiber node RPC: holders of those are trusted.
- Denial of service by volume against a resolver with rate limiting disabled.
- The local test nodes created by `npm run fiber:local`. Their keys are stored
  unencrypted by design and they are for testnet only.

## How a resolver is meant to be deployed

The security of a deployment depends on its configuration. See
[docs/deployment.md](docs/deployment.md), in particular the production startup
checks, what is public and what needs the key, Fiber RPC access, and webhook
targets.
