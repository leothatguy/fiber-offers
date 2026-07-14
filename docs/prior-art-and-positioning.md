# Fiber Offers: Prior Art, Differentiation, and Positioning

Research date: 2026-07-03

This document explains where Fiber Offers fits in the current Fiber ecosystem, what similar projects already do, what is still missing, and how to clearly explain why Fiber Offers is useful infrastructure rather than another payment app.

## Short Positioning

Fiber Offers is a reusable payment-request layer for Fiber Network.

Existing Fiber tools mostly help developers create, display, pay, monitor, or automate normal Fiber invoices. Fiber Offers adds the missing reusable primitive above those invoices: a static signed offer that can be published once, resolved into fresh Fiber invoices on demand, and reused for tipping, checkout, recurring billing, payment links, QR codes, and wallet receive flows.

The best one-line description:

> Fiber Offers is a BOLT12/LNURL-pay inspired reusable payment request layer for today's Fiber invoice stack.

Avoid saying:

> Fiber Offers is full BOLT12 for Fiber.

That is too strong for the MVP because full BOLT12 includes native Lightning-style offer messages, blinded paths, and deeper peer-to-peer transport behavior. The hackathon MVP is better described as an application-layer, HTTP-resolved offer protocol that can later evolve toward native Fiber support.

## The Core Gap

Fiber has strong primitives for off-chain payments, multi-asset channels, low-latency settlement, and invoices. However, the public developer surface is still centered around payment-specific invoices.

Current public Fiber invoice/payment flows include methods such as:

- `new_invoice`
- `parse_invoice`
- `get_invoice`
- `cancel_invoice`
- `send_payment`

These are useful, but they do not provide a standard reusable payment request that a recipient can publish once and let many payers use repeatedly.

The missing infrastructure is:

- one static QR code for repeated payments;
- one payment link that can be reused;
- one public payment identity like `alice@example.com`;
- a standard way for wallets to resolve a reusable payment intent into a fresh Fiber invoice;
- a shared format for recurrence, amount bounds, accepted assets, resolver metadata, and recipient identity;
- a reusable SDK so every wallet, merchant tool, or billing app does not invent its own incompatible workaround.

Fiber Offers fills that gap.

## What Fiber Offers Adds

Fiber Offers introduces a new application-layer primitive above Fiber invoices:

1. **Offer**
   A static, signed, reusable payment descriptor. It contains recipient identity, accepted assets, optional amount bounds, optional recurrence metadata, resolver details, and display metadata. It does not contain a one-time payment hash.

2. **Resolution**
   A payer wallet resolves an Offer into a fresh, normal Fiber invoice at payment time. Settlement still uses Fiber's existing payment path.

3. **Fiber Address**
   A human-readable identifier such as `leo@loavix.app` resolving to a canonical Offer through a `.well-known` endpoint.

4. **Wallet SDK and UI Components**
   Developer-facing helpers for creating, encoding, resolving, displaying, and paying Offers.

The key architectural point:

> Fiber Offers does not replace Fiber invoices. It standardizes how reusable payment intents produce fresh Fiber invoices.

## Comparison With Existing Fiber Projects

