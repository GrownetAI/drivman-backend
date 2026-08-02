import mongoose from "mongoose";
import mongooseLeanVirtuals from "mongoose-lean-virtuals";
import { slugify } from "./category.model.js";

/**
 * Dropdown vocabularies for the admin product form. Exported (and served by
 * GET /api/products/options) so the form's <select> options and the values the
 * API accepts can never drift apart.
 */
export const VEHICLE_TYPES = [
    "Hatchbacks",
    "Sedans",
    "SUVs",
    "MUVs",
    "Luxury",
    "Commercial",
];

// "None" in the form maps to null — a product simply has no badge.
export const PRODUCT_BADGES = ["Best Seller", "New Arrival", "Sale", "Limited Stock"];

// At or below this (but above zero) a product counts as "low stock" in the
// admin list filter. Env-tunable because it is a merchandising call, not a rule.
export const LOW_STOCK_THRESHOLD = Number(process.env.LOW_STOCK_THRESHOLD) || 5;

/**
 * publicId is the Cloudinary handle — kept so replacing or hard-deleting a
 * product can also remove the asset instead of orphaning it in storage.
 */
const productImageSchema = new mongoose.Schema(
    {
        url: { type: String, required: true, trim: true },
        alt: { type: String, trim: true, default: "" },
        publicId: { type: String, trim: true, default: null },
    },
    { _id: false },
);

const productSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: [true, "Product name is required"],
            trim: true,
            maxlength: 160,
        },
        slug: { type: String, unique: true, lowercase: true, trim: true, index: true },
        description: { type: String, trim: true, maxlength: 5000 },
        brand: { type: String, trim: true, index: true },

        category: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Category",
            required: [true, "Product must belong to a category"],
            index: true,
        },

        // price is what the customer pays. compareAtPrice is the struck-through
        // "was" price — optional, and only meaningful when higher than price.
        price: {
            type: Number,
            required: [true, "Price is required"],
            min: [0, "Price cannot be negative"],
        },
        compareAtPrice: { type: Number, min: 0, default: null },

        stock: { type: Number, required: true, min: 0, default: 0 },
        // Auto-generated from brand + model when the admin form leaves it out;
        // it is the admin list's second search key, so every product needs one.
        sku: { type: String, trim: true, uppercase: true, unique: true, sparse: true },

        // --- Vehicle-fitment attributes --------------------------------------
        // A product is a dashboard cover cut for one specific car model, so the
        // model name and seating-row layout are part of its identity, not tags.
        vehicleModel: { type: String, trim: true, index: true },
        vehicleType: {
            type: String,
            trim: true,
            // null is listed explicitly: Mongoose's enum validator rejects null
            // unless it is one of the permitted values.
            enum: {
                values: [...VEHICLE_TYPES, null],
                message: `vehicleType must be one of: ${VEHICLE_TYPES.join(", ")}`,
            },
            default: null,
            index: true,
        },
        colour: { type: String, trim: true, default: "Dashboard Black" },
        // "SET OF PCS" from the catalog — 3, 4 or 5 pieces.
        pieces: { type: Number, min: 1, default: 3 },
        // Derived from model names like "ERTIGA-19 (3 ROW)" / "WITH DICKY (4 ROW)".
        rows: { type: Number, min: 1, max: 4, default: null },
        hasDicky: { type: Boolean, default: false },

        // Storefront ribbon — "Best Seller", "Sale", … or none at all.
        badge: {
            type: String,
            trim: true,
            enum: {
                values: [...PRODUCT_BADGES, null],
                message: `badge must be one of: ${PRODUCT_BADGES.join(", ")}`,
            },
            default: null,
            index: true,
        },

        // First image is the main photo everywhere it is rendered.
        images: { type: [productImageSchema], default: [] },

        ratingAverage: { type: Number, default: 0, min: 0, max: 5 },
        ratingCount: { type: Number, default: 0 },

        isActive: { type: Boolean, default: true, index: true },
        isFeatured: { type: Boolean, default: false, index: true },
    },
    { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } },
);

// Text index powers ?search= on the listing endpoint.
productSchema.index({ name: "text", description: "text", brand: "text", vehicleModel: "text" });
// Compound index for the common "browse a category, sorted by price" query.
productSchema.index({ category: 1, price: 1 });
// The admin list sorts by newest within a visibility filter.
productSchema.index({ isActive: 1, createdAt: -1 });

productSchema.virtual("inStock").get(function inStock() {
    return this.stock > 0;
});

/** Drives the admin list's stock badge and its All Stock filter. */
productSchema.virtual("stockStatus").get(function stockStatus() {
    if (this.stock <= 0) return "out_of_stock";
    if (this.stock <= LOW_STOCK_THRESHOLD) return "low_stock";
    return "in_stock";
});

/** Thumbnail for list rows — saves every caller reaching into images[0]. */
productSchema.virtual("primaryImage").get(function primaryImage() {
    return this.images?.[0]?.url || null;
});

productSchema.virtual("discountPercent").get(function discountPercent() {
    if (!this.compareAtPrice || this.compareAtPrice <= this.price) return 0;
    return Math.round(((this.compareAtPrice - this.price) / this.compareAtPrice) * 100);
});

// Without this, `.lean({ virtuals: true })` silently drops inStock /
// discountPercent from every list response.
productSchema.plugin(mongooseLeanVirtuals);

productSchema.pre("validate", function generateSlug(next) {
    if (!this.slug && this.name) {
        // Suffix keeps slugs unique when two products share a name.
        this.slug = `${slugify(this.name)}-${this._id.toString().slice(-6)}`;
    }
    next();
});

/**
 * The admin form has no SKU field, but the product list searches by SKU — so
 * one is derived from brand + car model, matching the seeder's DRV-… shape.
 * A collision (two covers for the same model) falls back to an id suffix.
 */
productSchema.pre("validate", async function generateSku() {
    if (this.sku) return;

    const parts = [this.brand, this.vehicleModel || this.name]
        .filter(Boolean)
        .map((part) => slugify(String(part)).toUpperCase())
        .filter(Boolean);

    const base = `DRV-${parts.join("-")}`.slice(0, 60).replace(/-+$/, "");
    const taken = await this.constructor.exists({ sku: base, _id: { $ne: this._id } });
    this.sku = taken ? `${base}-${this._id.toString().slice(-4).toUpperCase()}` : base;
});

export const Product = mongoose.model("Product", productSchema);
