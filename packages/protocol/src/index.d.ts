export const OFFER_PREFIX: "fbroffer1";
export const OFFER_SCHEME: "fiberoffer-v1";
export const OFFER_HRP: "fbroffer";
export const REVOCATION_SCHEME: "fiberoffer-revocation-v1";
export const SUPPORTED_ASSET_TYPES: Set<FiberAssetType>;
export const SUPPORTED_NETWORKS: Set<FiberOfferNetwork>;
/** Upper bounds the format places on an offer. Sizes are in bytes unless named otherwise. */
export const OFFER_LIMITS: Readonly<{
  /** Canonical JSON of the whole signed offer. */
  offer_bytes: number;
  /** Characters of the encoded `fbroffer1...` form. */
  encoded_length: number;
  description_bytes: number;
  resolver_url_length: number;
  assets: number;
  symbol_length: number;
  metadata_bytes: number;
  /** `extensions` and all `x_...` fields together. */
  extensions_bytes: number;
  json_depth: number;
}>;

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
  /** `ckbScriptHash()` of the token's CKB type script. Required for `udt` and `rgbpp`. */
  type_script_hash?: string;
}

export type CkbScriptHashType = "data" | "type" | "data1" | "data2";

/** A CKB script. Hex fields are 0x-prefixed. */
export interface CkbScript {
  code_hash: string;
  hash_type: CkbScriptHashType;
  args: string;
}

/** blake2b-256 with CKB's `ckb-default-hash` personalization. */
export function ckbHash(bytes: Uint8Array): Uint8Array;
/** Canonical form (lowercase hex). Throws `FiberOfferError` with code `INVALID_CKB_SCRIPT`. */
export function normalizeCkbScript(script: CkbScript): CkbScript;
/** Molecule encoding of the script. */
export function serializeCkbScript(script: CkbScript): Uint8Array;
/** Reads a molecule-encoded script from bytes or 0x-prefixed hex. */
export function parseCkbScript(encoded: Uint8Array | string): CkbScript;
/** The `type_script_hash` an offer carries for this script. */
export function ckbScriptHash(script: CkbScript): string;

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
  /** On a recurring offer: which cycle of the subscription this request is for. */
  recurrence_cycle?: number;
  scheduled_for?: string;
  [key: string]: unknown;
}

/** A recurring cycle request carrying its subscription proof. */
export interface SignedRecurrenceRequest extends ResolutionRequestInput {
  amount: string;
  asset: FiberAsset;
  recurrence_cycle: number;
  /** `subscriptionId(subscriber_public_key)`. */
  approval_id: string;
  subscriber_public_key: string;
  subscriber_signature: string;
}

export const RECURRENCE_REQUEST_SCHEME: "fiberoffer-recurrence-v1";
/** The subscription ID for a subscriber's Ed25519 public key (`sub_` + 40 hex). */
export function subscriptionId(publicKeyPem: string): string;
/** Adds `approval_id`, `subscriber_public_key` and `subscriber_signature` to a cycle request. */
export function signRecurrenceRequest(
  offer: SignedFiberOffer,
  request: ResolutionRequestInput & { recurrence_cycle: number },
  subscriberPrivateKeyPem: string
): SignedRecurrenceRequest;
/** Checks the subscription proof on a cycle request. Payment history is the resolver's to check. */
export function verifyRecurrenceRequest(offer: SignedFiberOffer, request: ResolutionRequestInput): OfferVerificationResult;

export interface ValidatedResolutionRequest {
  amount: string;
  asset: FiberAsset;
}

export interface OfferKeyPair {
  privateKeyPem: string;
  publicKeyPem: string;
}

export function generateOfferKeyPair(): OfferKeyPair;
/** A copy with every object's members sorted, for display. Hash and sign `canonicalStringify`, not this. */
export function canonicalize<T>(value: T): T;
/**
 * The canonical JSON text (RFC 8785) that is hashed and signed. Throws
 * `INVALID_CANONICAL_VALUE` for anything without a single JSON spelling.
 */
export function canonicalStringify(value: unknown): string;
export function sha256Hex(value: string | Uint8Array | unknown): string;
export function base64UrlEncode(value: string | Uint8Array): string;
export function base64UrlDecode(value: string): Uint8Array;
/** Lowercase Bech32m over the offer's canonical JSON. */
export function encodeOffer(offer: SignedFiberOffer): string;
/**
 * Reads the lowercase or uppercase form. Throws `INVALID_OFFER_CHECKSUM` for a
 * damaged string and `INVALID_OFFER_ENCODING` (with `details.reason`) for
 * anything else that is not exactly an encoded offer.
 */
export function decodeOffer(encoded: string): SignedFiberOffer;
/** Whether a string is written as an encoded offer, in either case. */
export function isEncodedOffer(value: unknown): value is string;
export interface BuildOfferOptions {
  /** Unix seconds an `expiry` is checked against. Defaults to the current time. */
  now?: number;
}
/** Brings loosely written input to canonical form and derives the offer ID. */
export function buildUnsignedOffer(input: FiberOfferInput, options?: BuildOfferOptions): UnsignedFiberOffer;
/** Throws `INVALID_KEY_TYPE` unless the key is Ed25519. */
export function signOffer(unsignedOffer: UnsignedFiberOffer, privateKeyPem: string): SignedFiberOffer;
export function createSignedOffer(
  input: FiberOfferInput,
  privateKeyPem: string,
  options?: BuildOfferOptions
): SignedFiberOffer;
/**
 * Returns `{ ok: false, code }` when the ID or signature does not check out.
 * Throws `FiberOfferError` when the offer is malformed or not in canonical
 * form (`NON_CANONICAL_OFFER`, `UNKNOWN_OFFER_FIELD`, `INVALID_KEY_TYPE`, ...).
 */
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
  request: ResolutionRequestInput,
  /** `now` is the unix time, in seconds, the offer's expiry is checked against. */
  options?: { now?: number }
): ValidatedResolutionRequest;
export function offerToPaymentLink(offer: SignedFiberOffer, baseUrl?: string): string;
