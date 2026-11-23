// Turns whatever an invoice adapter throws into the HTTP error a payer sees.
// The distinction that matters to a wallet is whether retrying can help:
// "the recipient is unreachable right now" versus "this request will never
// produce an invoice until something is fixed".

const transientNetworkCodes = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET"
]);

const unavailable = {
  status: 503,
  code: "RECIPIENT_UNAVAILABLE",
  message: "recipient temporarily unavailable, try again",
  retryable: true
};

// For adapters to raise a problem with the request or the resolver's
// configuration. These pass through to the payer unchanged.
export function invoiceRequestError(code, message, details = undefined, status = 422) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.invoice_request_error = true;
  error.details = details;
  return error;
}

// A Fiber node with token authentication answers a missing, invalid or
// insufficient token with this JSON-RPC error, over HTTP 200 (seen on v0.10.1).
const FIBER_RPC_UNAUTHORIZED_CODE = -32999;

const unauthorized = {
  status: 502,
  code: "FIBER_RPC_UNAUTHORIZED",
  message: "the resolver is not authorized to use the recipient's Fiber node",
  retryable: false
};

export function classifyInvoiceFailure(error) {
  if (error?.invoice_request_error) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      retryable: false,
      details: error.details
    };
  }

  // Always a string in the response: a network error has a name (ECONNREFUSED)
  // and a JSON-RPC error a number (-32602), and a client reads one member.
  const causeCode = String(error?.code ?? "FIBER_RPC_UNAVAILABLE");

  switch (error?.kind) {
    case "timeout":
    case "transport":
      return { ...unavailable, cause_code: causeCode };
    case "http":
      if (error.http_status === 401 || error.http_status === 403) return { ...unauthorized, cause_code: causeCode };
      if (error.retryable) return { ...unavailable, cause_code: causeCode };
      return {
        status: 502,
        code: "FIBER_RPC_REJECTED",
        message: "the recipient's Fiber node endpoint refused the invoice request",
        retryable: false,
        cause_code: causeCode
      };
    case "rpc":
      if (error.code === FIBER_RPC_UNAUTHORIZED_CODE) return { ...unauthorized, cause_code: causeCode };
      return {
        status: 502,
        code: "FIBER_INVOICE_REJECTED",
        message: "the recipient's Fiber node rejected the invoice request",
        retryable: false,
        cause_code: causeCode
      };
    case "invalid_response":
      return {
        status: 502,
        code: "FIBER_RPC_INVALID_RESPONSE",
        message: "the recipient's Fiber node returned an unusable response",
        retryable: false,
        cause_code: causeCode
      };
    default:
      break;
  }

  if (error?.code === "INVALID_FIBER_RPC_RESPONSE") {
    return {
      status: 502,
      code: "FIBER_RPC_INVALID_RESPONSE",
      message: "the recipient's Fiber node returned an unusable response",
      retryable: false,
      cause_code: causeCode
    };
  }

  // An error of unknown origin (a custom adapter, or a bug). Retrying is
  // harmless, so it is reported as unavailable, and flagged so the operator
  // sees it in the error log rather than only in the request log.
  return {
    ...unavailable,
    cause_code: causeCode,
    unclassified: !transientNetworkCodes.has(error?.code)
  };
}
