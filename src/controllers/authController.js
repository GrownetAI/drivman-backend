import crypto from "crypto";
import { User } from "../models/user.model.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ok, created } from "../utils/ApiResponse.js";
import {
    ApiError,
    badRequest,
    unauthorized,
    forbidden,
    notFound,
    tooMany,
} from "../utils/ApiError.js";
import {
    requireFields,
    isValidEmail,
    isValidPhone,
    validatePassword,
} from "../utils/validators.js";
import {
    signAccessToken,
    issueRefreshToken,
    rotateRefreshToken,
    revokeRefreshToken,
    revokeAllRefreshTokens,
    setAuthCookies,
    clearAuthCookies,
    ACCESS_TOKEN_TTL,
} from "../services/tokenService.js";
import { sendPasswordResetEmail } from "../services/emailService.js";
import { emailOtpService, OTP_LENGTH } from "../services/emailOtpService.js";
import { sendOtpSms, checkOtp, isDevOtpMode } from "../services/otpServices.js";
import { logger } from "../utils/logger.js";

const RESET_TOKEN_TTL_MIN = 15;

const MAX_FAILED_ATTEMPTS = 5;

/**
 * Admins keep the lockout — they are the highest-value target in the system —
 * but at a higher ceiling. Locking the one account that can unblock everyone
 * else turns a fat-fingered password into an outage, and 20 guesses is still
 * far too few to brute-force anything.
 */
const MAX_FAILED_ATTEMPTS_ADMIN = 20;

const LOCK_DURATION_MS = 15 * 60 * 1000;

const maxFailedAttemptsFor = (user) =>
    user?.role === "admin" ? MAX_FAILED_ATTEMPTS_ADMIN : MAX_FAILED_ATTEMPTS;

const sha256 = (v) => crypto.createHash("sha256").update(v).digest("hex");

/**
 * Issues an access + refresh pair, sets both cookies, and returns the payload.
 * Every successful authentication in this file funnels through here so the
 * session shape can never drift between endpoints.
 */
const establishSession = async (req, res, user, message, statusCode = 200) => {
    const accessToken = signAccessToken(user);
    const refreshToken = await issueRefreshToken(user._id, {
        userAgent: req.headers["user-agent"],
        ip: req.ip,
    });

    setAuthCookies(res, { accessToken, refreshToken });

    await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });

    const fresh = await User.findById(user._id);

    return ok(
        res,
        {
            user: fresh,
            accessToken,
            refreshToken,
            expiresIn: ACCESS_TOKEN_TTL,
        },
        message,
        statusCode,
    );
};

/**
 * @route POST /api/auth/signup
 * Creates an UNVERIFIED account and emails a 6-digit verification code.
 * Deliberately issues NO tokens — the user cannot log in until the email
 * is confirmed via POST /api/auth/email/verify-otp.
 */
export const signup = asyncHandler(async (req, res) => {
    const { fullName, email, phone, password } = req.body;
    requireFields(req.body, ["fullName", "email", "phone", "password"]);

    if (!isValidEmail(email)) throw badRequest("Please provide a valid email address.");
    if (!isValidPhone(phone)) {
        throw badRequest("Phone must be in E.164 format, e.g. +919876543210.");
    }
    const pwError = validatePassword(password);
    if (pwError) throw badRequest(pwError);

    const normalizedEmail = email.toLowerCase().trim();
    const existing = await User.findOne({
         
            email: normalizedEmail 
    });

    if (existing) throw badRequest("That email is already registered. Try logging in.");

    const user = new User({
        fullName: fullName.trim(),
        email: normalizedEmail,
        phone: phone.trim(),
        password, // hashed by the pre-save hook
    });

    await user.save();

    let dispatch;
    try {
        dispatch = await emailOtpService.requestOtp({
            email: user.email,
            ip: req.ip,
            requestId: req.id,
        });
    } catch (mailError) {
        // If the code can't go out, the account is unreachable — remove it so
        // the address isn't locked up by an account nobody can activate.
        await User.deleteOne({ _id: user._id });
        logger.child({ requestId: req.id }).error("Signup verification code failed", {
            email: user.email,
            reason: mailError.message,
        });
        // A rate-limit rejection already carries the right status and wording.
        if (mailError instanceof ApiError) throw mailError;
        throw new Error("Could not send the verification code. Please try again.");
    }

    return created(
        res,
        {
            userId: user._id,
            email: user.email,
            expiresInMinutes: dispatch.ttlMinutes,
            // Surfaced in dev so you can verify without opening a mailbox.
            ...(dispatch.devOtpCode ? { devOtpCode: dispatch.devOtpCode } : {}),
        },
        `Account created. Enter the ${OTP_LENGTH}-digit code sent to ${user.email} to verify your address (valid ${dispatch.ttlMinutes} minutes).`,
    );
});

