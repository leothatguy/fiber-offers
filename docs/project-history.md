# Fiber Offers: Project History and Current State

**Project:** Fiber Offers

**Repository:** `git@github.com:leothatguy/fiber-offers.git`

**Production URL:** <https://fiber-offers.leothatguy.me>

**History covered:** 14-15 July 2026

**Document generated:** 15 July 2026

> This is the detailed engineering record of the work completed on Fiber Offers from the initial requirements review through the current hosted deployment. It records decisions, implementation, tests, production setup, live Fiber Network evidence, issues fixed, and remaining limitations. Secret values, private keys, AWS credentials, API keys, encryption keys, database passwords, and complete reusable invoices are intentionally excluded.

## 1. Executive summary

Fiber Offers was taken from a requirements package and early project state to an independently usable Fiber payment platform with:

- a signed, portable offer protocol;
- a resolver that turns stable offers into fresh Fiber invoices;
- a CLI for merchants who operate their own Fiber node;
- a JavaScript SDK for merchant applications and payer applications;
- a merchant dashboard, payer payment pages, and integrated documentation;
- PostgreSQL and Redis-backed horizontal deployment support;
- Docker Compose deployment with two resolver replicas and a background worker;
- a live CKB Fiber node connected to the hosted resolver;
- a public HTTPS deployment at `fiber-offers.leothatguy.me`;
- verified real payments over the public Fiber network;
- Terraform infrastructure that can be run locally without GitHub Actions;
- automated protocol, SDK, resolver, CLI, integration, smoke, and live Fiber checks.

The core product idea is now working: a merchant can create a stable offer once, share its payment link, QR code, encoded `fbroffer1...` payload, or Fiber Address, and let a payer resolve it into a new one-time `fibt...` Fiber invoice whenever payment is attempted.

The most important remaining production limitation is network liquidity independence. The hosted merchant currently has a proven public route and inbound liquidity, but the counterparty supplying that inbound liquidity is a local payer node. That node must remain online for that particular route to remain usable. A fully independent production deployment should obtain inbound liquidity from an always-on hosted node or public liquidity provider.

## 2. Original objective

The project was designed to solve a limitation in ordinary Fiber invoices: an invoice is a one-time payment request, while a merchant usually needs a stable product, checkout, donation, subscription, or payment identity that can be shared repeatedly.

Fiber Offers introduces a layer above the Fiber invoice:

1. The merchant signs a stable offer describing what may be paid.
2. The offer can be stored, encoded, shared, embedded, or published through a Fiber Address.
3. A payer resolves the offer through a resolver.
4. The resolver asks the merchant's Fiber node to create a fresh invoice.
5. The payer pays the ordinary Fiber invoice through the Fiber Network.
6. The resolver observes settlement and records the result.
7. Merchant webhooks, receipts, dashboard history, and application callbacks are updated.

The resolver is the bridge between Fiber Offers and the merchant's Fiber node. It does not replace Fiber and it does not hold funds. It coordinates offer validation, fresh invoice creation, settlement observation, persistence, and application-facing APIs.

## 3. Requirements review and alignment

### 3.1 Documents reviewed

The implementation was cross-checked against the source requirements in:

- `docs/Fiber Offers - PRD.pdf`;
- `docs/Fiber Offers - FRD.pdf`;
- `docs/Fiber Offers - Technical Requirements.pdf`;
- `docs/requirements-traceability.md`;
- `docs/requirements-errata.md`.

The review separated four things that had initially been mixed together:

- required user behavior;
- protocol and security invariants;
- prescribed implementation technology;
- hackathon/demo deliverables.

### 3.2 Functional alignment achieved

The completed implementation covers the important product and functional requirements:

- fixed-amount and payer-entered amount offers;
- CKB and token asset descriptors;
- reusable and single-use offers;
- recurrence metadata and payer-controlled recurrence;
- deterministic offer identifiers;
- signed offer creation and signed revocation;
- stable browser payment links and QR codes;
- fresh Fiber invoice generation on every resolution;
- Fiber Address discovery;
- invoice settlement synchronization;
- receipts and payment history;
- webhook creation, signing, delivery, retry, and logs;
- CLI merchant lifecycle;
- SDK merchant and payer workflows;
- browser and React/React Native integration exports;
- topology and payment-readiness diagnostics;
- horizontal production storage and worker architecture;
- self-hosting and production documentation.

The detailed requirement-by-requirement mapping remains in `docs/requirements-traceability.md`.

### 3.3 Necessary requirements errata

