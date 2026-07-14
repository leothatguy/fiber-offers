export const OFFER_PREFIX: "fbroffer1";
export const OFFER_SCHEME: "fiberoffer-v1";
export const OFFER_HRP: "fbroffer";
export const REVOCATION_SCHEME: "fiberoffer-revocation-v1";
export const SUPPORTED_ASSET_TYPES: Set<FiberAssetType>;
export const SUPPORTED_NETWORKS: Set<FiberOfferNetwork>;

export type FiberOfferNetwork = "mainnet" | "testnet" | "dev";
export type FiberAssetType = "ckb" | "udt" | "rgbpp";
export type IntegerLike = string | number | bigint;

export interface FiberOfferErrorDetails {
  [key: string]: unknown;
}

export class FiberOfferError extends Error {
  code: string;
  details?: FiberOfferErrorDetails;
  constructor(message: string, code?: string, details?: FiberOfferErrorDetails);
}

export interface FiberAsset {
  asset_type: FiberAssetType;
  symbol: string;
  type_script_hash?: string;
}

export interface FiberOfferRecurrence {
  interval: "daily" | "weekly" | "monthly" | "custom_seconds";
  amount: string;
  cap_cycles?: number;
  spending_cap_total?: string;
  custom_seconds?: number;
}

export interface FiberOfferRecurrenceInput {
  interval: FiberOfferRecurrence["interval"];
  amount: IntegerLike;
  cap_cycles?: IntegerLike;
  spending_cap_total?: IntegerLike;
  custom_seconds?: IntegerLike;
}

export interface FiberOfferMetadata {
  [key: string]: unknown;
}

export interface FiberOfferInput {
  network?: FiberOfferNetwork;
  node_id: string;
  public_key: string;
  resolver_url: string;
  description?: string;
  assets: FiberAsset[];
  amount_min?: IntegerLike;
  amount_max?: IntegerLike;
  recurrence?: FiberOfferRecurrenceInput;
  expiry?: IntegerLike;
  single_use?: boolean;
  metadata?: FiberOfferMetadata;
  extensions?: FiberOfferMetadata;
  [key: `x_${string}`]: unknown;
}

export interface UnsignedFiberOffer {
  scheme: typeof OFFER_SCHEME;
  version: 1;
  network: FiberOfferNetwork;
  node_id: string;
  public_key: string;
  resolver_url: string;
  description?: string;
  assets: FiberAsset[];
  amount_min?: string;
  amount_max?: string;
  recurrence?: FiberOfferRecurrence;
  expiry?: number;
  single_use: boolean;
  metadata?: FiberOfferMetadata;
  offer_id: string;
  extensions?: FiberOfferMetadata;
  [key: `x_${string}`]: unknown;
}

export interface FiberOfferSignature {
  scheme: "ed25519";
  value: string;
}

export interface SignedFiberOffer extends UnsignedFiberOffer {
  signature: FiberOfferSignature;
}

export interface OfferVerificationOk {
  ok: true;
}

export interface OfferVerificationFailure {
  ok: false;
  code: string;
  message: string;
}

export type OfferVerificationResult = OfferVerificationOk | OfferVerificationFailure;

export interface OfferRevocation {
  scheme: typeof REVOCATION_SCHEME;
  offer_id: string;
  node_id: string;
  revoked_at: number;
  reason?: string;
  signature: FiberOfferSignature;
}

export interface ResolutionRequestInput {
  amount: IntegerLike;
  asset?: FiberAsset;
  [key: string]: unknown;
}

export interface ValidatedResolutionRequest {
  amount: string;
  asset: FiberAsset;
}

export interface OfferKeyPair {
  privateKeyPem: string;
  publicKeyPem: string;
}

export function generateOfferKeyPair(): OfferKeyPair;
export function canonicalize<T>(value: T): T;
export function canonicalStringify(value: unknown): string;
export function sha256Hex(value: string | Uint8Array | unknown): string;
export function base64UrlEncode(value: string | Uint8Array): string;
export function base64UrlDecode(value: string): Uint8Array;
export function encodeOffer(offer: SignedFiberOffer): string;
export function decodeOffer(encoded: string): SignedFiberOffer;
export function buildUnsignedOffer(input: FiberOfferInput): UnsignedFiberOffer;
export function signOffer(unsignedOffer: UnsignedFiberOffer, privateKeyPem: string): SignedFiberOffer;
export function createSignedOffer(input: FiberOfferInput, privateKeyPem: string): SignedFiberOffer;
export function verifyOffer(offer: SignedFiberOffer): OfferVerificationResult;
export function createOfferRevocation(
  offer: SignedFiberOffer,
  privateKeyPem: string,
  input?: { revoked_at?: IntegerLike; reason?: string }
): OfferRevocation;
export function verifyOfferRevocation(
  offer: SignedFiberOffer,
  revocation: OfferRevocation,
  options?: { now?: number; maxAgeSeconds?: number }
): OfferVerificationResult;
export function assertValidOffer(offer: unknown, options?: { requireSignature?: boolean }): true;
export function validateResolutionRequest(
  offer: SignedFiberOffer,
  request: ResolutionRequestInput
): ValidatedResolutionRequest;
export function offerToPaymentLink(offer: SignedFiberOffer, baseUrl?: string): string;
