/**
 * Email configuration, read from the environment on every call rather than
 * captured at import time — the same reason server.js dynamic-imports app.js:
 * a module that snapshots process.env at load order becomes a trap.
 *
 * Nothing here is hardcoded. The sender address in particular differs per
 * environment (dev/staging/prod use different verified domains).
 */
const read = (key) => {
    const value = process.env[key];
    return typeof value === "string" ? value.trim() : "";
};

// "console" is TEMPORARY — remove once real email provider is configured.
// It's a dev-only stand-in that logs emails instead of sending them, so boot
// doesn't crash for lack of RESEND_API_KEY/SMTP credentials.
export const SUPPORTED_PROVIDERS = ["resend", "smtp", "console"];

export const getEmailConfig = () => ({
    provider: (read("EMAIL_PROVIDER") || "resend").toLowerCase(),
    resendApiKey: read("RESEND_API_KEY"),
    from: read("MAIL_FROM"),
    replyTo: read("MAIL_REPLY_TO") || undefined,
    // Used to build links inside emails. CLIENT_URL may be a comma-separated
    // CORS allowlist, so only the first origin is a usable link base.
    clientUrl: (read("CLIENT_URL") || "http://localhost:3000").split(",")[0].trim(),
    smtp: {
        host: read("SMTP_HOST"),
        port: Number(read("SMTP_PORT")) || 587,
        user: read("SMTP_USER"),
        pass: read("SMTP_PASS"),
    },
});

/**
 * Fails fast at startup. A missing API key must not surface as a runtime 500
 * on the first signup of the day — it should stop the process at boot, where
 * a deploy will catch it.
 */
export const assertEmailConfig = () => {
    const config = getEmailConfig();
    const problems = [];

    if (!SUPPORTED_PROVIDERS.includes(config.provider)) {
        problems.push(
            `EMAIL_PROVIDER must be one of: ${SUPPORTED_PROVIDERS.join(", ")} (got "${config.provider}").`,
        );
    }

    if (config.provider === "resend" && !config.resendApiKey) {
        problems.push("RESEND_API_KEY is required when EMAIL_PROVIDER=resend.");
    }

    if (config.provider === "smtp" && (!config.smtp.host || !config.smtp.user || !config.smtp.pass)) {
        problems.push("SMTP_HOST, SMTP_USER and SMTP_PASS are required when EMAIL_PROVIDER=smtp.");
    }

    if (!config.from) {
        problems.push('MAIL_FROM is required, e.g. MAIL_FROM="DRIVMAN <no-reply@yourdomain.com>".');
    }

    if (problems.length) {
        throw new Error(`Email configuration is invalid:\n  - ${problems.join("\n  - ")}`);
    }

    return config;
};
