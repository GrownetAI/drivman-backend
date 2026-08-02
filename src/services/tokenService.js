import jwt from "jsonwebtoken";
import crypto from "crypto";
import { User } from "../models/user.model.js";

/**
 * Two-token scheme:
 *
 *   Access token  — short-lived (15m), stateless JWT, sent on every request.
 *                   Never stored server-side; revocation is via passwordChangedAt.
 *   Refresh token — long-lived (7d), opaque random string, hashed and stored in
 *                   user.refreshTokens. Revocable per-device, rotated on use.
 *
 * Rotation matters: each refresh issues a NEW refresh token and deletes the old
 * one, so a stolen refresh token stops working the moment the real user refreshes.
 */

export const ACCESS_TOKEN_TTL = process.env.JWT_EXPIRES_IN || "15m";
export const REFRESH_TOKEN_TTL_DAYS = Number(process.env.JWT_REFRESH_EXPIRES_IN_DAYS) || 7;

const MAX_SESSIONS_PER_USER = 5;

export const signAccessToken = (user) =>
    jwt.sign(
        { sub: user._id.toString(), role: user.role, type: "access" },
        process.env.JWT_SECRET,
        { expiresIn: ACCESS_TOKEN_TTL },
    );

export const verifyAccessToken = (token) => {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.type !== "access") throw new jwt.JsonWebTokenError("Wrong token type.");
    return payload;
};

const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");

/**
 * Mints a refresh token, persists its hash against the user, and prunes both
 * expired entries and the oldest sessions beyond MAX_SESSIONS_PER_USER.
 * Returns the RAW token — the only time it exists in plaintext.
 */
export const issueRefreshToken = async (userId, { userAgent, ip } = {}) => {
    const raw = crypto.randomBytes(48).toString("hex");
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

    const user = await User.findById(userId).select("+refreshTokens");
    if (!user) throw new Error("User not found while issuing refresh token.");

    const now = new Date();
    const live = user.refreshTokens.filter((t) => t.expiresAt > now);
    live.push({ tokenHash: hash(raw), expiresAt, userAgent, ip, createdAt: now });

    // Keep only the N most recent sessions — an old forgotten device shouldn't
    // stay valid forever just because it was never logged out.
    user.refreshTokens = live
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, MAX_SESSIONS_PER_USER);

    await user.save({ validateBeforeSave: false });
    return raw;
};

/**
 * Validates a raw refresh token and rotates it in one step.
 * Returns { user, refreshToken } or null when the token is unknown/expired.
 */
export const rotateRefreshToken = async (rawToken, { userAgent, ip } = {}) => {
    if (!rawToken) return null;

    const tokenHash = hash(rawToken);
    const user = await User.findOne({ "refreshTokens.tokenHash": tokenHash }).select(
        "+refreshTokens",
    );
    if (!user) return null;

    const entry = user.refreshTokens.find((t) => t.tokenHash === tokenHash);
    if (!entry || entry.expiresAt <= new Date()) {
        // Expired: clean it out so the array doesn't grow unbounded.
        user.refreshTokens = user.refreshTokens.filter((t) => t.tokenHash !== tokenHash);
        await user.save({ validateBeforeSave: false });
        return null;
    }

    const raw = crypto.randomBytes(48).toString("hex");
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

    // Replace the used token in place — this is the rotation.
    user.refreshTokens = user.refreshTokens
        .filter((t) => t.tokenHash !== tokenHash && t.expiresAt > new Date())
        .concat({ tokenHash: hash(raw), expiresAt, userAgent, ip, createdAt: new Date() });

    await user.save({ validateBeforeSave: false });
    return { user, refreshToken: raw };
};

export const revokeRefreshToken = async (userId, rawToken) => {
    if (!rawToken) return;
    const tokenHash = hash(rawToken);
    await User.updateOne({ _id: userId }, { $pull: { refreshTokens: { tokenHash } } });
};

export const revokeAllRefreshTokens = async (userId) => {
    await User.updateOne({ _id: userId }, { $set: { refreshTokens: [] } });
};

// --- Cookies -----------------------------------------------------------------

const isProd = () => process.env.NODE_ENV === "production";

const baseCookie = () => ({
    httpOnly: true,
    secure: isProd(),
    sameSite: isProd() ? "none" : "lax",
    path: "/",
});

export const setAuthCookies = (res, { accessToken, refreshToken }) => {
    res.cookie("accessToken", accessToken, {
        ...baseCookie(),
        maxAge: 15 * 60 * 1000,
    });
    res.cookie("refreshToken", refreshToken, {
        ...baseCookie(),
        // Scoped to the auth routes so it isn't sent on every API call —
        // narrower blast radius if any single endpoint ever leaks headers.
        path: "/api/auth",
        maxAge: REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
    });
};

export const clearAuthCookies = (res) => {
    res.clearCookie("accessToken", { ...baseCookie() });
    res.clearCookie("refreshToken", { ...baseCookie(), path: "/api/auth" });
};
