import mongoose from "mongoose";
import {
    Order,
    ORDER_STATUSES,
    ORDER_STATUS_FILTERS,
    ORDER_STATUS_LABELS,
    PAYMENT_STATUSES,
    PAYMENT_METHODS,
} from "../models/order.model.js";
import { Cart } from "../models/cart.model.js";
import { Product } from "../models/product.model.js";
import { User } from "../models/user.model.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ok, created } from "../utils/ApiResponse.js";
import { badRequest, notFound, forbidden } from "../utils/ApiError.js";
import {
    requireFields,
    assertObjectId,
    isValidObjectId,
    parsePagination,
    buildMeta,
} from "../utils/validators.js";
import {
    createRazorpayOrder,
    verifyPaymentSignature,
    isRazorpayConfigured,
} from "../services/paymentService.js";
import { sendOrderConfirmationEmail } from "../services/emailService.js";

const FREE_SHIPPING_THRESHOLD = Number(process.env.FREE_SHIPPING_THRESHOLD ?? 5000);
const SHIPPING_FEE = Number(process.env.SHIPPING_FEE ?? 99);

const calculateShipping = (itemsTotal) =>
    itemsTotal >= FREE_SHIPPING_THRESHOLD ? 0 : SHIPPING_FEE;

const REQUIRED_ADDRESS_FIELDS = [
    "fullName",
    "phone",
    "line1",
    "city",
    "state",
    "postalCode",
];

// --- Status filtering --------------------------------------------------------

/** "Out for Delivery", "out-for-delivery" and "out_for_delivery" all mean the same thing. */
const normalizeStatusKey = (value) =>
    String(value).trim().toLowerCase().replace(/[\s-]+/g, "_");

/**
 * Turns a `?status=` value into a Mongo condition, accepting either a UI
 * bucket ("placed") or a raw status ("processing"). Returns null for "all" /
 * absent, meaning "don't filter".
 */
const resolveStatusFilter = (value) => {
    if (value === undefined || value === null || value === "") return null;

    const key = normalizeStatusKey(value);
    if (key === "all") return null;

    const group = ORDER_STATUS_FILTERS[key];
    if (group) return group.length === 1 ? group[0] : { $in: group };
    if (ORDER_STATUSES.includes(key)) return key;

    throw badRequest(
        `status must be one of: ${Object.keys(ORDER_STATUS_FILTERS).join(", ")} ` +
            `(or a raw status: ${ORDER_STATUSES.join(", ")}).`,
    );
};

/**
 * Rolls raw per-status counts up into the buckets the dropdown shows, so the
 * frontend can render its filter list — labels and all — straight from the API.
 */
const buildStatusSummary = (rawCounts) => {
    const byStatus = new Map(rawCounts.map((c) => [c._id, c.count]));
    const total = rawCounts.reduce((sum, c) => sum + c.count, 0);

    return {
        total,
        statuses: [
            { value: "all", label: ORDER_STATUS_LABELS.all, count: total },
            ...Object.entries(ORDER_STATUS_FILTERS).map(([value, members]) => ({
                value,
                label: ORDER_STATUS_LABELS[value],
                count: members.reduce((sum, m) => sum + (byStatus.get(m) ?? 0), 0),
            })),
        ],
    };
};

/**
 * Reserves stock for every line atomically.
 *
 * Each decrement is a conditional update — `{ _id, stock: { $gte: qty } }` —
 * so two concurrent checkouts for the last unit cannot both succeed. If any
 * line fails, the ones already taken are put back before we bail out. This is
 * the correct pattern for a standalone MongoDB without transactions.
 */
const reserveStock = async (lines) => {
    const taken = [];

    for (const line of lines) {
        const result = await Product.updateOne(
            { _id: line.product, stock: { $gte: line.quantity }, isActive: true },
            { $inc: { stock: -line.quantity } },
        );

        if (result.modifiedCount !== 1) {
            await releaseStock(taken);
            const current = await Product.findById(line.product).select("name stock");
            throw badRequest(
                current
                    ? `"${current.name}" only has ${current.stock} unit(s) left. Please update your cart.`
                    : "One of the products in your cart is no longer available.",
            );
        }
        taken.push(line);
    }

    return taken;
};

const releaseStock = async (lines) => {
    await Promise.all(
        lines.map((l) =>
            Product.updateOne({ _id: l.product }, { $inc: { stock: l.quantity } }),
        ),
    );
};