One important technical assumption in the draft documents was corrected: the Fiber Node JSON-RPC API does not provide an arbitrary message-signing method suitable for signing the Fiber Offer document.

The implemented trust model therefore uses:

- an Ed25519 lifecycle key to sign offers and revocations;
- the merchant Fiber node's public node ID inside the signed offer;
- a live resolver-side `node_info` check to prove that the configured RPC endpoint is the expected Fiber node;
- resolver-to-node calls for `new_invoice` and `get_invoice`.

This keeps the offer cryptographically stable and independently verifiable without pretending that the Fiber node can sign arbitrary application messages.

Other clarified rules are:

- an offer can be verified offline, but generating a fresh payable invoice requires the merchant Fiber node to be online;
- recurrence is payer-owned and policy-capped, not an automatic merchant pull-payment authority;
- the current static browser application and ESM packages are accepted implementation choices for the hackathon build.

### 3.4 Explicitly accepted technology differences

The original documents prescribed several deliverables that were intentionally not rebuilt when the acceptance gaps were resolved:

- NestJS resolver;
- Next.js merchant application;
- Expo payer application;
- separate Rust/TypeScript reference implementation;
- a second independent demo application.

The user explicitly chose to leave these framework and demo-deliverable differences in place. The implemented Node.js resolver, static browser application, CLI, SDK, examples, and live deployment cover the required behavior. This is a documented product decision, not an unnoticed deviation.

## 4. System architecture delivered

### 4.1 Main components

| Component | Responsibility |
| --- | --- |
| Protocol package | Canonical offer format, validation, signing, IDs, encoding, revocation, amount and recurrence rules |
| SDK package | Merchant API, payer flow, direct Fiber payment adapter, diagnostics, topology, recurrence, QR and framework exports |
| Resolver | Offer registration, resolution, Fiber RPC integration, auth, settlement, receipts, Fiber Address discovery, webhooks |
| CLI | Merchant initialization, diagnostics, creation, registration, listing, inspection, and revocation |
| Dashboard | Merchant operations, offers, payments, integrations, diagnostics, payer checkout, and documentation |
| PostgreSQL | Authoritative offers, resolutions, idempotency records, webhooks, events, and settlement state |
| Redis | Distributed rate limiting and BullMQ queues |
| Worker | Settlement synchronization and asynchronous webhook delivery |
| Nginx | Public gateway, TLS termination, forwarded headers, routing, and load balancing |
| Fiber node | Real CKB Fiber invoice creation, routing, payment, and invoice status |

### 4.2 Offer lifecycle

The working lifecycle is:

1. A merchant runs the CLI or uses the SDK to initialize a lifecycle identity.
2. The merchant connects configuration to its own Fiber node RPC endpoint.
3. The CLI `doctor` command checks that the endpoint is reachable and that the configured node identity matches `node_info`.
4. The merchant creates and signs an offer.
5. The offer is registered with a resolver.
6. The merchant shares a stable browser URL, QR code, `fbroffer1...` payload, or `username@domain` Fiber Address.
7. A payer opens or resolves the offer and submits an amount when needed.
8. The resolver validates the signature, policy, amount, state, expiry, recurrence, and idempotency rules.
9. The resolver calls the merchant Fiber node's `new_invoice` method.
10. The payer pays the returned `fibt...` invoice using an ordinary Fiber wallet/node.
11. The worker or resolver checks `get_invoice` until settlement is known.
12. The resolution becomes paid, a receipt is available, and webhook/dashboard state is updated.

### 4.3 Stable identifiers versus one-time invoices

The project now clearly distinguishes:

- **Payment link:** a browser URL for humans, such as `/pay/<offer-id>`;
- **Fiber Address:** a discoverable alias such as `coffee@fiber-offers.leothatguy.me`;
- **encoded offer:** a portable signed `fbroffer1...` document;
- **Fiber invoice:** a one-time `fibt...` payment request generated for one resolution.

A Fiber Address is not a web URL and normally is not opened directly in a browser. A compatible wallet or client splits `username@domain`, discovers the offer at `https://domain/.well-known/fiberoffer/username`, resolves it, and pays the returned invoice. The dashboard also provides a human-friendly payment link for environments without native Fiber Address support.

## 5. Protocol and security work

### 5.1 Protocol implementation

The protocol package provides:

