// How an application uses the packages, checked by the TypeScript compiler
// under `strict` (see ../types.test.js). Nothing here runs.
//
// A line marked @ts-expect-error is a mistake the declarations must catch: the
// check fails if the compiler accepts it.

import {
  FiberOfferError,
  OFFER_LIMITS,
  canonicalStringify,
  createOfferRevocation,
  createSignedOffer,
  decodeOffer,
  encodeOffer,
  generateOfferKeyPair,
  isEncodedOffer,
  signRecurrenceRequest,
  subscriptionId,
  validateResolutionRequest,
  verifyOffer,
  verifyOfferRevocation,
  verifyRecurrenceRequest,
  type FiberAsset,
  type FiberOfferInput,
  type OfferRevocation,
  type SignedFiberOffer
} from "@fiber-offers/protocol";
import {
  FiberOffersClient,
  FiberPaymentClient,
  FiberPaymentFlowClient,
  FiberRecurringPaymentScheduler,
  FiberRpcClient,
  InMemoryRecurringApprovalStore,
  WebStorageRecurringApprovalStore,
  createOffer,
  parseFiberAddress,
  verifyInvoiceForOffer,
  type InvoiceResolutionResponse,
  type PaymentFlowResult,
  type RecurrenceStatus,
  type ResolutionRecord,
  type ResolutionStatus,
  type WebStorageLike
} from "@fiber-offers/sdk";
import { FiberOffersClient as BrowserClient, type ResolutionStatus as BrowserResolutionStatus } from "@fiber-offers/sdk/browser";
import { JsonFileRecurringApprovalStore } from "@fiber-offers/sdk/node";
import { OfferQR, type OfferQRProps } from "@fiber-offers/sdk/react";
import { OfferQR as NativeOfferQR } from "@fiber-offers/sdk/react-native";

const ckb: FiberAsset = { asset_type: "ckb", symbol: "CKB" };

// ---- The protocol package ---------------------------------------------------

export function merchantSide(): { offer: SignedFiberOffer; revocation: OfferRevocation } {
  const keys = generateOfferKeyPair();
  const terms: FiberOfferInput = {
    network: "testnet",
    node_id: `02${"ab".repeat(32)}`,
    public_key: keys.publicKeyPem,
    resolver_url: "https://offers.merchant.example",
    description: "Monthly plan",
    assets: [ckb, { asset_type: "udt", symbol: "RUSD", type_script_hash: `0x${"11".repeat(32)}` }],
    amount_min: "2000",
    amount_max: 2000n,
    recurrence: { interval: "monthly", amount: 2000, cap_cycles: 12 },
    expiry: 1_900_000_000,
    metadata: { plan: "basic" },
    x_note: "an extension field"
  };
  const offer = createSignedOffer(terms, keys.privateKeyPem, { now: 1_800_000_000 });

  // What a signed offer holds is in canonical form: strings, not loose input.
  const minimum: string | undefined = offer.amount_min;
  const version: 1 = offer.version;
  const scheme: "fiberoffer-v1" = offer.scheme;
  const cycles: number | undefined = offer.recurrence?.cap_cycles;
  const bytes: number = OFFER_LIMITS.offer_bytes;
  void [minimum, version, scheme, cycles, bytes];

  const encoded: string = encodeOffer(offer);
  const decoded: SignedFiberOffer = decodeOffer(encoded);
  const text: string = canonicalStringify(decoded);
  void text;

  const verification = verifyOffer(decoded);
  if (!verification.ok) {
    // The failure branch carries the reason; the success branch does not.
    const reason: string = `${verification.code}: ${verification.message}`;
    void reason;
  } else {
    // @ts-expect-error a successful verification has no error code
    void verification.code;
  }

  const revocation = createOfferRevocation(offer, keys.privateKeyPem, { reason: "key rotated" });
  const revoked = verifyOfferRevocation(offer, revocation, { now: revocation.revoked_at });
  void revoked.ok;

  // @ts-expect-error an asset type the format does not have
  const unknownAsset: FiberAsset = { asset_type: "btc", symbol: "BTC" };
  // @ts-expect-error a network the format does not have
  const unknownNetwork: FiberOfferInput = { ...terms, network: "regtest" };
  // @ts-expect-error an offer cannot be signed without a key
  createSignedOffer(terms);
  // @ts-expect-error the offer's own limits are read-only
  OFFER_LIMITS.offer_bytes = 1;
  // @ts-expect-error a field the offer does not have
  void offer.price;
  void [unknownAsset, unknownNetwork];

  return { offer, revocation };
}

