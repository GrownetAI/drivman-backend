/**
 * A delivery failure that a provider adapter raises. `retryable` is decided by
 * the adapter — the one place that understands its own provider's error codes —
 * so the service can retry without knowing anything about Resend or SMTP.
 */
export class EmailDeliveryError extends Error {
    constructor(message, { retryable = false, statusCode = null, provider, code, cause } = {}) {
        super(message);
        this.name = "EmailDeliveryError";
        this.retryable = retryable;
        this.statusCode = statusCode;
        this.provider = provider;
        this.code = code;
        this.cause = cause;
        Error.captureStackTrace(this, this.constructor);
    }
}

/**
 * 5xx means the provider broke, 429 means "later" — both are worth another try.
 * A null status is a transport failure (DNS, socket, timeout), which is the most
 * retryable case of all. Every other 4xx is our fault: a malformed address or a
 * rejected key won't fix itself, so retrying just delays the error.
 */
export const isRetryableStatus = (statusCode) => {
    if (statusCode === null || statusCode === undefined) return true;
    if (statusCode === 429) return true;
    return statusCode >= 500;
};
