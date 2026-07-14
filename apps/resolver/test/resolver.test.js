import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, InMemoryOfferStore, JsonOfferStore } from "../src/server.js";
import { MockInvoiceAdapter } from "../src/invoice-adapter.js";
import { deliverWebhookEvent, signWebhookPayload } from "../src/webhook-delivery.js";
import {
  createOfferRevocation,
  createSignedOffer,
  encodeOffer,
  generateOfferKeyPair
} from "../../../packages/protocol/src/index.js";

test("creates a demo offer and resolves fresh invoices from it", async () => {
  await withServer(async (baseUrl) => {
    const created = await postJson(`${baseUrl}/demo/offers`, {
      username: "coffee",
      description: "Coffee checkout",
      amount_min: "1000",
      amount_max: "5000"
    });

    assert.equal(created.status, 201);
    assert.match(created.body.offer_id, /^0x[0-9a-f]{64}$/);
    assert.match(created.body.encoded_offer, /^fbroffer1/);
    assert.equal(created.body.fiber_address, `coffee@${new URL(baseUrl).host}`);

    const request = {
      amount: "1200",
      asset: { asset_type: "ckb", symbol: "CKB" }
    };
    const first = await postJson(`${baseUrl}/offers/${created.body.offer_id}/invoice`, request);
    const second = await postJson(`${baseUrl}/offers/${created.body.offer_id}/invoice`, request);

    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(first.body.mocked, true);
    assert.notEqual(first.body.invoice, second.body.invoice);
    assert.notEqual(first.body.payment_hash, second.body.payment_hash);
  });
});

test("lists offer inventory with compact operator summaries", async () => {
  await withServer(async (baseUrl) => {
    const first = await postJson(`${baseUrl}/demo/offers`, {
      username: "coffee",
      description: "Coffee checkout",
      amount_min: "1000",
      amount_max: "1000"
    });
    await postJson(`${baseUrl}/demo/offers`, {
      username: "tips",
      description: "Tips jar",
      amount_min: "100"
    });

    const listed = await getJson(`${baseUrl}/offers`);
    const fetched = await getJson(`${baseUrl}/offers/${first.body.offer_id}`);

    assert.equal(listed.status, 200);
    assert.equal(listed.body.offers.length, 2);
    assert.equal(listed.body.offers[0].encoded_offer, undefined);
    assert.equal(listed.body.offers.find((offer) => offer.fiber_address?.startsWith("tips@")).fiber_address, `tips@${new URL(baseUrl).host}`);
    assert.ok(listed.body.offers.some((offer) => offer.offer_id === first.body.offer_id));
    assert.equal(fetched.body.fiber_address, `coffee@${new URL(baseUrl).host}`);
  });
});

test("creates fixed pricing from one amount and rejects non-exact invoice requests", async () => {
  await withServer(async (baseUrl) => {
    const created = await postJson(`${baseUrl}/demo/offers`, {
      pricing_type: "fixed",
      amount: "1000"
    });

    const rejected = await postJson(`${baseUrl}/offers/${created.body.offer_id}/invoice`, {
      amount: "1001",
      asset: { asset_type: "ckb", symbol: "CKB" }
    });

    assert.equal(created.status, 201);
    assert.equal(created.body.offer.amount_min, "1000");
    assert.equal(created.body.offer.amount_max, "1000");
    assert.equal(created.body.offer.metadata.pricing_type, "fixed");
    assert.equal(rejected.status, 422);
    assert.equal(rejected.body.error.code, "AMOUNT_MUST_MATCH_FIXED_AMOUNT");
  });
});

test("replays an idempotent invoice request without creating another invoice or event", async () => {
  await withServer(async (baseUrl) => {
    const created = await postJson(`${baseUrl}/demo/offers`, {
      amount_min: "1000",
      amount_max: "3000"
    });
    const request = {
      amount: "1500",
      asset: { asset_type: "ckb", symbol: "CKB" }
    };
    const headers = { "idempotency-key": "checkout-order-42" };

    const first = await postJson(`${baseUrl}/offers/${created.body.offer_id}/invoice`, request, headers);
    const replay = await postJson(`${baseUrl}/offers/${created.body.offer_id}/invoice`, request, headers);
    const conflict = await postJson(
      `${baseUrl}/offers/${created.body.offer_id}/invoice`,
      { ...request, amount: "1600" },
      headers
    );
    const resolutions = await getJson(`${baseUrl}/offers/${created.body.offer_id}/resolutions`);
    const events = await getJson(`${baseUrl}/offers/${created.body.offer_id}/webhook-events`);

    assert.equal(first.status, 201);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.idempotent_replay, true);
    assert.equal(replay.body.resolution_id, first.body.resolution_id);
    assert.equal(replay.body.invoice, first.body.invoice);
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, "IDEMPOTENCY_KEY_REUSED");
    assert.equal(resolutions.body.resolutions.length, 1);
    assert.equal(events.body.events.length, 1);
  });
});

test("serializes concurrent single-use invoice requests", async () => {
  await withServer(async (baseUrl) => {
    const created = await postJson(`${baseUrl}/demo/offers`, {
      single_use: true,
      amount_min: "1000",
      amount_max: "3000"
    });
    const request = {
      amount: "1500",
      asset: { asset_type: "ckb", symbol: "CKB" }
    };

    const results = await Promise.all([
      postJson(`${baseUrl}/offers/${created.body.offer_id}/invoice`, request),
      postJson(`${baseUrl}/offers/${created.body.offer_id}/invoice`, request)
    ]);
    const successes = results.filter((result) => result.status === 201);
    const rejections = results.filter((result) => result.status === 409);
    const resolutions = await getJson(`${baseUrl}/offers/${created.body.offer_id}/resolutions`);

    assert.equal(successes.length, 1);
    assert.equal(rejections.length, 1);
    assert.equal(rejections[0].body.error.code, "OFFER_ALREADY_USED");
    assert.equal(resolutions.body.resolutions.length, 1);
  });
});

