import mongoose from "mongoose";

/**
 * One row per processed Razorpay webhook delivery. The unique index on
 * eventId is what makes replay-safe processing possible: a duplicate
 * delivery's insert fails with E11000 instead of racing the first insert.
 */
const webhookEventSchema = new mongoose.Schema(
    {
        eventId: { type: String, required: true, unique: true },
        event: { type: String, required: true },
    },
    { timestamps: true },
);

export const WebhookEvent = mongoose.model("WebhookEvent", webhookEventSchema);