- canonical serialization;
- deterministic offer IDs;
- Ed25519 signing and verification;
- Bech32m `fbroffer1` encoding and decoding;
- fixed and flexible amount validation;
- minimum/maximum amount rules;
- CKB, UDT, and RGB++ asset descriptors;
- expiry validation;
- single-use and reusable behavior;
- recurrence metadata and caps;
- signed revocation documents;
- stable TypeScript declarations.

Amounts use integer base units internally. For CKB, the backend and protocol continue to use shannons, where `1 CKB = 100,000,000 shannons`. The browser UI was changed to accept and display CKB so merchants do not have to reason in shannons during normal operation.

### 5.2 Authentication and secret handling

The resolver supports an operator API key, but the browser does not keep sending or displaying that key. It exchanges the key for a short-lived signed `HttpOnly` session cookie. The hosted public demo can issue this operator session automatically, allowing evaluators to use the dashboard without learning the deployment's API key.

Secret categories are intentionally separate:

- resolver API key for administrative API access;
- resolver encryption key for sensitive stored data;
- PostgreSQL password;
- merchant lifecycle private key;
- AWS credentials and SSH private key;
- webhook signing secrets.

Local development defaults exist to make Docker startup easy, but production deployment values are supplied through ignored environment files. Lifecycle keys are stored under `.fiber-offers/keys/` and are ignored by Git. Terraform state, plans, local variable files, SSH keys, and deployment environment files are also ignored.

No secret value is recorded in this history document.

### 5.3 Webhook hardening

Webhook support includes:

- encrypted webhook secrets using AES-256-GCM;
- signed webhook requests;
- queued delivery and retry;
- delivery/event logs;
- blocking of loopback, link-local, and private network targets by default to reduce SSRF risk;
- a deliberate development override only where explicitly configured.

## 6. Resolver and horizontal deployment

### 6.1 PostgreSQL as authoritative storage

The first implementation included an in-memory/local JSON store for lightweight development and tests. Production support was then built around PostgreSQL with migrations and transaction-aware operations.

The PostgreSQL implementation protects cross-replica behavior through:

- authoritative persisted offers and resolution records;
- database uniqueness constraints;
- idempotency keys;
- row locks and transactions;
- atomic single-use offer consumption;
- recurrence and resolution invariant checks;
- durable webhook and settlement state.

This means two resolver instances can receive requests concurrently without independently consuming the same single-use offer or creating duplicate logical resolutions.

### 6.2 Redis and background work

Redis is used for:

- distributed rate limiting shared by every resolver replica;
- BullMQ settlement jobs;
- BullMQ webhook delivery jobs;
- durable retry behavior independent of a particular HTTP process.

The worker runs separately from the HTTP resolver replicas. Resolver processes can therefore be scaled without every process racing to execute the same background work.

### 6.3 Docker topology

The production Compose topology contains:

- PostgreSQL 16;
- Redis 7;
- a one-shot migration service;
- two resolver replicas;
- one queue worker;
- one gateway/load balancer;
- a Fiber RPC relay/proxy;
- the hosted Fiber node in the production override.

PostgreSQL and Redis publish only to host loopback. The resolver replicas are exposed only inside the Docker network. Nginx is the public HTTP entry point. Health checks and startup dependencies prevent the gateway from presenting an unready application.

### 6.4 Fiber RPC relay

The resolver's Fiber RPC adapter is a strict allowlist, not a generic JSON-RPC proxy. It permits only the methods needed by Fiber Offers, including node identity, invoice creation, and invoice lookup.

The deployment also includes a narrow Unix-socket/loopback relay pattern for cases where the Fiber node RPC is reachable from the host rather than the application network. This keeps the RPC endpoint private while allowing containerized resolver replicas to use it.

## 7. CLI delivered

The CLI makes the platform independently usable by a merchant without the dashboard.

Implemented commands cover:

- initialization and local secret generation;
- resolver and Fiber RPC configuration;
- `doctor` checks for endpoint reachability and Fiber node identity;
- offer creation;
- offer registration;
- listing and inspection;
- revocation;
- JSON output suitable for scripts and demonstrations.

A recovery issue was fixed during the demo work. If offer creation succeeded locally but resolver registration failed because the API key was missing or invalid, the CLI used to leave the user with an awkward restart path. It now preserves the generated lifecycle key and prints an exact retry command. The identity and offer can be recovered instead of silently being replaced.

The CLI and dashboard are synchronized through the same resolver and database. An offer created by the CLI and registered with the resolver appears in the dashboard inventory; payments made against it appear in the same merchant activity views.

## 8. SDK delivered

The SDK was built for developers who want to integrate Fiber Offers into an existing project.