| Project | Scope | What it already solves | What is missing for reusable payment requests | Relationship to Fiber Offers |
| --- | --- | --- | --- | --- |
| Fiber Network core | Node, channels, invoices, payments, routing, CCH, core protocol | Provides the underlying payment-channel network and invoice/payment RPCs | No public reusable offer/payment-request layer exposed in the current developer surface | Fiber Offers builds on top of Fiber core without modifying settlement |
| Fiber roadmap "Payment Offers" | Planned or roadmap-level native payment feature | Shows the Fiber ecosystem recognizes this gap | Public implementation/API was not found in the current public developer surface during research | Fiber Offers can act as an app-layer prototype and reference design for future native work |
| Fiber Checkout | Drop-in React checkout component | Creates invoices, renders QR codes, polls invoice state, improves merchant checkout UX | QR points to a normal generated invoice, not a reusable static offer; no offer schema or resolver | Fiber Checkout could consume Fiber Offers later to support static checkout/payment links |
| Fiber Link | Community tipping and micropayment layer | Provides a real hosted tipping product, Discourse integration, ledger, admin controls, withdrawals | It is application-specific and hosted/custodial; it uses invoice-per-tip flow, not a general non-custodial reusable offer protocol | Fiber Offers is lower-level infrastructure that projects like Fiber Link could use for static tip links |
| Fiber Pay | CLI, SDK, React, runtime jobs, L402/agent tooling | Broad developer/operator tooling around Fiber nodes, invoices, payments, jobs, monitoring, browser flows | No reusable signed offer format or static payee intent primitive found | Fiber Offers is complementary and could integrate with Fiber Pay's SDK/runtime surfaces |
| Fiber L402 / Fiber402 | HTTP 402 and paywall infrastructure | Lets APIs return payment-required responses with Fiber invoices; good for machine/API payments | Each access event still generates or expects a payment-specific invoice; not a general public static payee offer | Fiber Offers can power reusable merchant/API payment intents, while x402 handles protected-resource payment flow |
| AgentPay / FiberAgentPay | AI-agent payments, hold invoices, service quotes, escrow-like flows | Strong agent-to-agent payment flows, hold invoice patterns, service payments, MCP/x402 bridges | Their "offers" are service quotes carrying hold invoices, not reusable static payee offers | Fiber Offers can be a general payment request layer; agent systems can still use hold invoices for task escrow |
| Fiber Charge Sim | EV charging/payment simulation | Demonstrates repeated invoice-based payments for metered charging | Repeated flow creates invoices per interval; no reusable offer/subscription primitive | Fiber Offers could standardize the reusable session/payment intent for metered services |
| Omniflow Fiber tools | Agent/orchestration tooling for Fiber invoice actions | Generates, decodes, and pays Fiber invoices through workflow tools | Tooling wraps invoice RPCs; no reusable offer protocol found | Fiber Offers gives orchestrators a higher-level reusable payment intent to call |

## Closest Non-Fiber Prior Art

Fiber Offers is closest to three Lightning ecosystem ideas:

| Prior art | What it does | How Fiber Offers relates |
| --- | --- | --- |
| Lightning BOLT11 invoices | One-time/payment-specific Lightning invoices | Fiber invoices are similar in spirit: payment-specific requests with payment hashes |
| Lightning BOLT12 Offers | Reusable offers that can produce invoices on demand | Fiber Offers borrows the reusable offer idea, but starts with HTTP resolution rather than full native peer messaging |
| LNURL-pay | Static URL/QR that returns fresh Lightning invoices through HTTP | Fiber Offers MVP is close to this transport model, but with a Fiber-specific signed schema |
| Lightning Address | `user@domain` identity that resolves through `.well-known` endpoints | Fiber Address is the Fiber-specific equivalent on top of Offers |

This means the idea is not random or speculative. It is taking a known payment-channel UX improvement and adapting it to Fiber's multi-asset, CKB-native context.

## Why This Is Different

Fiber Offers is different from the current ecosystem projects because it is not primarily:

- a checkout UI;
- a tipping product;
- an AI-agent protocol;
- an HTTP 402 paywall;
- a node dashboard;
- a payment simulator;
- a wallet app.

It is a reusable infrastructure primitive that those products can use.

The main difference is the layer:

| Layer | Examples | Role |
| --- | --- | --- |
| Fiber core | Fiber node, RPC, invoices, channels | Moves money |
| Payment tools | Fiber Pay, Omniflow tools | Help developers operate or integrate invoice/payment flows |
| Product flows | Fiber Checkout, Fiber Link, Fiber L402, AgentPay, Fiber Charge Sim | Implement specific use cases |
| Fiber Offers | Offer schema, resolver, SDK, Fiber Address | Standardizes reusable payment intents across products |

This is why Fiber Offers is infrastructure. It gives the ecosystem a shared primitive that many apps can reuse instead of every app inventing its own static payment link format.

## Why It Is Vital

Without a reusable payment-request layer, Fiber apps face repeated friction:

1. **Static receive UX is weak**
   A merchant, creator, or service cannot reliably publish one long-lived "pay me" QR code or link using only normal one-time invoice flows.

2. **Recipients need invoice-generation infrastructure**
   Every payment requires a fresh invoice. That means recipients, merchants, or backend services need to stay available and generate invoices on demand.

