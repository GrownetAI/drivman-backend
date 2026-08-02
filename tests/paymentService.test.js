import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.RAZORPAY_KEY_ID = "rzp_test_dummy";
process.env.RAZORPAY_KEY_SECRET = "test-key-secret";
process.env.RAZORPAY_WEBHOOK_SECRET = "test-webhook-secret";

const { verifyPaymentSignature, verifyWebhookSignature } = await import(
    "../src/services/paymentService.js"
);

// --- Checkout callback signature (order_id|payment_id, keyed by KEY_SECRET) --

test("verifyPaymentSignature accepts a correctly signed order/payment pair", () => {
    const orderId = "order_ABC123";
    const paymentId = "pay_XYZ789";
    const signature = crypto
        .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
        .update(`${orderId}|${paymentId}`)
        .digest("hex");

    assert.equal(verifyPaymentSignature({ orderId, paymentId, signature }), true);
});

test("verifyPaymentSignature rejects a tampered signature", () => {
    const orderId = "order_ABC123";
    const paymentId = "pay_XYZ789";
    const signature = crypto
        .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
        .update(`${orderId}|${paymentId}`)
        .digest("hex");

    // Flip the last character.
    const tampered = signature.slice(0, -1) + (signature.at(-1) === "0" ? "1" : "0");
    assert.equal(verifyPaymentSignature({ orderId, paymentId, signature: tampered }), false);
});

test("verifyPaymentSignature rejects a signature for a different payment id", () => {
    const orderId = "order_ABC123";
    const signature = crypto
        .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
        .update(`${orderId}|pay_original`)
        .digest("hex");

    assert.equal(
        verifyPaymentSignature({ orderId, paymentId: "pay_swapped", signature }),
        false,
    );
});

test("verifyPaymentSignature rejects missing fields instead of throwing", () => {
    assert.equal(
        verifyPaymentSignature({ orderId: "order_ABC123", paymentId: "pay_XYZ789" }),
        false,
    );
});

// --- Webhook signature (raw body, keyed by WEBHOOK_SECRET) -------------------

test("verifyWebhookSignature accepts a signature computed over the exact raw body", () => {
    const rawBody = Buffer.from(JSON.stringify({ event: "payment.captured" }));
    const signature = crypto
        .createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET)
        .update(rawBody)
        .digest("hex");

    assert.equal(verifyWebhookSignature({ rawBody, signature }), true);
});

test("verifyWebhookSignature rejects a body that doesn't match the signed bytes", () => {
    const signedBody = Buffer.from(JSON.stringify({ event: "payment.captured" }));
    const signature = crypto
        .createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET)
        .update(signedBody)
        .digest("hex");

    const differentBody = Buffer.from(JSON.stringify({ event: "payment.failed" }));
    assert.equal(verifyWebhookSignature({ rawBody: differentBody, signature }), false);
});

test("verifyWebhookSignature rejects when the webhook secret is not configured", () => {
    const rawBody = Buffer.from(JSON.stringify({ event: "payment.captured" }));
    const signature = crypto.createHmac("sha256", "some-secret").update(rawBody).digest("hex");

    const original = process.env.RAZORPAY_WEBHOOK_SECRET;
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
    try {
        assert.equal(verifyWebhookSignature({ rawBody, signature }), false);
    } finally {
        process.env.RAZORPAY_WEBHOOK_SECRET = original;
    }
});