It includes:

- `FiberOffersClient` for resolver operations;
- `FiberPaymentClient` for paying a Fiber invoice through a node adapter;
- an end-to-end payment flow client;
- direct invoice and resolver workflow helpers;
- normalized failure categories;
- Fiber topology diagnostics;
- payment-readiness checks;
- merchant and payer examples;
- QR output for browser, React, and React Native use;
- TypeScript declarations;
- recurrence schedulers and persistence adapters;
- Node-specific file-backed recurrence support;
- browser-safe exports that do not import Node-only modules.

The SDK does not magically replace a Fiber node. A developer still needs access to a Fiber node or a compatible wallet/provider to create or pay actual Fiber invoices. What the SDK removes is the need to reimplement offer parsing, validation, resolver calls, state handling, diagnostics, and payment-flow coordination.

Recurrence remains payer-controlled. A payer-side scheduler decides when to resolve and pay the next invoice, subject to the signed offer's policy caps. The merchant cannot pull arbitrary future payments merely because an offer contains recurrence metadata.

## 9. Dashboard and documentation work

### 9.1 Merchant dashboard

The dashboard now includes:

- overview and live health status;
- offer creation and offer inventory;
- active, revoked, reusable, and single-use state;
- stable offer links and Fiber Addresses;
- payment/resolution attempts;
- invoice and settlement status;
- webhook creation and event history;
- diagnostics and topology status;
- public hosted operator access.

The CKB interface was corrected so the form and display values use CKB while all API and protocol calculations remain in shannons.

The offer inventory was also corrected to show offers registered through the CLI. Earlier, resolution attempts could appear on the dashboard while the inventory counter remained zero. Both views now use the authoritative resolver data.

### 9.2 Payer pages

The payer flow now:

- opens without requiring the evaluator to paste the private resolver API key;
- resolves a stable offer into a fresh invoice;
- exposes the complete invoice for copying into a Fiber wallet/node;
- shows payment attempts associated with that offer;
- updates settlement state from the resolver;
- distinguishes a generated but unpaid invoice from a paid resolution;
- keeps fixed-amount and flexible-amount behavior clear;
- renders its QR code within the parent container at desktop and mobile widths.

The empty table on a fresh payment page is expected: the stable offer page has no invoice until somebody resolves it. Once a resolution is created, that attempt appears in the payer and merchant views. A copied Fiber invoice can be paid directly; the payer does not need to copy the resolution ID or payment hash. Those identifiers are for tracking and synchronization, not payment authorization.

### 9.3 Webhook modal feedback

Toast notifications for webhook creation were initially rendered below the modal backdrop. Both success and error messages were technically present but could only be seen after closing the dialog.

The toast layer was moved into the browser's top-layer popover model with a high-level fallback. Toasts now remain visible above modal backdrops, while retaining dismissal and timing behavior.

### 9.4 Documentation site

The in-product documentation was expanded to cover:

- quick start;
- concepts and protocol model;
- merchants and CLI lifecycle;
- payer and wallet workflows;
- Fiber node connectivity;
- API reference;
- SDK integration;
- production deployment;
- self-hosting;
- Fiber Address discovery;
- browser links versus wallet identifiers versus one-time invoices.

Mobile documentation navigation was rebuilt as a familiar responsive drawer:

- fixed header and menu trigger;
- slide-in sidebar;
- backdrop dismissal;
- Escape-key handling;
- focus return;
- inert background content;
- appropriate scroll locking;
- reduced-motion handling;
- desktop sidebar preserved at larger widths.

This work was checked at 390-pixel mobile width and 1440-pixel desktop width.

### 9.5 False “Offline” status fix

The hosted dashboard briefly showed “Offline” even while the service was healthy. The cause was startup ordering: diagnostics loaded before the public operator session cookie had been established, so the protected diagnostic request returned unauthorized and the UI interpreted that result as infrastructure downtime.

Hosted startup was changed to establish the operator session first and then load diagnostics. A failed authenticated diagnostic call still reports an error, but authentication setup no longer produces a false offline state.

## 10. Demo preparation and cleanup

Several demo-specific problems were resolved:

- unauthorized offer registration now preserves the lifecycle key and gives a retry command;
- public payment links no longer require evaluators to know the private API key;
- the dashboard uses CKB rather than shannons for human-facing values;
- CLI-created offers appear in dashboard inventory;
- E2E output exposes stable top-level fields for `jq` instead of returning apparent `null` values from a mismatched filter;
- E2E checks can use an existing offer rather than always creating an unrelated new one;
- the payment page lists resolution attempts for its offer;
- copied `fibt...` invoices can be paid directly through Fiber RPC;
- stale demo offers were cleared when a clean recording state was needed;
- the QR overflow was fixed;
- the demo script was removed from the repository when the user requested that it remain local only.

