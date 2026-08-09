import crypto from "crypto";
import { User } from "../models/user.model.js";
import { emailService } from "./emailService.js";
import { createMongoOtpStore } from "./emailOtp/mongoOtpStore.js";
import { logger as rootLogger } from "../utils/logger.js";
import { badRequest, tooMany } from "../utils/ApiError.js";

export const OTP_LENGTH = 6;
export const OTP_TTL_MINUTES = 10;
export const RESEND_COOLDOWN_SECONDS = 60;
export const MAX_REQUESTS_PER_HOUR = 5;
export const MAX_VERIFY_ATTEMPTS = 5;

// Rows outlive the code so the hourly counter has something to count.
const RETENTION_MINUTES = 60;

export const PURPOSE_VERIFICATION = "email_verification";
export const PURPOSE_EMAIL_CHANGE = "email_change";

const COOLDOWN_MS = RESEND_COOLDOWN_SECONDS * 1000;
const HOUR_MS = 60 * 60 * 1000;

/**
 * Both endpoints are padded to this duration. Without it, "we looked up an
 * account and sent an email" takes visibly longer than "we did nothing",
 * which enumerates accounts by stopwatch.
 */
const MIN_RESPONSE_MS = 700;

/**
 * Every verification failure returns this exact string — wrong code, expired
 * code, no code ever requested, unknown address. Distinguishing them would
 * tell an attacker which addresses are registered.
 */
const GENERIC_VERIFY_FAILURE = "That code is invalid or has expired. Please request a new one.";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const normalizeEmail = (email) => String(email || "").toLowerCase().trim();

/** Uniform over the whole 6-digit range — randomInt rejects modulo bias for us. */
export const generateOtpCode = () =>
    String(crypto.randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, "0");

/**
 * Keyed HMAC rather than a bare hash. A 6-digit code has only a million
 * possibilities, so a plain SHA-256 column is trivially reversed from a
 * database dump — but an HMAC is useless without the server secret, which
 * lives in the environment and not in the database. Binding the address into
 * the input stops a hash being replayed against a different account.
 */
export const hashOtpCode = (code, email) => {
    const secret = process.env.OTP_HASH_SECRET || process.env.JWT_SECRET;
    if (!secret) {
        throw new Error("OTP hashing requires OTP_HASH_SECRET or JWT_SECRET to be set.");
    }
    return crypto
        .createHmac("sha256", secret)
        .update(`${normalizeEmail(email)}:${String(code).trim()}`)
        .digest("hex");
};

const timingSafeEqual = (a, b) => {
    const bufA = Buffer.from(String(a), "utf8");
    const bufB = Buffer.from(String(b), "utf8");
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
};

const defaultUsers = {
    findByEmail: (email) => User.findOne({ email }),
    findById: (id) => User.findById(id),
    emailTaken: (email, exceptUserId) =>
        User.exists({ email, ...(exceptUserId ? { _id: { $ne: exceptUserId } } : {}) }),
    markVerified: (email, at) =>
        User.findOneAndUpdate(
            { email },
            { $set: { isEmailVerified: true, emailVerifiedAt: at } },
            { new: true },
        ),
    /**
     * The address is the account's login identity, so it only moves once the
     * new inbox has proven itself — and it lands already verified, because
     * entering the code IS the proof.
     */
    applyEmailChange: (id, email, at) =>
        User.findByIdAndUpdate(
            id,
            { $set: { email, isEmailVerified: true, emailVerifiedAt: at } },
            { new: true },
        ),
};

/**
 * Everything is injectable so the logic can be tested against an in-memory
 * store and a mocked mailer — no MongoDB, no Resend, no real timers.
 */
