import {
    Product,
    VEHICLE_TYPES,
    PRODUCT_BADGES,
    LOW_STOCK_THRESHOLD,
} from "../models/product.model.js";
import { Category } from "../models/category.model.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ok, created } from "../utils/ApiResponse.js";
import { badRequest, notFound } from "../utils/ApiError.js";
import {
    requireFields,
    isValidObjectId,
    parsePagination,
    buildMeta,
} from "../utils/validators.js";
import {
    isImageUploadConfigured,
    uploadImageBuffer,
    destroyImages,
} from "../services/imageUploadService.js";
import { MAX_PRODUCT_IMAGES } from "../middlewares/upload.middleware.js";

const SORT_MAP = {
    newest: { createdAt: -1 },
    oldest: { createdAt: 1 },
    price_asc: { price: 1 },
    price_desc: { price: -1 },
    name_asc: { name: 1 },
    name_desc: { name: -1 },
    rating: { ratingAverage: -1 },
    stock_asc: { stock: 1 },
    stock_desc: { stock: -1 },
};

/** Fields an admin may set. Everything else (ratings, slug, timestamps) is
 *  derived — accepting them from the request body would let a typo overwrite
 *  a product's rating or break its permalink. */
const WRITABLE_FIELDS = [
    "name",
    "description",
    "brand",
    "category",
    "price",
    "compareAtPrice",
    "stock",
    "sku",
    "vehicleModel",
    "vehicleType",
    "colour",
    "pieces",
    "rows",
    "hasDicky",
    "badge",
    "images",
    "isActive",
    "isFeatured",
];

/** Empty strings and the form's "None" option both mean "no value". */
const BLANK = new Set(["", "none", "null", "undefined"]);
const isBlank = (v) =>
    v === null || v === undefined || (typeof v === "string" && BLANK.has(v.trim().toLowerCase()));

const escapeRegex = (value) => String(value).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Accepts ["https://…"] or [{url, alt, publicId}] — the uploader returns the
 *  latter, hand-written payloads tend to send the former. */
const normaliseImages = (input) => {
    if (!Array.isArray(input)) throw badRequest("images must be an array.");

    return input
        .map((image) => {
            if (typeof image === "string") return { url: image.trim(), alt: "", publicId: null };
            if (image && typeof image === "object" && image.url) {
                return {
                    url: String(image.url).trim(),
                    alt: image.alt ? String(image.alt).trim() : "",
                    publicId: image.publicId || null,
                };
            }
            throw badRequest("Each image must be a URL string or an object with a url.");
        })
        .filter((image) => image.url);
};

/** Resolves the category field, which may arrive as an id (admin dropdown) or
 *  a slug (imports and scripts). Returns the ObjectId. */
const resolveCategoryId = async (value) => {
    const category = isValidObjectId(value)
        ? await Category.findById(value).select("_id")
        : await Category.findOne({ slug: String(value).trim().toLowerCase() }).select("_id");

    if (!category) throw badRequest("Category does not exist.");
    return category._id;
};

/** Builds the update/create payload: whitelisted, trimmed, blanks normalised. */
const pickWritable = (body) => {
    const payload = {};

    for (const field of WRITABLE_FIELDS) {
        if (body[field] === undefined) continue;
        payload[field] = body[field];
    }

    // Optional single-choice fields: blank/"None" clears them rather than
    // failing enum validation.
    for (const field of ["vehicleType", "badge", "compareAtPrice", "rows"]) {
        if (field in payload && isBlank(payload[field])) payload[field] = null;
    }

    if (payload.images !== undefined) payload.images = normaliseImages(payload.images);
    if (payload.sku !== undefined && isBlank(payload.sku)) delete payload.sku;

    return payload;
};

/**
 * Cross-field rules Mongoose cannot express on its own. `existing` is the
 * current document on updates, so a partial PATCH is validated against the
 * values it will actually end up with.
 */
