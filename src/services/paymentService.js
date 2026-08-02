import Razorpay from "razorpay";
import crypto from "crypto";

/**
 * Razorpay works in paise (1 INR = 100 paise), so every amount crossing this
 * boundary is converted here rather than in controllers — the single place a
 * factor-of-100 bug could hide.
 */
let cachedClient = null;

const hasRazorpayConfig = () =>
    Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);

export const isRazorpayConfigured = hasRazorpayConfig;

const client = () => {
    if (cachedClient) return cachedClient;
    if (!hasRazorpayConfig()) {
        throw new Error("Razorpay is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.");
    }
    cachedClient = new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
    return cachedClient;
};

export const toPaise = (rupees) => Math.round(Number(rupees) * 100);

export const createRazorpayOrder = async ({ amount, receipt, notes }) =>
    client().orders.create({
        amount: toPaise(amount),
        currency: "INR",
        receipt,
        notes,
    });

/**
 * Verifies the HMAC Razorpay returns on payment success. Uses a timing-safe
 * comparison so the signature can't be recovered byte-by-byte via timing.
 */
export const verifyPaymentSignature = ({ orderId, paymentId, signature }) => {
    if (!orderId || !paymentId || !signature) return false;

    const expected = crypto
        .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
        .update(`${orderId}|${paymentId}`)
        .digest("hex");

    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(String(signature), "utf8");
    if (a.length !== b.length) return false;

    return crypto.timingSafeEqual(a, b);
};

export const fetchPayment = async (paymentId) => client().payments.fetch(paymentId);

/**
 * Verifies the X-Razorpay-Signature header on an incoming webhook: HMAC of
 * the exact raw request body (not the re-serialized JSON, which can differ
 * byte-for-byte) using RAZORPAY_WEBHOOK_SECRET.
 */
export const verifyWebhookSignature = ({ rawBody, signature }) => {
    if (!rawBody || !signature) return false;
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret) return false;

    const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");

    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(String(signature), "utf8");
    if (a.length !== b.length) return false;

    return crypto.timingSafeEqual(a, b);
};
