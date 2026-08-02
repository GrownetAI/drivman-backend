import mongoose from "mongoose";
import mongooseLeanVirtuals from "mongoose-lean-virtuals";

/**
 * Categories are a single-level tree: a category either is a root, or has a
 * `parent` pointing at a root. Deeper nesting isn't modelled because the
 * storefront navigation is two levels (e.g. "Tyres" > "All-Terrain").
 */
const categorySchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: [true, "Category name is required"],
            trim: true,
            maxlength: 80,
        },
        slug: {
            type: String,
            required: true,
            unique: true,
            lowercase: true,
            trim: true,
            index: true,
        },
        description: { type: String, trim: true, maxlength: 500 },
        image: { type: String, trim: true },
        parent: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Category",
            default: null,
            index: true,
        },
        isActive: { type: Boolean, default: true, index: true },
        sortOrder: { type: Number, default: 0 },
    },
    { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } },
);

categorySchema.virtual("children", {
    ref: "Category",
    localField: "_id",
    foreignField: "parent",
});

export const slugify = (text) =>
    text
        .toString()
        .toLowerCase()
        .trim()
        .replace(/[^\w\s-]/g, "")
        .replace(/[\s_-]+/g, "-")
        .replace(/^-+|-+$/g, "");

// Required for the populated `children` virtual to survive `.lean()`.
categorySchema.plugin(mongooseLeanVirtuals);

categorySchema.pre("validate", function generateSlug(next) {
    if (!this.slug && this.name) this.slug = slugify(this.name);
    next();
});

export const Category = mongoose.model("Category", categorySchema);
