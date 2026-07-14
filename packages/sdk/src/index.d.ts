export {
  createSignedOffer,
  createOfferRevocation,
  decodeOffer,
  encodeOffer,
  generateOfferKeyPair,
  offerToPaymentLink,
  verifyOffer,
  verifyOfferRevocation
} from "@fiber-offers/protocol";

export type {
  FiberAsset,
  FiberAssetType,
  FiberOfferInput,
  FiberOfferNetwork,
  FiberOfferRecurrence,
  IntegerLike,
  OfferKeyPair,
  OfferRevocation,
  OfferVerificationResult,
  SignedFiberOffer,
  UnsignedFiberOffer
} from "@fiber-offers/protocol";

import type { FiberAsset, FiberOfferInput, IntegerLike, OfferKeyPair, SignedFiberOffer } from "@fiber-offers/protocol";

export type JsonObject = Record<string, unknown>;
export type OfferId = string;
export type OfferOrId = OfferId | { offer_id?: string };
export type FetchLike = (url: any, init?: any) => Promise<FetchLikeResponse>;
export type CheckStatus = "pass" | "warn" | "fail";
export type ReadinessConfidence = "low" | "medium" | "high";

export interface FetchLikeResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export interface FiberOffersClientOptions {
  resolverUrl?: string;
  fetchImpl?: FetchLike;
  apiKey?: string;
}

export interface CreateOfferOptions extends Partial<FiberRpcClientOptions> {
  rpcClient?: Pick<FiberRpcClient, "call">;
  fiberRpcUrl?: string;
  nodeInfoMethod?: string;
  keyPair?: OfferKeyPair;
  username?: string;
}

export interface CreatedOffer {
  offer: SignedFiberOffer;
  encoded_offer: string;
  offer_private_key_pem: string;
  node_identity: { node_id: string; source: string };
}

export interface RegisterOfferOptions {
  username?: string;
}

export interface RegisteredOfferResponse {
  offer_id: string;
  offer?: SignedFiberOffer;
  encoded_offer?: string;
  fiber_address?: string;
  payment_link?: string;
  [key: string]: unknown;
}

export interface OfferListItem {
  offer_id: string;
  description?: string;
  network?: string;
  assets?: FiberAsset[];
  amount_min?: string;
  amount_max?: string;
  single_use?: boolean;
  disabled?: boolean;
  fiber_address?: string;
  payment_link?: string;
  created_at?: string;
  updated_at?: string;
}

export interface OfferListResponse {
  offers: OfferListItem[];
}

export interface PaymentRequest {
  amount: IntegerLike;
  asset?: FiberAsset;
  invoice?: string;
  payment_request?: string;
  metadata?: JsonObject;
  [key: string]: unknown;
}

export interface WebhookRegistrationInput {
  url: string;
  events?: WebhookEventType[];
  secret?: string;
  [key: string]: unknown;
}

export type WebhookEventType =
  | "invoice.created"
  | "invoice.received"
  | "invoice.paid"
  | "invoice.expired"
  | "invoice.failed"
  | "invoice.cancelled";

