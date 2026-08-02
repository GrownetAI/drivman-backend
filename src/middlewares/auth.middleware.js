import jwt from "jsonwebtoken";
import { User } from "../models/user.model.js";
import { verifyAccessToken } from "../services/tokenService.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { unauthorized, forbidden } from "../utils/ApiError.js";

const extractToken = (req) => {
    if (req.cookies?.accessToken) return req.cookies.accessToken;
    const header = req.headers.authorization;
    if (header?.startsWith("Bearer ")) return header.slice(7).trim();
    return null;
};

/**
 * Verifies the access token and loads the user. Rejects tokens that were
 * issued before the user's last password change, so changing a password
 * really does log every other device out.
 */
export const requireAuth = asyncHandler(async (req, _res, next) => {
    const token = extractToken(req);
    if (!token) throw unauthorized("Not authenticated. Please log in.");

    let payload;
    try {
        payload = verifyAccessToken(token);
    } catch (err) {
        if (err instanceof jwt.TokenExpiredError) {
            throw unauthorized("Access token expired. Please refresh.");
        }
        throw unauthorized("Invalid token. Please log in again.");
    }

    const user = await User.findById(payload.sub).select("+passwordChangedAt");
    if (!user) throw unauthorized("This account no longer exists.");
    if (!user.isActive) throw forbidden("This account has been deactivated.");
    if (user.passwordChangedAfter(payload.iat)) {
        throw unauthorized("Password was changed recently. Please log in again.");
    }

    req.user = user;
    next();
});

/** Blocks the request until the user has confirmed their email address. */
export const requireVerifiedEmail = (req, _res, next) => {
    if (!req.user?.isEmailVerified) {
        return next(
            forbidden("Please verify your email address to continue."),
        );
    }
    next();
};

/** Role gate — use as requireRole("admin"). */
export const requireRole =
    (...roles) =>
    (req, _res, next) => {
        if (!roles.includes(req.user?.role)) {
            return next(forbidden("You do not have permission to perform this action."));
        }
        next();
    };

/**
 * Attaches req.user when a valid token is present, but never rejects.
 * Used on public endpoints that personalise output for logged-in users.
 */
export const optionalAuth = asyncHandler(async (req, _res, next) => {
    const token = extractToken(req);
    if (!token) return next();
    try {
        const payload = verifyAccessToken(token);
        const user = await User.findById(payload.sub);
        if (user?.isActive) req.user = user;
    } catch {
        // Ignore — an invalid token on a public route is just "not logged in".
    }
    next();
});
