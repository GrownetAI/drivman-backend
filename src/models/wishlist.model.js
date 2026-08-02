import mongoose from "mongoose";

const wishlistSchema = new mongoose.Schema(
    {
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
            unique: true,
            index: true,
        },
        // A plain ObjectId array — $addToSet gives us idempotent adds for free,
        // so adding the same product twice is a no-op rather than an error.
        products: [
            {
                type: mongoose.Schema.Types.ObjectId,
                ref: "Product",
            },
        ],
    },
    { timestamps: true },
);

export const Wishlist = mongoose.model("Wishlist", wishlistSchema);