export interface WebhookSubscription {
  id: string;
  offer_id: string;
  url: string;
  events: WebhookEventType[];
  secret_hint?: string;
  disabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface WebhookCreateResponse extends WebhookSubscription {
  signing_secret: string;
}

export interface WebhookListResponse {
  offer_id: string;
  webhooks: WebhookSubscription[];
}

export interface WebhookUpdateInput {
  url?: string;
  events?: WebhookEventType[];
  disabled?: boolean;
}

export interface WebhookDeliveryOptions {
  retryFailed?: boolean;
}

export interface SyncResolutionsOptions {
  includeTerminal?: boolean;
}

export interface InvoiceRequestOptions {
  idempotencyKey?: string;
}

export interface ResolutionStatusUpdate {
  status: string;
  source?: string;
  settlement?: JsonObject;
  metadata?: JsonObject;
  [key: string]: unknown;
}

export interface FiberAddressParts {
  username: string;
  domain: string;
}

export class FiberOffersClient {
  resolverUrl: string;
  fetchImpl: FetchLike;
  apiKey?: string;
  constructor(options?: FiberOffersClientOptions);
  registerOffer(offerOrEncoded: SignedFiberOffer | string, options?: RegisterOfferOptions): Promise<RegisteredOfferResponse>;
  createAndRegisterOffer(
    input: FiberOfferInput,
    privateKeyPem: string,
    options?: RegisterOfferOptions
  ): Promise<RegisteredOfferResponse>;
  createOffer(input: Omit<FiberOfferInput, "node_id" | "public_key">, options: CreateOfferOptions): Promise<CreatedOffer>;
  createAndRegisterOfferFromNode(
    input: Omit<FiberOfferInput, "node_id" | "public_key">,
    options: CreateOfferOptions
  ): Promise<CreatedOffer & { registered: RegisteredOfferResponse }>;
  resolveOffer(offerOrEncoded: SignedFiberOffer | OfferId | string): Promise<RegisteredOfferResponse>;
  resolveAndRequestInvoice(
    offerOrEncoded: SignedFiberOffer | OfferId | string,
    request: PaymentRequest,
    options?: InvoiceRequestOptions
  ): Promise<{ offer: RegisteredOfferResponse; invoice: InvoiceResolutionResponse }>;
  getOffer(offerId: OfferId): Promise<RegisteredOfferResponse>;
  listOffers(): Promise<OfferListResponse>;
  diagnostics(): Promise<ResolverDiagnostics>;
  offerQrUrl(offerId: OfferId, payload?: "link" | "offer"): string;
  checkPayment(offerOrId: OfferOrId, request: PaymentRequest): Promise<PaymentReadiness>;
  getResolutions(offerOrId: OfferOrId): Promise<ResolutionRecord[]>;
  getRecurrenceStatus(offerOrId: OfferOrId): Promise<RecurrenceStatus>;
  revokeOffer(offerOrId: OfferOrId, revocation: JsonObject): Promise<JsonObject>;
  getResolution(offerOrId: OfferOrId, resolutionId: string): Promise<ResolutionRecord>;
  getReceipt(offerOrId: OfferOrId, resolutionId: string): Promise<JsonObject>;
  getReconciliation(offerOrId: OfferOrId): Promise<JsonObject>;
  getReconciliationCsv(offerOrId: OfferOrId): Promise<string>;
  createWebhook(offerOrId: OfferOrId, webhook: WebhookRegistrationInput): Promise<WebhookCreateResponse>;
  getWebhooks(offerOrId: OfferOrId): Promise<WebhookListResponse>;
  updateWebhook(offerOrId: OfferOrId, webhookId: string, update: WebhookUpdateInput): Promise<WebhookSubscription>;
  deleteWebhook(offerOrId: OfferOrId, webhookId: string): Promise<JsonObject>;
  rotateWebhookSecret(offerOrId: OfferOrId, webhookId: string): Promise<WebhookCreateResponse>;
  testWebhook(offerOrId: OfferOrId, webhookId: string): Promise<WebhookDeliveryResult>;
  getWebhookEvents(offerOrId: OfferOrId): Promise<WebhookEventListResponse>;
  deliverWebhookEvents(offerOrId: OfferOrId, options?: WebhookDeliveryOptions): Promise<WebhookDeliveryResult>;
  deliverWebhookEvent(offerOrId: OfferOrId, eventId: string, options?: WebhookDeliveryOptions): Promise<WebhookDeliveryResult>;
  reconciliationCsvUrl(offerOrId: OfferOrId): string;
  updateResolutionStatus(
    offerOrId: OfferOrId,
    resolutionId: string,
    update: ResolutionStatusUpdate
  ): Promise<ResolutionRecord>;
  syncResolution(offerOrId: OfferOrId, resolutionId: string): Promise<ResolutionSyncResult>;
  syncResolutions(offerOrId: OfferOrId, options?: SyncResolutionsOptions): Promise<BatchResolutionSyncResult>;
  requestInvoice(
    offerOrId: OfferOrId,
    request: PaymentRequest,
    options?: InvoiceRequestOptions
  ): Promise<InvoiceResolutionResponse>;
  bindFiberAddress(username: string, offerId: string): Promise<JsonObject>;
  resolveFiberAddress(address: string): Promise<RegisteredOfferResponse>;
  demoCreateOffer(input: JsonObject): Promise<RegisteredOfferResponse>;
}

export function parseFiberAddress(address: string): FiberAddressParts;
export function offerQrUrl(offerId: OfferId, resolverUrl: string, payload?: "link" | "offer"): string;

export interface FiberRpcClientOptions {
  url: string;
  username?: string;
  password?: string;
  fetchImpl?: FetchLike;
}

export class FiberRpcClient {
  url: string;
  username?: string;
  password?: string;
  fetchImpl: FetchLike;
  constructor(options: FiberRpcClientOptions);
  call<T = unknown>(method: string, params?: unknown[]): Promise<T>;
}

export function createOffer(
  input: Omit<FiberOfferInput, "node_id" | "public_key">,
  options: CreateOfferOptions
): Promise<CreatedOffer>;

export interface FiberPaymentClientOptions extends Partial<FiberRpcClientOptions> {
  rpc?: Pick<FiberRpcClient, "call">;
}

export interface FiberSendPaymentOptions {
  timeout?: IntegerLike;
  timeoutSeconds?: IntegerLike;
  max_fee_amount?: IntegerLike;
  maxFeeAmount?: IntegerLike;
  max_fee_rate?: IntegerLike;
  maxFeeRate?: IntegerLike;
  max_parts?: IntegerLike;
  maxParts?: IntegerLike;
  trampoline_hops?: string[] | string;
  trampolineHops?: string[] | string;
  hop_hints?: unknown;
  hopHints?: unknown;
  keysend?: boolean;
  udt_type_script?: unknown;
  udtTypeScript?: unknown;
  allow_self_payment?: boolean;
  allowSelfPayment?: boolean;
  custom_records?: JsonObject;
  customRecords?: JsonObject;
  dry_run?: boolean;
  dryRun?: boolean;
  diagnostics?: FiberTopologyDiagnostics;
  stage?: string;
  [key: string]: unknown;
}

export interface FiberSendPaymentParams {
  invoice: string;
  timeout?: string;
  max_fee_amount?: string;
  max_fee_rate?: string;
  max_parts?: string;
  trampoline_hops?: string[];
  hop_hints?: unknown;
  keysend?: boolean;
  udt_type_script?: unknown;
  allow_self_payment?: boolean;
  custom_records?: JsonObject;
  dry_run?: boolean;
}

export interface FiberPaymentResult {
  payment_hash?: string;
  fee?: string;
  routers?: unknown[];
  [key: string]: unknown;
}

export interface FiberRouteCheckOk {
  ok: true;
  payable: true;
  stage?: string;
  params?: FiberSendPaymentParams;
  dry_run?: FiberPaymentResult;
  payment_hash?: string;
  fee?: string;
  routers?: unknown[];
}

export interface FiberRouteCheckFailure {
  ok: false;
  payable: false;
  stage?: string;
  params?: FiberSendPaymentParams;
  failure: FiberPaymentFailure;
}

export type FiberRouteCheckResult = FiberRouteCheckOk | FiberRouteCheckFailure;

export class FiberPaymentClient {
  rpc: Pick<FiberRpcClient, "call">;
  constructor(options?: FiberPaymentClientOptions);
  sendPayment<T = FiberPaymentResult>(invoice: string, options?: FiberSendPaymentOptions): Promise<T>;
  dryRunPayment<T = FiberPaymentResult>(invoice: string, options?: FiberSendPaymentOptions): Promise<T>;
  checkPaymentRoute(invoice: string, options?: FiberSendPaymentOptions): Promise<FiberRouteCheckResult>;
  getPayment<T = FiberPaymentResult>(paymentHash: string): Promise<T>;
}

export function fiberSendPaymentParams(invoice: string, options?: FiberSendPaymentOptions): FiberSendPaymentParams;
export function toFiberHexQuantity(value: IntegerLike): string;
export function toFiberDecimalQuantity(value: IntegerLike): string;

export interface FiberNodeDiagnosticsClientOptions extends Partial<FiberRpcClientOptions> {
  rpc?: Pick<FiberRpcClient, "call">;
}

export class FiberNodeDiagnosticsClient {
  rpc: Pick<FiberRpcClient, "call">;
  constructor(options?: FiberNodeDiagnosticsClientOptions);
  inspectNode(): Promise<FiberNodeInspection>;
  payerDiagnostics(): Promise<{ payer: FiberTopologyRoleSnapshot }>;
}

export interface FiberNodeInspection {
  node: FiberNodeSummary;
  peers: FiberPeersSummary;
  channels: FiberChannelsSummary;
  pending_channels: FiberPendingChannelsSummary;
}

export interface FiberNodeSummary {
  node_id?: string;
  pubkey?: string;
  version?: string;
  network?: string;
  chain?: string;
  peers_count?: string;
  channel_count?: string;
  open_channel_auto_accept_min_ckb_funding_amount?: string;
  auto_accept_channel_ckb_funding_amount?: string;
  addresses?: unknown;
}

export interface FiberPeersSummary {
  count: number;
  pubkeys: string[];
  peers: FiberPeer[];
}

export interface FiberPeer {
  pubkey?: string;
  address?: string;
}

export interface FiberChannelsSummary {
  total: number;
  ready: number;
  enabled: number;
  disabled: number;
  public: number;
  private: number;
  ckb: number;
  udt: number;
  usable_outbound: number;
  usable_inbound: number;
  local_balance_total: string;
  local_balance_total_hex: string;
  remote_balance_total: string;
  remote_balance_total_hex: string;
  pending_tlc_count: number;
  counterparties: FiberChannelCounterparty[];
  offline_counterparties: string[];
}

export interface FiberPendingChannelsSummary {
  total: number;
  opening: number;
  failed: number;
  counterparties: FiberPendingChannelCounterparty[];
}

export interface FiberChannelCounterparty {
  pubkey: string;
  connected: boolean;
  channels: number;
  public: number;
  private: number;
  local_balance_total: string;
  local_balance_total_hex: string;
  remote_balance_total: string;
  remote_balance_total_hex: string;
  pending_tlc_count: number;
}

export interface FiberPendingChannelCounterparty {
  pubkey: string;
  connected: boolean;
  channels: number;
  opening: number;
  failed: number;
  local_balance_total: string;
  local_balance_total_hex: string;
  remote_balance_total: string;
  remote_balance_total_hex: string;
  opening_local_balance_total: string;
  opening_local_balance_total_hex: string;
  opening_remote_balance_total: string;
  opening_remote_balance_total_hex: string;
  states: string[];
  opening_states: string[];
  channel_ids: string[];
  opening_channel_ids: string[];
  failure_details: unknown[];
}

export function summarizeFiberChannels(channelsResult: unknown, peerPubkeys?: string[]): FiberChannelsSummary;

export interface FiberTopologyClientOptions {
  merchant?: string | FiberNodeDiagnosticsClientOptions;
  payer?: string | FiberNodeDiagnosticsClientOptions;
  merchantRpcUrl?: string;
  payerRpcUrl?: string;
  merchantClient?: FiberNodeDiagnosticsClient;
  payerClient?: FiberNodeDiagnosticsClient;
  paymentClient?: FiberPaymentClient;
  fetchImpl?: FetchLike;
}

export class FiberTopologyClient {
  merchantRpcUrl?: string;
  payerRpcUrl?: string;
  merchant: FiberNodeDiagnosticsClient;
  payer: FiberNodeDiagnosticsClient;
  paymentClient?: FiberPaymentClient;
  constructor(options?: FiberTopologyClientOptions);
  inspectPair(): Promise<FiberTopologyReport>;
  checkInvoiceRoute(invoice: string, options?: FiberSendPaymentOptions & { paymentClient?: FiberPaymentClient }): Promise<FiberTopologyReport>;
}

export interface AnalyzeFiberTopologyInput {
  merchant?: FiberNodeInspection | { [key: string]: unknown };
  payer?: FiberNodeInspection | { [key: string]: unknown };
  merchantRpcUrl?: string;
  payerRpcUrl?: string;
}

export function analyzeFiberTopology(input?: AnalyzeFiberTopologyInput): FiberTopologyReport;

export interface FiberTopologyReport {
  ok: boolean;
  status: "ready" | "degraded" | "blocked" | "opening";
  summary: string;
  readiness: {
    deterministic_local_payment: boolean;
    direct_channel_ready: boolean;
    direct_channel_opening: boolean;
    shared_online_counterparty_count: number;
    dry_run_required: boolean;
  };
  merchant: FiberTopologyRoleSnapshot;
  payer: FiberTopologyRoleSnapshot;
  direct_channel: FiberDirectChannelReport;
  common_channel_counterparties: string[];
  online_common_channel_counterparties: string[];
  route_candidates: FiberRouteCandidates;
  blockers: ReadinessIssue[];
  warnings: ReadinessIssue[];
  next_actions: string[];
  fixture_recommendation: JsonObject;
  diagnostics: FiberTopologyDiagnostics;
  route_check?: FiberRouteCheckResult;
}

export interface FiberTopologyRoleSnapshot {
  rpc_url?: string;
  pubkey?: string;
  node_id?: string;
  version?: string;
  network?: string;
  chain?: string;
  peers_count?: string;
  channel_count?: string;
  open_channel_auto_accept_min_ckb_funding_amount?: string;
  auto_accept_channel_ckb_funding_amount?: string;
  addresses?: unknown;
  peers: string[];
  peer_details: FiberPeer[];
  channels: FiberChannelsSummary;
  pending_channels: FiberPendingChannelsSummary;
}

export interface FiberDirectChannelReport {
  payer_to_merchant: boolean;
  merchant_to_payer: boolean;
  pending_payer_to_merchant: boolean;
  pending_merchant_to_payer: boolean;
  opening: boolean;
  partial_opening: boolean;
  ready: boolean;
  payer_connected_to_merchant: boolean;
  merchant_connected_to_payer: boolean;
  usable_for_payer_to_merchant: boolean;
  payer_local_balance_total: string;
  payer_local_balance_total_hex: string;
  merchant_remote_balance_total: string;
  merchant_remote_balance_total_hex: string;
  payer_view?: FiberChannelCounterparty;
  merchant_view?: FiberChannelCounterparty;
  pending_payer_view?: FiberPendingChannelCounterparty;
  pending_merchant_view?: FiberPendingChannelCounterparty;
}

export interface FiberRouteCandidates {
  direct?: {
    payer_pubkey?: string;
    merchant_pubkey?: string;
    payer_local_balance_total: string;
    payer_local_balance_total_hex: string;
  };
  shared_counterparties: Array<{
    pubkey: string;
    online_from_payer: boolean;
    online_from_merchant: boolean;
    online_from_both: boolean;
  }>;
}

export interface FiberTopologyDiagnostics {
  merchant?: FiberTopologyRoleSnapshot;
  payer?: FiberTopologyRoleSnapshot;
  direct_channel?: {
    merchant_to_payer: boolean;
    payer_to_merchant: boolean;
  };
  common_channel_counterparties?: string[];
}

export interface DirectChannelFixtureOptions {
  fundingAmount?: IntegerLike;
  funding_amount?: IntegerLike;
  channelFundingAmount?: IntegerLike;
  channel_funding_amount?: IntegerLike;
  acceptFundingAmount?: IntegerLike;
  accept_funding_amount?: IntegerLike;
  merchantAcceptFundingAmount?: IntegerLike;
  merchant_accept_funding_amount?: IntegerLike;
  publicChannel?: boolean;
  public_channel?: boolean;
  oneWay?: boolean;
  one_way?: boolean;
  merchantPeerAddress?: string;
  merchant_peer_address?: string;
  payerRpcUrl?: string;
  payer_rpc_url?: string;
  merchantRpcUrl?: string;
  merchant_rpc_url?: string;
  merchantPubkey?: string;
  merchant_pubkey?: string;
}

export interface DirectChannelFixtureStep {
  id: "connect_peer" | "open_channel" | "accept_channel" | string;
  rpc_url?: string;
  rpc_method?: string;
  rpc_params?: JsonObject;
  command?: string;
}

export interface DirectChannelFixturePlan {
  ok: boolean;
  status:
    | "already_ready"
    | "missing_input"
    | "ready_to_accept"
    | "already_opening"
    | "stalled_opening"
    | "ready_to_execute";
  execute_guard: "FIBER_FIXTURE_OPEN_DIRECT_CHANNEL=true";
  summary: string;
  already_ready: boolean;
  already_opening: boolean;
  stalled_opening: boolean;
  accept_needed: boolean;
  connect_needed: boolean;
  open_needed: boolean;
  missing: string[];
  payer_rpc_url?: string;
  merchant_rpc_url?: string;
  merchant_pubkey?: string;
  merchant_peer_address?: string;
  funding_amount?: string;
  funding_amount_hex?: string;
  accept_temporary_channel_id?: string;
  accept_funding_amount?: string;
  accept_funding_amount_hex?: string;
  public_channel: boolean;
  one_way: boolean;
  steps: DirectChannelFixtureStep[];
  post_checks: string[];
  warning: string;
}

export function planDirectChannelFixture(
  topology: FiberTopologyReport,
  options?: DirectChannelFixtureOptions
): DirectChannelFixturePlan;

export interface PaymentReadinessInput {
  offer_id?: string;
  amount?: IntegerLike;
  asset?: FiberAsset;
  request?: PaymentRequest;
  topology?: Partial<FiberTopologyReport> & JsonObject;
  routeCheck?: FiberRouteCheckResult;
  route_check?: FiberRouteCheckResult;
  invoice?: string;
  payment_request?: string;
  paymentRequest?: string;
  invoice_mode?: string;
  payment_link?: string;
  checks?: ReadinessCheck[];
}

export interface ReadinessCheck {
  id: string;
  status: CheckStatus;
  message: string;
  code?: string;
  details?: JsonObject;
  likely_causes?: string[];
  next_actions?: string[];
}

export interface ReadinessIssue {
  code?: string;
  summary: string;
  details?: JsonObject;
  likely_causes?: string[];
  next_actions?: string[];
}

export interface FiberTopologySnapshot {
  ok?: boolean;
  configured?: boolean;
  status?: string;
  summary?: string;
  readiness?: JsonObject;
  direct_channel?: FiberDirectChannelReport;
  route_candidates?: FiberRouteCandidates;
  common_channel_counterparties?: string[];
  online_common_channel_counterparties?: string[];
  blockers?: ReadinessIssue[];
  warnings?: ReadinessIssue[];
  next_actions?: string[];
  error?: JsonObject;
}

export interface PaymentReadiness {
  offer_id?: string;
  ok: boolean;
  ready: boolean;
  payable?: boolean;
  confidence: ReadinessConfidence;
  code?: string;
  summary: string;
  amount?: IntegerLike;
  asset?: FiberAsset;
  invoice_mode?: string;
  payment_link?: string;
  checks: ReadinessCheck[];
  blockers: ReadinessIssue[];
  warnings: ReadinessIssue[];
  next_actions: string[];
  next_action: "fix_request" | "send_payment" | "run_route_dry_run" | "request_invoice" | string;
  topology?: FiberTopologySnapshot;
  route_check?: FiberRouteCheckResult;
  failure?: FiberPaymentFailure;
}

export function analyzePaymentReadiness(input?: PaymentReadinessInput): PaymentReadiness;

export interface FiberPaymentFailure {
  code: string;
  summary: string;
  fiber_error?: FiberNodeError;
  likely_causes: string[];
  next_actions: string[];
  route_context?: JsonObject;
}

export interface FiberNodeError {
  method?: string;
  url?: string;
  code?: string | number;
  message?: string;
  data?: unknown;
  details?: unknown;
}

export function normalizeFiberPaymentFailure(
  error: unknown,
  options?: { stage?: string; diagnostics?: FiberTopologyDiagnostics }
): FiberPaymentFailure | undefined;
export function fiberNodeError(error: unknown): FiberNodeError;

export interface FiberPaymentFlowClientOptions {
  resolverClient?: Pick<FiberOffersClient, "checkPayment" | "requestInvoice">;
  resolver?: Pick<FiberOffersClient, "checkPayment" | "requestInvoice">;
  paymentClient?: Pick<FiberPaymentClient, "checkPaymentRoute" | "sendPayment">;
  payerPaymentClient?: Pick<FiberPaymentClient, "checkPaymentRoute" | "sendPayment">;
}

export interface FiberPaymentFlowOptions extends FiberSendPaymentOptions {
  idempotencyKey?: string;
  execute?: boolean;
  skipInitialReadiness?: boolean;
  requireInitialReadiness?: boolean;
  forceLocalDryRun?: boolean;
}

export interface PaymentFlowResult {
  ok: boolean;
  status:
    | "blocked_before_invoice"
    | "invoice_unavailable"
    | "ready_to_send"
    | "blocked_after_invoice"
    | "payment_client_required"
    | "payment_sent"
    | "payment_failed"
    | string;
  request?: PaymentRequest;
  invoice?: InvoiceResolutionResponse;
  readiness?: PaymentReadiness;
  route_check?: FiberRouteCheckResult;
  payment?: FiberPaymentResult;
  payment_hash?: string;
  fee?: string;
  execute_required?: boolean;
  next_action?: string;
  failure?: FiberPaymentFailure | ReadinessIssue;
}

export class FiberPaymentFlowClient {
  resolver: Pick<FiberOffersClient, "checkPayment" | "requestInvoice">;
  paymentClient?: Pick<FiberPaymentClient, "checkPaymentRoute" | "sendPayment">;
  constructor(options: FiberPaymentFlowClientOptions);
  preparePayment(offerOrId: OfferOrId, request: PaymentRequest, options?: FiberPaymentFlowOptions): Promise<PaymentFlowResult>;
  payOffer(offerOrId: OfferOrId, request: PaymentRequest, options?: FiberPaymentFlowOptions): Promise<PaymentFlowResult>;
}

export interface RecurrenceStatus {
  offer_id: string;
  enabled: boolean;
  revoked: boolean;
  terms?: import("@fiber-offers/protocol").FiberOfferRecurrence;
  cycles_created?: number;
  cycles_paid?: number;
  next_cycle?: number;
  reserved_total?: string;
  paid_total?: string;
  spending_cap_remaining?: string;
  cycle_cap_remaining?: number;
}

export interface RecurringApproval {
  id: string;
  offer_id: string;
  offer: SignedFiberOffer;
  asset: FiberAsset;
  status: "active" | "revoked" | "cap_reached" | "failed";
  approved_at: string;
  revoked_at?: string;
  next_due_at: string;
  cycles_paid: number;
  spending_total: string;
  attempts: JsonObject[];
  last_error?: JsonObject;
  consecutive_failures?: number;
  next_retry_at?: string;
}

export interface RecurringApprovalStore {
  list(): Promise<RecurringApproval[]>;
  get(id: string): Promise<RecurringApproval | undefined>;
  put(approval: RecurringApproval): Promise<RecurringApproval>;
}

export class InMemoryRecurringApprovalStore implements RecurringApprovalStore {
  constructor(initial?: RecurringApproval[]);
  list(): Promise<RecurringApproval[]>;
  get(id: string): Promise<RecurringApproval | undefined>;
  put(approval: RecurringApproval): Promise<RecurringApproval>;
}

export class WebStorageRecurringApprovalStore implements RecurringApprovalStore {
  constructor(options?: { storage?: Storage; key?: string });
  list(): Promise<RecurringApproval[]>;
  get(id: string): Promise<RecurringApproval | undefined>;
  put(approval: RecurringApproval): Promise<RecurringApproval>;
}

export interface RecurringSchedulerStatus {
  running: boolean;
  interval_ms: number;
  retry_delay_ms: number;
  last_run_at?: string;
  last_error?: JsonObject;
}

export class FiberRecurringPaymentScheduler {
  constructor(options: {
    paymentFlow: FiberPaymentFlowClient;
    resolverClient?: Pick<FiberOffersClient, "getOffer">;
    resolver?: Pick<FiberOffersClient, "getOffer">;
    store?: RecurringApprovalStore;
    storage?: Storage;
    storageKey?: string;
    now?: () => Date;
    intervalMs?: number;
    retryDelayMs?: number;
    maxConsecutiveFailures?: number;
    autoStart?: boolean;
    runOnStart?: boolean;
    onEvent?: (event: JsonObject) => void;
    setInterval?: typeof globalThis.setInterval;
    clearInterval?: typeof globalThis.clearInterval;
  });
  approve(
    offerOrEncoded: SignedFiberOffer | RegisteredOfferResponse | OfferId | string,
    options?: { id?: string; asset?: FiberAsset; startAt?: string | Date }
  ): Promise<RecurringApproval>;
  revoke(approvalId: string): Promise<RecurringApproval>;
  runDue(now?: string | Date): Promise<JsonObject[]>;
  start(options?: { runOnStart?: boolean }): RecurringSchedulerStatus;
  stop(): RecurringSchedulerStatus;
  status(): RecurringSchedulerStatus;
}

export interface InvoiceResolutionResponse {
  resolution_id?: string;
  invoice?: string | { invoice?: string; [key: string]: unknown };
  payment_hash?: string;
  amount?: string;
  asset?: FiberAsset;
  status?: string;
  idempotency_key?: string;
  idempotent_replay?: boolean;
  [key: string]: unknown;
}

export interface ResolutionRecord {
  resolution_id?: string;
  offer_id?: string;
  invoice?: string;
  payment_hash?: string;
  amount?: string;
  asset?: FiberAsset;
  status?: string;
  status_history?: unknown[];
  settlement?: JsonObject;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export interface ResolutionSyncResult {
  changed?: boolean;
  previous_status?: string;
  next_status?: string;
  resolution?: ResolutionRecord;
  [key: string]: unknown;
}

export interface BatchResolutionSyncResult {
  checked?: number;
  changed?: number;
  skipped?: number;
  results?: ResolutionSyncResult[];
  [key: string]: unknown;
}

export interface WebhookEventRecord {
  id?: string;
  event?: string;
  status?: string;
  attempts?: number;
  last_error?: string;
  payload?: JsonObject;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export interface WebhookEventListResponse {
  offer_id: string;
  events: WebhookEventRecord[];
}

export interface WebhookDeliveryResult {
  attempted?: number;
  delivered?: number;
  failed?: number;
  skipped?: number;
  events?: WebhookEventRecord[];
  [key: string]: unknown;
}

export interface ResolverDiagnostics {
  invoice_mode?: string;
  store?: JsonObject;
  fiber?: JsonObject;
  topology?: FiberTopologySnapshot;
  workers?: JsonObject;
  [key: string]: unknown;
}
