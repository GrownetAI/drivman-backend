/**
 * Operational error — one we threw on purpose, with a status code the
 * client should see. Anything that isn't an ApiError is treated as a bug
 * and reported as a generic 500 (details logged, never sent to the client).
 */
export class ApiError extends Error {
    constructor(statusCode, message, details = undefined) {
        super(message);
        this.statusCode = statusCode;
        this.details = details;
        this.isOperational = true;
        Error.captureStackTrace(this, this.constructor);
    }
}

export const badRequest = (msg, details) => new ApiError(400, msg, details);
export const unauthorized = (msg = "Not authenticated.") => new ApiError(401, msg);
export const forbidden = (msg = "You do not have permission to do this.") => new ApiError(403, msg);
export const notFound = (msg = "Resource not found.") => new ApiError(404, msg);
export const conflict = (msg) => new ApiError(409, msg);
export const tooMany = (msg) => new ApiError(429, msg);