No demo narration script is currently committed in the codebase. Temporary demo output used `/tmp` files such as `/tmp/fiber-offer-demo.json` and `/tmp/fiber-e2e-demo.json`.

## 11. AWS infrastructure and deployment

### 11.1 Provisioning approach

The sibling `../loavix` project was reviewed for its Terraform and Ansible patterns. Fiber Offers received its own scoped Terraform configuration under `infra/terraform/`.

Terraform is run locally. There is no GitHub Actions deployment pipeline. The local helper keeps the operational files in known project-relative locations while Git ignores sensitive or machine-specific state:

- Terraform state and backup state;
- saved plans;
- `.tfvars` containing real values;
- the local deployment SSH private key;
- deployment environment files.

AWS credentials came from the user's existing shell environment. They were not invented, printed into documentation, or committed.

The Fiber Offers server and the Loavix server are separate infrastructure. Loavix was used as a reference and initially supplied local Fiber nodes for testing; it is not the production Fiber Offers application host.

### 11.2 Provisioned host

The deployed infrastructure includes:

- AWS EC2 instance: `i-07c17ae7d0d5daff6`;
- public IPv4 address: `54.145.234.134`;
- SSH user: `ec2-user`;
- project path: `/home/ec2-user/fiber-offers`;
- local ignored deploy key path: `infra/terraform/.local/deploy-key`.

At the user's explicit request, SSH ingress was opened to `0.0.0.0/0` so the server can be reached from changing networks. Compensating controls are key-only authentication, disabled password authentication, and disabled root login. Restricting SSH to a stable administrative CIDR or using AWS Systems Manager would be safer for a longer-lived production environment.

### 11.3 Domain and TLS

The project uses the personal Namecheap domain `leothatguy.me` with the subdomain:

`fiber-offers.leothatguy.me`

DNS management was traced to the active cPanel nameserver configuration rather than Namecheap BasicDNS. The subdomain was pointed at the AWS public IP, Nginx was configured for the host, and Let's Encrypt TLS was installed.

At the last deployment verification:

- HTTPS was active;
- HTTP redirected through the intended host configuration;
- Certbot renewal timer was active;
- the certificate was valid through 13 October 2026.

A forwarded-protocol issue was also fixed so the application correctly recognizes HTTPS behind the host Nginx proxy.

### 11.4 Hosted container stack

The hosted server runs the production Docker Compose topology, including:

- PostgreSQL;
- Redis;
- migration job;
- two resolver instances;
- worker;
- gateway;
- host HTTPS proxy;
- a live `nervos/fiber:0.9.0-rc1` Fiber node.

The production deployment uses environment-provided secrets. Development fallback values in Compose are not treated as public production credentials.

## 12. Live Fiber node setup

### 12.1 Initial live integration

Local Fiber nodes in `../loavix` were used to replace the mock invoice path with real Fiber RPC calls. This proved:

- resolver-to-node connectivity;
- node identity verification;
- fresh invoice creation;
- invoice lookup and settlement synchronization;
- two resolutions of one reusable offer producing distinct invoices and payment hashes;
- ordinary direct payment of the copied invoice.

An initial direct private channel between the test payer and merchant was created as a deterministic integration fixture. That fixture made the first E2E tests reliable, but it did not prove that an unrelated user could route a payment over the public network.

### 12.2 Hosted merchant node

The hosted merchant Fiber node has public node ID:

`0349fdc5ae3fd050831a89b544cceeb2e8c6e1d6ecfc1e4f0cdb689be263b02d5a`

Its announced public address is:

`/dns4/fiber-offers.leothatguy.me/tcp/8228/p2p/QmUkfP8NXjt1iRfgHhBddpTZ5f5GDwLHsJvS7AGDW4gmHz`

The Fiber P2P port is public; the Fiber RPC port remains private to the deployment.

### 12.3 Inbound-liquidity diagnosis

The hosted node initially had a public channel, but the channel allocation gave the merchant no useful inbound capacity. That meant the node could send funds but an unrelated payer could not necessarily route funds into it.

This distinction was important:

- a connected peer does not guarantee a route;
- a route does not guarantee sufficient capacity;
- channel total capacity does not equal inbound capacity;
- reserves reduce the immediately usable amount.

