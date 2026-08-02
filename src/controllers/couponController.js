import { Coupon, DISCOUNT_TYPES, CODE_RE } from "../models/coupon.model.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ok, created } from "../utils/ApiResponse.js";
import { badRequest, notFound, conflict } from "../utils/ApiError.js";
import { requireFields, parsePagination, buildMeta } from "../utils/validators.js";

const SORT_MAP = {
    newest: { createdAt: -1 },
    oldest: { createdAt: 1 },
    code_asc: { code: 1 },
    code_desc: { code: -1 },
    expiry_asc: { expiresAt: 1 },
    expiry_desc: { expiresAt: -1 },
    usage_desc: { usedCount: -1 },
    usage_asc: { usedCount: 1 },
    value_desc: { discountValue: -1 },
    value_asc: { discountValue: 1 },
};

/** The form's dropdown labels, plus the spellings API clients tend to send. */
const DISCOUNT_TYPE_ALIASES = {
    percentage: "percentage",
    percent: "percentage",
    "percentage (%)": "percentage",
    "%": "percentage",
    flat: "flat",
    "flat amount": "flat",
    fixed: "flat",
    amount: "flat",
};

const escapeRegex = (value) => String(value).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const isBlank = (v) => v === null || v === undefined || (typeof v === "string" && !v.trim());

/** A coupon whose limit is reached — expressed as a query fragment so the
 *  listing can filter on it in the database rather than in memory. */
const EXHAUSTED_MATCH = {
    $expr: {
        $and: [{ $ne: ["$usageLimit", null] }, { $gte: ["$usedCount", "$usageLimit"] }],
    },
};

const NOT_EXHAUSTED_MATCH = {
    $expr: {
        $or: [{ $eq: ["$usageLimit", null] }, { $lt: ["$usedCount", "$usageLimit"] }],
    },
};

/** The admin links by id, but support staff paste the code — accept either. */
const findByIdOrCode = (idOrCode) => {
    const value = String(idOrCode).trim();
    if (/^[0-9a-fA-F]{24}$/.test(value)) return Coupon.findById(value);
    return Coupon.findOne({ code: value.toUpperCase() });
};

const normaliseCode = (value) => {
    const code = String(value).trim().toUpperCase().replace(/\s+/g, "");
    if (!CODE_RE.test(code)) {
        throw badRequest(
            "Coupon code must be 3-24 characters using only letters, numbers, hyphens or underscores.",
        );
    }
    return code;
};

const normaliseDiscountType = (value) => {
    const type = DISCOUNT_TYPE_ALIASES[String(value).trim().toLowerCase()];
    if (!type) {
        throw badRequest(`discountType must be one of: ${DISCOUNT_TYPES.join(", ")}.`);
    }
    return type;
};

/** Rejects "12abc" and NaN, which `parseFloat`/`Number()` alone would let past. */
const toNumber = (value, label) => {
    const num = typeof value === "number" ? value : Number(String(value).trim());
    if (!Number.isFinite(num)) throw badRequest(`${label} must be a number.`);
    return num;
};

/** The date input posts "2026-12-31"; treat it as end-of-day so a coupon is
 *  usable for the whole day it expires on. */
const normaliseExpiry = (value) => {
    if (isBlank(value)) return null;

    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) throw badRequest("expiresAt is not a valid date.");

    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
        date.setHours(23, 59, 59, 999);
    }
    return date;
};

const normaliseUsageLimit = (value) => {
    if (isBlank(value)) return null; // Unlimited.

    const limit = toNumber(value, "usageLimit");
    if (!Number.isInteger(limit) || limit < 1) {
        throw badRequest("usageLimit must be a whole number of at least 1, or empty for unlimited.");
    }
    return limit;
};

const assertDiscountFits = (type, value) => {
    if (value <= 0) throw badRequest("discountValue must be greater than 0.");
    if (type === "percentage" && value > 100) {
        throw badRequest("A percentage discount cannot exceed 100%.");
    }
};

/**
 * @route GET /api/coupons — admin only.
 * Query: ?page ?limit ?search ?status ?discountType ?isActive ?sort
 */
export const listCoupons = asyncHandler(async (req, res) => {
    const { page, limit, skip } = parsePagination(req.query);
    const { search, status, discountType, isActive, sort } = req.query;

    const filter = {};
    const now = new Date();

    if (search) filter.code = new RegExp(escapeRegex(search), "i");
    if (discountType) filter.discountType = normaliseDiscountType(discountType);
    if (isActive !== undefined) filter.isActive = isActive === "true";

    switch (status) {
        case "active":
            Object.assign(filter, NOT_EXHAUSTED_MATCH, {
                isActive: true,
                $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
            });
            break;
        case "inactive":
            filter.isActive = false;
            break;
        case "expired":
            filter.expiresAt = { $ne: null, $lte: now };
            break;
        case "exhausted":
            Object.assign(filter, EXHAUSTED_MATCH);
            break;
        case undefined:
        case "":
        case "all":
            break;
        default:
            throw badRequest(
                "status must be one of: active, inactive, expired, exhausted, all.",
            );
    }

    const [coupons, total] = await Promise.all([
        Coupon.find(filter)
            .sort(SORT_MAP[sort] || SORT_MAP.newest)
            .skip(skip)
            .limit(limit)
            .lean({ virtuals: true }),
        Coupon.countDocuments(filter),
    ]);

    return ok(res, { coupons, meta: buildMeta(page, limit, total) }, "Coupons fetched.");
});

