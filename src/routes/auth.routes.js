import express from "express";
import rateLimit from "express-rate-limit";
import {
    signup,
    verifyEmail,
    resendVerification,
    sendEmailOtp,
    verifyEmailOtp,
    login,
    requestOtp,
    refresh,
    logout,
    logoutAll,
    getMe,
    forgotPassword,
    resetPassword,
    changePassword,
    verifyPhone,
    sendPhoneOtp,
} from "../controllers/authController.js";
import { requireAuth, optionalAuth } from "../middlewares/auth.middleware.js";

const router = express.Router();

const limiter = (windowMinutes, max, message) =>
    rateLimit({
        windowMs: windowMinutes * 60 * 1000,
        max,
        message: { success: false, message },
        standardHeaders: true,
        legacyHeaders: false,
        // Rate-limit by account identifier when one is supplied, falling back
        // to IP. Keying on IP alone lets an attacker rotate IPs to bypass it.
        keyGenerator: (req) =>
            req.body?.email?.toLowerCase() || req.body?.phone || req.ip,
    });

/**
 * Second layer, keyed purely on IP. The per-email limits live in
 * emailOtpService (database-backed, so they survive a restart and hold across
 * instances); this catches one host spraying many different addresses.
 * No keyGenerator override — the default is IP-based and IPv6-aware.
 */
const ipLimiter = (windowMinutes, max, message) =>
    rateLimit({
        windowMs: windowMinutes * 60 * 1000,
        max,
        message: { success: false, message },
        standardHeaders: true,
        legacyHeaders: false,
    });

const loginLimiter = limiter(15, 10, "Too many login attempts. Please try again in 15 minutes.");
const otpLimiter = limiter(10, 3, "Too many OTP requests. Please try again in 10 minutes.");
const emailLimiter = limiter(15, 3, "Too many email requests. Please try again in 15 minutes.");
const signupLimiter = limiter(60, 5, "Too many signup attempts. Please try again later.");

const emailOtpSendIpLimiter = ipLimiter(
    60,
    10,
    "Too many verification codes requested from this network. Please try again later.",
);
const emailOtpVerifyIpLimiter = ipLimiter(
    15,
    20,
    "Too many verification attempts from this network. Please try again later.",
);

// --- Public ------------------------------------------------------------------
router.post("/signup", signupLimiter, signup);

// Email verification by 6-digit code — the primary flow.
router.post("/email/send-otp", emailOtpSendIpLimiter, sendEmailOtp);
router.post("/email/verify-otp", emailOtpVerifyIpLimiter, verifyEmailOtp);

// Legacy link-based verification. Nothing mints these tokens any more, but
// links already sitting in inboxes still resolve.
router.post("/verify-email", verifyEmail);
router.get("/verify-email", verifyEmail);

// Alias of /email/send-otp, kept so existing clients keep working.
router.post("/resend-verification", emailLimiter, emailOtpSendIpLimiter, resendVerification);

router.post("/login", loginLimiter, login);
router.post("/request-otp", otpLimiter, requestOtp);
router.post("/refresh", refresh);

router.post("/forgot-password", emailLimiter, forgotPassword);
router.post("/reset-password", resetPassword);

// optionalAuth so logout still clears cookies even with an expired access token
router.post("/logout", optionalAuth, logout);

// --- Protected ---------------------------------------------------------------
router.use(requireAuth);

router.get("/me", getMe);
router.post("/logout-all", logoutAll);
router.patch("/change-password", changePassword);
router.post("/send-phone-otp", otpLimiter, sendPhoneOtp);
router.post("/verify-phone", verifyPhone);

export default router;