/**
 * @route POST /api/orders
 * Body: { shippingAddress | addressId, paymentMethod: "COD"|"RAZORPAY", items? }
 *
 * Sources lines from the user's cart unless an explicit `items` array is
 * given (buy-now flow). Prices are always re-read from the database — the
 * client never gets to state a price.
 */
export const createOrder = asyncHandler(async (req, res) => {
    const { paymentMethod = "COD", addressId, items: directItems } = req.body;

    if (!["COD", "RAZORPAY"].includes(paymentMethod)) {
        throw badRequest('paymentMethod must be either "COD" or "RAZORPAY".');
    }
    if (paymentMethod === "RAZORPAY" && !isRazorpayConfigured()) {
        throw badRequest("Online payment is unavailable right now. Please choose COD.");
    }

    // --- Resolve the shipping address --------------------------------------
    let shippingAddress = req.body.shippingAddress;

    if (addressId) {
        const saved = req.user.addresses.id(addressId);
        if (!saved) throw badRequest("That saved address could not be found.");
        shippingAddress = {
            fullName: saved.fullName,
            phone: saved.phone,
            line1: saved.line1,
            line2: saved.line2,
            city: saved.city,
            state: saved.state,
            postalCode: saved.postalCode,
            country: saved.country,
        };
    }

    if (!shippingAddress) {
        throw badRequest("Provide either a shippingAddress object or an addressId.");
    }
    requireFields(
        shippingAddress,
        REQUIRED_ADDRESS_FIELDS.map((f) => f),
    );

    // --- Resolve the line items ---------------------------------------------
    let sourceLines;

    if (Array.isArray(directItems) && directItems.length > 0) {
        sourceLines = directItems.map((i) => ({
            product: assertObjectId(i.productId, "productId"),
            quantity: Math.max(1, parseInt(i.quantity, 10) || 1),
        }));
    } else {
        const cart = await Cart.findOne({ user: req.user._id });
        if (!cart || cart.items.length === 0) {
            throw badRequest("Your cart is empty.");
        }
        sourceLines = cart.items.map((i) => ({
            product: i.product,
            quantity: i.quantity,
        }));
    }

    const productIds = sourceLines.map((l) => l.product);
    const products = await Product.find({ _id: { $in: productIds }, isActive: true });
    const productMap = new Map(products.map((p) => [String(p._id), p]));

    const orderItems = [];
    for (const line of sourceLines) {
        const product = productMap.get(String(line.product));
        if (!product) {
            throw badRequest("One or more products in your order are no longer available.");
        }
        if (product.stock < line.quantity) {
            throw badRequest(
                product.stock === 0
                    ? `"${product.name}" is out of stock.`
                    : `Only ${product.stock} unit(s) of "${product.name}" are available.`,
            );
        }

        orderItems.push({
            product: product._id,
            name: product.name,
            image: product.images?.[0]?.url,
            price: product.price,
            quantity: line.quantity,
            subtotal: Number((product.price * line.quantity).toFixed(2)),
        });
    }

    const itemsTotal = Number(orderItems.reduce((s, i) => s + i.subtotal, 0).toFixed(2));
    const shippingFee = calculateShipping(itemsTotal);
    const grandTotal = Number((itemsTotal + shippingFee).toFixed(2));

    // --- Reserve stock, then create the order ------------------------------
    const reserved = await reserveStock(
        orderItems.map((i) => ({ product: i.product, quantity: i.quantity })),
    );

    let order;
    try {
        order = await Order.create({
            user: req.user._id,
            items: orderItems,
            shippingAddress,
            itemsTotal,
            shippingFee,
            grandTotal,
            paymentMethod,
            // COD orders are confirmed on placement; online orders stay pending
            // until the payment signature is verified.
            paymentStatus: "pending",
            status: paymentMethod === "COD" ? "confirmed" : "pending",
            statusHistory: [
                {
                    status: paymentMethod === "COD" ? "confirmed" : "pending",
                    note:
                        paymentMethod === "COD"
                            ? "Order placed with Cash on Delivery."
                            : "Awaiting online payment.",
                },
            ],
        });

        if (paymentMethod === "RAZORPAY") {
            const rzpOrder = await createRazorpayOrder({
                amount: grandTotal,
                receipt: order.orderNumber,
                notes: { orderId: String(order._id), userId: String(req.user._id) },
            });
            order.razorpay.orderId = rzpOrder.id;
            await order.save();
        }
    } catch (err) {
        // Never leave stock reserved for an order that doesn't exist.
        await releaseStock(reserved);
        if (order?._id) await Order.deleteOne({ _id: order._id });
        throw err;
    }

    // Clear the cart only when the order came from it and is already payable.
    if (!directItems && paymentMethod === "COD") {
        await Cart.updateOne({ user: req.user._id }, { $set: { items: [] } });
    }

    if (paymentMethod === "COD") {
        sendOrderConfirmationEmail({
            to: req.user.email,
            fullName: req.user.fullName,
            order,
            requestId: req.id,
        }).catch((e) => console.error("Order email failed:", e.message));
    }

    return created(
        res,
        {
            order,
            ...(paymentMethod === "RAZORPAY" && {
                payment: {
                    razorpayOrderId: order.razorpay.orderId,
                    amount: grandTotal,
                    currency: "INR",
                    keyId: process.env.RAZORPAY_KEY_ID,
                },
            }),
        },
        paymentMethod === "COD"
            ? "Order placed successfully."
            : "Order created. Complete the payment to confirm it.",
    );
});