export function payerSideOffline(offer: SignedFiberOffer, input: unknown): void {
  if (isEncodedOffer(input)) {
    // Narrowed to a string by the check above.
    void decodeOffer(input).offer_id;
  }

  const request = validateResolutionRequest(offer, { amount: 2000 }, { now: 1_800_000_000 });
  const amount: string = request.amount;
  const asset: FiberAsset = request.asset;
  void [amount, asset];

  const subscriber = generateOfferKeyPair();
  const cycle = signRecurrenceRequest(offer, { amount: "2000", asset: ckb, recurrence_cycle: 1 }, subscriber.privateKeyPem);
  const id: string = subscriptionId(cycle.subscriber_public_key);
  void [id === cycle.approval_id, verifyRecurrenceRequest(offer, cycle).ok];

  // @ts-expect-error a cycle request needs its cycle number
  signRecurrenceRequest(offer, { amount: "2000" }, subscriber.privateKeyPem);

  try {
    decodeOffer("not an offer");
  } catch (error) {
    if (error instanceof FiberOfferError) {
      const code: string = error.code;
      const reason: unknown = error.details?.reason;
      void [code, reason];
    }
  }
}

// ---- The SDK ----------------------------------------------------------------

export async function payAnOffer(offer: SignedFiberOffer): Promise<string | undefined> {
  const resolver = new FiberOffersClient({ resolverUrl: offer.resolver_url, timeoutMs: 10_000 });
  const node = new FiberPaymentClient({ url: "http://127.0.0.1:8229", token: "a biscuit token" });
  const flow = new FiberPaymentFlowClient({ resolver, paymentClient: node });

  const fetched = await resolver.getOffer(offer.offer_id);
  const signed: SignedFiberOffer = fetched.offer;
  const encoded: string = fetched.encoded_offer;
  void [signed, encoded, fetched.valid === false ? fetched.invalid_code : undefined];

  const readiness = await resolver.checkPayment(offer, { amount: "2000", asset: ckb });
  if (!readiness.ready) return readiness.code;

  const invoice: InvoiceResolutionResponse = await resolver.requestInvoice(
    offer,
    { amount: "2000", asset: ckb },
    { idempotencyKey: "order-1042" }
  );
  // The invoice is a string, and the response names the resolution it belongs to.
  const invoiceString: string = invoice.invoice;
  const status: ResolutionStatus = invoice.status;
  const replay: boolean | undefined = invoice.idempotent_replay;
  void [status, replay];

  const parsed = await node.parseInvoice(invoiceString);
  const verified = verifyInvoiceForOffer({
    offer,
    request: { amount: "2000", asset: ckb },
    parsed,
    expectedPaymentHash: invoice.payment_hash,
    expectedResolutionId: invoice.resolution_id
  });
  if (!verified.ok) return verified.failure?.code;

  const resolution: ResolutionRecord = await resolver.getResolution(offer, invoice.resolution_id);
  // A resolution holds the invoice as an object, not as the bare string.
  const again: string = resolution.invoice.invoice;
  const lapses: string = resolution.invoice.expires_at;
  void [again, lapses, resolution.recurrence?.cycle];

  const result: PaymentFlowResult = await flow.payOffer(offer, { amount: "2000", asset: ckb }, { confirm: true });
  if (result.status === "payment_succeeded") return result.payment_hash;

  // @ts-expect-error the invoice is not an object
  void invoice.invoice.invoice;
  // @ts-expect-error a resolution's invoice is not a string
  void resolution.invoice.toUpperCase();
  // @ts-expect-error a resolution is identified by `id`, and it is a string
  const wrongId: number = resolution.id;
  // @ts-expect-error not a status a resolution can have
  const wrongStatus: ResolutionStatus = "invoice_refunded";
  // @ts-expect-error a payment request needs an amount
  await resolver.requestInvoice(offer, { asset: ckb });
  // @ts-expect-error the payment flow needs a resolver
  void new FiberPaymentFlowClient();
  void [wrongId, wrongStatus];

  return result.failure?.code;
}

