/**
 * Test doubles for the OTP service's collaborators. The service takes all of
 * these by injection, which is what lets the logic be tested with no MongoDB,
 * no Resend account and no real timers.
 */

/** Mirrors createMongoOtpStore's interface, backed by an array. */
export const createMemoryOtpStore = () => {
    const rows = [];
    let nextId = 1;

    const newestFirst = (a, b) => b.createdAt - a.createdAt;

    return {
        rows,

        create: async (record) => {
            const row = { ...record, _id: String(nextId++) };
            rows.push(row);
            return row;
        },

        usage: async (email, since) => {
            const matching = rows
                .filter((row) => row.email === email && row.createdAt >= since)
                .sort(newestFirst);
            return { count: matching.length, lastRequestAt: matching[0]?.createdAt ?? null };
        },

        findLatestActive: async (email, now) =>
            rows
                .filter((row) => row.email === email && !row.consumedAt && row.expiresAt > now)
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

        invalidateActive: async (email, at) => {
            rows
                .filter((row) => row.email === email && !row.consumedAt)
                .forEach((row) => {
                    row.consumedAt = at;
                });
        },
    };
};

/** Stands in for EmailService — records calls instead of sending anything. */
export const createMailerMock = ({ failWith = null } = {}) => {
    const sent = [];
    return {
        sent,
        sendOtpEmail: async (args) => {
            if (failWith) throw failWith;
            sent.push(args);
            return { id: `mock-${sent.length}` };
        },
    };
};

export const createUsersMock = (seed = []) => {
    const users = seed.map((user) => ({ ...user }));
    return {
        users,
        findByEmail: async (email) => users.find((user) => user.email === email) ?? null,
        markVerified: async (email, at) => {
            const user = users.find((u) => u.email === email);
            if (!user) return null;
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
