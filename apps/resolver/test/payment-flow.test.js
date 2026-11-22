// End-to-end checks of the public SDK payment flow against a real resolver
// process (mock invoice mode). These catch disagreements between what the SDK
// sends and what the resolver accepts, which unit tests on either side miss.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, InMemoryOfferStore } from "../src/server.js";
import { MockInvoiceAdapter } from "../src/invoice-adapter.js";
import {
  FIBER_CURRENCIES,
  FiberOffersClient,
  FiberPaymentFlowClient,
  formatInvoiceDescription
} from "../../../packages/sdk/src/index.js";
import {
  ckbScriptHash,
  createSignedOffer,
  encodeOffer,
  generateOfferKeyPair,
  serializeCkbScript
} from "../../../packages/protocol/src/index.js";

const asset = { asset_type: "ckb", symbol: "CKB" };
const tokenScript = { code_hash: "0x" + "aa".repeat(32), hash_type: "type", args: "0x" + "01".repeat(32) };
const token = { asset_type: "udt", symbol: "USDI", type_script_hash: ckbScriptHash(tokenScript) };

test("SDK payOffer completes a payment on a single-use offer", async () => {
  await withResolver(async ({ client, ledger }) => {
    const created = await client.demoCreateOffer({ single_use: true, amount: "1000" });
    const payer = fakePayerNode({ ledger });
    const flow = new FiberPaymentFlowClient({ resolverClient: client, paymentClient: payer });

    const paid = await flow.payOffer(created.offer_id, { amount: "1000", asset }, { execute: true });
    const secondAttempt = await flow.payOffer(created.offer_id, { amount: "1000", asset }, { execute: true });

    assert.equal(paid.status, "payment_sent");
    assert.equal(paid.ok, true);
    assert.equal(payer.sent.length, 1);
    assert.equal(payer.sent[0], paid.invoice.invoice);
    assert.equal(secondAttempt.status, "blocked_before_invoice");
    assert.equal(secondAttempt.failure.code, "OFFER_ALREADY_USED");
    assert.equal(payer.sent.length, 1);
  });
});

test("SDK payOffer retries a single-use payment after a transport failure", async () => {
  await withResolver(async ({ client, ledger }) => {
    const created = await client.demoCreateOffer({ single_use: true, amount: "1000" });
    const payer = fakePayerNode({ ledger, failFirstSend: true });
    const flow = new FiberPaymentFlowClient({ resolverClient: client, paymentClient: payer });
    const options = { execute: true, idempotencyKey: "order-42" };

    const failed = await flow.payOffer(created.offer_id, { amount: "1000", asset }, options);
    const retried = await flow.payOffer(created.offer_id, { amount: "1000", asset }, options);
    const resolutions = await client.getResolutions(created.offer_id);

    assert.equal(failed.status, "payment_failed");
    assert.equal(retried.status, "payment_sent");
    assert.equal(retried.invoice.idempotent_replay, true);
    assert.equal(retried.invoice.invoice, failed.invoice.invoice);
    assert.deepEqual(payer.sent, [failed.invoice.invoice]);
    assert.equal(resolutions.resolutions.length, 1);
  });
});

test("SDK payOffer retries a recurring cycle after a transport failure", async () => {
  await withResolver(async ({ client, ledger }) => {
    const created = await client.demoCreateOffer({
      amount: "1000",
      recurrence: { interval: "daily", amount: "1000", cap_cycles: 3 }
    });
    const payer = fakePayerNode({ ledger, failFirstSend: true });
    const flow = new FiberPaymentFlowClient({ resolverClient: client, paymentClient: payer });
    const cycleOne = { amount: "1000", asset, recurrence_cycle: 1, approval_id: "approval-7" };
    const options = { execute: true, idempotencyKey: "approval-7:1" };

    const failed = await flow.payOffer(created.offer_id, cycleOne, options);
    const retried = await flow.payOffer(created.offer_id, cycleOne, options);
    const nextCycle = await flow.payOffer(
      created.offer_id,
      { ...cycleOne, recurrence_cycle: 2 },
      { execute: true, idempotencyKey: "approval-7:2" }
    );
    const status = await client.getRecurrenceStatus(created.offer_id);

    assert.equal(failed.status, "payment_failed");
    assert.equal(retried.status, "payment_sent");
    assert.equal(retried.invoice.recurrence.cycle, 1);
    assert.equal(nextCycle.status, "payment_sent");
    assert.equal(nextCycle.invoice.recurrence.cycle, 2);
    assert.equal(status.cycles_created, 2);
    assert.equal(payer.sent.length, 2);
  });
});

