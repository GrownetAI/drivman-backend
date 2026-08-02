/**
 * Minimal structured logger. JSON lines in production so a log collector can
 * parse them, human-readable everywhere else. Deliberately dependency-free —
 * the project had nothing but bare console calls, and a logging library is not
 * worth a new package just for this.
 *
 * NEVER pass a secret as metadata: OTP codes, raw tokens, passwords, API keys.
 * Log the email address and a request id instead — enough to trace a delivery,
 * useless to anyone who reads the logs.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

const threshold = () => {
    const configured = LEVELS[(process.env.LOG_LEVEL || "").toLowerCase()];
    if (configured !== undefined) return configured;
    return process.env.NODE_ENV === "production" ? LEVELS.info : LEVELS.debug;
};

// debug/info both go to stdout; warn and error to stderr.
const STREAM = { debug: "log", info: "log", warn: "warn", error: "error" };

const emit = (level, bindings, message, meta) => {
    if (LEVELS[level] < threshold()) return;

    const write = console[STREAM[level]];
    const fields = { ...bindings, ...meta };

    if (process.env.NODE_ENV === "production") {
        write(JSON.stringify({ level, message, ...fields, time: new Date().toISOString() }));
        return;
    }

    const detail = Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : "";
    write(`[${level.toUpperCase()}] ${message}${detail}`);
};

const build = (bindings) => ({
    debug: (message, meta) => emit("debug", bindings, message, meta),
    info: (message, meta) => emit("info", bindings, message, meta),
    warn: (message, meta) => emit("warn", bindings, message, meta),
    error: (message, meta) => emit("error", bindings, message, meta),
    /** Returns a logger that stamps every record with these fields — e.g. a request id. */
    child: (extra) => build({ ...bindings, ...extra }),
});

export const logger = build({});
