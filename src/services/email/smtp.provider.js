import nodemailer from "nodemailer";
import { getEmailConfig } from "../../config/email.config.js";
import { EmailDeliveryError, isRetryableStatus } from "./deliveryError.js";

/**
 * SMTP adapter (nodemailer), kept from the original implementation. It is not
 * the default any more, but it stays for two reasons: it costs nothing —
 * nodemailer was already a dependency — and it is the proof that the provider
 * seam actually works. Set EMAIL_PROVIDER=smtp to fall back to it.
 */
let cachedTransport = null;
let cachedSignature = null;

const transport = () => {
    const { smtp } = getEmailConfig();

    if (!smtp.host || !smtp.user || !smtp.pass) {
        throw new EmailDeliveryError(
            "SMTP is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER and SMTP_PASS.",
            { retryable: false, provider: "smtp" },
        );
    }

    const signature = `${smtp.host}:${smtp.port}:${smtp.user}`;
    if (cachedTransport && cachedSignature === signature) return cachedTransport;

    cachedTransport = nodemailer.createTransport({
        host: smtp.host,
        port: smtp.port,
        secure: smtp.port === 465, // 465 = implicit TLS; 587 upgrades via STARTTLS
        auth: { user: smtp.user, pass: smtp.pass },
    });
    cachedSignature = signature;
    return cachedTransport;
};

export const smtpProvider = {
    name: "smtp",

    async send({ from, to, subject, html, text, replyTo }) {
        const mailer = transport();

        try {
            const info = await mailer.sendMail({ from, to, subject, html, text, replyTo });
            return { id: info?.messageId ?? null };
        } catch (cause) {
            // nodemailer surfaces the SMTP reply code on `responseCode`; a
            // 4xx there is a permanent rejection, 5xx/absent is worth a retry.
            throw new EmailDeliveryError(`SMTP send failed: ${cause.message}`, {
                retryable: isRetryableStatus(cause.responseCode ?? null),
                statusCode: cause.responseCode ?? null,
                code: cause.code,
                provider: "smtp",
                cause,
            });
        }
    },
};
