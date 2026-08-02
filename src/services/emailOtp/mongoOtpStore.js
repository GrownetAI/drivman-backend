import { EmailOtp } from "../../models/emailOtp.model.js";

/**
 * MongoDB implementation of the OTP store.
 *
 * The service talks only to this shape, so moving OTPs to Redis later (if the
 * project ever gains a cache layer) means writing a sibling of this file with
 * the same six methods — SETEX for create, INCR for recordAttempt — and
 * changing nothing else.
 */
export const createMongoOtpStore = () => ({
    create: (record) => EmailOtp.create(record),

    /**
     * Request volume for the rolling window, plus when the last request was.
     * One query answers both the hourly cap and the 60-second cooldown.
     */
    usage: async (email, since) => {
        const rows = await EmailOtp.find({ email, createdAt: { $gte: since } })
            .select("createdAt")
            .sort({ createdAt: -1 })
            .lean();

        return { count: rows.length, lastRequestAt: rows[0]?.createdAt ?? null };
    },

    /**
     * The newest code that is still live. Expiry is filtered here rather than
     * relying on the TTL sweep, which lags by up to a minute.
     */
    findLatestActive: (email, now) =>
        EmailOtp.findOne({ email, consumedAt: null, expiresAt: { $gt: now } })
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
    invalidateActive: (email, at) =>
        EmailOtp.updateMany({ email, consumedAt: null }, { $set: { consumedAt: at } }),
});
