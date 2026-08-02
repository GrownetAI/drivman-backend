import { Resend } from "resend";
import { getEmailConfig } from "../../config/email.config.js";
import { EmailDeliveryError, isRetryableStatus } from "./deliveryError.js";

/**
 * Resend adapter. The only file in the codebase that imports the Resend SDK —
 * swapping providers means writing a sibling of this file, not touching a
 * controller.
 *
 * The client is built lazily and re-built if the key changes, matching how
 * paymentService.js and otpServices.js cache their clients.
 */
let cachedClient = null;
let cachedKey = null;

const client = () => {
    const { resendApiKey } = getEmailConfig();

    if (!resendApiKey) {
        // Not retryable: a missing key is a deploy problem, not a blip.
        throw new EmailDeliveryError("RESEND_API_KEY is not configured.", {
            retryable: false,
            provider: "resend",
        });
    }

    if (cachedClient && cachedKey === resendApiKey) return cachedClient;

    cachedClient = new Resend(resendApiKey);
    cachedKey = resendApiKey;
    return cachedClient;
};

export const resendProvider = {
    name: "resend",

    async send({ from, to, subject, html, text, replyTo }) {
        // Outside the try: a config error must not be misread as a transport blip.
        const resend = client();

        let response;
        try {
            response = await resend.emails.send({ from, to, subject, html, text, replyTo });
        } catch (cause) {
            // The SDK returns API errors in `error`; anything it *throws* is a
            // transport failure (DNS, socket, timeout) and always worth a retry.
            throw new EmailDeliveryError(`Resend request failed: ${cause.message}`, {
                retryable: true,
                provider: "resend",
                cause,
            });
        }

        const { data, error } = response ?? {};

        if (error) {
            throw new EmailDeliveryError(error.message || "Resend rejected the message.", {
                retryable: isRetryableStatus(error.statusCode),
                statusCode: error.statusCode ?? null,
                code: error.name,
                provider: "resend",
            });
        }

        return { id: data?.id ?? null };
    },
};