test("resolves a Fiber Address to its encoded offer", async () => {
  await withServer(async (baseUrl) => {
    const created = await postJson(`${baseUrl}/demo/offers`, {
      username: "tips",
      description: "Tips jar"
    });
    const resolved = await getJson(`${baseUrl}/.well-known/fiberoffer/tips`);

    assert.equal(resolved.status, 200);
    assert.equal(resolved.body.offer_id, created.body.offer_id);
    assert.equal(resolved.body.encoded_offer, created.body.encoded_offer);
  });
});

test("serves QR SVGs for payment links and encoded offers", async () => {
  await withServer(async (baseUrl) => {
    const created = await postJson(`${baseUrl}/demo/offers`, {
      username: "qr",
      description: "QR checkout"
    });

    const linkQr = await getText(`${baseUrl}/offers/${created.body.offer_id}/qr.svg?payload=link`);
    const offerQr = await getText(`${baseUrl}/offers/${created.body.offer_id}/qr.svg?payload=offer`);

    assert.equal(linkQr.status, 200);
    assert.equal(linkQr.contentType, "image/svg+xml; charset=utf-8");
    assert.match(linkQr.body, /^<svg/);
    assert.equal(offerQr.status, 200);
    assert.match(offerQr.body, /^<svg/);
  });
});

test("checks payment readiness without creating an invoice", async () => {
  await withServer(async (baseUrl) => {
    const created = await postJson(`${baseUrl}/demo/offers`, {
      amount_min: "1000",
      amount_max: "2000"
    });
    const request = {
      amount: "1500",
      asset: { asset_type: "ckb", symbol: "CKB" }
    };

    const readiness = await postJson(`${baseUrl}/offers/${created.body.offer_id}/check`, request);
    const resolutions = await getJson(`${baseUrl}/offers/${created.body.offer_id}/resolutions`);

    assert.equal(readiness.status, 200);
    assert.equal(readiness.body.ready, true);
    assert.equal(readiness.body.next_action, "request_invoice");
    assert.equal(readiness.body.checks.some((check) => check.id === "signature" && check.status === "pass"), true);
    assert.equal(resolutions.body.resolutions.length, 0);
  });
});

test("reports readiness failures as diagnostics", async () => {
  await withServer(async (baseUrl) => {
    const created = await postJson(`${baseUrl}/demo/offers`, {
      amount_min: "1000",
      amount_max: "2000"
    });
    const readiness = await postJson(`${baseUrl}/offers/${created.body.offer_id}/check`, {
      amount: "2500",
      asset: { asset_type: "ckb", symbol: "CKB" }
    });

    assert.equal(readiness.status, 200);
    assert.equal(readiness.body.ready, false);
    assert.equal(readiness.body.next_action, "fix_request");
    assert.equal(readiness.body.checks.some((check) => check.code === "AMOUNT_TOO_HIGH"), true);
  });
});

test("adds Fiber topology confidence to payment readiness", async () => {
  const topologyClient = {
    async inspectPair() {
      return readyDirectTopology();
    }
  };

  await withServer(
    async (baseUrl) => {
      const created = await postJson(`${baseUrl}/demo/offers`, {
        amount_min: "1000",
        amount_max: "2000"
      });
      const readiness = await postJson(`${baseUrl}/offers/${created.body.offer_id}/check`, {
        amount: "1500",
        asset: { asset_type: "ckb", symbol: "CKB" }
      });

      assert.equal(readiness.status, 200);
      assert.equal(readiness.body.ready, true);
      assert.equal(readiness.body.confidence, "medium");
      assert.equal(readiness.body.topology.status, "ready");
      assert.equal(
        readiness.body.checks.some((check) => check.id === "amount_liquidity" && check.status === "pass"),
        true
      );
    },
    { topologyClient }
  );
});

test("runs invoice dry-run during payment readiness when invoice is supplied", async () => {
  let receivedInvoice;
  let receivedOptions;
  const topologyClient = {
    async checkInvoiceRoute(invoice, options) {
      receivedInvoice = invoice;
      receivedOptions = options;
      return {
        ...readyDirectTopology(),
        route_check: {
          ok: true,
          payable: true,
          dry_run: {
            payment_hash: "0xabc",
            fee: "0x0"
          }
        }
      };
    }
  };

  await withServer(
    async (baseUrl) => {
      const created = await postJson(`${baseUrl}/demo/offers`, {
        amount_min: "1000",
        amount_max: "2000"
      });
      const readiness = await postJson(`${baseUrl}/offers/${created.body.offer_id}/check`, {
        amount: "1500",
        asset: { asset_type: "ckb", symbol: "CKB" },
        invoice: "fibt1invoice",
        timeout_seconds: 5
      });

      assert.equal(readiness.status, 200);
      assert.equal(readiness.body.ready, true);
      assert.equal(readiness.body.confidence, "high");
      assert.equal(readiness.body.next_action, "send_payment");
      assert.equal(readiness.body.route_check.ok, true);
      assert.equal(receivedInvoice, "fibt1invoice");
      assert.equal(receivedOptions.timeoutSeconds, 5);
    },
    { topologyClient }
  );
});

test("reports resolver diagnostics in mock mode", async () => {
  await withServer(async (baseUrl) => {
    await postJson(`${baseUrl}/demo/offers`, {
      username: "diag",
      description: "Diagnostics checkout"
    });

    const diagnostics = await getJson(`${baseUrl}/diagnostics`);

    assert.equal(diagnostics.status, 200);
    assert.equal(diagnostics.body.invoice_mode, "mock");
    assert.equal(diagnostics.body.invoice_source.status, "mock");
    assert.equal(diagnostics.body.store.offers, 1);
    assert.equal(diagnostics.body.store.fiber_addresses, 1);
  });
});

