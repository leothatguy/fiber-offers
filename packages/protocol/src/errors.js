export class FiberOfferError extends Error {
  constructor(message, code = "FIBER_OFFER_ERROR", details = undefined) {
    super(message);
    this.name = "FiberOfferError";
    this.code = code;
    this.details = details;
  }
}