### 12.4 Additional 1,000 CKB channel

A new public channel was opened with 1,000 CKB allocated from the local payer side toward the hosted merchant. The exact JSON-RPC funding amount was represented as:

`0x174876e800` shannons

The resulting channel evidence was:

- channel ID: `0xa8e7b4fd8f0b3f5fedfeb11d75361755319470d7f82da02bd64096846f8b9159`;
- funding outpoint: `0x4d6baa3d96a19ba34b990e8cde50a48d92a3c5ef13bc9a11177b03071366aaee00000000`;
- state: ready;
- initial usable merchant inbound: approximately 901 CKB after channel reserves.

After a 1 CKB public-route proof payment, usable inbound was approximately 900 CKB.

### 12.5 Public route proof

An unrelated payer node with public key:

`03c4a7cb51839ca59995ef7bd16267abd6bdfde312e840772a7ce20cd2f33d7029`

had no direct channel to the merchant. It successfully paid through a public intermediate node to the hosted merchant. The result was:

- payer status: `Success`;
- merchant invoice status: `Paid`;
- payment amount: 1 CKB;
- fee: 0.001 CKB;
- no direct payer-to-merchant channel.

This proved real public Fiber routing rather than merely exercising the deterministic direct test fixture.

### 12.6 Coffee offer proof

The hosted coffee offer has:

- Fiber Address: `coffee@fiber-offers.leothatguy.me`;
- offer ID: `0x5e76ba68ea260e2db9813fa333d2a81dc2f17cb1bb9e419825db3d329084591d`;
- payment page: <https://fiber-offers.leothatguy.me/pay/0x5e76ba68ea260e2db9813fa333d2a81dc2f17cb1bb9e419825db3d329084591d>.

A fresh invoice from that offer was paid successfully over the public route. Recorded evidence:

- amount: 1 CKB;
- fee: 0.001 CKB;
- payment hash: `0x7e452a0247093dad173ed19cd413c0da63e1f8f824ba2c30eadb4e321efb3efd`;
- resolver resolution: `res_0eb4f76d-9d96-4ec5-9676-4238a087420c`;
- payer status: success;
- merchant invoice status: paid;
- resolver status: `invoice_paid`.

The test also confirmed the product behavior discussed during demo preparation: a payer can copy the Fiber invoice alone and pay it through `send_payment`. The resolution ID and payment hash do not need to be manually supplied by the payer. The resolver derives and synchronizes those tracking details from the invoice lifecycle.

### 12.7 Local route-node availability issue

The local Docker container `loavix-fiber-payer` was later found stopped after a clean termination. Because that node supplied the current inbound channel, its shutdown made route-dependent hosted diagnostics fail even though the web application itself remained online.

The container was restarted and its Docker restart policy was changed to `unless-stopped`. Resolver health returned to a healthy invoice-source state.

This is an operational repair, not the final production topology. The route is still dependent on a node running on the local PC. For a truly independent hosted service, the inbound channel should be moved to an always-on server or obtained from a durable public liquidity peer.

## 13. Test and verification work

### 13.1 Automated coverage

The repository includes focused tests for:

- protocol encoding, IDs, signatures, validation, recurrence, and revocation;
- SDK API behavior, failures, adapters, diagnostics, topology, and recurrence;
- resolver API behavior, authentication, idempotency, single-use races, settlement, receipts, Fiber Address discovery, and webhooks;
- PostgreSQL store semantics;
- Redis rate limiting;
- CLI lifecycle and failure recovery;
- smoke/demo workflow;
- live Fiber invoice creation;
- live payment execution;
- resolver settlement synchronization;
- route and topology checks;
- multi-payment reusable-offer behavior.

At the recorded acceptance run, the full suite reported:

- 112 total tests;
- 108 passing;
- 4 skipped infrastructure-only tests.

The skipped checks require optional live services and are exercised separately in the live environment.

### 13.2 Visual and responsive verification

Browser checks covered:

- dashboard desktop and mobile layouts;
- offer QR containment;
- payment-page state;
- webhook toast visibility above modal dialogs;
- documentation drawer behavior at 390px;
- documentation desktop behavior at 1440px;
- hosted diagnostics after public operator authentication.

### 13.3 Production verification

Production verification included:

- DNS and HTTPS reachability;
- Nginx forwarding behavior;
- resolver health;
- PostgreSQL and Redis health;
- two resolver replicas and worker startup;
- live Fiber RPC node identity;
- fresh invoice creation;
- direct copied-invoice payment;
- settlement synchronization;
- public multi-hop payment;
- hosted dashboard status.