3. **Wallets lack a standard payment intent**
   A wallet can pay invoices, but it does not have a standard reusable object that says: "Here is who I am paying, what assets are accepted, what amount bounds apply, and where to get a fresh invoice."

4. **Recurring and subscription flows become custom**
   Subscriptions, recurring invoices, and pay-as-you-go billing require each app to invent its own metadata, scheduler, caps, and revocation model.

5. **Merchant and billing products duplicate work**
   Checkout, invoices, hosted payment pages, API metering, and tip jars all need the same underlying reusable receive primitive.

6. **Human-readable payment identity is missing**
   Long encoded invoice strings are not enough for consumer-grade or merchant-grade UX. `user@domain`-style resolution gives Fiber a familiar identity layer.

Fiber Offers fixes these problems by separating the reusable payment intent from the single-use invoice used for settlement.

## What To Say In A Pitch

Use this:

> I looked at the existing Fiber ecosystem. There are strong tools for invoice generation, checkout components, L402/x402 paywalls, agent payments, and tipping products. What I did not find was a general reusable payment-request primitive for Fiber: something like BOLT12/LNURL-pay, but designed around Fiber invoices and multi-asset support. Fiber Offers fills that gap.

Use this:

> Fiber Offers does not compete with Fiber Checkout, Fiber Link, Fiber Pay, or x402 projects. It gives those projects a lower-level reusable payment intent they can build on.

Use this:

> Today, most flows start by generating an invoice. Fiber Offers starts one level earlier: publish a reusable offer once, then resolve it into fresh Fiber invoices whenever payment is needed.

Use this:

> The MVP is intentionally non-invasive. It does not require changing Fiber node settlement logic. It sits above existing Fiber RPCs and produces normal Fiber invoices.

Avoid this:

> Nobody has thought about offers on Fiber.

Better:

> The Fiber roadmap mentions Payment Offers, so the need is recognized. What is missing publicly is a reusable app-layer implementation, schema, resolver, and SDK that developers can try now.

## Scope Boundaries

### In Scope For The Hackathon MVP

- Offer schema v1
- Canonical JSON representation
- Compact encoded offer string
- Signature or integrity model
- Resolver API
- `GET /offers/:id`
- `POST /offers/:id/invoice`
- `GET /.well-known/fiberoffer/:user`
- TypeScript SDK
- QR/link UI component
- Demo showing one static Offer resolving into two distinct invoices
- Mock mode plus real Fiber RPC adapter where possible
- Documentation explaining what is real, mocked, and future work

### Nice To Have

- Basic recurrence metadata
- Simulated recurring resolution
- Spending cap model
- Offer revocation
- Multi-asset selection

### Out Of Scope For MVP

- Full native BOLT12-style peer messaging
- Blinded path privacy
- Mainnet security guarantees
- Custodial hosted wallet
- Fiat on/off-ramp
- Full merchant processor
- Production subscription autopay system

## How To Compare Against Specific Projects In Q&A

### If Asked About Fiber Checkout

Fiber Checkout is a checkout component for normal invoices. Fiber Offers is a reusable payment request layer.

Fiber Checkout answers:

> How can a merchant show a QR code for this specific invoice?

Fiber Offers answers:

> How can a merchant publish one stable payment code that always resolves into a fresh invoice?

They are complementary. Fiber Checkout could use Fiber Offers as its upstream payment-intent layer.

### If Asked About Fiber Link

Fiber Link is a hosted tipping product with service-ledger behavior. Fiber Offers is non-custodial infrastructure for reusable payment requests.

Fiber Link answers:

> How can a community run tipping inside a forum?

Fiber Offers answers:

> What standard reusable payment descriptor should wallets and apps use across Fiber?

Fiber Link could use Fiber Offers for static creator tip links or reusable profile payment codes.

### If Asked About Fiber Pay

Fiber Pay is a broad developer toolchain for Fiber operations, invoices, payments, browser nodes, jobs, and agent/L402 workflows. Fiber Offers is a narrower protocol/SDK for reusable payment requests.

Fiber Pay answers:

> How do developers operate and automate Fiber invoice/payment flows?

Fiber Offers answers:

> What reusable payment intent should those flows start from?