export async function merchantOperations(offer: SignedFiberOffer, revocation: OfferRevocation): Promise<void> {
  const merchant = new FiberOffersClient({ resolverUrl: offer.resolver_url, apiKey: "the resolver's API key" });

  const registered = await merchant.registerOffer(offer, { username: "shop" });
  const address: string | undefined = registered.fiber_address;
  void address;

  // The history comes wrapped with the offer ID.
  const history = await merchant.getResolutions(offer);
  const paid: ResolutionRecord[] = history.resolutions.filter((resolution) => resolution.status === "invoice_paid");
  void paid;
  // @ts-expect-error the history is not a bare list
  void history.map((resolution) => resolution);

  const webhook = await merchant.createWebhook(offer, { url: "https://merchant.example/hooks", events: ["invoice.paid"] });
  const secret: string = webhook.signing_secret;
  void secret;
  // @ts-expect-error not a webhook event
  await merchant.createWebhook(offer, { url: "https://merchant.example/hooks", events: ["invoice.refunded"] });

  const events = await merchant.getWebhookEvents(offer);
  const delivered: boolean = events.events.every((event) => event.deliveries.every((delivery) => delivery.status === "delivered"));
  void delivered;

  const summary: RecurrenceStatus = await merchant.getRecurrenceStatus(offer);
  const subscribers: number | undefined = summary.subscriptions;
  void subscribers;

  const answer = await merchant.revokeOffer(offer, revocation);
  const done: true = answer.revoked;
  void done;
  // @ts-expect-error a revocation is the signed proof, not a reason
  await merchant.revokeOffer(offer, { reason: "closed" });

  const found = await merchant.resolveFiberAddress("shop@offers.merchant.example");
  const { username, domain } = parseFiberAddress(found.address);
  void [username, domain];

  const created = await createOffer(
    { network: "testnet", resolver_url: offer.resolver_url, assets: [ckb], amount_min: "1000" },
    { fiberRpcUrl: "http://127.0.0.1:8227", fiberRpcToken: "a biscuit token" }
  );
  const key: string = created.offer_private_key_pem;
  void key;
}

export async function subscriptions(offer: SignedFiberOffer, flow: FiberPaymentFlowClient): Promise<void> {
  // Any object with these two methods is a store; no browser types are needed.
  const memory = new Map<string, string>();
  const storage: WebStorageLike = {
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => void memory.set(key, value)
  };

  const scheduler = new FiberRecurringPaymentScheduler({
    paymentFlow: flow,
    store: new WebStorageRecurringApprovalStore({ storage }),
    intervalMs: 60_000,
    autoStart: false
  });
  const approval = await scheduler.approve(offer, { asset: ckb, startAt: new Date() });
  const state: "active" | "revoked" | "cap_reached" | "failed" = approval.status;
  const running: boolean = scheduler.start().running;
  void [state, running, await scheduler.runDue()];
  scheduler.stop();

  void [new InMemoryRecurringApprovalStore(), new JsonFileRecurringApprovalStore("approvals.json")];
  // @ts-expect-error the scheduler needs something that can pay
  void new FiberRecurringPaymentScheduler({ store: new InMemoryRecurringApprovalStore() });
}

export async function nodeAccess(): Promise<void> {
  const rpc = new FiberRpcClient({ url: "http://127.0.0.1:8227", timeoutMs: 5_000 });
  const info = await rpc.call<{ node_id?: string }>("node_info");
  const nodeId: string | undefined = info.node_id;
  void nodeId;
  // @ts-expect-error a node's address is required
  void new FiberRpcClient({});
}

// ---- The other entry points -------------------------------------------------

export function entryPoints(offerId: string): void {
  const browser: FiberOffersClient = new BrowserClient({ resolverUrl: "https://offers.merchant.example" });
  const status: BrowserResolutionStatus = "invoice_paid";
  const props: OfferQRProps = { offerId, resolverUrl: browser.resolverUrl, payload: "link", size: 240 };
  void [status, OfferQR(props), NativeOfferQR({ ...props, onCopy: (link: string) => void link })];
  // @ts-expect-error a QR code needs to know which offer
  OfferQR({ resolverUrl: browser.resolverUrl });
}