test("SDK verifies the invoice against the signed offer before paying", async () => {
  await withResolver(async ({ client, ledger }) => {
    const created = await client.demoCreateOffer({ amount: "1000", assets: [asset, token] });
    const payer = fakePayerNode({ ledger });
    const flow = new FiberPaymentFlowClient({ resolverClient: client, paymentClient: payer });

    // By offer ID, by encoded offer and by signed offer object.
    const byId = await flow.payOffer(created.offer_id, { amount: "1000", asset }, { execute: true });
    const byEncoded = await flow.payOffer(created.encoded_offer, { amount: "1000", asset: token }, { execute: true });
    const byObject = await flow.payOffer(created.offer, { amount: "1000" }, { execute: true });

    assert.deepEqual([byId.status, byEncoded.status, byObject.status], ["payment_sent", "payment_sent", "payment_sent"]);
    assert.equal(byId.invoice_verification.verified, true);
    assert.equal(byId.invoice_verification.invoice.payee_public_key, created.offer.node_id);
    assert.equal(byEncoded.invoice_verification.invoice.type_script_hash, token.type_script_hash);
    assert.deepEqual(
      byId.invoice_verification.checks.map((check) => [check.id, check.status]),
      [["payee", "pass"], ["amount", "pass"], ["currency", "pass"], ["asset", "pass"], ["expiry", "pass"], ["binding", "pass"]]
    );
    // The node-signed description names this offer and the resolution it was minted for.
    assert.equal(byId.invoice_verification.invoice.offer_id, created.offer_id);
    assert.equal(byId.invoice_verification.invoice.resolution_id, byId.invoice.resolution_id);
    assert.equal(payer.sent.length, 3);
  });
});

test("SDK refuses to pay an invoice a resolver substituted", async () => {
  const attacks = [
    {
      name: "a different payee",
      code: "INVOICE_PAYEE_MISMATCH",
      tamper: (invoice) => setAttr(invoice, "payee_public_key", "03" + "e".repeat(64))
    },
    { name: "no stated payee", code: "INVOICE_PAYEE_MISSING", tamper: (invoice) => dropAttr(invoice, "payee_public_key") },
    { name: "a larger amount", code: "INVOICE_AMOUNT_MISMATCH", tamper: (invoice) => ({ ...invoice, amount: "0x2710" }) },
    { name: "another network", code: "INVOICE_CURRENCY_MISMATCH", tamper: (invoice) => ({ ...invoice, currency: "Fibb" }) },
    {
      name: "a token instead of CKB",
      code: "INVOICE_ASSET_MISMATCH",
      tamper: (invoice) => setAttr(invoice, "udt_script", hex(serializeCkbScript(tokenScript)))
    },
    {
      name: "an expired invoice",
      code: "INVOICE_EXPIRED",
      tamper: (invoice) => ({ ...invoice, data: { ...invoice.data, timestamp: "0x1" } })
    },
    {
      // A genuine invoice from the same node, same amount, for someone else's order.
      name: "an invoice issued for a different offer",
      code: "INVOICE_OFFER_MISMATCH",
      tamper: (invoice) => setAttr(invoice, "description", `Other order (fiberoffer:0x${"7".repeat(64)}:res_other)`)
    },
    {
      name: "an invoice from another resolution of the same offer",
      code: "INVOICE_RESOLUTION_MISMATCH",
      tamper: (invoice) =>
        setAttr(
          invoice,
          "description",
          invoice.data.attrs.find((attribute) => "description" in attribute).description.replace(/res_[a-z0-9-]+/, "res_earlier")
        )
    },
    {
      name: "an invoice that names no offer",
      code: "INVOICE_BINDING_MISSING",
      tamper: (invoice) => setAttr(invoice, "description", "Coffee checkout")
    },
    {
      name: "a payment hash that is not the invoice's",
      code: "INVOICE_PAYMENT_HASH_MISMATCH",
      tamper: (invoice) => ({ ...invoice, data: { ...invoice.data, payment_hash: "0x" + "6".repeat(64) } })
    }
  ];

  for (const attack of attacks) {
    await withResolver(
      async ({ client, ledger }) => {
        const created = await client.demoCreateOffer({ amount: "1000" });
        const payer = fakePayerNode({ ledger });
        const flow = new FiberPaymentFlowClient({ resolverClient: client, paymentClient: payer });

        const result = await flow.payOffer(created.encoded_offer, { amount: "1000", asset }, { execute: true });

        assert.equal(result.status, "invoice_rejected", attack.name);
        assert.equal(result.ok, false, attack.name);
        assert.equal(result.failure.code, attack.code, attack.name);
        assert.equal(result.next_action, "do_not_pay", attack.name);
        assert.deepEqual(payer.sent, [], attack.name);
      },
      { tamper: attack.tamper }
    );
  }
});

