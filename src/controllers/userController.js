import {
    User,
    CUSTOMER_STATUS_FILTERS,
    CUSTOMER_STATUS_LABELS,
} from "../models/user.model.js";
import { Order } from "../models/order.model.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ok, created } from "../utils/ApiResponse.js";
import { badRequest, notFound, unauthorized } from "../utils/ApiError.js";
import {
    requireFields,
    assertObjectId,
    isValidEmail,
    isValidPhone,
    parsePagination,
    buildMeta,
} from "../utils/validators.js";
import { emailOtpService } from "../services/emailOtpService.js";

/** @route GET /api/users/profile */
export const getProfile = asyncHandler(async (req, res) =>
    ok(res, { user: req.user }, "Profile fetched."),
);

/**
 * @route PATCH /api/users/profile   Body: { fullName?, phone? }
 * Email is intentionally NOT editable here — changing it would require a fresh
 * verification cycle, which belongs in its own flow.
 */
export const updateProfile = asyncHandler(async (req, res) => {
    const { fullName, phone } = req.body;

    if (fullName === undefined && phone === undefined) {
        throw badRequest("Provide at least one of: fullName, phone.");
    }

    const user = await User.findById(req.user._id);

    if (fullName !== undefined) {
        if (String(fullName).trim().length < 2) {
            throw badRequest("Full name must be at least 2 characters.");
        }
        user.fullName = String(fullName).trim();
    }

    if (phone !== undefined && phone !== user.phone) {
        if (!isValidPhone(phone)) {
            throw badRequest("Phone must be in E.164 format, e.g. +919876543210.");
        }
        // A number may be shared by several accounts (one household, one phone),
        // so there is deliberately no uniqueness check here. Email is the
        // identifying field.
        user.phone = phone.trim();
        // A new number is unproven until an OTP confirms it.
        user.isPhoneVerified = false;
    }

    await user.save();
    return ok(res, { user }, "Profile updated.");
});

/**
 * @route POST /api/users/profile/email   Body: { newEmail, currentPassword }
 * Step 1 of changing the login address: emails a code to the NEW address.
 * Nothing on the account changes until that code comes back.
 *
 * The current password is required because a hijacked session must not be able
 * to walk away with the account by moving its email somewhere else.
 */
export const requestEmailChange = asyncHandler(async (req, res) => {
    const { newEmail, currentPassword } = req.body;
    requireFields(req.body, ["newEmail", "currentPassword"]);

    if (!isValidEmail(newEmail)) throw badRequest("Please provide a valid email address.");

    const user = await User.findById(req.user._id).select("+password");
    if (!(await user.comparePassword(currentPassword))) {
        throw unauthorized("Your current password is incorrect.");
    }

    const result = await emailOtpService.requestEmailChange({
        userId: req.user._id,
        newEmail,
        ip: req.ip,
        requestId: req.id,
    });

    return ok(
        res,
        {
            pendingEmail: result.pendingEmail,
            expiresInMinutes: result.ttlMinutes,
            ...(result.devOtpCode ? { devOtpCode: result.devOtpCode } : {}),
        },
        `Enter the code sent to ${result.pendingEmail} to confirm the change.`,
    );
});

/**
 * @route POST /api/users/profile/email/verify   Body: { code }
 * Step 2: the code proves the new inbox belongs to them, so the address moves
 * and lands already verified.
 */
export const verifyEmailChange = asyncHandler(async (req, res) => {
    const { code, otp } = req.body;
    const submitted = code ?? otp;
    requireFields({ code: submitted }, ["code"]);

    const { user } = await emailOtpService.verifyEmailChange({
        userId: req.user._id,
        code: submitted,
        requestId: req.id,
    });

    return ok(res, { user }, "Email address updated.");
});

// --- Addresses ---------------------------------------------------------------

/** @route GET /api/users/addresses */
export const listAddresses = asyncHandler(async (req, res) =>
    ok(res, { addresses: req.user.addresses, count: req.user.addresses.length }, "Addresses fetched."),
);

/**
 * @route POST /api/users/addresses
 * The first address a user saves automatically becomes their default.
 */
export const addAddress = asyncHandler(async (req, res) => {
    requireFields(req.body, ["fullName", "phone", "line1", "city", "state", "postalCode"]);

    const user = await User.findById(req.user._id);
    const makeDefault = req.body.isDefault === true || user.addresses.length === 0;

    if (makeDefault) user.addresses.forEach((a) => (a.isDefault = false));

    user.addresses.push({ ...req.body, isDefault: makeDefault });
    await user.save();

    return created(
        res,
        { address: user.addresses.at(-1), addresses: user.addresses },
        "Address added.",
    );
});

