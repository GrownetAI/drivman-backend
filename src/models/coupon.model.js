import mongoose from "mongoose";
import mongooseLeanVirtuals from "mongoose-lean-virtuals";

/** "Percentage (%)" and "Flat Amount" in the admin panel's discount dropdown. */
export const DISCOUNT_TYPES = ["percentage", "flat"];

/** Derived lifecycle state shown in the admin table. */
export const COUPON_STATUSES = ["active", "inactive", "expired", "exhausted"];

/** Codes are typed by hand at checkout — keep them short and unambiguous. */
export const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{2,23}$/;

const couponSchema = new mongoose.Schema(
    {
        code: {
            type: String,
            required: [true, "Coupon code is required"],
            unique: true,
            uppercase: true,
            trim: true,
            index: true,
            match: [
                CODE_RE,
                "Coupon code must be 3-24 characters of letters, numbers, hyphens or underscores",
            ],
        },

        discountType: {
            type: String,
            enum: DISCOUNT_TYPES,
            default: "percentage",
            required: true,
        },

        /** Percent off (1-100) when `discountType` is "percentage", else rupees off. */
        discountValue: {
            type: Number,
            required: [true, "Discount value is required"],
            min: [0.01, "Discount value must be greater than 0"],
        },

        /** 0 = no minimum. The admin table renders that as "None". */
        minOrderAmount: { type: Number, default: 0, min: 0 },

        /** null = unlimited redemptions. */
        usageLimit: {
            type: Number,
            default: null,
            min: [1, "Usage limit must be at least 1"],
        },

        /**
         * Incremented when an order redeems the coupon — never settable from a
         * request body, otherwise an admin edit could rewrite redemption history.
         */
        usedCount: { type: Number, default: 0, min: 0 },

        /** null = never expires. */
        expiresAt: { type: Date, default: null },

        isActive: { type: Boolean, default: true, index: true },

        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    },
    { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } },
);

// The listing sorts by expiry and filters on active/expired, and the storefront
// will look coupons up by code — both are covered here.
couponSchema.index({ isActive: 1, expiresAt: 1 });

/**
 * Each virtual reads the stored fields directly rather than another virtual:
 * on a `.lean({ virtuals: true })` result the getters run against a plain
 * object, where a sibling virtual may not have been attached yet.
 */
const expired = (doc) => Boolean(doc.expiresAt) && new Date(doc.expiresAt).getTime() <= Date.now();

const exhausted = (doc) =>
    doc.usageLimit !== null && doc.usageLimit !== undefined
        ? (doc.usedCount ?? 0) >= doc.usageLimit
        : false;

/** active | inactive | expired | exhausted — in the order the admin table shows. */
const statusOf = (doc) => {
    if (!doc.isActive) return "inactive";
    if (expired(doc)) return "expired";
    if (exhausted(doc)) return "exhausted";
    return "active";
};

couponSchema.virtual("isExpired").get(function isExpired() {
    return expired(this);
});

couponSchema.virtual("isExhausted").get(function isExhausted() {
    return exhausted(this);
});

/** null when the coupon has no usage limit. */
couponSchema.virtual("remainingUses").get(function remainingUses() {
    if (this.usageLimit === null || this.usageLimit === undefined) return null;
    return Math.max(0, this.usageLimit - (this.usedCount ?? 0));
});

/**
 * One field the admin table can colour-code, instead of making the frontend
 * re-derive it from three others.
 */
couponSchema.virtual("status").get(function status() {
    return statusOf(this);
});

/** True only when the coupon may actually be redeemed right now. */
couponSchema.virtual("isRedeemable").get(function isRedeemable() {
    return statusOf(this) === "active";
});

couponSchema.plugin(mongooseLeanVirtuals);

/** Percentages above 100 would hand out money — Mongoose can't express this
 *  cross-field rule on the field itself. */
couponSchema.pre("validate", function checkPercentageCeiling(next) {
    if (this.discountType === "percentage" && this.discountValue > 100) {
        this.invalidate("discountValue", "A percentage discount cannot exceed 100%.");
    }
    next();
});

export const Coupon = mongoose.model("Coupon", couponSchema);