test("reports unhealthy when the live Fiber invoice source is unreachable", async () => {
  const invoiceAdapter = {
    mode: "fiber-rpc",
    async probe() {
      return {
        mode: "fiber-rpc",
        configured: true,
        reachable: false,
        status: "error",
        error: { code: "FIBER_RPC_PROBE_FAILED" }
      };
    }
  };

  await withServer(async (baseUrl) => {
    const health = await getJson(`${baseUrl}/health`);
    assert.equal(health.status, 503);
    assert.equal(health.body.ok, false);
    assert.equal(health.body.dependencies.invoice_source.ok, false);
    assert.equal(health.body.dependencies.invoice_source.error, "FIBER_RPC_PROBE_FAILED");
  }, { invoiceAdapter, enforceNodeOwnership: false });
});

test("reports unconfigured Fiber topology when payer RPC is missing", async () => {
  await withServer(async (baseUrl) => {
    const topology = await getJson(`${baseUrl}/topology`);

    assert.equal(topology.status, 200);
    assert.equal(topology.body.ok, false);
    assert.equal(topology.body.configured, false);
    assert.equal(topology.body.status, "unconfigured");
  });
});

test("reports configured Fiber topology", async () => {
  const topologyClient = {
    async inspectPair() {
      return {
        ok: true,
        status: "ready",
        summary: "direct channel ready",
        direct_channel: {
          usable_for_payer_to_merchant: true
        }
      };
    }
  };

  await withServer(
    async (baseUrl) => {
      const topology = await getJson(`${baseUrl}/topology`);

      assert.equal(topology.status, 200);
      assert.equal(topology.body.configured, true);
      assert.equal(topology.body.ok, true);
      assert.equal(topology.body.status, "ready");
      assert.equal(topology.body.direct_channel.usable_for_payer_to_merchant, true);
    },
    { topologyClient }
  );
});

test("enforces API key when configured", async () => {
  await withServer(
    async (baseUrl) => {
      const health = await getJson(`${baseUrl}/health`);
      const rejected = await postJson(`${baseUrl}/demo/offers`, {
        username: "auth"
      });
      const listRejected = await getJson(`${baseUrl}/offers`);
      const accepted = await postJson(
        `${baseUrl}/demo/offers`,
        {
          username: "auth"
        },
        { "x-api-key": "test-key" }
      );

      assert.equal(health.body.auth_required, true);
      assert.equal(rejected.status, 401);
      assert.equal(rejected.body.error.code, "UNAUTHORIZED");
      assert.equal(listRejected.status, 401);
      assert.equal(accepted.status, 201);
      assert.match(accepted.body.offer_id, /^0x[0-9a-f]{64}$/);
    },
    { apiKey: "test-key" }
  );
});

test("reports reachable Fiber RPC diagnostics from the invoice adapter", async () => {
  const invoiceAdapter = {
    mode: "fiber-rpc",
    async probe() {
      return {
        mode: "fiber-rpc",
        configured: true,
        reachable: true,
        status: "ok",
        method: "node_info",
        result_summary: { node_id: "02abc" }
      };
    },
    async createInvoice() {
      throw new Error("not used");
    }
  };

  await withServer(
    async (baseUrl) => {
      const diagnostics = await getJson(`${baseUrl}/diagnostics`);

      assert.equal(diagnostics.status, 200);
      assert.equal(diagnostics.body.ok, true);
      assert.equal(diagnostics.body.invoice_mode, "fiber-rpc");
      assert.equal(diagnostics.body.invoice_source.reachable, true);
      assert.equal(diagnostics.body.invoice_source.result_summary.node_id, "02abc");
    },
    { invoiceAdapter }
  );
});

test("tracks and updates invoice resolution status", async () => {
  await withServer(async (baseUrl) => {
    const created = await postJson(`${baseUrl}/demo/offers`, {
      amount_min: "1000",
      amount_max: "2000"
    });
    const invoice = await postJson(`${baseUrl}/offers/${created.body.offer_id}/invoice`, {
      amount: "1500",
      asset: { asset_type: "ckb", symbol: "CKB" }
    });

    const statusBefore = await getJson(
      `${baseUrl}/offers/${created.body.offer_id}/resolutions/${invoice.body.resolution_id}`
    );
    const paid = await postJson(
      `${baseUrl}/offers/${created.body.offer_id}/resolutions/${invoice.body.resolution_id}/status`,
      {
        status: "invoice_paid",
        source: "test",
        settlement_reference: "mock-settlement-1"
      }
    );
    const listed = await getJson(`${baseUrl}/offers/${created.body.offer_id}/resolutions`);

    assert.equal(statusBefore.status, 200);
    assert.equal(statusBefore.body.status, "invoice_created");
    assert.equal(paid.status, 200);
    assert.equal(paid.body.status, "invoice_paid");
    assert.equal(paid.body.settlement.settlement_reference, "mock-settlement-1");
    assert.equal(listed.body.resolutions[0].status, "invoice_paid");
  });
});