Fiber Offers can integrate with Fiber Pay rather than replace it.

### If Asked About x402 / L402 Projects

x402 and L402 protect resources and require payment before access. They are request/response payment protocols for APIs and content.

Fiber Offers is a reusable payment descriptor. It can be used by merchants, wallets, tip jars, and recurring billing even when no protected HTTP resource is involved.

x402 answers:

> How does an API ask a client to pay before receiving a response?

Fiber Offers answers:

> How does anyone publish a reusable Fiber payment request?

### If Asked About AgentPay

AgentPay's "offer" is a service quote in an agent-to-agent workflow, often carrying a hold invoice. Fiber Offers is a general reusable payment request for any payer/payee flow.

AgentPay answers:

> How do agents request services, lock payment, execute work, and settle?

Fiber Offers answers:

> How do wallets and apps represent a reusable Fiber payment intent?

AgentPay could use Fiber Offers for service discovery or reusable provider payment endpoints, while still using hold invoices for escrow.

### If Asked About The Official Fiber Roadmap

The roadmap signal is a positive sign, not a threat. It proves the need is real.

Say:

> The Fiber roadmap mentions Payment Offers. My project is an application-layer reference implementation that can be used today and can help validate schema, resolver, wallet UX, and developer needs before or alongside native protocol work.

## Strategic Importance

Fiber Offers is strategically useful because it creates a common denominator for many future Fiber products:

- wallets can support reusable receive flows;
- merchants can publish stable QR codes;
- creators can publish tip jars;
- billing apps can issue recurring payment intents;
- AI/API payment tools can expose stable payment endpoints;
- SDKs can standardize parsing and resolution;
- future native Fiber payment offers can learn from real app-layer usage.

If successful, Fiber Offers becomes a small but important piece of payment infrastructure:

> the thing that turns Fiber from "generate an invoice for each payment" into "publish a payment endpoint once and receive forever."

## Recommended Submission Framing

Category:

> Wallet and Payment UX Infrastructure

Summary:

> Fiber Offers is a reusable, signed payment-request protocol and SDK for Fiber Network. It lets a recipient publish one static Offer as a QR code, link, or Fiber Address. A payer wallet resolves that Offer into a fresh standard Fiber invoice whenever payment is needed, allowing the same Offer to be paid repeatedly without changing Fiber's settlement path.

Infrastructure gap addressed:

> Fiber currently has invoice/payment primitives and several tools that use them, but there is no public reusable payment-request layer equivalent to BOLT12/LNURL-pay for Fiber. This forces checkout, tipping, recurring billing, and merchant tools to regenerate invoices and invent custom payment-link formats. Fiber Offers standardizes that missing layer.

Why now:

> As Fiber grows beyond demos into wallets, merchants, billing, AI/API payments, and multi-asset flows, reusable payment requests become a foundational integration primitive. Building it early prevents fragmented, incompatible app-specific solutions.

## Sources Checked

- Fiber Network repository: https://github.com/nervosnetwork/fiber
- Fiber invoice protocol: https://github.com/nervosnetwork/fiber/blob/develop/docs/specs/payment-invoice.md
- Fiber JS RPC wrapper: https://github.com/nervosnetwork/fiber/blob/develop/fiber-js/src/index.ts
- Fiber showcase and roadmap: https://www.fiber.world/ and https://www.fiber.world/showcase
- Fiber Checkout: https://github.com/salmansarwarr/Fiber-checkout
- Fiber Link: https://github.com/Keith-CY/fiber-link/tree/main
- Fiber Pay: https://github.com/RetricSu/fiber-pay
- Fiber L402: https://github.com/RetricSu/fiber-l402
- Fiber402: https://github.com/David-Pjs/fiber402
- AgentPay: https://github.com/alefnt/AgentPay
- FiberAgentPay: https://github.com/Jeremicarose/FiberAgentPay
- Fiber Charge Sim: https://github.com/HappySonnyDev/fiber-charge-sim
- Lightning BOLT12 Offers: https://github.com/lightning/bolts/blob/master/12-offer-encoding.md
- LNURL-pay LUD-06: https://github.com/lnurl/luds/blob/luds/06.md
- Lightning Address LUD-16: https://github.com/lnurl/luds/blob/luds/16.md
