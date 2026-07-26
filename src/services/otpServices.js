import twilio from "twilio";
import dotenv from "dotenv";

dotenv.config();

const twilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
);

const verifyService = twilioClient.verify.v2.services(
    process.env.TWILIO_VERIFY_SERVICE_SID
);

// Twilio Verify manages OTP generation, delivery, and expiry itself —
// default expiry is 10 min, configurable in the Twilio console under
// your Verify Service settings (not per-request via this API).
// We still keep our own short-lived JWT (2 min) wrapping the signup
// flow, so the effective "must verify within X minutes" behavior for
// our app stays enforced regardless of Twilio's own window.
export const OTP_EXPIRY_MINUTES = 2;

/**
 * Triggers Twilio Verify to generate + send an OTP via SMS.
 * Expects phone in E.164 format, e.g. +919876543210
 */
export const sendOtpSms = async (phone) => {
    return verifyService.verifications.create({
        to: phone,
        channel: "sms"
    });
};

/**
 * Asks Twilio to check the OTP the user entered.
 * Returns true if approved, false otherwise.
 */
export const checkOtp = async (phone, otp) => {
    try {
        const result = await verifyService.verificationChecks.create({
            to: phone,
            code: otp
        });
        return result.status === "approved";
    } catch (error) {
        // Twilio throws (e.g. 404) if there's no pending verification
        // for this phone, or the code format is invalid — treat as "not approved"
        return false;
    }
};