test("syncs invoice resolution status from the invoice source", async () => {
  const invoiceAdapter = {
    mode: "fiber-rpc",
    async probe() {
      return {
        mode: "fiber-rpc",
        configured: true,
        reachable: true,
        status: "ok",
        method: "node_info"
      };
    },
    async createInvoice() {
      return {
        mode: "fiber-rpc",
        invoice: "fibt1000000001sync",
        payment_request: "fibt1000000001sync",
        payment_hash: "0x" + "a".repeat(64),
        mocked: false
      };
    },
    async syncInvoice(paymentHash) {
      return {
        mode: "fiber-rpc",
        payment_hash: paymentHash,
        status: "invoice_paid",
        fiber_status: "Paid",
        get_invoice_method: "get_invoice",
        amount: "0x5dc",
        currency: "Fibt",
        invoice: "fibt1000000001sync",
        raw_result: {
          status: "Paid"
        }
      };
    }
  };

  await withServer(
    async (baseUrl) => {
      const created = await postJson(`${baseUrl}/demo/offers`, {
        amount_min: "1000",
        amount_max: "2000"
      });
      await postJson(`${baseUrl}/offers/${created.body.offer_id}/webhooks`, {
        url: "https://merchant.example/hooks/fiber",
        events: ["invoice.paid"]
      });
      const invoice = await postJson(`${baseUrl}/offers/${created.body.offer_id}/invoice`, {
        amount: "1500",
        asset: { asset_type: "ckb", symbol: "CKB" }
      });
      const synced = await postJson(
        `${baseUrl}/offers/${created.body.offer_id}/resolutions/${invoice.body.resolution_id}/sync`,
        {}
      );
      const events = await getJson(`${baseUrl}/offers/${created.body.offer_id}/webhook-events`);

      assert.equal(synced.status, 200);
      assert.equal(synced.body.changed, true);
      assert.equal(synced.body.previous_status, "invoice_created");
      assert.equal(synced.body.next_status, "invoice_paid");
      assert.equal(synced.body.invoice_source.fiber_status, "Paid");
      assert.equal(synced.body.resolution.status, "invoice_paid");
      assert.equal(synced.body.resolution.settlement.settlement_reference, "0x" + "a".repeat(64));
      assert.equal(synced.body.resolution.status_history.at(-1).source, "fiber-rpc");
      assert.deepEqual(
        events.body.events.map((event) => event.type),
        ["invoice.created", "invoice.paid"]
      );
      assert.equal(events.body.events[1].deliveries.length, 1);
      assert.equal(events.body.events[1].payload.invoice_source.fiber_status, "Paid");
    },
    { invoiceAdapter }
  );
});

test("background worker syncs open invoice resolutions", async () => {
  const invoiceAdapter = {
    mode: "fiber-rpc",
    async probe() {
      return { mode: "fiber-rpc", configured: true, reachable: true, status: "ok" };
    },
    async createInvoice() {
      return {
        mode: "fiber-rpc",
        invoice: "fibt1worker",
        payment_request: "fibt1worker",
        payment_hash: "0x" + "c".repeat(64),
        mocked: false
      };
    },
    async syncInvoice(paymentHash) {
      return {
        mode: "fiber-rpc",
        payment_hash: paymentHash,
        status: "invoice_paid",
        fiber_status: "Paid",
        get_invoice_method: "get_invoice",
        amount: "0x5dc",
        currency: "Fibt",
        invoice: "fibt1worker",
        raw_result: { status: "Paid" }
      };
    }
  };

  await withServer(
    async (baseUrl, server) => {
      const created = await postJson(`${baseUrl}/demo/offers`, {
        amount_min: "1000",
        amount_max: "2000"
      });
      const invoice = await postJson(`${baseUrl}/offers/${created.body.offer_id}/invoice`, {
        amount: "1500",
        asset: { asset_type: "ckb", symbol: "CKB" }
      });

      const pass = await server.backgroundWorkers.runSettlementSyncPass();
      const resolution = await getJson(
        `${baseUrl}/offers/${created.body.offer_id}/resolutions/${invoice.body.resolution_id}`
      );
      const events = await getJson(`${baseUrl}/offers/${created.body.offer_id}/webhook-events`);

      assert.equal(pass.offers, 1);
      assert.equal(pass.changed, 1);
      assert.equal(resolution.body.status, "invoice_paid");
      assert.deepEqual(
        events.body.events.map((event) => event.type),
        ["invoice.created", "invoice.paid"]
      );
    },
    { invoiceAdapter, publicOrigin: "http://resolver.worker.test" }
  );
});

test("background worker skips historical mock invoices in live mode", async () => {
  let syncCalls = 0;
  const invoiceAdapter = {
    mode: "fiber-rpc",
    async probe() {
      return { mode: "fiber-rpc", configured: true, reachable: true, status: "ok" };
    },
    async createInvoice() {
      return {
        mode: "mock",
        invoice: "fibermock_historical",
        payment_hash: "0x" + "d".repeat(64),
        mocked: true
      };
    },
    async syncInvoice() {
      syncCalls += 1;
      throw new Error("historical mock invoice must not reach Fiber RPC");
    }
  };

  await withServer(
    async (baseUrl, server) => {
      const created = await postJson(`${baseUrl}/demo/offers`, {
        amount_min: "1000",
        amount_max: "2000"
      });
      await postJson(`${baseUrl}/offers/${created.body.offer_id}/invoice`, {
        amount: "1500",
        asset: { asset_type: "ckb", symbol: "CKB" }
      });

      const pass = await server.backgroundWorkers.runSettlementSyncPass();

      assert.equal(pass.failed, 0);
      assert.equal(pass.skipped, 1);
      assert.equal(pass.results[0].results[0].reason, "invoice_source_mismatch");
      assert.equal(syncCalls, 0);
    },
    { invoiceAdapter }
  );
});

