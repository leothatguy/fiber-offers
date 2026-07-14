import { createServer, InMemoryOfferStore } from "../apps/resolver/src/server.js";
import { MockInvoiceAdapter } from "../apps/resolver/src/invoice-adapter.js";

const server = createServer({
  store: new InMemoryOfferStore(),
  invoiceAdapter: new MockInvoiceAdapter()
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const baseUrl = `http://${address.address}:${address.port}`;

try {
  const page = await getText(`${baseUrl}/`);
  if (
    !page.includes("data-workspace-view=\"payments\"") ||
    !page.includes("pricingTypeInput") ||
    !page.includes("offerPreviewAddress") ||
    !page.includes("paymentBriefAddress") ||
    !page.includes("webhookForm") ||
    !page.includes("webhookList") ||
    !page.includes("invoiceDetailsDialog") ||
    page.includes("requestTwiceButton") ||
    page.includes("latestInvoiceValue") ||
    !page.includes('href="/docs"')
  ) {
    throw new Error("expected demo page to include the merchant workspace, offer preview, and payment brief");
  }

  const docPages = [
    ["/docs", "Reusable payment offers for Fiber"],
    ["/docs/quickstart", "Quickstart"],
    ["/docs/concepts", "Offers, pricing, and identity"],
    ["/docs/api", "Resolver API reference"],
    ["/docs/wallets", "Wallet payment flows"],
    ["/docs/merchants", "Merchant operations"],
    ["/docs/fiber", "Fiber node integration"],
    ["/docs/sdk", "SDK integration"],
    ["/docs/production", "Production and security"]
  ];
  for (const [path, title] of docPages) {
    const docsPage = await getText(`${baseUrl}${path}`);
    if (!docsPage.includes(title)) {
      throw new Error(`expected documentation page ${path} to be served`);
    }
  }

  const favicon = await getText(`${baseUrl}/favicon.svg`);
  if (!favicon.includes("<svg")) {
    throw new Error("expected SVG favicon to be served");
  }

  const docsHighlighter = await getText(`${baseUrl}/docs-highlight.js`);
  if (!docsHighlighter.includes("highlightJson")) {
    throw new Error("expected documentation syntax highlighter to be served");
  }

  const diagnostics = await getJson(`${baseUrl}/diagnostics`);
  if (!diagnostics.workers) {
    throw new Error("expected diagnostics to expose background worker status");
  }

  const offer = await postJson(`${baseUrl}/demo/offers`, {
    username: "coffee",
    description: "Coffee checkout",
    amount_min: "1000",
    amount_max: "5000"
  });
  const inventory = await getJson(`${baseUrl}/offers`);
  if (!inventory.offers.some((item) => item.offer_id === offer.offer_id)) {
    throw new Error("expected offer inventory to include the created offer");
  }
  const invoiceA = await postJson(`${baseUrl}/offers/${offer.offer_id}/invoice`, {
    amount: "1200",
    asset: { asset_type: "ckb", symbol: "CKB" }
  });
  const invoiceB = await postJson(`${baseUrl}/offers/${offer.offer_id}/invoice`, {
    amount: "1200",
    asset: { asset_type: "ckb", symbol: "CKB" }
  });

  if (invoiceA.invoice === invoiceB.invoice) {
    throw new Error("expected two fresh invoices from the same static offer");
  }

  console.log("Fiber Offers smoke demo passed");
  console.log(`Offer: ${offer.offer_id}`);
  console.log(`Fiber Address: ${offer.fiber_address}`);
  console.log(`Invoice A: ${invoiceA.invoice}`);
  console.log(`Invoice B: ${invoiceB.invoice}`);
} finally {
  await new Promise((resolve) => server.close(resolve));
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`${response.status} ${payload.error?.code ?? "ERROR"}: ${payload.error?.message ?? "request failed"}`);
  }
  return payload;
}

async function getJson(url) {
  const response = await fetch(url);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`${response.status} ${payload.error?.code ?? "ERROR"}: ${payload.error?.message ?? "request failed"}`);
  }
  return payload;
}

async function getText(url) {
  const response = await fetch(url);
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status}: request failed`);
  }
  return body;
}
