import express from "express";
import rateLimit from "express-rate-limit";
import { signup, login, logout, getMe, sendOtp, verifySignupOtp } from "../controllers/userController.js";
import { isAuthenticated, requireActiveAccount } from "../middlewares/user.middleware.js";
 
const router = express.Router();
 
// Prevents SMS-cost abuse: max 3 OTP requests per phone/IP window per 10 min
const otpRequestLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 3,
    message: {
        success: false,
        message: "Too many OTP requests. Please try again in 10 minutes."
    },
    standardHeaders: true,
    legacyHeaders: false
});
 
// Prevents brute-forcing the 6-digit code: max 5 attempts per 10 min
const otpVerifyLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 5,
    message: {
        success: false,
        message: "Too many verification attempts. Please try again in 10 minutes."
    },
    standardHeaders: true,
    legacyHeaders: false
});
 
// Signup — creates account, issues session, sends verification OTP
router.post("/signup", signup);
router.post("/verify-signup-otp", otpVerifyLimiter, verifySignupOtp);
 
// Login (returning users) — phone + password OR phone + OTP
router.post("/login", login);
router.post("/logout", logout);
 
// Request an OTP — used both to resend signup verification and for OTP login
router.post("/send-otp", otpRequestLimiter, sendOtp);
 
// Protected routes — blocked until phone is verified via OTP.
// isAuthenticated confirms the token is valid; requireActiveAccount
// then confirms isActive: true before allowing access.
router.get("/me", isAuthenticated, requireActiveAccount, getMe);
 
// Any other app route you add later should follow the same pattern:
// router.get("/some-protected-thing", isAuthenticated, requireActiveAccount, someController);
 
export default router;