## 14. Chronological implementation record

### 14 July 2026: core independent platform

Commit `dd6bb40` - `feat: build independent Fiber offers platform`

This was the main foundation: 95 files and roughly 24,868 added lines. It introduced the protocol, SDK, CLI, resolver, dashboard, documentation site, Docker stack, PostgreSQL/Redis integration, worker, test suites, live Fiber scripts, architecture material, and the source requirement PDFs.

### 14 July 2026: production acceptance gaps

Commit `93cf24c` - `feat: close production acceptance gaps`

This pass tightened resolver behavior, completed recurrence support, added Node-specific recurrence storage, expanded SDK types and examples, improved live E2E behavior, documented the requirements errata, and updated the traceability and acceptance records.

### 14 July 2026: self-hosting documentation

Commit `df0ce7b` - `docs: add self-hosting deployment guide`

The in-product documentation gained a dedicated self-hosting section and navigation entry. Resolver support and tests were adjusted for the documentation route.

### 15 July 2026: merchant and payer demo polish

Commit `3d96b18` - `fix: polish merchant and payer demo flows`

This fixed public payment-page authentication, merchant/payer state presentation, CKB display, E2E use of existing offers, demo data cleanup, and QR/layout details. The committed demo script was deleted so it could remain local as requested.

### 15 July 2026: AWS provisioning

Commit `364185b` - `infra: provision aws merchant host`

This added scoped AWS networking, compute, security group, variables, outputs, and Terraform documentation.

### 15 July 2026: repeatable local Terraform workflow

Commit `83083aa` - `infra: persist local terraform workflow`

This added the project-local Terraform helper and ignore rules so provisioning could be repeated from the repository without committing state, credentials, plans, or SSH keys.

### 15 July 2026: hosted demo deployment

Commit `5780903` - `feat: add hosted demo deployment`

This added the production Fiber node configuration, host Nginx HTTP/HTTPS configuration, production Compose override, and public hosted operator access behavior.

### 15 July 2026: hosted network hardening

Commit `f048d42` - `fix: harden hosted network deployment`

This corrected proxy headers and network boundaries, strengthened Nginx behavior, and adjusted production Compose and Terraform network settings.

### 15 July 2026: modal toast layering

Commit `e85baa8` - `fix: keep toasts above modal dialogs`

This moved dashboard toasts above modal backdrops and preserved their interactive dismissal behavior.

### 15 July 2026: Fiber Address documentation and mobile navigation

Commit `9376d1a` - `docs: clarify payment discovery and improve mobile navigation`

This clarified how Fiber Addresses, web links, offer payloads, and invoices differ. It also implemented the responsive documentation drawer and accessibility behavior.

### 15 July 2026: hosted status startup fix

Commit `9c436e0` - `fix: load hosted diagnostics after operator session`

This corrected the dashboard's false “Offline” state by loading hosted diagnostics only after the operator session was available.

### 15 July 2026: public npm package release

The `fiber-offers` npm organization was created with `leothatguy` as owner, and
the reusable developer surfaces were published publicly at version `0.1.0`:

- `@fiber-offers/protocol`;
- `@fiber-offers/sdk`;
- `@fiber-offers/cli`.

Each package received an npm-specific README, MIT license, repository metadata,
Node.js engine constraints, explicit public access, and a restricted file list.
The resolver was marked private because it is a deployment application rather
than a supported library package.

Release verification found and fixed an npm binary-symlink issue in the CLI's
main-module detection. A regression test now executes the CLI through an
npm-style symlink. The final packages were installed from the public registry
in a clean temporary consumer project; protocol and SDK imports, transitive
dependencies, and the installed `fiber-offers --help` command all succeeded.

## 15. Current user workflows

### 15.1 Independent merchant using the CLI

A merchant can:

1. run its own Fiber node;
2. run or choose a Fiber Offers resolver;
3. initialize the CLI and generate its lifecycle identity;
4. configure the Fiber RPC URL, resolver URL, and API key;
5. run `doctor` to verify the actual Fiber node identity;
6. create and register offers;
7. publish a payment link, QR code, encoded offer, or Fiber Address;
8. receive ordinary Fiber payments into its own node;
9. view settlement in the CLI, dashboard, API, or webhooks.

The resolver is operational infrastructure, not a custodian. The merchant retains its Fiber node and funds.

### 15.2 Developer using the SDK