/**
 * @route POST /api/auth/email/send-otp   Body: { email }
 * Issues a fresh verification code. The response is identical whether or not
 * the address has an account, so it can't be used to discover who is
 * registered — see emailOtpService for the rate limits behind it.
 */
export const sendEmailOtp = asyncHandler(async (req, res) => {
    const { email } = req.body;
    requireFields(req.body, ["email"]);
    if (!isValidEmail(email)) throw badRequest("Please provide a valid email address.");

    const dispatch = await emailOtpService.requestOtp({
        email,
        ip: req.ip,
        requestId: req.id,
    });

    return ok(
        res,
        {
            expiresInMinutes: dispatch.ttlMinutes,
            ...(dispatch.devOtpCode ? { devOtpCode: dispatch.devOtpCode } : {}),
        },
        "If that email is registered and unverified, a verification code has been sent.",
    );
});

/**
 * @route POST /api/auth/email/verify-otp   Body: { email, code }
 * Confirms the address and logs the user straight in.
 */
export const verifyEmailOtp = asyncHandler(async (req, res) => {
    const { email, code, otp } = req.body;
    const submitted = code ?? otp;

    requireFields({ email, code: submitted }, ["email", "code"]);

    // A malformed code is deliberately NOT rejected early — it goes through the
    // same path as a wrong one so it consumes an attempt and takes the same time.
    const { user } = await emailOtpService.verifyOtp({
        email,
        code: submitted,
        requestId: req.id,
    });

    return establishSession(req, res, user, "Email verified. You are now logged in.");
});

/**
 * @route POST /api/auth/verify-email   Body: { token }
 * @route GET  /api/auth/verify-email?token=...
 *
 * LEGACY link-based verification. Signup issues codes now, so nothing mints
 * these tokens any more; the route stays so links already sitting in inboxes
 * still work. Prefer /api/auth/email/verify-otp.
 */
export const verifyEmail = asyncHandler(async (req, res) => {
    const token = req.body?.token || req.query?.token;
    if (!token) throw badRequest("Verification token is required.");

    const user = await User.findOne({
        emailVerificationTokenHash: sha256(String(token)),
        emailVerificationExpiresAt: { $gt: new Date() },
    }).select("+emailVerificationTokenHash +emailVerificationExpiresAt");

    if (!user) {
        throw badRequest("This verification link is invalid or has expired. Request a new one.");
    }

    user.isEmailVerified = true;
    user.emailVerifiedAt = new Date();
    user.emailVerificationTokenHash = undefined;
    user.emailVerificationExpiresAt = undefined;
    await user.save({ validateBeforeSave: false });

    return establishSession(req, res, user, "Email verified. You are now logged in.");
});

/**
 * @route POST /api/auth/resend-verification   Body: { email }
 * Kept as an alias of /api/auth/email/send-otp so existing clients don't break —
 * it now sends a code rather than a link.
 */
export const resendVerification = sendEmailOtp;

/**
 * Shared failed-login bookkeeping: counts attempts and locks the account for
 * 15 minutes after 5 failures, so a password can't be brute-forced even if the
 * attacker rotates IPs past the rate limiter.
 */
const registerFailedAttempt = async (user) => {
    const attempts = (user.failedLoginAttempts || 0) + 1;
    const update = { failedLoginAttempts: attempts };
    if (attempts >= maxFailedAttemptsFor(user)) {
        update.lockedUntil = new Date(Date.now() + LOCK_DURATION_MS);
        update.failedLoginAttempts = 0;
    }
    await User.updateOne({ _id: user._id }, { $set: update });
};

const clearFailedAttempts = (userId) =>
    User.updateOne({ _id: userId }, { $set: { failedLoginAttempts: 0 }, $unset: { lockedUntil: 1 } });

/**
 * @route POST /api/auth/login
 * Three supported shapes:
 *   { email, password }
 *   { phone, password }
 *   { phone, otp }
 * Email verification is enforced on all three.
 */
