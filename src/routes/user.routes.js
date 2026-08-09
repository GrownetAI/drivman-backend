import express from "express";
import rateLimit from "express-rate-limit";
import {
    getProfile,
    updateProfile,
    requestEmailChange,
    verifyEmailChange,
    listAddresses,
    addAddress,
    updateAddress,
    deleteAddress,
    setDefaultAddress,
    listUsers,
    listCustomers,
    setUserStatus,
} from "../controllers/userController.js";
import { requireAuth, requireRole } from "../middlewares/auth.middleware.js";

const router = express.Router();

router.use(requireAuth);

/**
 * Second layer on top of the per-address limits in emailOtpService. Keyed on
 * IP by default, which is IPv6-aware.
 */
const emailChangeLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    message: {
        success: false,
        message: "Too many email change requests. Please try again later.",
    },
    standardHeaders: true,
    legacyHeaders: false,
});

router.get("/profile", getProfile);
router.patch("/profile", updateProfile);

// Changing the login address is a two-step, code-verified flow.
router.post("/profile/email", emailChangeLimiter, requestEmailChange);
router.post("/profile/email/verify", emailChangeLimiter, verifyEmailChange);

router.get("/addresses", listAddresses);
router.post("/addresses", addAddress);
router.patch("/addresses/:addressId", updateAddress);
router.delete("/addresses/:addressId", deleteAddress);
router.patch("/addresses/:addressId/default", setDefaultAddress);

// Admin
router.get("/admin/customers", requireRole("admin"), listCustomers);
router.get("/", requireRole("admin"), listUsers);
router.patch("/:id/status", requireRole("admin"), setUserStatus);

export default router;