export const createEmailOtpService = ({
    store = createMongoOtpStore(),
    emails = emailService,
    users = defaultUsers,
    logger = rootLogger,
    now = () => Date.now(),
    wait = sleep,
} = {}) => {
    const padTiming = async (startedAt) => {
        const elapsed = now() - startedAt;
        if (elapsed < MIN_RESPONSE_MS) await wait(MIN_RESPONSE_MS - elapsed);
    };

    /**
     * Issues a code and emails it. Returns the same shape whether or not the
     * address belongs to an account — the caller has nothing to leak.
     */
    const requestOtp = async ({ email, ip, requestId } = {}) => {
        const startedAt = now();
        const address = normalizeEmail(email);
        const log = logger.child({ requestId, email: address, flow: "email_otp_request" });

        // --- Per-email rate limits ------------------------------------------
        // Checked before anything else, and against rows that exist for
        // unregistered addresses too, so the 429 is not an existence oracle.
        const { count, lastRequestAt } = await store.usage(
            address,
            new Date(now() - HOUR_MS),
            PURPOSE_VERIFICATION,
        );

        if (lastRequestAt) {
            const sinceLast = now() - new Date(lastRequestAt).getTime();
            if (sinceLast < COOLDOWN_MS) {
                const retryAfter = Math.ceil((COOLDOWN_MS - sinceLast) / 1000);
                throw tooMany(`Please wait ${retryAfter} second(s) before requesting another code.`);
            }
        }

        if (count >= MAX_REQUESTS_PER_HOUR) {
            log.warn("OTP hourly cap reached", { count });
            throw tooMany(
                `Too many verification codes requested. Please try again in an hour.`,
            );
        }

        const user = await users.findByEmail(address);
        // Nothing to send for an unknown address, and nothing to gain from
        // re-verifying one that is already confirmed.
        const eligible = Boolean(user) && !user.isEmailVerified;

        const code = generateOtpCode();
        const issuedAt = new Date(now());

        // A fresh code retires the previous one — two live codes would double
        // the guessing surface.
        await store.invalidateActive(address, issuedAt, PURPOSE_VERIFICATION);

        const record = await store.create({
            email: address,
            purpose: PURPOSE_VERIFICATION,
            codeHash: eligible ? hashOtpCode(code, address) : null,
            dispatched: eligible,
            attempts: 0,
            consumedAt: null,
            expiresAt: new Date(now() + OTP_TTL_MINUTES * 60 * 1000),
            purgeAt: new Date(now() + RETENTION_MINUTES * 60 * 1000),
            requestIp: ip,
            createdAt: issuedAt,
        });

        if (!eligible) {
            log.info("OTP request recorded without dispatch", {
                reason: user ? "already_verified" : "no_account",
            });
            await padTiming(startedAt);
            return { ttlMinutes: OTP_TTL_MINUTES, dispatched: false };
        }

        try {
            // The code goes to the mailer and nowhere else — never to a log line.
            await emails.sendOtpEmail({
                to: address,
                code,
                ttlMinutes: OTP_TTL_MINUTES,
                fullName: user.fullName,
                requestId,
            });
        } catch (error) {
            // The send failed, so this attempt shouldn't burn the user's hourly
            // budget or hold them in the 60-second cooldown for our outage.
            await store.consume(record._id ?? record.id, new Date(now()));
            log.error("OTP email failed after retries", { reason: error.message });
            throw error;
        }

        log.info("OTP dispatched", { expiresInMinutes: OTP_TTL_MINUTES });
        await padTiming(startedAt);

        return {
            ttlMinutes: OTP_TTL_MINUTES,
            dispatched: true,
            // Convenience for local work, matching how the existing auth flow
            // surfaces devVerificationToken / devResetToken.
            ...(process.env.NODE_ENV !== "production" ? { devOtpCode: code } : {}),
        };
    };

    /**
     * Checks a submitted code. On success the user is marked verified and the
     * document is returned so the caller can open a session.
     */
    const verifyOtp = async ({ email, code, requestId } = {}) => {
        const startedAt = now();
        const address = normalizeEmail(email);
        const log = logger.child({ requestId, email: address, flow: "email_otp_verify" });

        const reject = async (message = GENERIC_VERIFY_FAILURE, makeError = badRequest) => {
            await padTiming(startedAt);
            throw makeError(message);
        };

        const record = await store.findLatestActive(address, new Date(now()), PURPOSE_VERIFICATION);

        if (!record) {
            // Still hash, so "never requested" doesn't return faster than "wrong code".
            hashOtpCode(String(code ?? ""), address);
            log.warn("OTP verify with no live code");
            return reject();
        }

        // Lockout is evaluated for undispatched rows too, so an unregistered
        // address behaves exactly like a registered one under guessing.
        if (record.attempts >= MAX_VERIFY_ATTEMPTS) {
            await store.consume(record._id ?? record.id, new Date(now()));
            log.warn("OTP locked out", { attempts: record.attempts });
            return reject(
                "Too many incorrect attempts. Please request a new code.",
                tooMany,
            );
        }

        const candidate = hashOtpCode(String(code ?? ""), address);
        const matches = Boolean(record.codeHash) && timingSafeEqual(record.codeHash, candidate);

        if (!matches) {
            const { attempts } = await store.recordAttempt(record._id ?? record.id);

            if (attempts >= MAX_VERIFY_ATTEMPTS) {
                // Burn the code: further guessing needs a fresh request, which
                // the per-email limits then throttle.
                await store.consume(record._id ?? record.id, new Date(now()));
                log.warn("OTP locked out after final wrong attempt", { attempts });
                return reject(
                    "Too many incorrect attempts. Please request a new code.",
                    tooMany,
                );
            }

            log.warn("OTP mismatch", { attempts });
            return reject();
        }

        await store.consume(record._id ?? record.id, new Date(now()));

        const user = await users.markVerified(address, new Date(now()));
        if (!user) {
            // The account disappeared between request and verify.
            log.warn("OTP matched but account is gone");
            return reject();
        }

        log.info("Email verified via OTP");
        await padTiming(startedAt);

        return { user };
    };

    /**
     * Starts a change of login address. The code goes to the NEW address, and
     * nothing on the account moves until it comes back — so a typo costs the
     * user one wasted email rather than access to their own account.
     *
     * Unlike requestOtp this is authenticated, so it can afford to be specific:
     * "that address is taken" is not an enumeration leak here, because signup
     * already reveals the same fact to anyone who asks.
     */
    const requestEmailChange = async ({ userId, newEmail, ip, requestId } = {}) => {
        const address = normalizeEmail(newEmail);
        const log = logger.child({ requestId, userId: String(userId), flow: "email_change_request" });

        const user = await users.findById(userId);
        if (!user) throw badRequest("Account not found.");

        if (address === normalizeEmail(user.email)) {
            throw badRequest("That is already your email address.");
        }

        if (await users.emailTaken(address, userId)) {
            throw badRequest("That email address is already in use by another account.");
        }

        // Rate limits are keyed on the destination address, so one account
        // cannot be used to spray codes at somebody else's inbox.
        const { count, lastRequestAt } = await store.usage(
            address,
            new Date(now() - HOUR_MS),
            PURPOSE_EMAIL_CHANGE,
        );

        if (lastRequestAt) {
            const sinceLast = now() - new Date(lastRequestAt).getTime();
            if (sinceLast < COOLDOWN_MS) {
                const retryAfter = Math.ceil((COOLDOWN_MS - sinceLast) / 1000);
                throw tooMany(`Please wait ${retryAfter} second(s) before requesting another code.`);
            }
        }

        if (count >= MAX_REQUESTS_PER_HOUR) {
            log.warn("Email-change hourly cap reached", { count });
            throw tooMany("Too many change requests. Please try again in an hour.");
        }

        const code = generateOtpCode();
        const issuedAt = new Date(now());

        // Only one pending change per account at a time.
        await store.invalidateActiveForUser(userId, issuedAt, PURPOSE_EMAIL_CHANGE);

        const record = await store.create({
            email: address,
            purpose: PURPOSE_EMAIL_CHANGE,
            userId,
            codeHash: hashOtpCode(code, address),
            dispatched: true,
            attempts: 0,
            consumedAt: null,
            expiresAt: new Date(now() + OTP_TTL_MINUTES * 60 * 1000),
            purgeAt: new Date(now() + RETENTION_MINUTES * 60 * 1000),
            requestIp: ip,
            createdAt: issuedAt,
        });

        try {
            await emails.sendEmailChangeOtp({
                to: address,
                code,
                ttlMinutes: OTP_TTL_MINUTES,
                fullName: user.fullName,
                requestId,
            });
        } catch (error) {
            await store.consume(record._id ?? record.id, new Date(now()));
            log.error("Email-change code failed after retries", { reason: error.message });
            throw error;
        }

        log.info("Email-change code dispatched");

        return {
            ttlMinutes: OTP_TTL_MINUTES,
            pendingEmail: address,
            ...(process.env.NODE_ENV !== "production" ? { devOtpCode: code } : {}),
        };
    };

    /** Completes the change once the new inbox proves itself. */
    const verifyEmailChange = async ({ userId, code, requestId } = {}) => {
        const startedAt = now();
        const log = logger.child({ requestId, userId: String(userId), flow: "email_change_verify" });

        const reject = async (message = GENERIC_VERIFY_FAILURE, makeError = badRequest) => {
            await padTiming(startedAt);
            throw makeError(message);
        };

        const record = await store.findLatestActiveForUser(
            userId,
            new Date(now()),
            PURPOSE_EMAIL_CHANGE,
        );

        if (!record) {
            log.warn("Email-change verify with no pending request");
            return reject("No pending email change. Please request one first.");
        }

        if (record.attempts >= MAX_VERIFY_ATTEMPTS) {
            await store.consume(record._id ?? record.id, new Date(now()));
            return reject("Too many incorrect attempts. Please request a new code.", tooMany);
        }

        const candidate = hashOtpCode(String(code ?? ""), record.email);
        const matches = Boolean(record.codeHash) && timingSafeEqual(record.codeHash, candidate);

        if (!matches) {
            const { attempts } = await store.recordAttempt(record._id ?? record.id);
            if (attempts >= MAX_VERIFY_ATTEMPTS) {
                await store.consume(record._id ?? record.id, new Date(now()));
                log.warn("Email-change locked out", { attempts });
                return reject("Too many incorrect attempts. Please request a new code.", tooMany);
            }
            log.warn("Email-change code mismatch", { attempts });
            return reject();
        }

        // Re-checked at the last moment: someone else may have claimed the
        // address during the ten minutes the code was valid.
        if (await users.emailTaken(record.email, userId)) {
            await store.consume(record._id ?? record.id, new Date(now()));
            return reject("That email address is already in use by another account.");
        }

        await store.consume(record._id ?? record.id, new Date(now()));

        const user = await users.applyEmailChange(userId, record.email, new Date(now()));
        if (!user) return reject("Account not found.");

        log.info("Email address changed");
        await padTiming(startedAt);

        return { user };
    };

    return { requestOtp, verifyOtp, requestEmailChange, verifyEmailChange };
};

/** The instance the controllers use. */
export const emailOtpService = createEmailOtpService();