/** @route PATCH /api/users/addresses/:addressId */
export const updateAddress = asyncHandler(async (req, res) => {
    const user = await User.findById(req.user._id);
    const address = user.addresses.id(req.params.addressId);
    if (!address) throw notFound("Address not found.");

    const editable = [
        "label", "fullName", "phone", "line1", "line2",
        "city", "state", "postalCode", "country",
    ];
    editable.forEach((f) => {
        if (req.body[f] !== undefined) address[f] = req.body[f];
    });

    if (req.body.isDefault === true) {
        user.addresses.forEach((a) => (a.isDefault = false));
        address.isDefault = true;
    }

    await user.save();
    return ok(res, { address, addresses: user.addresses }, "Address updated.");
});

/**
 * @route DELETE /api/users/addresses/:addressId
 * Deleting the default promotes the next address so the user is never left
 * without one.
 */
export const deleteAddress = asyncHandler(async (req, res) => {
    const user = await User.findById(req.user._id);
    const address = user.addresses.id(req.params.addressId);
    if (!address) throw notFound("Address not found.");

    const wasDefault = address.isDefault;
    address.deleteOne();

    if (wasDefault && user.addresses.length > 0) user.addresses[0].isDefault = true;

    await user.save();
    return ok(res, { addresses: user.addresses }, "Address deleted.");
});

/** @route PATCH /api/users/addresses/:addressId/default */
export const setDefaultAddress = asyncHandler(async (req, res) => {
    const user = await User.findById(req.user._id);
    const address = user.addresses.id(req.params.addressId);
    if (!address) throw notFound("Address not found.");

    user.addresses.forEach((a) => (a.isDefault = false));
    address.isDefault = true;
    await user.save();

    return ok(res, { addresses: user.addresses }, "Default address updated.");
});

// --- Admin -------------------------------------------------------------------

const escapeRegex = (value) => String(value).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const CUSTOMER_SORT_MAP = {
    newest: { createdAt: -1 },
    oldest: { createdAt: 1 },
    name_asc: { fullName: 1 },
    name_desc: { fullName: -1 },
};

/**
 * An order counts towards a customer's history once it is real money:
 * `pending` means an online checkout that was never paid for, and `cancelled`
 * was refunded or never collected. Neither belongs in "4 orders · ₹28,450".
 */
const COUNTED_ORDER_STATUSES = { $nin: ["pending", "cancelled"] };

/**
 * Turns a `?status=` value into an `isActive` condition. Returns null for
 * "all" / absent, meaning "don't filter".
 */
const resolveCustomerStatus = (value) => {
    if (value === undefined || value === null || value === "") return null;

    const key = String(value).trim().toLowerCase();
    if (key === "all") return null;
    if (key in CUSTOMER_STATUS_FILTERS) return CUSTOMER_STATUS_FILTERS[key];

    throw badRequest(
        `status must be one of: all, ${Object.keys(CUSTOMER_STATUS_FILTERS).join(", ")}.`,
    );
};

const parseBoolean = (value, field) => {
    if (typeof value === "boolean") return value;
    if (value === "true") return true;
    if (value === "false") return false;
    throw badRequest(`"${field}" must be true or false.`);
};

/**
 * The three header tiles and the counts behind the status dropdown, in one
 * pass. Deliberately covers the whole customer base rather than the current
 * page or search — the tiles report the shop, not the query.
 */
const buildCustomerSummary = async () => {
    const [counts] = await User.aggregate([
        { $match: { role: "user" } },
        {
            $group: {
                _id: null,
                total: { $sum: 1 },
                active: { $sum: { $cond: ["$isActive", 1, 0] } },
                blocked: { $sum: { $cond: ["$isActive", 0, 1] } },
            },
        },
        { $project: { _id: 0 } },
    ]);

    const { total, active, blocked } = counts || { total: 0, active: 0, blocked: 0 };

    return {
        total,
        active,
        blocked,
        statuses: [
            { value: "all", label: CUSTOMER_STATUS_LABELS.all, count: total },
            { value: "active", label: CUSTOMER_STATUS_LABELS.active, count: active },
            { value: "blocked", label: CUSTOMER_STATUS_LABELS.blocked, count: blocked },
        ],
    };
};

/**
 * @route GET /api/users/admin/customers — admin only.
 * The customers table: searchable by name, email or phone, filterable by
 * status, paginated, with each row carrying its lifetime order count and spend.
 *
 * Query: page, limit, search, status (all|active|blocked),
 *        sort (newest|oldest|name_asc|name_desc)
 */