test("batch sync skips terminal and missing-hash resolutions", async () => {
  let syncCalls = 0;
  const invoiceAdapter = {
    mode: "fiber-rpc",
    async probe() {
      return { mode: "fiber-rpc", configured: true, reachable: true, status: "ok" };
    },
    async createInvoice() {
      return {
        mode: "fiber-rpc",
        invoice: `fibt_${syncCalls}`,
        payment_hash: `0x${String(syncCalls).padStart(64, "b")}`,
        mocked: false
      };
    },
    async syncInvoice(paymentHash) {
      syncCalls += 1;
      return {
        mode: "fiber-rpc",
        payment_hash: paymentHash,
        status: "invoice_received",
        fiber_status: "Received",
        get_invoice_method: "get_invoice"
      };
    }
  };

  await withServer(
    async (baseUrl) => {
      const created = await postJson(`${baseUrl}/demo/offers`, {
        amount_min: "1000",
        amount_max: "3000"
      });
      const first = await postJson(`${baseUrl}/offers/${created.body.offer_id}/invoice`, {
        amount: "1500",
        asset: { asset_type: "ckb", symbol: "CKB" }
      });
      const second = await postJson(`${baseUrl}/offers/${created.body.offer_id}/invoice`, {
        amount: "1600",
        asset: { asset_type: "ckb", symbol: "CKB" }
      });
      await postJson(`${baseUrl}/offers/${created.body.offer_id}/resolutions/${second.body.resolution_id}/status`, {
        status: "invoice_cancelled"
      });

      const synced = await postJson(`${baseUrl}/offers/${created.body.offer_id}/resolutions/sync`, {});

      assert.equal(synced.status, 200);
      assert.equal(synced.body.checked, 2);
      assert.equal(synced.body.changed, 1);
      assert.equal(synced.body.skipped, 1);
      assert.equal(synced.body.results[0].resolution_id, first.body.resolution_id);
      assert.equal(synced.body.results[0].next_status, "invoice_received");
      assert.equal(synced.body.results[1].reason, "terminal_status");
    },
    { invoiceAdapter }
  );
});

test("exports reconciliation reports and receipts", async () => {
  await withServer(async (baseUrl) => {
    const created = await postJson(`${baseUrl}/demo/offers`, {
      username: "books",
      amount_min: "1000",
      amount_max: "3000"
    });
    const invoice = await postJson(`${baseUrl}/offers/${created.body.offer_id}/invoice`, {
      amount: "2500",
      asset: { asset_type: "ckb", symbol: "CKB" }
    });
    await postJson(`${baseUrl}/offers/${created.body.offer_id}/resolutions/${invoice.body.resolution_id}/status`, {
      status: "invoice_paid",
      source: "test",
      settlement_reference: "settlement-2500"
    });

    const report = await getJson(`${baseUrl}/offers/${created.body.offer_id}/reconciliation.json`);
    const csv = await getText(`${baseUrl}/offers/${created.body.offer_id}/reconciliation.csv`);
    const receipt = await getJson(
      `${baseUrl}/offers/${created.body.offer_id}/resolutions/${invoice.body.resolution_id}/receipt.json`
    );

    assert.equal(report.status, 200);
    assert.equal(report.body.totals.resolution_count, 1);
    assert.equal(report.body.totals.by_status.invoice_paid, 1);
    assert.equal(report.body.rows[0].settlement_reference, "settlement-2500");
    assert.equal(csv.status, 200);
    assert.equal(csv.contentType, "text/csv; charset=utf-8");
    assert.match(csv.body, /invoice_paid/);
    assert.match(csv.body, /settlement-2500/);
    assert.equal(receipt.status, 200);
    assert.equal(receipt.body.payment.status, "invoice_paid");
    assert.equal(receipt.body.payment.settlement.settlement_reference, "settlement-2500");
  });
});

test("records webhook subscriptions and lifecycle outbox events", async () => {
  await withServer(async (baseUrl) => {
    const created = await postJson(`${baseUrl}/demo/offers`, {
      username: "hooks",
      amount_min: "1000",
      amount_max: "3000"
    });
    const webhook = await postJson(`${baseUrl}/offers/${created.body.offer_id}/webhooks`, {
      url: "https://merchant.example/hooks/fiber",
      events: ["invoice.created", "invoice.paid"]
    });
    const invoice = await postJson(`${baseUrl}/offers/${created.body.offer_id}/invoice`, {
      amount: "1500",
      asset: { asset_type: "ckb", symbol: "CKB" }
    });
    await postJson(`${baseUrl}/offers/${created.body.offer_id}/resolutions/${invoice.body.resolution_id}/status`, {
      status: "invoice_paid",
      source: "test"
    });
    const webhooks = await getJson(`${baseUrl}/offers/${created.body.offer_id}/webhooks`);
    const events = await getJson(`${baseUrl}/offers/${created.body.offer_id}/webhook-events`);

    assert.equal(webhook.status, 201);
    assert.match(webhook.body.id, /^wh_/);
    assert.equal(invoice.body.webhook_delivery_count, 1);
    assert.equal(webhooks.body.webhooks.length, 1);
    assert.deepEqual(
      events.body.events.map((event) => event.type),
      ["invoice.created", "invoice.paid"]
    );
    assert.equal(events.body.events[0].deliveries[0].status, "pending");
    assert.equal(events.body.events[0].payload.resolution.status, "invoice_created");
    assert.equal(events.body.events[1].payload.resolution.status, "invoice_paid");
  });
});