export const login = asyncHandler(async (req, res) => {
    const { email, phone, password, otp } = req.body;

    if (!email && !phone) throw badRequest("Provide either an email or a phone number.");
    if (!password && !otp) throw badRequest("Provide either a password or an OTP.");
    if (password && otp) throw badRequest("Provide either a password or an OTP, not both.");
    if (email && otp) throw badRequest("OTP login requires a phone number, not an email.");

    // Email is unique, so it resolves to at most one account. A phone number is
    // NOT unique — several accounts may share one — so it can resolve to many,
    // and the credential is what picks between them.
    const candidates = email
        ? await User.find({ email: email.toLowerCase().trim() })
              .select("+password +failedLoginAttempts +lockedUntil")
              .limit(1)
        : await User.find({ phone: phone.trim() }).select(
              "+password +failedLoginAttempts +lockedUntil",
          );

    // Uniform message for "no such user" and "wrong password" — revealing which
    // one it was would let an attacker enumerate registered accounts.
    const invalid = () => unauthorized("Invalid credentials.");

    if (!candidates.length) {
        // Still burn a little time so a missing account isn't detectably faster.
        if (password) await new Promise((r) => setTimeout(r, 120));
        throw invalid();
    }

    // A locked account must not have its password tested, or the lockout would
    // not actually slow anything down.
    const unlocked = candidates.filter((candidate) => !candidate.isLocked());
    if (!unlocked.length) {
        const soonest = Math.min(...candidates.map((c) => c.lockedUntil.getTime()));
        const mins = Math.ceil((soonest - Date.now()) / 60000);
        throw tooMany(`Account temporarily locked. Try again in ${mins} minute(s).`);
    }

    let user;

    if (password) {
        // With a shared number the password is what identifies the account, so
        // each candidate is checked before the attempt is called invalid.
        for (const candidate of unlocked) {
            if (await candidate.comparePassword(password)) {
                user = candidate;
                break;
            }
        }
        if (!user) {
            // Count the failure against every account on that number — otherwise
            // sharing a phone would multiply the brute-force budget.
            await Promise.all(unlocked.map(registerFailedAttempt));
            throw invalid();
        }
    } else {
        // An OTP proves control of the number, not which account was intended,
        // so it cannot disambiguate a shared one.
        if (unlocked.length > 1) {
            throw badRequest(
                "Several accounts use this phone number. Please log in with your email and password instead.",
            );
        }
        user = unlocked[0];

        const approved = await checkOtp(user.phone, otp);
        if (!approved) {
            await registerFailedAttempt(user);
            throw unauthorized("Invalid or expired OTP.");
        }
        // Successfully receiving an SMS code proves the number belongs to them.
        if (!user.isPhoneVerified) {
            await User.updateOne({ _id: user._id }, { $set: { isPhoneVerified: true } });
        }
    }

    if (!user.isActive) throw forbidden("This account has been deactivated.");

    // The gate the old code was missing: unverified accounts cannot get a session.
    // TEMPORARY — remove once real email provider is configured: SKIP_EMAIL_VERIFICATION
    // lets unverified accounts log in when the OTP email can't actually be delivered
    // (no RESEND_API_KEY yet). Off by default — must be explicitly "true" to bypass.
    const skipEmailVerification = process.env.SKIP_EMAIL_VERIFICATION === "true";
    if (!user.isEmailVerified && !skipEmailVerification) {
        throw forbidden(
            "Please verify your email address before logging in. Use /api/auth/resend-verification to get a new link.",
        );
    }

    await clearFailedAttempts(user._id);
    return establishSession(req, res, user, "Logged in successfully.");
});

/**
 * @route POST /api/auth/request-otp   Body: { phone }
 * Sends a login OTP. Generic response regardless of whether the number exists.
 */
export const requestOtp = asyncHandler(async (req, res) => {
    const { phone } = req.body;
    requireFields(req.body, ["phone"]);
    if (!isValidPhone(phone)) {
        throw badRequest("Phone must be in E.164 format, e.g. +919876543210.");
    }

    const genericMessage = "If that number is registered, an OTP has been sent.";

    // Several accounts may share the number, so match an *eligible* one rather
    // than the first one stored — otherwise a deactivated account sitting on the
    // same number would suppress the OTP.
    const user = await User.findOne({
        phone: phone.trim(),
        isEmailVerified: true,
        isActive: true,
    });

    if (user) {
        try {
            await sendOtpSms(user.phone);
        } catch (err) {
            console.error("OTP send failed:", err.message);
            throw new Error("Could not send the OTP. Please try again.");
        }
    }

    return ok(
        res,
        isDevOtpMode() ? { devMode: true, hint: "Check the server console for the code." } : null,
        genericMessage,
    );
});

/**
 * @route POST /api/auth/refresh
 * Exchanges a refresh token for a new access token, rotating the refresh
 * token in the process. Accepts the token from the cookie or the body.
 */
export const refresh = asyncHandler(async (req, res) => {
    const raw = req.cookies?.refreshToken || req.body?.refreshToken;
    if (!raw) throw unauthorized("No refresh token provided.");

    const result = await rotateRefreshToken(raw, {
        userAgent: req.headers["user-agent"],
        ip: req.ip,
    });

    if (!result) {
        clearAuthCookies(res);
        throw unauthorized("Refresh token is invalid or expired. Please log in again.");
    }

    const { user, refreshToken } = result;
    if (!user.isActive) throw forbidden("This account has been deactivated.");

    const accessToken = signAccessToken(user);
    setAuthCookies(res, { accessToken, refreshToken });

    return ok(
        res,
        { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_TTL },
        "Token refreshed.",
    );
});

