# Final Checklist

## Before Submission

- [x] Add repository URL to [submission.md](submission.md).
- [ ] Add hosted demo URL to [submission.md](submission.md), if available.
- [x] Add team member names to [submission.md](submission.md).
- [ ] Record demo video using [demo-script.md](demo-script.md).
- [x] Run `npm test` (105 passing, 4 environment-gated infrastructure checks skipped on 2026-07-14).
- [x] Run `npm run test:infra` against PostgreSQL and Redis (4 passing on 2026-07-14).
- [x] Run `npm run smoke` (passed on 2026-07-14).
- [x] Run the equivalent full regression and smoke verification (passed on 2026-07-14).
- [ ] Start demo with `npm run dev`.
- [ ] Create an offer in the browser.
- [ ] Request two invoices from the same offer.
- [ ] Mark one invoice paid.
- [ ] Open reconciliation JSON and CSV.
- [ ] Register webhook and click `Deliver`.
- [ ] Open the event outbox.
- [x] Run `docker compose up --build`; verify two healthy API replicas, PostgreSQL, Redis, BullMQ worker, and Nginx (2026-07-14).
- [x] Mint and read back a live Loavix FNN invoice, pass payer dry-run, and settle a 1 CKB testnet payment through the Docker resolver (2026-07-14).
- [x] Run CLI `doctor`, create/register/list a live offer, verify its `0600` lifecycle key, and revoke it with a signed proof (2026-07-14).
- [x] Run the updated live E2E harness and verify two independent payer client sessions both settle (two 1 CKB testnet payments on 2026-07-14).
- [x] Add signed `HttpOnly` dashboard sessions, durable payer recurrence, five-second settlement coverage, and requirements errata.

## Submission Fields

- Project summary: see [submission.md](submission.md).
- Category: Wallet and Payment UX Infrastructure.
- Technical breakdown: see [architecture.md](architecture.md) and [spec-v1.md](spec-v1.md).
- Fiber infrastructure gap: see [submission.md](submission.md).
- Future roadmap: see [submission.md](submission.md).
- Runnable instructions: see [README.md](../README.md).
- Deployment notes: see [deployment.md](deployment.md).
- Demo script: see [demo-script.md](demo-script.md).
- Prior art comparison: see [prior-art-and-positioning.md](prior-art-and-positioning.md).