const assertValidPayload = (payload, existing = null) => {
    const resolve = (field) =>
        payload[field] !== undefined ? payload[field] : existing?.[field];

    const price = resolve("price");
    const compareAtPrice = resolve("compareAtPrice");
    const stock = resolve("stock");
    const pieces = resolve("pieces");
    const rows = resolve("rows");

    if (price !== undefined && price !== null) {
        if (Number.isNaN(Number(price))) throw badRequest("Price must be a number.");
        if (Number(price) < 0) throw badRequest("Price cannot be negative.");
    }

    if (compareAtPrice != null) {
        if (Number.isNaN(Number(compareAtPrice))) {
            throw badRequest("compareAtPrice must be a number.");
        }
        if (Number(compareAtPrice) <= Number(price)) {
            throw badRequest("compareAtPrice must be higher than price.");
        }
    }

    if (stock !== undefined && stock !== null) {
        if (!Number.isInteger(Number(stock))) throw badRequest("Stock must be a whole number.");
        if (Number(stock) < 0) throw badRequest("Stock cannot be negative.");
    }

    if (pieces !== undefined && pieces !== null && Number(pieces) < 1) {
        throw badRequest("Set of pieces must be at least 1.");
    }

    if (rows != null && (Number(rows) < 1 || Number(rows) > 4)) {
        throw badRequest("Rows must be between 1 and 4.");
    }

    if (payload.vehicleType && !VEHICLE_TYPES.includes(payload.vehicleType)) {
        throw badRequest(`vehicleType must be one of: ${VEHICLE_TYPES.join(", ")}.`);
    }

    if (payload.badge && !PRODUCT_BADGES.includes(payload.badge)) {
        throw badRequest(`badge must be one of: ${PRODUCT_BADGES.join(", ")}.`);
    }
};

/** Shared filter builder for the public and admin listings. */
const applyCommonFilters = (filter, query) => {
    const { brand, vehicleType, vehicleModel, badge, colour, pieces, rows, minPrice, maxPrice } =
        query;

    if (brand) filter.brand = new RegExp(`^${escapeRegex(brand)}$`, "i");
    if (vehicleType) filter.vehicleType = vehicleType;
    if (vehicleModel) filter.vehicleModel = new RegExp(escapeRegex(vehicleModel), "i");
    if (badge) filter.badge = badge;
    if (colour) filter.colour = new RegExp(`^${escapeRegex(colour)}$`, "i");
    if (pieces) filter.pieces = Number(pieces);
    if (rows) filter.rows = Number(rows);

    if (minPrice || maxPrice) {
        filter.price = {};
        if (minPrice) filter.price.$gte = Number(minPrice);
        if (maxPrice) filter.price.$lte = Number(maxPrice);
    }
};

/** Category filter that also covers the category's direct children, so
 *  browsing a parent shows everything beneath it. */
const applyCategoryFilter = async (filter, category) => {
    const categoryDoc = isValidObjectId(category)
        ? await Category.findById(category).select("_id")
        : await Category.findOne({ slug: String(category).toLowerCase() }).select("_id");

    if (!categoryDoc) throw notFound("Category not found.");

    const children = await Category.find({ parent: categoryDoc._id }).select("_id").lean();
    filter.category = { $in: [categoryDoc._id, ...children.map((c) => c._id)] };
};

/**
 * Stock buckets are mutually exclusive so they line up with the counts in the
 * admin summary: out (0) · low (1…threshold) · in (above threshold).
 */
const applyStockFilter = (filter, stock) => {
    switch (String(stock).toLowerCase()) {
        case "out":
        case "out_of_stock":
            filter.stock = { $lte: 0 };
            break;
        case "low":
        case "low_stock":
            filter.stock = { $gt: 0, $lte: LOW_STOCK_THRESHOLD };
            break;
        case "in":
        case "in_stock":
            filter.stock = { $gt: LOW_STOCK_THRESHOLD };
            break;
        default:
            break;
    }
};

/**
 * @route GET /api/products
 * Public listing — active products only.
 * Query: page, limit, category (id|slug), brand, search, minPrice, maxPrice,
 *        pieces, rows, vehicleType, vehicleModel, badge, colour, inStock,
 *        featured, sort
 */
export const listProducts = asyncHandler(async (req, res) => {
    const { page, limit, skip } = parsePagination(req.query);
    const { category, search, inStock, featured, sort = "newest" } = req.query;

    const filter = { isActive: true };

    if (category) await applyCategoryFilter(filter, category);
    applyCommonFilters(filter, req.query);

    if (inStock === "true") filter.stock = { $gt: 0 };
    if (featured === "true") filter.isFeatured = true;

    // Regex rather than $text so partial matches work ("swi" finds "SWIFT-18"),
    // which a text index cannot do.
    if (search) {
        const re = new RegExp(escapeRegex(search), "i");
        filter.$or = [
            { name: re },
            { brand: re },
            { vehicleModel: re },
            { sku: re },
            { description: re },
        ];
    }

    const [products, total] = await Promise.all([
        Product.find(filter)
            .sort(SORT_MAP[sort] || SORT_MAP.newest)
            .skip(skip)
            .limit(limit)
            .populate("category", "name slug")
            .lean({ virtuals: true }),
        Product.countDocuments(filter),
    ]);

    return ok(res, { products, meta: buildMeta(page, limit, total) }, "Products fetched.");
});