test("manages webhook lifecycle, signing secrets, and test deliveries", async () => {
  await withWebhookReceiver(async (receiver) => {
    await withServer(async (baseUrl) => {
      const created = await postJson(`${baseUrl}/demo/offers`, { amount_min: "1000", amount_max: "3000" });
      const webhook = await postJson(`${baseUrl}/offers/${created.body.offer_id}/webhooks`, {
        url: receiver.url,
        events: ["invoice.created", "invoice.paid"]
      });

      assert.equal(webhook.status, 201);
      assert.match(webhook.body.signing_secret, /^whsec_/);
      assert.match(webhook.body.secret_hint, /^whsec_/);

      const listed = await getJson(`${baseUrl}/offers/${created.body.offer_id}/webhooks`);
      assert.equal(listed.body.webhooks.length, 1);
      assert.equal(listed.body.webhooks[0].signing_secret, undefined);

      const paused = await patchJson(`${baseUrl}/offers/${created.body.offer_id}/webhooks/${webhook.body.id}`, {
        disabled: true
      });
      const rejectedTest = await postJson(
        `${baseUrl}/offers/${created.body.offer_id}/webhooks/${webhook.body.id}/test`,
        {}
      );
      assert.equal(paused.body.disabled, true);
      assert.equal(rejectedTest.status, 409);
      assert.equal(rejectedTest.body.error.code, "WEBHOOK_DISABLED");

      await patchJson(`${baseUrl}/offers/${created.body.offer_id}/webhooks/${webhook.body.id}`, { disabled: false });
      const rotated = await postJson(
        `${baseUrl}/offers/${created.body.offer_id}/webhooks/${webhook.body.id}/rotate-secret`,
        {}
      );
      assert.match(rotated.body.signing_secret, /^whsec_/);
      assert.notEqual(rotated.body.signing_secret, webhook.body.signing_secret);

      const delivered = await postJson(`${baseUrl}/offers/${created.body.offer_id}/webhooks/${webhook.body.id}/test`, {});
      assert.equal(delivered.status, 200);
      assert.equal(delivered.body.delivered, 1);
      assert.equal(receiver.requests.length, 1);
      assert.equal(receiver.requests[0].headers["x-fiber-offers-event-type"], "webhook.test");
      assert.equal(
        receiver.requests[0].headers["x-fiber-offers-signature"],
        signWebhookPayload(
          rotated.body.signing_secret,
          receiver.requests[0].headers["x-fiber-offers-timestamp"],
          receiver.requests[0].body
        )
      );

      const deleted = await deleteJson(`${baseUrl}/offers/${created.body.offer_id}/webhooks/${webhook.body.id}`);
      const afterDelete = await getJson(`${baseUrl}/offers/${created.body.offer_id}/webhooks`);
      assert.equal(deleted.body.deleted, true);
      assert.equal(afterDelete.body.webhooks.length, 0);
    });
  });
});

test("delivers webhook outbox events with signed HTTP posts", async () => {
  await withWebhookReceiver(async (receiver) => {
    await withServer(async (baseUrl) => {
      const created = await postJson(`${baseUrl}/demo/offers`, {
        username: "delivery",
        amount_min: "1000",
        amount_max: "3000"
      });
      await postJson(`${baseUrl}/offers/${created.body.offer_id}/webhooks`, {
        url: receiver.url,
        events: ["invoice.created"],
        secret: "test-secret"
      });
      const invoice = await postJson(`${baseUrl}/offers/${created.body.offer_id}/invoice`, {
        amount: "1500",
        asset: { asset_type: "ckb", symbol: "CKB" }
      });
      const delivery = await postJson(`${baseUrl}/offers/${created.body.offer_id}/webhook-events/deliver`, {});
      const events = await getJson(`${baseUrl}/offers/${created.body.offer_id}/webhook-events`);

      assert.equal(invoice.body.webhook_delivery_count, 1);
      assert.equal(delivery.status, 200);
      assert.equal(delivery.body.attempted, 1);
      assert.equal(delivery.body.delivered, 1);
      assert.equal(receiver.requests.length, 1);
      assert.equal(receiver.requests[0].headers["x-fiber-offers-event-type"], "invoice.created");
      assert.equal(
        receiver.requests[0].headers["x-fiber-offers-signature"],
        signWebhookPayload("test-secret", receiver.requests[0].headers["x-fiber-offers-timestamp"], receiver.requests[0].body)
      );
      assert.equal(JSON.parse(receiver.requests[0].body).payload.resolution.id, invoice.body.resolution_id);
      assert.equal(events.body.events[0].deliveries[0].status, "delivered");
      assert.equal(events.body.events[0].deliveries[0].attempts, 1);
    });
  });
});

test("fails a webhook delivery after the configured timeout", async () => {
  const result = await deliverWebhookEvent(
    {
      id: "evt_timeout",
      offer_id: "0x" + "b".repeat(64),
      type: "invoice.created",
      created_at: new Date().toISOString(),
      payload: { resolution: { id: "res_timeout" } }
    },
    {
      secret: "timeout-secret"
    },
    {
      webhook_id: "wh_timeout",
      url: "https://merchant.example/hooks/fiber"
    },
    {
      timeoutMs: 10,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener(
            "abort",
            () => {
              const error = new Error("request aborted");
              error.name = "AbortError";
              reject(error);
            },
            { once: true }
          );
        })
    }
  );

  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "WEBHOOK_DELIVERY_TIMEOUT");
  assert.match(result.error.message, /timed out after 10ms/);
});

test("background worker delivers pending webhook events", async () => {
  await withWebhookReceiver(async (receiver) => {
    await withServer(async (baseUrl, server) => {
      const created = await postJson(`${baseUrl}/demo/offers`, {
        username: "worker-delivery",
        amount_min: "1000",
        amount_max: "3000"
      });
      await postJson(`${baseUrl}/offers/${created.body.offer_id}/webhooks`, {
        url: receiver.url,
        events: ["invoice.created"],
        secret: "worker-secret"
      });
      await postJson(`${baseUrl}/offers/${created.body.offer_id}/invoice`, {
        amount: "1500",
        asset: { asset_type: "ckb", symbol: "CKB" }
      });

      const pass = await server.backgroundWorkers.runWebhookDeliveryPass();
      const events = await getJson(`${baseUrl}/offers/${created.body.offer_id}/webhook-events`);

      assert.equal(pass.offers, 1);
      assert.equal(pass.attempted, 1);
      assert.equal(pass.delivered, 1);
      assert.equal(receiver.requests.length, 1);
      assert.equal(receiver.requests[0].headers["x-fiber-offers-event-type"], "invoice.created");
      assert.equal(events.body.events[0].deliveries[0].status, "delivered");
      assert.equal(events.body.events[0].deliveries[0].attempts, 1);
    });
  });
});