A developer can install the SDK and use a hosted or self-hosted resolver. The SDK handles offer and resolver logic, but actual payment still needs a Fiber-capable wallet or node adapter. A merchant application similarly needs a merchant Fiber node available to the resolver for fresh invoice generation.

### 15.3 Hosted dashboard operator

The current live dashboard is one independent merchant deployment. Another merchant can deploy the same repository, generate different secrets, point it at a different Fiber node, and operate an entirely separate offer inventory and payment history.

The current hosted public-operator mode is optimized for judging and demonstration. A multi-merchant SaaS version would require real user accounts, merchant isolation, scoped API keys, and per-merchant Fiber node/credential registration.

## 16. Current state at handoff

At the end of the recorded work:

- Git branch: `main`;
- latest application commit before the npm release work: `9c436e0`;
- GitHub remote: `git@github.com:leothatguy/fiber-offers.git`;
- npm packages: `@fiber-offers/protocol@0.1.0`, `@fiber-offers/sdk@0.1.0`, and `@fiber-offers/cli@0.1.0`;
- public dashboard: <https://fiber-offers.leothatguy.me>;
- public Fiber Address: `coffee@fiber-offers.leothatguy.me`;
- hosted resolver and Fiber invoice source: healthy at the last verification;
- real public Fiber payment: proven;
- current inbound route: usable but dependent on the local payer node remaining online;
- demo script: intentionally absent from the repository;
- deployment: local Terraform plus SSH/Docker Compose, no GitHub Actions.

## 17. Remaining work and honest limitations

The hackathon-ready system is functional, but these are the main items for a durable production service:

1. **Always-on inbound liquidity.** Replace the local payer node as the hosted merchant's liquidity counterparty with an always-on hosted/public peer.
2. **Managed secrets.** Move long-lived production secrets from a host environment file into AWS Secrets Manager, SSM Parameter Store, or an equivalent secret manager.
3. **Backups.** Add automated PostgreSQL backup, restore drills, and retention policy.
4. **Monitoring.** Add metrics, structured log aggregation, uptime checks, channel-liquidity alerts, queue-depth alerts, and certificate-expiry alerts.
5. **SSH exposure.** Restrict port 22 from `0.0.0.0/0` when a stable administration path is available.
6. **Multi-tenant SaaS.** Add merchant accounts, scoped authorization, tenant isolation, billing, and per-merchant node configuration before advertising the hosted instance as a general shared service.
7. **External wallet interoperability.** Test Fiber Address and copied-invoice behavior against more third-party wallets rather than only node RPC clients.
8. **Token liquidity validation.** Exercise UDT/RGB++ offers with real channels and assets, not only protocol-level validation.
9. **Framework deliverables.** Build NestJS/Next.js/Expo/reference demo artifacts only if the submission rules make the originally prescribed technology mandatory. They remain an explicitly accepted difference today.
10. **Liquidity automation.** Add operational tooling for inbound/outbound capacity planning, channel rebalancing, peer availability, and route readiness.

## 18. Final assessment

The project is on the intended product path. It is no longer merely a UI demonstration around mocked invoices: it creates real Fiber invoices, accepts real Fiber payments, synchronizes settlement, and exposes the result consistently through the CLI, SDK, resolver, dashboard, receipt, and webhook layers.

The architecture also supports two distinct deployment models:

- an independent merchant who self-hosts the resolver and connects its own Fiber node;
- an application developer who uses the SDK with either a hosted or self-hosted resolver and a Fiber-capable payment provider.

The strongest proof completed was the public multi-hop payment from an unrelated payer node to the hosted merchant, followed by successful resolver settlement. The biggest remaining infrastructure task is to make the route and its inbound liquidity fully server-side so that the live service no longer depends on the local PC.

## 19. Related project documents

- `README.md` - primary project overview and quick start;
- `docs/requirements-traceability.md` - functional requirement mapping;
- `docs/requirements-errata.md` - clarified and accepted requirement changes;
- `docs/spec-v1.md` - protocol specification;
- `docs/architecture.md` - component architecture;
- `docs/independent-merchant.md` - self-hosted merchant lifecycle;
- `docs/deployment.md` - production deployment details;
- `docs/live-fiber-testing.md` - live node and payment testing procedures;
- `docs/api-quick-reference.md` - resolver API summary;
- `docs/submission.md` - hackathon submission evidence;
- `docs/final-checklist.md` - final acceptance checklist;
- `infra/terraform/README.md` - AWS provisioning workflow.