export const listCustomers = asyncHandler(async (req, res) => {
    const { page, limit, skip } = parsePagination(req.query);
    const { search, sort = "newest" } = req.query;

    // Staff accounts are not customers — this table is the shop's address book.
    const filter = { role: "user" };

    const isActive = resolveCustomerStatus(req.query.status);
    if (isActive !== null) filter.isActive = isActive;

    if (search) {
        const re = new RegExp(escapeRegex(search), "i");
        filter.$or = [{ fullName: re }, { email: re }, { phone: re }];
    }

    const [customers, total, summary] = await Promise.all([
        User.aggregate([
            { $match: filter },
            { $sort: CUSTOMER_SORT_MAP[sort] || CUSTOMER_SORT_MAP.newest },
            // Paginate BEFORE the lookup so order history is rolled up for the
            // rows being shown, not for every customer in the database.
            { $skip: skip },
            { $limit: limit },
            {
                $lookup: {
                    from: Order.collection.name,
                    let: { userId: "$_id" },
                    pipeline: [
                        {
                            $match: {
                                $expr: { $eq: ["$user", "$$userId"] },
                                status: COUNTED_ORDER_STATUSES,
                            },
                        },
                        {
                            $group: {
                                _id: null,
                                count: { $sum: 1 },
                                spent: { $sum: "$grandTotal" },
                            },
                        },
                    ],
                    as: "orderSummary",
                },
            },
            {
                // Aggregation bypasses the schema's toJSON transform, so the
                // safe fields are listed explicitly rather than excluded.
                $project: {
                    fullName: 1,
                    email: 1,
                    phone: 1,
                    isActive: 1,
                    isEmailVerified: 1,
                    isPhoneVerified: 1,
                    lastLoginAt: 1,
                    createdAt: 1,
                    status: { $cond: ["$isActive", "active", "blocked"] },
                    ordersCount: { $ifNull: [{ $arrayElemAt: ["$orderSummary.count", 0] }, 0] },
                    totalSpent: {
                        $round: [{ $ifNull: [{ $arrayElemAt: ["$orderSummary.spent", 0] }, 0] }, 2],
                    },
                },
            },
        ]),
        User.countDocuments(filter),
        buildCustomerSummary(),
    ]);

    return ok(
        res,
        { customers, meta: buildMeta(page, limit, total), summary },
        "Customers fetched.",
    );
});

/** @route GET /api/users — admin only. */
export const listUsers = asyncHandler(async (req, res) => {
    const { page, limit, skip } = parsePagination(req.query);
    const filter = {};

    if (req.query.role) filter.role = req.query.role;
    if (req.query.search) {
        const re = new RegExp(escapeRegex(req.query.search), "i");
        filter.$or = [{ fullName: re }, { email: re }, { phone: re }];
    }

    const [users, total] = await Promise.all([
        User.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
        User.countDocuments(filter),
    ]);

    return ok(res, { users, meta: buildMeta(page, limit, total) }, "Users fetched.");
});

/**
 * @route PATCH /api/users/:id/status — admin only.
 * Body: { isActive } · { blocked } · or empty to flip the current state, which
 * is what the block button in the customers table sends.
 *
 * Returns the refreshed summary so the header tiles move with the table
 * without a second round trip.
 */
export const setUserStatus = asyncHandler(async (req, res) => {
    const userId = assertObjectId(req.params.id, "user id");
    const { isActive, blocked } = req.body ?? {};

    const user = await User.findById(userId).select("+refreshTokens");
    if (!user) throw notFound("User not found.");
    if (String(user._id) === String(req.user._id)) {
        throw badRequest("You cannot change your own account status.");
    }
    // Locking staff out of the panel is not a customer-management action, and
    // getting it wrong can leave the shop with no way back in.
    if (user.role === "admin") {
        throw badRequest("Admin accounts cannot be blocked from the customers panel.");
    }

    if (isActive !== undefined) user.isActive = parseBoolean(isActive, "isActive");
    else if (blocked !== undefined) user.isActive = !parseBoolean(blocked, "blocked");
    else user.isActive = !user.isActive;

    // Blocking must end their sessions immediately, not at token expiry.
    if (!user.isActive) user.refreshTokens = [];
    await user.save();

    const summary = await buildCustomerSummary();

    return ok(
        res,
        { user, summary },
        user.isActive ? "Customer unblocked." : "Customer blocked.",
    );
});
