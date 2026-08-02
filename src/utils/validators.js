import mongoose from "mongoose";
import { badRequest } from "./ApiError.js";

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// E.164: leading +, country code, up to 15 digits total.
export const E164_RE = /^\+[1-9]\d{7,14}$/;

export const isValidEmail = (v) => typeof v === "string" && EMAIL_RE.test(v.trim());
export const isValidPhone = (v) => typeof v === "string" && E164_RE.test(v.trim());
export const isValidObjectId = (v) => mongoose.Types.ObjectId.isValid(v);

/**
 * Password policy: 8+ chars with at least one letter and one number.
 * Deliberately not requiring symbols — length beats symbol-soup, and complex
 * rules push users toward predictable substitutions.
 */
export const validatePassword = (password) => {
    if (typeof password !== "string" || password.length < 8) {
        return "Password must be at least 8 characters long.";
    }
    if (password.length > 128) {
        return "Password must be at most 128 characters long.";
    }
    if (!/[a-zA-Z]/.test(password) || !/\d/.test(password)) {
        return "Password must contain at least one letter and one number.";
    }
    return null;
};

/** Throws a 400 listing every missing field at once, rather than one at a time. */
export const requireFields = (body, fields) => {
    const missing = fields.filter((f) => {
        const v = body?.[f];
        return v === undefined || v === null || (typeof v === "string" && !v.trim());
    });
    if (missing.length) {
        throw badRequest(
            `Missing required field${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}.`,
            missing.map((f) => ({ field: f, message: `${f} is required.` })),
        );
    }
};

export const assertObjectId = (value, label = "id") => {
    if (!isValidObjectId(value)) throw badRequest(`Invalid ${label}.`);
    return value;
};

/** Normalises ?page & ?limit into safe numbers with a hard ceiling. */
export const parsePagination = (query, { defaultLimit = 20, maxLimit = 100 } = {}) => {
    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const limit = Math.min(maxLimit, Math.max(1, parseInt(query.limit, 10) || defaultLimit));
    return { page, limit, skip: (page - 1) * limit };
};

export const buildMeta = (page, limit, total) => ({
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit) || 1,
    hasNextPage: page * limit < total,
    hasPrevPage: page > 1,
});