/**
 * @route GET /api/products/admin — admin only.
 * The product-management table: hidden products included, searchable by name
 * or SKU, filterable by category and stock bucket, paginated.
 * Query: page, limit, search, category, brand, vehicleType, badge,
 *        status (all|visible|hidden), stock (all|in|low|out), sort
 */
export const listAdminProducts = asyncHandler(async (req, res) => {
    const { page, limit, skip } = parsePagination(req.query);
    const { search, category, status = "all", stock = "all", sort = "newest" } = req.query;

    const filter = {};

    if (category) await applyCategoryFilter(filter, category);
    applyCommonFilters(filter, req.query);
    applyStockFilter(filter, stock);

    if (status === "visible") filter.isActive = true;
    if (status === "hidden") filter.isActive = false;

    // Name or SKU — the two things an admin has in front of them.
    if (search) {
        const re = new RegExp(escapeRegex(search), "i");
        filter.$or = [{ name: re }, { sku: re }, { brand: re }, { vehicleModel: re }];
    }

    const [products, total, summary] = await Promise.all([
        Product.find(filter)
            .sort(SORT_MAP[sort] || SORT_MAP.newest)
            .skip(skip)
            .limit(limit)
            .populate("category", "name slug")
            .lean({ virtuals: true }),
        Product.countDocuments(filter),
        // Catalog-wide totals for the header count and the filter chips —
        // one pass instead of five countDocuments round-trips.
        Product.aggregate([
            {
                $group: {
                    _id: null,
                    total: { $sum: 1 },
                    visible: { $sum: { $cond: ["$isActive", 1, 0] } },
                    hidden: { $sum: { $cond: ["$isActive", 0, 1] } },
                    outOfStock: { $sum: { $cond: [{ $lte: ["$stock", 0] }, 1, 0] } },
                    lowStock: {
                        $sum: {
                            $cond: [
                                {
                                    $and: [
                                        { $gt: ["$stock", 0] },
                                        { $lte: ["$stock", LOW_STOCK_THRESHOLD] },
                                    ],
                                },
                                1,
                                0,
                            ],
                        },
                    },
                    inStock: { $sum: { $cond: [{ $gt: ["$stock", LOW_STOCK_THRESHOLD] }, 1, 0] } },
                },
            },
            { $project: { _id: 0 } },
        ]),
    ]);

    return ok(
        res,
        {
            products,
            meta: buildMeta(page, limit, total),
            summary: summary[0] || {
                total: 0,
                visible: 0,
                hidden: 0,
                inStock: 0,
                lowStock: 0,
                outOfStock: 0,
            },
            lowStockThreshold: LOW_STOCK_THRESHOLD,
        },
        "Products fetched.",
    );
});

/**
 * @route GET /api/products/options
 * Everything the Add/Edit Product form's dropdowns need, in one call, so the
 * client never hardcodes a value the API would reject.
 */
export const productOptions = asyncHandler(async (req, res) => {
    const [categories, brands, colours] = await Promise.all([
        Category.find({ isActive: true }).sort({ sortOrder: 1, name: 1 }).select("name slug").lean(),
        Product.distinct("brand"),
        Product.distinct("colour"),
    ]);

    return ok(
        res,
        {
            categories,
            brands: brands.filter(Boolean).sort(),
            colours: colours.filter(Boolean).sort(),
            vehicleTypes: VEHICLE_TYPES,
            badges: PRODUCT_BADGES,
            sorts: Object.keys(SORT_MAP),
            stockFilters: ["all", "in", "low", "out"],
            statusFilters: ["all", "visible", "hidden"],
            lowStockThreshold: LOW_STOCK_THRESHOLD,
            maxImages: MAX_PRODUCT_IMAGES,
            imageUploadEnabled: isImageUploadConfigured(),
        },
        "Product options fetched.",
    );
});

/** @route GET /api/products/brands — distinct brand list for filter UIs. */
export const listBrands = asyncHandler(async (req, res) => {
    const brands = await Product.distinct("brand", { isActive: true });
    return ok(res, { brands: brands.filter(Boolean).sort() }, "Brands fetched.");
});

/** @route GET /api/products/featured */
export const featuredProducts = asyncHandler(async (req, res) => {
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10));
    const products = await Product.find({ isActive: true, isFeatured: true })
        .sort({ createdAt: -1 })
        .limit(limit)
        .populate("category", "name slug")
        .lean({ virtuals: true });

    return ok(res, { products, count: products.length }, "Featured products fetched.");
});

/**
 * @route GET /api/products/admin/:id — admin only.
 * The edit form needs to load hidden products too, which the public endpoint
 * deliberately 404s on.
 */
