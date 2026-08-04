import { getEmailConfig } from "../config/email.config.js";
import { logger as rootLogger } from "../utils/logger.js";
import { resendProvider } from "./email/resend.provider.js";
import { smtpProvider } from "./email/smtp.provider.js";
// TEMPORARY — remove once real email provider is configured.
import { consoleProvider } from "./email/console.provider.js";
import { EmailDeliveryError } from "./email/deliveryError.js";
import {
    otpEmail,
    verificationEmail,
    passwordResetEmail,
    orderConfirmationEmail,
} from "./email/templates.js";

/**
 * The application's email interface. Callers ask for a *kind of message*
 * ("send the OTP") and never touch a provider SDK, a template or a retry
 * policy — so swapping Resend for something else is a one-line change to
 * EMAIL_PROVIDER, with no edit to any controller.
 *
 * Adding a message type later (shipping updates, refunds) means adding one
 * template plus one method here; the interface shape does not change.
 */
// "console" entry is TEMPORARY — remove once real email provider is configured.
const PROVIDERS = { resend: resendProvider, smtp: smtpProvider, console: consoleProvider };

const MAX_RETRIES = 2; // 3 attempts total
const BASE_BACKOFF_MS = 300; // 300ms, then 600ms

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Everything is injectable so tests can drive the retry logic with a fake
 * provider and no timers. Production uses the defaults.
 */
export const createEmailService = ({
    provider,
    logger = rootLogger,
    wait = sleep,
    maxRetries = MAX_RETRIES,
    config = getEmailConfig,
} = {}) => {
    const resolveProvider = () => {
        if (provider) return provider;

        const name = config().provider;
        const selected = PROVIDERS[name];
        if (!selected) {
            throw new EmailDeliveryError(
                `Unknown email provider "${name}". Set EMAIL_PROVIDER to one of: ${Object.keys(PROVIDERS).join(", ")}.`,
                { retryable: false },
            );
        }
        return selected;
    };

    /**
     * The single choke point for delivery. Every template goes through here,
     * so retry policy and log shape can't drift between message types.
     */
    const deliver = async ({ to, subject, html, text, kind, requestId }) => {
        const active = resolveProvider();
        const { from, replyTo } = config();
        const log = logger.child({
            kind,
            provider: active.name,
            to,
            ...(requestId ? { requestId } : {}),
        });

        for (let attempt = 0; ; attempt += 1) {
            try {
                const result = await active.send({ from, to, subject, html, text, replyTo });
                log.info("Email sent", {
                    messageId: result?.id ?? null,
                    attempts: attempt + 1,
                });
                return result;
            } catch (error) {
                const retryable = error instanceof EmailDeliveryError && error.retryable;
                const details = {
                    reason: error.message,
                    statusCode: error.statusCode ?? null,
                    attempts: attempt + 1,
                };

                if (!retryable || attempt >= maxRetries) {
                    log.error("Email delivery failed", { ...details, retryable });
                    throw error;
                }

                const backoffMs = BASE_BACKOFF_MS * 2 ** attempt;
                log.warn("Email delivery failed, retrying", { ...details, backoffMs });
                await wait(backoffMs);
            }
        }
    };

    return {
        /** Which adapter is live — useful in a health check. */
        get providerName() {
            return resolveProvider().name;
        },

        /**
         * The signup verification code. `code` is passed to the template and
         * never reaches a log line.
         */
        sendOtpEmail: ({ to, code, ttlMinutes, fullName, requestId }) =>
            deliver({
                to,
                ...otpEmail({ fullName, code, ttlMinutes }),
                kind: "email_otp",
                requestId,
            }),

        sendVerificationEmail: ({ to, fullName, token, ttlMinutes, requestId }) =>
            deliver({
                to,
                ...verificationEmail({
                    fullName,
                    token,
                    ttlMinutes,
                    baseUrl: config().clientUrl,
                }),
                kind: "email_verification_link",
                requestId,
            }),

        sendPasswordResetEmail: ({ to, fullName, token, ttlMinutes, requestId }) =>
            deliver({
                to,
                ...passwordResetEmail({
                    fullName,
                    token,
                    ttlMinutes,
                    baseUrl: config().clientUrl,
                }),
                kind: "password_reset",
                requestId,
            }),

        sendOrderConfirmationEmail: ({ to, fullName, order, requestId }) =>
            deliver({
                to,
                ...orderConfirmationEmail({ fullName, order }),
                kind: "order_confirmation",
                requestId,
            }),

        /** Escape hatch for one-off messages that don't warrant a template. */
        sendEmail: ({ to, subject, html, text, requestId }) =>
            deliver({ to, subject, html, text, kind: "custom", requestId }),
    };
};

/** The instance the app uses. Providers are resolved on first send, not on import. */
export const emailService = createEmailService();

// Function exports kept so existing callers (authController, orderController)
// import exactly what they always did.
export const sendOtpEmail = (args) => emailService.sendOtpEmail(args);
export const sendVerificationEmail = (args) => emailService.sendVerificationEmail(args);
export const sendPasswordResetEmail = (args) => emailService.sendPasswordResetEmail(args);
export const sendOrderConfirmationEmail = (args) => emailService.sendOrderConfirmationEmail(args);
export const sendEmail = (args) => emailService.sendEmail(args);

export { EmailDeliveryError };
