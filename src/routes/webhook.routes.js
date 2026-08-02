import express from "express";
import { handleRazorpayWebhook } from "../controllers/webhookController.js";

const router = express.Router();

// No requireAuth — Razorpay calls this directly. verifyWebhookSignature in
// the controller is what authenticates the request.
router.post("/razorpay", handleRazorpayWebhook);

export default router;