test("SDK refuses the wrong token, an unreadable invoice, and an unverifiable one", async () => {
  const otherScript = { ...tokenScript, args: "0x" + "02".repeat(32) };
  await withResolver(
    async ({ client, ledger }) => {
      const created = await client.demoCreateOffer({ amount: "1000", assets: [asset, token] });
      const payer = fakePayerNode({ ledger });
      const flow = new FiberPaymentFlowClient({ resolverClient: client, paymentClient: payer });

      const wrongToken = await flow.payOffer(created.offer, { amount: "1000", asset: token }, { execute: true });

      // A payer node that says the string is not an invoice at all.
      payer.parseInvoice = async () => {
        throw Object.assign(new Error("invalid invoice"), { kind: "rpc", retryable: false });
      };
      const unreadable = await flow.payOffer(created.offer, { amount: "1000", asset }, { execute: true });

      // A payer node that cannot read invoices leaves nothing to verify with.
      delete payer.parseInvoice;
      const unverifiable = await flow.payOffer(created.offer, { amount: "1000", asset }, { execute: true });
      const overridden = await flow.payOffer(
        created.offer,
        { amount: "1000", asset },
        { execute: true, skipInvoiceVerification: true }
      );

      assert.deepEqual([wrongToken.status, wrongToken.failure.code], ["invoice_rejected", "INVOICE_ASSET_MISMATCH"]);
      assert.deepEqual([unreadable.status, unreadable.failure.code], ["invoice_rejected", "INVOICE_UNPARSEABLE"]);
      assert.deepEqual([unverifiable.status, unverifiable.failure.code], ["invoice_unverified", "INVOICE_NOT_VERIFIED"]);
      assert.equal(overridden.status, "payment_sent");
      assert.equal(payer.sent.length, 1);
    },
    {
      // Token invoices are really for a different token; CKB ones are honest.
      tamper: (invoice, { isToken }) =>
        isToken ? setAttr(invoice, "udt_script", hex(serializeCkbScript(otherScript))) : invoice
    }
  );
});

test("SDK refuses a resolver the offer did not sign and requests the offer cannot accept", async () => {
  await withResolver(async ({ client, baseUrl, ledger }) => {
    const payer = fakePayerNode({ ledger });
    const flow = new FiberPaymentFlowClient({ resolverClient: client, paymentClient: payer });
    const keys = generateOfferKeyPair();
    const elsewhere = createSignedOffer(
      {
        node_id: "02" + "5".repeat(64),
        public_key: keys.publicKeyPem,
        resolver_url: "https://offers.merchant.example",
        amount_min: "1000",
        amount_max: "1000",
        assets: [asset]
      },
      keys.privateKeyPem
    );
    await client.registerOffer(elsewhere);

    const mismatch = await flow.payOffer(encodeOffer(elsewhere), { amount: "1000", asset }, { execute: true });
    const overridden = await new FiberPaymentFlowClient({
      resolverClient: client,
      paymentClient: payer,
      allowResolverMismatch: true
    }).payOffer(encodeOffer(elsewhere), { amount: "1000", asset }, { execute: true });

    const local = await client.demoCreateOffer({ amount: "1000" });
    const tooMuch = await flow.payOffer(local.offer, { amount: "5000", asset }, { execute: true });
    const tampered = { ...local.offer, amount_max: "999999" };

    assert.deepEqual([mismatch.status, mismatch.failure.code], ["resolver_mismatch", "RESOLVER_URL_MISMATCH"]);
    assert.deepEqual(mismatch.failure.details, {
      offer_resolver: "https://offers.merchant.example",
      contacted_resolver: baseUrl
    });
    assert.equal(overridden.status, "payment_sent");
    assert.deepEqual([tooMuch.status, tooMuch.failure.code], ["blocked_before_invoice", "AMOUNT_MUST_MATCH_FIXED_AMOUNT"]);
    await assert.rejects(
      () => flow.payOffer(tampered, { amount: "5000", asset }, { execute: true }),
      (error) => error.code === "OFFER_ID_MISMATCH"
    );
    assert.equal(payer.sent.length, 1);
  });
});