test("rejects invalid terminal status transitions", async () => {
  await withServer(async (baseUrl) => {
    const created = await postJson(`${baseUrl}/demo/offers`);
    const invoice = await postJson(`${baseUrl}/offers/${created.body.offer_id}/invoice`, {
      amount: "1000",
      asset: { asset_type: "ckb", symbol: "CKB" }
    });
    await postJson(`${baseUrl}/offers/${created.body.offer_id}/resolutions/${invoice.body.resolution_id}/status`, {
      status: "invoice_paid"
    });
    const rejected = await postJson(
      `${baseUrl}/offers/${created.body.offer_id}/resolutions/${invoice.body.resolution_id}/status`,
      {
        status: "invoice_failed"
      }
    );

    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.error.code, "INVALID_STATUS_TRANSITION");
  });
});

test("rejects invoice requests outside offer bounds", async () => {
  await withServer(async (baseUrl) => {
    const created = await postJson(`${baseUrl}/demo/offers`, {
      amount_min: "1000",
      amount_max: "2000"
    });
    const rejected = await postJson(`${baseUrl}/offers/${created.body.offer_id}/invoice`, {
      amount: "2500",
      asset: { asset_type: "ckb", symbol: "CKB" }
    });

    assert.equal(rejected.status, 422);
    assert.equal(rejected.body.error.code, "AMOUNT_TOO_HIGH");
  });
});

test("binds live offers to the configured Fiber node identity", async () => {
  const configuredNodeId = "02" + "c".repeat(64);
  await withServer(async (baseUrl) => {
    const keys = generateOfferKeyPair();
    const offer = createSignedOffer(
      {
        node_id: "03" + "d".repeat(64),
        public_key: keys.publicKeyPem,
        resolver_url: baseUrl,
        assets: [{ asset_type: "ckb", symbol: "CKB" }]
      },
      keys.privateKeyPem
    );
    const rejected = await postJson(`${baseUrl}/offers`, { encoded_offer: encodeOffer(offer) });
    assert.equal(rejected.status, 403);
    assert.equal(rejected.body.error.code, "OFFER_NODE_MISMATCH");

    const created = await postJson(`${baseUrl}/demo/offers`, { amount: "1000" });
    assert.equal(created.body.offer.node_id, configuredNodeId);
    assert.equal(created.body.ownership.status, "verified");
  }, { invoiceAdapter: new MockInvoiceAdapter({ nodeId: configuredNodeId }), enforceNodeOwnership: true });
});

test("revokes an offer with its signed lifecycle key", async () => {
  await withServer(async (baseUrl) => {
    const created = await postJson(`${baseUrl}/demo/offers`, { amount: "1000" });
    const revocation = createOfferRevocation(created.body.offer, created.body.offer_private_key_pem);
    const revoked = await deleteJsonBody(`${baseUrl}/offers/${created.body.offer_id}`, { revocation });
    const invoice = await postJson(`${baseUrl}/offers/${created.body.offer_id}/invoice`, {
      amount: "1000",
      asset: { asset_type: "ckb", symbol: "CKB" }
    });
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body.revoked, true);
    assert.equal(invoice.status, 410);
    assert.equal(invoice.body.error.code, "OFFER_REVOKED");
  });
});

test("enforces recurring cycle and spending caps", async () => {
  await withServer(async (baseUrl) => {
    const created = await postJson(`${baseUrl}/demo/offers`, {
      amount: "1000",
      recurrence: { interval: "custom_seconds", custom_seconds: 1, amount: "1000", cap_cycles: 2 }
    });
    const request = { amount: "1000", asset: { asset_type: "ckb", symbol: "CKB" } };
    const first = await postJson(`${baseUrl}/offers/${created.body.offer_id}/invoice`, { ...request, recurrence_cycle: 1 });
    const second = await postJson(`${baseUrl}/offers/${created.body.offer_id}/invoice`, { ...request, recurrence_cycle: 2 });
    const blocked = await postJson(`${baseUrl}/offers/${created.body.offer_id}/invoice`, { ...request, recurrence_cycle: 3 });
    const status = await getJson(`${baseUrl}/offers/${created.body.offer_id}/recurrence-status`);
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error.code, "RECURRENCE_CYCLE_CAP_REACHED");
    assert.equal(status.body.cycles_created, 2);
    assert.equal(status.body.cycle_cap_remaining, 0);
  });
});

test("rejects Fiber Address username collisions", async () => {
  await withServer(async (baseUrl) => {
    await postJson(`${baseUrl}/demo/offers`, { username: "claimed", amount: "1000" });
    const collision = await postJson(`${baseUrl}/demo/offers`, { username: "claimed", amount: "2000" });
    assert.equal(collision.status, 409);
    assert.equal(collision.body.error.code, "USERNAME_ALREADY_CLAIMED");
  });
});

test("returns a stable unavailable-recipient error when invoice RPC fails", async () => {
  const invoiceAdapter = new MockInvoiceAdapter();
  invoiceAdapter.createInvoice = async () => {
    const error = new Error("connect refused");
    error.code = "ECONNREFUSED";
    throw error;
  };
  await withServer(async (baseUrl) => {
    const created = await postJson(`${baseUrl}/demo/offers`, { amount: "1000" });
    const result = await postJson(`${baseUrl}/offers/${created.body.offer_id}/invoice`, {
      amount: "1000",
      asset: { asset_type: "ckb", symbol: "CKB" }
    });
    assert.equal(result.status, 503);
    assert.equal(result.body.error.code, "RECIPIENT_UNAVAILABLE");
    assert.match(result.body.error.message, /temporarily unavailable/);
  }, { invoiceAdapter });
});

