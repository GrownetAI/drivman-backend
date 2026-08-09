/**
 * Test doubles for the OTP service's collaborators. The service takes all of
 * these by injection, which is what lets the logic be tested with no MongoDB,
 * no Resend account and no real timers.
 */

const DEFAULT_PURPOSE = "email_verification";

/** Mirrors createMongoOtpStore's interface, backed by an array. */
export const createMemoryOtpStore = () => {
    const rows = [];
    let nextId = 1;

    const newestFirst = (a, b) => b.createdAt - a.createdAt;
    // Rows written before purpose existed default to verification, matching the
    // Mongoose schema default.
    const purposeOf = (row) => row.purpose ?? DEFAULT_PURPOSE;

    return {
        rows,

        create: async (record) => {
            const row = { ...record, _id: String(nextId++) };
            rows.push(row);
            return row;
        },

        usage: async (email, since, purpose = DEFAULT_PURPOSE) => {
            const matching = rows
                .filter(
                    (row) =>
                        row.email === email &&
                        purposeOf(row) === purpose &&
                        row.createdAt >= since,
                )
                .sort(newestFirst);
            return { count: matching.length, lastRequestAt: matching[0]?.createdAt ?? null };
        },

        findLatestActive: async (email, now, purpose = DEFAULT_PURPOSE) =>
            rows
                .filter(
                    (row) =>
                        row.email === email &&
                        purposeOf(row) === purpose &&
                        !row.consumedAt &&
                        row.expiresAt > now,
                )
                .sort(newestFirst)[0] ?? null,

        findLatestActiveForUser: async (userId, now, purpose) =>
            rows
                .filter(
                    (row) =>
                        String(row.userId) === String(userId) &&
                        purposeOf(row) === purpose &&
                        !row.consumedAt &&
                        row.expiresAt > now,
                )
                .sort(newestFirst)[0] ?? null,

        recordAttempt: async (id) => {
            const row = rows.find((r) => r._id === id);
            row.attempts += 1;
            return { attempts: row.attempts };
        },

        consume: async (id, at) => {
            const row = rows.find((r) => r._id === id);
            if (row) row.consumedAt = at;
        },

        invalidateActive: async (email, at, purpose = DEFAULT_PURPOSE) => {
            rows
                .filter(
                    (row) =>
                        row.email === email && purposeOf(row) === purpose && !row.consumedAt,
                )
                .forEach((row) => {
                    row.consumedAt = at;
                });
        },

        invalidateActiveForUser: async (userId, at, purpose) => {
            rows
                .filter(
                    (row) =>
                        String(row.userId) === String(userId) &&
                        purposeOf(row) === purpose &&
                        !row.consumedAt,
                )
                .forEach((row) => {
                    row.consumedAt = at;
                });
        },
    };
};

/** Stands in for EmailService — records calls instead of sending anything. */
export const createMailerMock = ({ failWith = null } = {}) => {
    const sent = [];
    const record = (kind) => async (args) => {
        if (failWith) throw failWith;
        sent.push({ kind, ...args });
        return { id: `mock-${sent.length}` };
    };
    return {
        sent,
        sendOtpEmail: record("email_otp"),
        sendEmailChangeOtp: record("email_change_otp"),
    };
};

export const createUsersMock = (seed = []) => {
    const users = seed.map((user, i) => ({ _id: user._id ?? `u${i + 1}`, ...user }));
    const byId = (id) => users.find((u) => String(u._id) === String(id));

    return {
        users,
        findByEmail: async (email) => users.find((user) => user.email === email) ?? null,
        findById: async (id) => byId(id) ?? null,
        emailTaken: async (email, exceptUserId) =>
            users.some(
                (u) => u.email === email && String(u._id) !== String(exceptUserId ?? ""),
            ),
        markVerified: async (email, at) => {
            const user = users.find((u) => u.email === email);
            if (!user) return null;
            user.isEmailVerified = true;
            user.emailVerifiedAt = at;
            return user;
        },
        applyEmailChange: async (id, email, at) => {
            const user = byId(id);
            if (!user) return null;
            user.email = email;
            user.isEmailVerified = true;
            user.emailVerifiedAt = at;
            return user;
        },
    };
};

/** A clock the test drives by hand, so expiry and cooldowns need no waiting. */
export const createClock = (start = Date.UTC(2026, 0, 1, 12, 0, 0)) => {
    let current = start;
    return {
        now: () => current,
        advance: (ms) => {
            current += ms;
        },
    };
};

export const silentLogger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child() {
        return silentLogger;
    },
};

/** Replaces the backoff sleep — records the delays instead of waiting them out. */
export const createWaitSpy = () => {
    const delays = [];
    const wait = async (ms) => {
        delays.push(ms);
    };
    wait.delays = delays;
    return wait;
};
