import mongoose from "mongoose";
import { ApiError } from "../utils/ApiError.js";

export const notFoundHandler = (req, _res, next) => {
    next(new ApiError(404, `Route ${req.method} ${req.originalUrl} not found.`));
};

/**
 * Central error formatter. Converts the errors Mongoose and JWT throw into
 * clean client-facing responses, and makes sure an unexpected bug never leaks
 * a stack trace or internal message in production.
 */
// eslint-disable-next-line no-unused-vars -- Express requires the 4-arg shape
export const errorHandler = (err, _req, res, _next) => {
    let error = err;

    if (err instanceof mongoose.Error.ValidationError) {
        const details = Object.values(err.errors).map((e) => ({
            field: e.path,
            message: e.message,
        }));
        error = new ApiError(400, "Validation failed.", details);
    } else if (err instanceof mongoose.Error.CastError) {
        error = new ApiError(400, `Invalid ${err.path}: ${err.value}`);
    } else if (err?.code === 11000) {
        const field = Object.keys(err.keyPattern || { field: 1 })[0];
        error = new ApiError(409, `That ${field} is already registered.`);
    }

    if (!(error instanceof ApiError)) {
        console.error("Unhandled error:", err);
        error = new ApiError(500, "Something went wrong. Please try again.");
    }

    const body = {
        success: false,
        message: error.message,
    };
    if (error.details) body.errors = error.details;
    if (process.env.NODE_ENV !== "production" && err.stack) body.stack = err.stack;

    res.status(error.statusCode).json(body);
};