/** @route POST /api/auth/logout — ends this device's session only. */
export const logout = asyncHandler(async (req, res) => {
    const raw = req.cookies?.refreshToken || req.body?.refreshToken;
    if (raw && req.user) await revokeRefreshToken(req.user._id, raw);
    clearAuthCookies(res);
    return ok(res, null, "Logged out successfully.");
});

/** @route POST /api/auth/logout-all — ends every session on every device. */
export const logoutAll = asyncHandler(async (req, res) => {
    await revokeAllRefreshTokens(req.user._id);
    clearAuthCookies(res);
    return ok(res, null, "Logged out from all devices.");
});

/** @route GET /api/auth/me */
export const getMe = asyncHandler(async (req, res) =>
    ok(res, { user: req.user }, "Current user fetched."),
);

/**
 * @route POST /api/auth/forgot-password   Body: { email }
 */
export const forgotPassword = asyncHandler(async (req, res) => {
    const { email } = req.body;
    requireFields(req.body, ["email"]);

    const genericMessage = "If that email is registered, a reset link has been sent.";
    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user) return ok(res, null, genericMessage);

    const rawToken = user.createPasswordResetToken(RESET_TOKEN_TTL_MIN);
    await user.save({ validateBeforeSave: false });

    try {
        await sendPasswordResetEmail({
            to: user.email,
            fullName: user.fullName,
            token: rawToken,
            ttlMinutes: RESET_TOKEN_TTL_MIN,
            requestId: req.id,
        });
    } catch (mailError) {
        user.passwordResetTokenHash = undefined;
        user.passwordResetExpiresAt = undefined;
        await user.save({ validateBeforeSave: false });
        logger.child({ requestId: req.id }).error("Reset email failed", {
            email: user.email,
            reason: mailError.message,
        });
        throw new Error("Could not send the reset email. Please try again.");
    }

    return ok(
        res,
        process.env.NODE_ENV !== "production" ? { devResetToken: rawToken } : null,
        genericMessage,
    );
});

/**
 * @route POST /api/auth/reset-password   Body: { token, password }
 * Revokes every existing session — a password reset must kick out whoever
 * may have had access.
 */
export const resetPassword = asyncHandler(async (req, res) => {
    const { token, password } = req.body;
    requireFields(req.body, ["token", "password"]);

    const pwError = validatePassword(password);
    if (pwError) throw badRequest(pwError);

    const user = await User.findOne({
        passwordResetTokenHash: sha256(String(token)),
        passwordResetExpiresAt: { $gt: new Date() },
    }).select("+passwordResetTokenHash +passwordResetExpiresAt +refreshTokens");

    if (!user) throw badRequest("This reset link is invalid or has expired.");

    user.password = password;
    user.passwordResetTokenHash = undefined;
    user.passwordResetExpiresAt = undefined;
    user.refreshTokens = [];
    // A user who proves mailbox control by clicking the link has, in effect,
    // verified their address — so an unverified account becomes verified here.
    user.isEmailVerified = true;
    await user.save();

    clearAuthCookies(res);
    return ok(res, null, "Password reset. Please log in with your new password.");
});

/**
 * @route PATCH /api/auth/change-password   Body: { currentPassword, newPassword }
 * Keeps the current device logged in, drops all the others.
 */
export const changePassword = asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    requireFields(req.body, ["currentPassword", "newPassword"]);

    const pwError = validatePassword(newPassword);
    if (pwError) throw badRequest(pwError);
    if (currentPassword === newPassword) {
        throw badRequest("The new password must be different from the current one.");
    }

    const user = await User.findById(req.user._id).select("+password +refreshTokens");
    if (!(await user.comparePassword(currentPassword))) {
        throw unauthorized("Your current password is incorrect.");
    }

    user.password = newPassword;
    user.refreshTokens = [];
    await user.save();

    return establishSession(req, res, user, "Password changed successfully.");
});

/** @route POST /api/auth/verify-phone   Body: { otp } — requires auth. */
export const verifyPhone = asyncHandler(async (req, res) => {
    const { otp } = req.body;
    requireFields(req.body, ["otp"]);

    const approved = await checkOtp(req.user.phone, otp);
    if (!approved) throw unauthorized("Invalid or expired OTP.");

    await User.updateOne({ _id: req.user._id }, { $set: { isPhoneVerified: true } });
    const user = await User.findById(req.user._id);

    return ok(res, { user }, "Phone number verified.");
});

/** @route POST /api/auth/send-phone-otp — requires auth. */
export const sendPhoneOtp = asyncHandler(async (req, res) => {
    if (req.user.isPhoneVerified) {
        return ok(res, null, "Your phone number is already verified.");
    }
    await sendOtpSms(req.user.phone);
    return ok(
        res,
        isDevOtpMode() ? { devMode: true, hint: "Check the server console for the code." } : null,
        "OTP sent to your registered phone number.",
    );
});