/** @route GET /api/coupons/:idOrCode — admin only. */
export const getCoupon = asyncHandler(async (req, res) => {
    const coupon = await findByIdOrCode(req.params.idOrCode);
    if (!coupon) throw notFound("Coupon not found.");

    return ok(res, { coupon }, "Coupon fetched.");
});

/** @route POST /api/coupons — admin only. */
export const createCoupon = asyncHandler(async (req, res) => {
    requireFields(req.body, ["code", "discountValue"]);

    const code = normaliseCode(req.body.code);
    if (await Coupon.exists({ code })) {
        throw conflict(`A coupon with the code "${code}" already exists.`);
    }

    const discountType = req.body.discountType
        ? normaliseDiscountType(req.body.discountType)
        : "percentage";
    const discountValue = toNumber(req.body.discountValue, "discountValue");
    assertDiscountFits(discountType, discountValue);

    const minOrderAmount = isBlank(req.body.minOrderAmount)
        ? 0
        : toNumber(req.body.minOrderAmount, "minOrderAmount");
    if (minOrderAmount < 0) throw badRequest("minOrderAmount cannot be negative.");

    const expiresAt = normaliseExpiry(req.body.expiresAt ?? req.body.expiryDate);
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
        throw badRequest("The expiry date must be in the future.");
    }

    const coupon = await Coupon.create({
        code,
        discountType,
        discountValue,
        minOrderAmount,
        usageLimit: normaliseUsageLimit(req.body.usageLimit),
        expiresAt,
        isActive: req.body.isActive === undefined ? true : Boolean(req.body.isActive),
        createdBy: req.user?._id,
    });

    return created(res, { coupon }, "Coupon created.");
});

/**
 * @route PATCH /api/coupons/:id — admin only.
 * Every field is optional; `usedCount` is deliberately not writable.
 */
export const updateCoupon = asyncHandler(async (req, res) => {
    const coupon = await Coupon.findById(req.params.id);
    if (!coupon) throw notFound("Coupon not found.");

    const { code, discountType, discountValue, minOrderAmount, usageLimit, isActive } = req.body;

    if (code !== undefined) {
        const nextCode = normaliseCode(code);
        if (nextCode !== coupon.code && (await Coupon.exists({ code: nextCode }))) {
            throw conflict(`A coupon with the code "${nextCode}" already exists.`);
        }
        coupon.code = nextCode;
    }

    if (discountType !== undefined) coupon.discountType = normaliseDiscountType(discountType);
    if (discountValue !== undefined) coupon.discountValue = toNumber(discountValue, "discountValue");
    // Run the cross-field check against the values the document now holds, so a
    // PATCH that changes only the type still catches "flat 500" → "500%".
    assertDiscountFits(coupon.discountType, coupon.discountValue);

    if (minOrderAmount !== undefined) {
        const amount = isBlank(minOrderAmount) ? 0 : toNumber(minOrderAmount, "minOrderAmount");
        if (amount < 0) throw badRequest("minOrderAmount cannot be negative.");
        coupon.minOrderAmount = amount;
    }

    if (usageLimit !== undefined) {
        const limit = normaliseUsageLimit(usageLimit);
        if (limit !== null && limit < coupon.usedCount) {
            throw badRequest(
                `This coupon has already been used ${coupon.usedCount} time(s) — the usage limit cannot be lower than that.`,
            );
        }
        coupon.usageLimit = limit;
    }

    // A past date is allowed here: back-dating the expiry is how an admin kills
    // a coupon without deleting its history.
    if (req.body.expiresAt !== undefined || req.body.expiryDate !== undefined) {
        coupon.expiresAt = normaliseExpiry(req.body.expiresAt ?? req.body.expiryDate);
    }

    if (isActive !== undefined) coupon.isActive = Boolean(isActive);

    await coupon.save();
    return ok(res, { coupon }, "Coupon updated.");
});

/**
 * @route PATCH /api/coupons/:id/status — admin only.
 * Backs the table's ACTIVE toggle. Body {isActive} sets it explicitly; an
 * empty body flips it, matching PATCH /api/products/:id/visibility.
 */
export const setCouponStatus = asyncHandler(async (req, res) => {
    const coupon = await Coupon.findById(req.params.id);
    if (!coupon) throw notFound("Coupon not found.");

    coupon.isActive =
        req.body?.isActive === undefined ? !coupon.isActive : Boolean(req.body.isActive);
    await coupon.save();

    return ok(res, { coupon }, coupon.isActive ? "Coupon activated." : "Coupon deactivated.");
});

/**
 * @route DELETE /api/coupons/:id — admin only.
 * Redeemed coupons are kept unless `?force=true`: deleting one that customers
 * have used throws away the record of why those orders were discounted.
 */
export const deleteCoupon = asyncHandler(async (req, res) => {
    const coupon = await Coupon.findById(req.params.id);
    if (!coupon) throw notFound("Coupon not found.");

    if (coupon.usedCount > 0 && req.query.force !== "true") {
        throw badRequest(
            `This coupon has been used ${coupon.usedCount} time(s). Deactivate it instead, or pass ?force=true to delete it anyway.`,
        );
    }

    await coupon.deleteOne();
    return ok(res, null, "Coupon deleted.");
});