/**
 * @route POST /api/orders/:id/verify-payment
 * Body: { razorpayPaymentId, razorpaySignature }
 */
export const verifyPayment = asyncHandler(async (req, res) => {
    const orderId = assertObjectId(req.params.id, "order id");
    requireFields(req.body, ["razorpayPaymentId", "razorpaySignature"]);
    const { razorpayPaymentId, razorpaySignature } = req.body;

    const order = await Order.findById(orderId);
    if (!order) throw notFound("Order not found.");
    if (String(order.user) !== String(req.user._id)) {
        throw forbidden("This order does not belong to you.");
    }
    if (order.paymentStatus === "paid") {
        return ok(res, { order }, "This payment has already been verified.");
    }
    if (!order.razorpay?.orderId) {
        throw badRequest("This order has no online payment attached to it.");
    }

    const valid = verifyPaymentSignature({
        orderId: order.razorpay.orderId,
        paymentId: razorpayPaymentId,
        signature: razorpaySignature,
    });

    if (!valid) {
        order.paymentStatus = "failed";
        order.statusHistory.push({
            status: order.status,
            note: "Payment signature verification failed.",
        });
        await order.save();
        throw badRequest("Payment verification failed. Your card has not been charged.");
    }

    order.paymentStatus = "paid";
    order.status = "confirmed";
    order.razorpay.paymentId = razorpayPaymentId;
    order.razorpay.signature = razorpaySignature;
    order.statusHistory.push({ status: "confirmed", note: "Payment verified successfully." });
    await order.save();

    await Cart.updateOne({ user: req.user._id }, { $set: { items: [] } });

    sendOrderConfirmationEmail({
        to: req.user.email,
        fullName: req.user.fullName,
        order,
        requestId: req.id,
    }).catch((e) => console.error("Order email failed:", e.message));

    return ok(res, { order }, "Payment verified. Your order is confirmed.");
});

/** @route GET /api/orders — the caller's own orders. */
export const listMyOrders = asyncHandler(async (req, res) => {
    const { page, limit, skip } = parsePagination(req.query);
    const filter = { user: req.user._id };

    const status = resolveStatusFilter(req.query.status);
    if (status) filter.status = status;

    const [orders, total] = await Promise.all([
        Order.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
        Order.countDocuments(filter),
    ]);

    return ok(res, { orders, meta: buildMeta(page, limit, total) }, "Orders fetched.");
});

/** @route GET /api/orders/:id */
export const getOrder = asyncHandler(async (req, res) => {
    const orderId = assertObjectId(req.params.id, "order id");

    const order = await Order.findById(orderId)
        .populate("items.product", "name slug images isActive")
        .lean();

    if (!order) throw notFound("Order not found.");
    if (String(order.user) !== String(req.user._id) && req.user.role !== "admin") {
        throw forbidden("This order does not belong to you.");
    }

    return ok(res, { order }, "Order fetched.");
});

/**
 * @route PATCH /api/orders/:id/cancel   Body: { reason }
 * Only allowed before dispatch — once shipped, cancellation becomes a returns
 * problem rather than an order problem.
 */