export const getAdminProduct = asyncHandler(async (req, res) => {
    const product = await Product.findById(req.params.id)
        .populate("category", "name slug")
        .lean({ virtuals: true });

    if (!product) throw notFound("Product not found.");
    return ok(res, { product }, "Product fetched.");
});

/** @route GET /api/products/:idOrSlug */
export const getProduct = asyncHandler(async (req, res) => {
    const { idOrSlug } = req.params;
    const query = isValidObjectId(idOrSlug)
        ? { _id: idOrSlug }
        : { slug: String(idOrSlug).toLowerCase() };

    const product = await Product.findOne(query)
        .populate("category", "name slug")
        .lean({ virtuals: true });

    if (!product || !product.isActive) throw notFound("Product not found.");

    const related = await Product.find({
        category: product.category?._id,
        _id: { $ne: product._id },
        isActive: true,
    })
        .limit(8)
        .select("name slug price compareAtPrice images stock brand badge")
        .lean({ virtuals: true });

    return ok(res, { product, related }, "Product fetched.");
});

/**
 * @route POST /api/products/images — admin only.
 * Multipart upload for the form's image picker. Returns the image objects to
 * put in the product's `images` array — the first one is the main photo.
 */
export const uploadImages = asyncHandler(async (req, res) => {
    if (!isImageUploadConfigured()) {
        throw badRequest(
            "Image uploads are not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET.",
        );
    }

    const files = [...(req.files?.images || []), ...(req.files?.image || [])];
    if (!files.length) throw badRequest('No image received. Send files under the field "images".');

    const alts = Array.isArray(req.body?.alt) ? req.body.alt : [req.body?.alt].filter(Boolean);

    const images = await Promise.all(
        files.map((file, index) =>
            uploadImageBuffer(file.buffer, { alt: alts[index] || req.body?.alt || "" }),
        ),
    );

    return created(res, { images, count: images.length }, "Images uploaded.");
});

/** @route POST /api/products — admin only. */
export const createProduct = asyncHandler(async (req, res) => {
    requireFields(req.body, ["name", "price", "category"]);

    const payload = pickWritable(req.body);
    payload.category = await resolveCategoryId(payload.category);
    assertValidPayload(payload);

    const product = await Product.create(payload);
    await product.populate("category", "name slug");

    return created(res, { product }, "Product created.");
});

/** @route PATCH /api/products/:id — admin only. */
export const updateProduct = asyncHandler(async (req, res) => {
    const product = await Product.findById(req.params.id);
    if (!product) throw notFound("Product not found.");

    const payload = pickWritable(req.body);
    if (payload.category !== undefined) {
        payload.category = await resolveCategoryId(payload.category);
    }
    assertValidPayload(payload, product);

    // Images dropped from the set are no longer referenced anywhere, so remove
    // them from storage rather than leaving them to pile up.
    const removedPublicIds =
        payload.images === undefined
            ? []
            : product.images
                  .filter(
                      (existing) =>
                          existing.publicId &&
                          !payload.images.some((next) => next.publicId === existing.publicId),
                  )
                  .map((existing) => existing.publicId);

    // Slug is immutable once set — changing it would break existing links.
    Object.assign(product, payload);
    await product.save();
    await product.populate("category", "name slug");

    if (removedPublicIds.length) await destroyImages(removedPublicIds);

    return ok(res, { product }, "Product updated.");
});

/**
 * @route PATCH /api/products/:id/visibility — admin only.
 * Backs the list's VISIBLE / HIDDEN toggle. Body {isActive} sets it
 * explicitly; an empty body flips it.
 */
export const toggleProductVisibility = asyncHandler(async (req, res) => {
    const product = await Product.findById(req.params.id);
    if (!product) throw notFound("Product not found.");

    product.isActive =
        req.body?.isActive === undefined ? !product.isActive : Boolean(req.body.isActive);
    await product.save();

    return ok(
        res,
        { product: { _id: product._id, name: product.name, isActive: product.isActive } },
        product.isActive ? "Product is now visible." : "Product is now hidden.",
    );
});

/**
 * @route DELETE /api/products/:id — admin only.
 * Soft delete by default so existing orders keep resolving their product
 * references. ?hard=true removes the document outright.
 */
export const deleteProduct = asyncHandler(async (req, res) => {
    const product = await Product.findById(req.params.id);
    if (!product) throw notFound("Product not found.");

    if (req.query.hard === "true") {
        const publicIds = product.images.map((image) => image.publicId).filter(Boolean);
        await product.deleteOne();
        if (publicIds.length) await destroyImages(publicIds);
        return ok(res, null, "Product permanently deleted.");
    }

    product.isActive = false;
    await product.save();
    return ok(res, { product }, "Product deactivated.");
});