// Stands in for the payer's Fiber node: accepts dry-runs and records payments.
// It reads an invoice from the ledger of what was really minted, as a real node
// reads the invoice string itself: never from what the resolver claims.
function fakePayerNode(options = {}) {
  let failNextSend = Boolean(options.failFirstSend);
  const node = {
    sent: [],
    async parseInvoice(invoice) {
      const parsed = options.ledger?.get(invoice);
      if (!parsed) throw Object.assign(new Error("invalid invoice"), { kind: "rpc", retryable: false });
      return { invoice: parsed };
    },
    async checkPaymentRoute(invoice) {
      return { ok: true, payable: true, payment_hash: `0xroute-${invoice.length}` };
    },
    async sendPayment(invoice) {
      if (failNextSend) {
        failNextSend = false;
        throw new Error("socket hang up");
      }
      node.sent.push(invoice);
      return { payment_hash: `0xsent-${node.sent.length}`, status: "Created" };
    }
  };
  return node;
}

// Mints mock invoices and records, per invoice string, what a Fiber node would
// read back from it. `tamper` plays a hostile resolver: it changes what the
// invoice really contains while the resolver's response stays as it was.
class LedgerInvoiceAdapter extends MockInvoiceAdapter {
  constructor(ledger, tamper) {
    super();
    this.ledger = ledger;
    this.tamper = tamper ?? ((invoice) => invoice);
  }

  async createInvoice(input) {
    const issued = await super.createInvoice(input);
    const isToken = input.asset.asset_type !== "ckb";
    const honest = {
      currency: FIBER_CURRENCIES[input.offer.network],
      amount: `0x${BigInt(input.amount).toString(16)}`,
      signature: "0x00",
      data: {
        timestamp: `0x${Date.now().toString(16)}`,
        payment_hash: issued.payment_hash,
        attrs: [
          { description: formatInvoiceDescription(input.offer, input.resolutionId) },
          { expiry_time: { secs: issued.expiry_seconds, nanos: 0 } },
          { payee_public_key: input.offer.node_id },
          ...(isToken ? [{ udt_script: hex(serializeCkbScript(tokenScript)) }] : [])
        ]
      }
    };
    this.ledger.set(issued.invoice, this.tamper(honest, { isToken }));
    return issued;
  }
}

function setAttr(invoice, name, value) {
  const attrs = invoice.data.attrs.filter((attribute) => !(name in attribute));
  return { ...invoice, data: { ...invoice.data, attrs: [...attrs, { [name]: value }] } };
}

function dropAttr(invoice, name) {
  return { ...invoice, data: { ...invoice.data, attrs: invoice.data.attrs.filter((attribute) => !(name in attribute)) } };
}

function hex(bytes) {
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

async function withResolver(callback, options = {}) {
  const ledger = new Map();
  const server = createServer({
    store: new InMemoryOfferStore(),
    invoiceAdapter: options.invoiceAdapter ?? new LedgerInvoiceAdapter(ledger, options.tamper),
    topologyClient: false,
    workers: false,
    logger: { error() {}, info() {} }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { address, port } = server.address();
  const baseUrl = `http://${address}:${port}`;
  try {
    await callback({ baseUrl, server, ledger, client: new FiberOffersClient({ resolverUrl: baseUrl }) });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
