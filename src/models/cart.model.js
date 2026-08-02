import mongoose from "mongoose";

/**
 * One cart per user. Line items store only product + quantity — price is
 * always read live from the Product at read/checkout time, so a cart can
 * never lock in a stale price.
 */
const cartItemSchema = new mongoose.Schema(
    {
        product: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Product",
            required: true,
        },
        quantity: {
            type: Number,
            required: true,
            min: [1, "Quantity must be at least 1"],
            default: 1,
        },
        addedAt: { type: Date, default: Date.now },
    },
    { _id: false },
);

const cartSchema = new mongoose.Schema(
    {
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
            unique: true,
            index: true,
        },
        items: { type: [cartItemSchema], default: [] },
    },
    { timestamps: true },
);

export const Cart = mongoose.model("Cart", cartSchema);
