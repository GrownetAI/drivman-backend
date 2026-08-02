import mongoose from "mongoose";

/**
 * One document per OTP *request* — including requests for addresses that have
 * no account. That is deliberate: if a row were only written for registered
 * addresses, the rate limiter itself would answer "does this email exist?"
 * (a second request inside 60s would 429 only for real accounts). Writing the
 * row either way keeps both cases indistinguishable.
 *
 * Two independent clocks:
 *   expiresAt — how long the code stays valid (10 minutes)
 *   purgeAt   — when the row is deleted (1 hour), which is also the window the
 *               hourly rate limit counts over
 *
 * The TTL index is the cleanup strategy — MongoDB's background monitor drops
 * expired rows, so there is no cron job to run and nothing to forget to deploy.
 * Because that monitor only sweeps every ~60s, reads also filter on expiresAt
 * rather than trusting the row's absence.
 */
const emailOtpSchema = new mongoose.Schema({
    email: {
        type: String,
        required: true,
        lowercase: true,
        trim: true,
        index: true,
    },

    // HMAC-SHA256 of the code — never the code itself. Null when the request
    // had no eligible account, in which case there is nothing to verify against.
    codeHash: { type: String, select: false, default: null },

    purpose: {
        type: String,
        enum: ["email_verification"],
        default: "email_verification",
    },

    // False when no eligible account existed: the row is bookkeeping for the
    // rate limiter only, and no email was sent.
    dispatched: { type: Boolean, default: false },

    attempts: { type: Number, default: 0 },
    consumedAt: { type: Date, default: null },

    expiresAt: { type: Date, required: true },
    purgeAt: { type: Date, required: true },

    requestIp: { type: String },
    createdAt: { type: Date, default: Date.now },
});

// Serves both the hourly count and the 60-second cooldown lookup.
emailOtpSchema.index({ email: 1, createdAt: -1 });

// expireAfterSeconds: 0 means "delete when purgeAt is reached".
emailOtpSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

export const EmailOtp = mongoose.model("EmailOtp", emailOtpSchema);
