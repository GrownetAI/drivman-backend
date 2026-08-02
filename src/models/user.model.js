import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import crypto from "crypto";

/**
 * Tokens (email verification, password reset, refresh) are NEVER stored in
 * plaintext. We store a SHA-256 hash and send the raw value to the user
 * exactly once. A database leak therefore yields nothing usable.
 */
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

const refreshTokenSchema = new mongoose.Schema(
    {
        tokenHash: { type: String, required: true },
        expiresAt: { type: Date, required: true },
        userAgent: { type: String },
        ip: { type: String },
        createdAt: { type: Date, default: Date.now },
    },
    { _id: false },
);

const addressSchema = new mongoose.Schema(
    {
        label: { type: String, trim: true, default: "Home" },
        fullName: { type: String, required: true, trim: true },
        phone: { type: String, required: true, trim: true },
        line1: { type: String, required: true, trim: true },
        line2: { type: String, trim: true },
        city: { type: String, required: true, trim: true },
        state: { type: String, required: true, trim: true },
        postalCode: { type: String, required: true, trim: true },
        country: { type: String, default: "India", trim: true },
        isDefault: { type: Boolean, default: false },
    },
    { timestamps: true },
);

/**
 * The customers table filters by the two states a store owner thinks in:
 * an account is either usable or it isn't. Both map onto `isActive` — there
 * is no third state to model.
 */
export const CUSTOMER_STATUS_FILTERS = {
    active: true,
    blocked: false,
};

/** Display names, served with the counts so the frontend builds its dropdown from the API. */
export const CUSTOMER_STATUS_LABELS = {
    all: "All Statuses",
    active: "Active",
    blocked: "Blocked",
};

const userSchema = new mongoose.Schema(
    {
        fullName: {
            type: String,
            required: [true, "Full name is required"],
            trim: true,
            minlength: [2, "Full name must be at least 2 characters"],
            maxlength: [80, "Full name must be at most 80 characters"],
        },
        email: {
            type: String,
            required: [true, "Email is required"],
            unique: true,
            lowercase: true,
            trim: true,
            index: true,
        },
        phone: {
            type: String,
            required: [true, "Phone is required"],
            unique: true,
            trim: true,
            index: true,
        },
        password: {
            type: String,
            required: [true, "Password is required"],
            select: false,
        },
        role: {
            type: String,
            enum: ["user", "admin"],
            default: "user",
        },

        // --- Verification state -------------------------------------------
        // isEmailVerified is the gate for logging in. isPhoneVerified is
        // tracked separately because phone+OTP login needs it, but it is not
        // required to use the account.
        isEmailVerified: { type: Boolean, default: false },
        isPhoneVerified: { type: Boolean, default: false },

        // When the address was confirmed. Kept alongside the flag so later
        // sends (order mail, shipping updates) can tell how stale the proof is.
        emailVerifiedAt: { type: Date },

        emailVerificationTokenHash: { type: String, select: false },
        emailVerificationExpiresAt: { type: Date, select: false },

        passwordResetTokenHash: { type: String, select: false },
        passwordResetExpiresAt: { type: Date, select: false },

        // Invalidates all previously-issued access tokens when the password
        // changes — the auth middleware compares this against the JWT's iat.
        passwordChangedAt: { type: Date, select: false },

        // --- Brute-force protection ---------------------------------------
        failedLoginAttempts: { type: Number, default: 0, select: false },
        lockedUntil: { type: Date, select: false },

        // --- Sessions -------------------------------------------------------
        // One entry per active device. Logout removes one; logout-all clears
        // the array. This is what makes refresh tokens revocable.
        refreshTokens: { type: [refreshTokenSchema], select: false, default: [] },

        addresses: { type: [addressSchema], default: [] },

        isActive: { type: Boolean, default: true },
        lastLoginAt: { type: Date },
    },
    {
        timestamps: true,
        toJSON: {
            transform(_doc, ret) {
                delete ret.password;
                delete ret.refreshTokens;
                delete ret.emailVerificationTokenHash;
                delete ret.emailVerificationExpiresAt;
                delete ret.passwordResetTokenHash;
                delete ret.passwordResetExpiresAt;
                delete ret.failedLoginAttempts;
                delete ret.lockedUntil;
                delete ret.passwordChangedAt;
                delete ret.__v;
                return ret;
            },
        },
    },
);

// The customers table is always "role user, one status bucket, newest first".
userSchema.index({ role: 1, isActive: 1, createdAt: -1 });

/** Hash the password whenever it is set or changed — never in a controller. */
userSchema.pre("save", async function hashPassword(next) {
    if (!this.isModified("password")) return next();

    this.password = await bcrypt.hash(this.password, 12);

    // Backdate by 1s so a token minted in the same second as the change is
    // still treated as "issued after" it, avoiding a spurious logout.
    if (!this.isNew) this.passwordChangedAt = new Date(Date.now() - 1000);

    next();
});

userSchema.methods.comparePassword = function comparePassword(candidate) {
    return bcrypt.compare(candidate, this.password);
};

/** True if the JWT was issued before the password last changed. */
userSchema.methods.passwordChangedAfter = function passwordChangedAfter(jwtIssuedAtSeconds) {
    if (!this.passwordChangedAt) return false;
    return jwtIssuedAtSeconds * 1000 < this.passwordChangedAt.getTime();
};

userSchema.methods.isLocked = function isLocked() {
    return Boolean(this.lockedUntil && this.lockedUntil > new Date());
};

/**
 * Creates a one-time email-verification token. Returns the RAW token for
 * emailing; only the hash is persisted.
 */
userSchema.methods.createEmailVerificationToken = function createEmailVerificationToken(ttlMinutes = 30) {
    const raw = crypto.randomBytes(32).toString("hex");
    this.emailVerificationTokenHash = sha256(raw);
    this.emailVerificationExpiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);
    return raw;
};

userSchema.methods.createPasswordResetToken = function createPasswordResetToken(ttlMinutes = 15) {
    const raw = crypto.randomBytes(32).toString("hex");
    this.passwordResetTokenHash = sha256(raw);
    this.passwordResetExpiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);
    return raw;
};

userSchema.statics.hashToken = sha256;

export const User = mongoose.model("User", userSchema);