test("encrypts webhook signing secrets in JSON persistence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fiber-offers-store-"));
  try {
    const path = join(directory, "offers.json");
    const store = new JsonOfferStore(path, { encryptionKey: "test-encryption-key" });
    const keys = generateOfferKeyPair();
    const offer = createSignedOffer(
      {
        node_id: "02" + "e".repeat(64),
        public_key: keys.publicKeyPem,
        resolver_url: "https://resolver.example",
        assets: [{ asset_type: "ckb", symbol: "CKB" }]
      },
      keys.privateKeyPem
    );
    await store.upsertOffer(offer, encodeOffer(offer));
    await store.addWebhook(offer.offer_id, {
      url: "https://merchant.example/hook",
      events: ["invoice.paid"],
      secret: "whsec_plaintext-must-not-persist"
    });
    const raw = await readFile(path, "utf8");
    assert.doesNotMatch(raw, /plaintext-must-not-persist/);
    assert.match(raw, /enc:v1:/);

    const reloaded = new JsonOfferStore(path, { encryptionKey: "test-encryption-key" });
    assert.equal((await reloaded.listWebhooks(offer.offer_id))[0].secret, "whsec_plaintext-must-not-persist");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("blocks private webhook targets when production policy is enabled", async () => {
  await withServer(async (baseUrl) => {
    const created = await postJson(`${baseUrl}/demo/offers`, { amount: "1000" });
    const webhook = await postJson(`${baseUrl}/offers/${created.body.offer_id}/webhooks`, {
      url: "http://127.0.0.1:9999/internal",
      events: ["invoice.paid"]
    });
    assert.equal(webhook.status, 400);
    assert.equal(webhook.body.error.code, "INVALID_WEBHOOK_URL");
  }, { allowPrivateWebhookTargets: false });
});

test("rate limits repeated public invoice creation", async () => {
  await withServer(async (baseUrl) => {
    const created = await postJson(`${baseUrl}/demo/offers`, { amount: "1000" });
    const request = { amount: "1000", asset: { asset_type: "ckb", symbol: "CKB" } };
    const first = await postJson(`${baseUrl}/offers/${created.body.offer_id}/invoice`, request);
    const blocked = await postJson(`${baseUrl}/offers/${created.body.offer_id}/invoice`, request);
    assert.equal(first.status, 201);
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error.code, "RATE_LIMITED");
  }, { rateLimitMax: 1 });
});

function readyDirectTopology() {
  return {
    ok: true,
    status: "ready",
    summary: "A direct payer-to-merchant channel is connected and has payer outbound liquidity.",
    readiness: {
      deterministic_local_payment: true,
      direct_channel_ready: true,
      dry_run_required: true
    },
    direct_channel: {
      usable_for_payer_to_merchant: true,
      payer_local_balance_total: "5000",
      payer_local_balance_total_hex: "0x1388"
    },
    payer: {
      channels: {
        ckb: 1,
        pending_tlc_count: 0
      }
    },
    merchant: {
      channels: {
        ckb: 1,
        pending_tlc_count: 0
      }
    },
    route_candidates: {
      direct: {
        payer_local_balance_total: "5000",
        payer_local_balance_total_hex: "0x1388"
      },
      shared_counterparties: []
    },
    common_channel_counterparties: [],
    online_common_channel_counterparties: [],
    blockers: [],
    warnings: [],
    next_actions: ["Run a Fiber send_payment dry-run against a fresh invoice before sending funds."]
  };
}

async function withServer(callback, options = {}) {
  const server = createServer({
    store: new InMemoryOfferStore(),
    invoiceAdapter: options.invoiceAdapter ?? new MockInvoiceAdapter(),
    apiKey: options.apiKey,
    topologyClient: options.topologyClient ?? false,
    fetchImpl: options.fetchImpl,
    workers: options.workers,
    publicOrigin: options.publicOrigin,
    enforceNodeOwnership: options.enforceNodeOwnership,
    allowPrivateWebhookTargets: options.allowPrivateWebhookTargets,
    rateLimitMax: options.rateLimitMax,
    rateLimitWindowMs: options.rateLimitWindowMs,
    logger: options.logger ?? { error() {} }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://${address.address}:${address.port}`;

  try {
    await callback(baseUrl, server);
  } finally {
    server.stopBackgroundWorkers?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function withWebhookReceiver(callback) {
  const requests = [];
  const server = createHttpServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    requests.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body
    });
    response.writeHead(204);
    response.end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const receiver = {
    url: `http://${address.address}:${address.port}/webhooks/fiber`,
    requests
  };

  try {
    await callback(receiver);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function getJson(url) {
  const response = await fetch(url);
  return {
    status: response.status,
    body: await response.json()
  };
}

async function getText(url) {
  const response = await fetch(url);
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    body: await response.text()
  };
}

async function postJson(url, body, headers = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
  return {
    status: response.status,
    body: await response.json()
  };
}

async function patchJson(url, body, headers = {}) {
  const response = await fetch(url, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
  return {
    status: response.status,
    body: await response.json()
  };
}

async function deleteJson(url, headers = {}) {
  const response = await fetch(url, { method: "DELETE", headers });
  return {
    status: response.status,
    body: await response.json()
  };
}

async function deleteJsonBody(url, body, headers = {}) {
  const response = await fetch(url, {
    method: "DELETE",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}
