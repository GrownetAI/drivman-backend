import { EmailOtp } from "../../models/emailOtp.model.js";

/**
 * MongoDB implementation of the OTP store.
 *
 * Every query is scoped by `purpose`, so a signup code and a pending
 * email-change code for the same address never see each other.
 *
 * The service talks only to this shape, so moving OTPs to Redis later (if the
 * project ever gains a cache layer) means writing a sibling of this file with
 * the same methods — SETEX for create, INCR for recordAttempt — and changing
 * nothing else.
 */
const DEFAULT_PURPOSE = "email_verification";

export const createMongoOtpStore = () => ({
    create: (record) => EmailOtp.create(record),

    /**
     * Request volume for the rolling window, plus when the last request was.
     * One query answers both the hourly cap and the 60-second cooldown.
     */
    usage: async (email, since, purpose = DEFAULT_PURPOSE) => {
        const rows = await EmailOtp.find({ email, purpose, createdAt: { $gte: since } })
            .select("createdAt")
            .sort({ createdAt: -1 })
            .lean();

        return { count: rows.length, lastRequestAt: rows[0]?.createdAt ?? null };
    },

    /**
     * The newest code that is still live. Expiry is filtered here rather than
     * relying on the TTL sweep, which lags by up to a minute.
     */
    findLatestActive: (email, now, purpose = DEFAULT_PURPOSE) =>
        EmailOtp.findOne({ email, purpose, consumedAt: null, expiresAt: { $gt: now } })
            .select("+codeHash")
            .sort({ createdAt: -1 }),

    /**
     * The newest live code belonging to one account. Used by the email-change
     * flow, where the row is keyed on the address being moved TO — which the
     * verifying request shouldn't have to repeat back to us.
     */
    findLatestActiveForUser: (userId, now, purpose) =>
        EmailOtp.findOne({ userId, purpose, consumedAt: null, expiresAt: { $gt: now } })
            .select("+codeHash")
            .sort({ createdAt: -1 }),

    recordAttempt: async (id) => {
        const updated = await EmailOtp.findByIdAndUpdate(
            id,
            { $inc: { attempts: 1 } },
            { new: true },
        );
        return { attempts: updated?.attempts ?? 0 };
    },

    consume: (id, at) => EmailOtp.updateOne({ _id: id }, { $set: { consumedAt: at } }),

    /** Issuing a new code retires every outstanding one for that address. */
    invalidateActive: (email, at, purpose = DEFAULT_PURPOSE) =>
        EmailOtp.updateMany({ email, purpose, consumedAt: null }, { $set: { consumedAt: at } }),

    /** Same, but for one account's pending email change. */
    invalidateActiveForUser: (userId, at, purpose) =>
        EmailOtp.updateMany({ userId, purpose, consumedAt: null }, { $set: { consumedAt: at } }),
});