export const cancelOrder = asyncHandler(async (req, res) => {
    const orderId = assertObjectId(req.params.id, "order id");

    const order = await Order.findById(orderId);
    if (!order) throw notFound("Order not found.");
    if (String(order.user) !== String(req.user._id) && req.user.role !== "admin") {
        throw forbidden("This order does not belong to you.");
    }

    if (["shipped", "out_for_delivery", "delivered"].includes(order.status)) {
        throw badRequest(
            `An order that is already ${ORDER_STATUS_LABELS[order.status] ?? order.status} ` +
                "cannot be cancelled.",
        );
    }
    if (order.status === "cancelled") throw badRequest("This order is already cancelled.");

    // Put every reserved unit back on the shelf.
    await releaseStock(order.items.map((i) => ({ product: i.product, quantity: i.quantity })));

    order.status = "cancelled";
    order.cancelledAt = new Date();
    order.cancellationReason = req.body?.reason || "Cancelled by customer.";
    if (order.paymentStatus === "paid") order.paymentStatus = "refunded";
    order.statusHistory.push({ status: "cancelled", note: order.cancellationReason });
    await order.save();

    return ok(
        res,
        { order },
        order.paymentStatus === "refunded"
            ? "Order cancelled. Your refund will be processed in 5-7 business days."
            : "Order cancelled.",
    );
});

// --- Admin -------------------------------------------------------------------

const escapeRegex = (value) => String(value).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const ADMIN_SORT_MAP = {
    newest: { createdAt: -1 },
    oldest: { createdAt: 1 },
    total_high: { grandTotal: -1, createdAt: -1 },
    total_low: { grandTotal: 1, createdAt: -1 },
};

/**
 * A bare date ("2026-08-02") from a date picker means the whole day, so the
 * upper bound is pushed to 23:59:59.999. A full timestamp is taken as-is.
 */
const parseDateBound = (value, label, { endOfDay = false } = {}) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        throw badRequest(`"${label}" must be a valid date (e.g. 2026-08-02).`);
    }
    if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(String(value).trim())) {
        date.setUTCHours(23, 59, 59, 999);
    }
    return date;
};

/**
 * Everything the admin table can filter by EXCEPT status — the status
 * dropdown needs counts for the buckets it is not currently showing, so it
 * is applied separately by the caller.
 */
const buildAdminOrderFilter = async (query) => {
    const filter = {};

    if (query.paymentStatus) {
        if (!PAYMENT_STATUSES.includes(query.paymentStatus)) {
            throw badRequest(`paymentStatus must be one of: ${PAYMENT_STATUSES.join(", ")}.`);
        }
        filter.paymentStatus = query.paymentStatus;
    }

    if (query.paymentMethod) {
        const method = String(query.paymentMethod).trim().toUpperCase();
        if (!PAYMENT_METHODS.includes(method)) {
            throw badRequest(`paymentMethod must be one of: ${PAYMENT_METHODS.join(", ")}.`);
        }
        filter.paymentMethod = method;
    }

    if (query.userId) {
        // Built as a real ObjectId: aggregation ($match) does not cast strings
        // the way find() does, and this filter is used by both.
        filter.user = new mongoose.Types.ObjectId(assertObjectId(query.userId, "userId"));
    }

    const createdAt = {};
    if (query.from) createdAt.$gte = parseDateBound(query.from, "from");
    if (query.to) createdAt.$lte = parseDateBound(query.to, "to", { endOfDay: true });
    if (Object.keys(createdAt).length) filter.createdAt = createdAt;

    // "Search by Order ID or customer name" — an admin has one of three things
    // in front of them: the order number, who ordered, or who it ships to.
    const search = query.search?.trim();
    if (search) {
        const re = new RegExp(escapeRegex(search), "i");
        const or = [
            { orderNumber: re },
            { "shippingAddress.fullName": re },
            { "shippingAddress.phone": re },
        ];

        const matchedUsers = await User.find({
            $or: [{ fullName: re }, { email: re }, { phone: re }],
        })
            .select("_id")
            .lean();
        if (matchedUsers.length) {
            or.push({ user: { $in: matchedUsers.map((u) => u._id) } });
        }

        // Pasting a raw order _id should find it too.
        if (isValidObjectId(search)) or.push({ _id: new mongoose.Types.ObjectId(search) });

        filter.$or = or;
    }

    return filter;
};

/**
 * @route GET /api/orders/admin/all — admin only.
 * The order-management table: filterable by status bucket, payment, customer
 * and date range, searchable, paginated.
 *
 * Query: page, limit, status, paymentStatus, paymentMethod, userId,
 *        search, from, to, sort (newest|oldest|total_high|total_low)
 *
 * Responds with `summary.statuses` — the counts behind every dropdown entry,
 * narrowed by the other active filters but not by the selected status.
 */
