import twilio from "twilio";

/**
 * OTP delivery via Twilio Verify — Twilio owns generation, delivery and expiry,
 * so no OTP ever touches our database.
 *
 * When Twilio env vars are absent, the service falls back to DEV MODE: the OTP
 * is a fixed code printed to the server console. This keeps the phone+OTP login
 * path testable locally without spending SMS credits. Dev mode refuses to
 * activate when NODE_ENV=production.
 */

const DEV_OTP = process.env.DEV_OTP_CODE || "123456";

const hasTwilioConfig = () =>
    Boolean(
        process.env.TWILIO_ACCOUNT_SID &&
            process.env.TWILIO_AUTH_TOKEN &&
            process.env.TWILIO_VERIFY_SERVICE_SID,
    );

export const isDevOtpMode = () =>
    !hasTwilioConfig() && process.env.NODE_ENV !== "production";

let cachedService = null;

const verifyService = () => {
    if (cachedService) return cachedService;
    if (!hasTwilioConfig()) {
        throw new Error(
            "Twilio is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_VERIFY_SERVICE_SID.",
        );
    }
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    cachedService = client.verify.v2.services(process.env.TWILIO_VERIFY_SERVICE_SID);
    return cachedService;
};

/** Sends an OTP to a phone in E.164 format (e.g. +919876543210). */
export const sendOtpSms = async (phone) => {
    if (isDevOtpMode()) {
        console.log(`[DEV OTP] Code for ${phone} is ${DEV_OTP}`);
        return { status: "pending", dev: true };
    }
    return verifyService().verifications.create({ to: phone, channel: "sms" });
};

/** Returns true only when Twilio approves the code. */
export const checkOtp = async (phone, otp) => {
    if (isDevOtpMode()) {
        return String(otp) === DEV_OTP;
    }
    try {
        const result = await verifyService().verificationChecks.create({
            to: phone,
            code: String(otp),
        });
        return result.status === "approved";
    } catch {
        // Twilio 404s when there's no pending verification for this number,
        // and 400s on a malformed code — both mean "not approved".
        return false;
    }
};
