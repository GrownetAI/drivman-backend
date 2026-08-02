import mongoose from "mongoose";

/**
 * Unlike cart items, order items SNAPSHOT the product (name, image, price at
 * time of purchase). An order is a historical record — if the product is later
 * renamed, repriced, or deleted, the order must still show what was bought and
 * what was actually paid.
 */
const orderItemSchema = new mongoose.Schema(
    {
        product: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
        name: { type: String, required: true },
        image: { type: String },
        price: { type: Number, required: true, min: 0 },
        quantity: { type: Number, required: true, min: 1 },
        subtotal: { type: Number, required: true, min: 0 },
    },
    { _id: false },
);

const shippingAddressSchema = new mongoose.Schema(
    {
        fullName: { type: String, required: true },
        phone: { type: String, required: true },
        line1: { type: String, required: true },
        line2: { type: String },
        city: { type: String, required: true },
        state: { type: String, required: true },
        postalCode: { type: String, required: true },
        country: { type: String, default: "India" },
    },
    { _id: false },
);

export const ORDER_STATUSES = [
    "pending",
    "confirmed",
    "processing",
    "shipped",
    "out_for_delivery",
    "delivered",
    "cancelled",
];

/**
 * The admin panel filters by the five buckets a store owner actually thinks
 * in, not by the seven internal statuses. "Placed" covers everything between
 * checkout and dispatch — pending, confirmed and processing are bookkeeping
 * states that look identical from the shop floor.
 *
 * Every key here is a valid `?status=` value; so is any raw status above, for
 * callers that need the finer grain.
 */
export const ORDER_STATUS_FILTERS = {
    placed: ["pending", "confirmed", "processing"],
    shipped: ["shipped"],
    out_for_delivery: ["out_for_delivery"],
    delivered: ["delivered"],
    cancelled: ["cancelled"],
};

/** Display names, served with the counts so the frontend builds its dropdown from the API. */
export const ORDER_STATUS_LABELS = {
    all: "All Statuses",
    placed: "Placed",
    shipped: "Shipped",
    out_for_delivery: "Out for Delivery",
    delivered: "Delivered",
    cancelled: "Cancelled",
};

export const PAYMENT_STATUSES = ["pending", "paid", "failed", "refunded"];

export const PAYMENT_METHODS = ["COD", "RAZORPAY"];

const orderSchema = new mongoose.Schema(
    {
        orderNumber: { type: String, unique: true, index: true },

        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
            index: true,
        },

        items: {
            type: [orderItemSchema],
            required: true,
            validate: [(v) => v.length > 0, "Order must contain at least one item"],
        },

        shippingAddress: { type: shippingAddressSchema, required: true },

        itemsTotal: { type: Number, required: true, min: 0 },
        shippingFee: { type: Number, default: 0, min: 0 },
        discount: { type: Number, default: 0, min: 0 },
        grandTotal: { type: Number, required: true, min: 0 },

        paymentMethod: {
            type: String,
            enum: PAYMENT_METHODS,
            required: true,
        },
        paymentStatus: {
            type: String,
            enum: PAYMENT_STATUSES,
            default: "pending",
            index: true,
        },
        razorpay: {
            orderId: { type: String, index: true, sparse: true },
            paymentId: { type: String },
            signature: { type: String },
        },

        status: {
            type: String,
            enum: ORDER_STATUSES,
            default: "pending",
            index: true,
        },
        statusHistory: [
            {
                status: { type: String, enum: ORDER_STATUSES },
                at: { type: Date, default: Date.now },
                note: String,
                _id: false,
            },
        ],

        placedAt: { type: Date, default: Date.now },
        deliveredAt: { type: Date },
        cancelledAt: { type: Date },
        cancellationReason: { type: String },
    },
    { timestamps: true },
);

orderSchema.index({ user: 1, createdAt: -1 });
// The admin listing is always "one status bucket, newest first".
orderSchema.index({ status: 1, createdAt: -1 });

/**
 * Human-readable order number. Uses a per-day counter rather than a random
 * suffix so support staff can read it aloud: DRV-20260728-0007
 */
orderSchema.pre("validate", async function generateOrderNumber(next) {
    if (this.orderNumber) return next();

    const now = new Date();
    const datePart = [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, "0"),
        String(now.getDate()).padStart(2, "0"),
    ].join("");

    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const countToday = await this.constructor.countDocuments({ createdAt: { $gte: startOfDay } });

    this.orderNumber = `DRV-${datePart}-${String(countToday + 1).padStart(4, "0")}`;
    next();
});

export const Order = mongoose.model("Order", orderSchema);