export const listAllOrders = asyncHandler(async (req, res) => {
    const { page, limit, skip } = parsePagination(req.query);
    const { sort = "newest" } = req.query;

    const baseFilter = await buildAdminOrderFilter(req.query);
    const status = resolveStatusFilter(req.query.status);
    const filter = status ? { ...baseFilter, status } : baseFilter;

    const [orders, total, rawCounts] = await Promise.all([
        Order.find(filter)
            .sort(ADMIN_SORT_MAP[sort] || ADMIN_SORT_MAP.newest)
            .skip(skip)
            .limit(limit)
            .populate("user", "fullName email phone")
            .lean(),
        Order.countDocuments(filter),
        Order.aggregate([{ $match: baseFilter }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
    ]);

    return ok(
        res,
        {
            orders,
            meta: buildMeta(page, limit, total),
            summary: buildStatusSummary(rawCounts),
        },
        "All orders fetched.",
    );
});

/**
 * @route GET /api/orders/admin/stats — admin only.
 * Header tiles for the dashboard: the same status counts as the listing plus
 * money totals. Accepts the same filters, so the numbers can follow a date
 * range without pulling a single order row.
 */
export const getOrderStats = asyncHandler(async (req, res) => {
    const filter = await buildAdminOrderFilter(req.query);

    const [rawCounts, totals] = await Promise.all([
        Order.aggregate([{ $match: filter }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
        Order.aggregate([
            { $match: filter },
            {
                $group: {
                    _id: null,
                    // Cancelled orders are not revenue, booked or otherwise.
                    bookedRevenue: {
                        $sum: {
                            $cond: [{ $eq: ["$status", "cancelled"] }, 0, "$grandTotal"],
                        },
                    },
                    collectedRevenue: {
                        $sum: {
                            $cond: [{ $eq: ["$paymentStatus", "paid"] }, "$grandTotal", 0],
                        },
                    },
                    awaitingPayment: {
                        $sum: { $cond: [{ $eq: ["$paymentStatus", "pending"] }, 1, 0] },
                    },
                },
            },
            { $project: { _id: 0 } },
        ]),
    ]);

    const money = totals[0] || { bookedRevenue: 0, collectedRevenue: 0, awaitingPayment: 0 };

    return ok(
        res,
        {
            ...buildStatusSummary(rawCounts),
            bookedRevenue: Number(money.bookedRevenue.toFixed(2)),
            collectedRevenue: Number(money.collectedRevenue.toFixed(2)),
            awaitingPayment: money.awaitingPayment,
        },
        "Order stats fetched.",
    );
});

/**
 * @route PATCH /api/orders/:id/status   Body: { status, note } — admin only.
 * Enforces a forward-only state machine so an order can't jump from
 * "delivered" back to "processing".
 */
const ALLOWED_TRANSITIONS = {
    pending: ["confirmed", "cancelled"],
    confirmed: ["processing", "cancelled"],
    processing: ["shipped", "cancelled"],
    // Dispatched orders may skip the courier's "out for delivery" scan.
    shipped: ["out_for_delivery", "delivered"],
    out_for_delivery: ["delivered"],
    delivered: [],
    cancelled: [],
};

export const updateOrderStatus = asyncHandler(async (req, res) => {
    const orderId = assertObjectId(req.params.id, "order id");
    requireFields(req.body, ["status"]);
    const { note } = req.body;

    // A transition needs an exact status — "placed" spans three of them.
    const status = normalizeStatusKey(req.body.status);
    if (!ORDER_STATUSES.includes(status)) {
        throw badRequest(`status must be one of: ${ORDER_STATUSES.join(", ")}.`);
    }

    const order = await Order.findById(orderId);
    if (!order) throw notFound("Order not found.");

    const allowed = ALLOWED_TRANSITIONS[order.status] || [];
    if (!allowed.includes(status)) {
        throw badRequest(
            `Cannot move an order from "${order.status}" to "${status}".` +
                (allowed.length ? ` Allowed next: ${allowed.join(", ")}.` : " This order is final."),
        );
    }

    if (status === "cancelled") {
        await releaseStock(order.items.map((i) => ({ product: i.product, quantity: i.quantity })));
        order.cancelledAt = new Date();
        order.cancellationReason = note || "Cancelled by admin.";
        if (order.paymentStatus === "paid") order.paymentStatus = "refunded";
    }

    if (status === "delivered") {
        order.deliveredAt = new Date();
        // COD is collected on delivery, so that's the moment it becomes paid.
        if (order.paymentMethod === "COD") order.paymentStatus = "paid";
    }

    order.status = status;
    order.statusHistory.push({ status, note: note || `Status updated to ${status}.` });
    await order.save();

    return ok(res, { order }, `Order status updated to "${status}".`);
});
