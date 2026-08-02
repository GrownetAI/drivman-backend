import { Order } from "../models/order.model.js";
import { WebhookEvent } from "../models/webhookEvent.model.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { verifyWebhookSignature } from "../services/paymentService.js";
import {
    createWebhookIdempotencyGuard,
    mongoWebhookEventStore,
} from "../services/webhookIdempotency.js";

const idempotencyGuard = createWebhookIdempotencyGuard(mongoWebhookEventStore(WebhookEvent));

/**
 * Applies a verified payment outcome to the order it belongs to. This is the
 * source of truth for paymentStatus — POST /:id/verify-payment only gives the
 * frontend a fast provisional read; this handler is what actually settles it,
 * and it runs whether or not the frontend ever called verify-payment at all.
 */
const applyPaymentOutcome = async ({ razorpayOrderId, paymentId, outcome, note }) => {
    if (!razorpayOrderId) return;

    const order = await Order.findOne({ "razorpay.orderId": razorpayOrderId });
    if (!order) return; // Unknown order — nothing to reconcile, ack and move on.
    if (order.paymentStatus === outcome) return; // Already settled by a prior event.

    order.paymentStatus = outcome;
    if (paymentId) order.razorpay.paymentId = paymentId;
    if (outcome === "paid" && order.status === "pending") order.status = "confirmed";

    order.statusHistory.push({ status: order.status, note });
    await order.save();
};

const EVENT_HANDLERS = {
    "payment.captured": async (payload) => {
        const payment = payload.payment?.entity;
        await applyPaymentOutcome({
            razorpayOrderId: payment?.order_id,
            paymentId: payment?.id,
            outcome: "paid",
            note: "Payment captured (webhook).",
        });
    },
    "payment.failed": async (payload) => {
        const payment = payload.payment?.entity;
        await applyPaymentOutcome({
            razorpayOrderId: payment?.order_id,
            paymentId: payment?.id,
            outcome: "failed",
            note: "Payment failed (webhook).",
        });
    },
    "order.paid": async (payload) => {
        const payment = payload.payment?.entity;
        const order = payload.order?.entity;
        await applyPaymentOutcome({
            razorpayOrderId: order?.id ?? payment?.order_id,
            paymentId: payment?.id,
            outcome: "paid",
            note: "Order marked paid (webhook).",
        });
    },
};

/**
 * @route POST /api/webhooks/razorpay
 * Public endpoint — authenticated by the Razorpay signature, not a user
 * session. req.rawBody is the exact byte buffer captured by express.json's
 * `verify` hook in app.js; the signature is computed over those bytes, not
 * the re-parsed req.body.
 */
export const handleRazorpayWebhook = asyncHandler(async (req, res) => {
    const signature = req.headers["x-razorpay-signature"];

    if (!verifyWebhookSignature({ rawBody: req.rawBody, signature })) {
        return res.status(400).json({ success: false, message: "Invalid webhook signature." });
    }

    const body = req.body;
    // Razorpay resends the same event-id header on retries of one delivery;
    // that's the correct dedupe key (payload ids can repeat across event types).
    const eventId = req.headers["x-razorpay-event-id"] || `${body.event}:${body.created_at}`;

    const isFirstDelivery = await idempotencyGuard.claim(eventId, body.event);
    if (!isFirstDelivery) {
        return res.status(200).json({ success: true, message: "Already processed." });
    }

    const handler = EVENT_HANDLERS[body.event];
    if (handler) await handler(body.payload || {});

    return res.status(200).json({ success: true, message: "Webhook processed." });
});
