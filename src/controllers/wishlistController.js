import { Wishlist } from "../models/wishlist.model.js";
import { Cart } from "../models/cart.model.js";
import { Product } from "../models/product.model.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ok } from "../utils/ApiResponse.js";
import { badRequest, notFound } from "../utils/ApiError.js";
import { requireFields, assertObjectId } from "../utils/validators.js";

const getOrCreateWishlist = async (userId) => {
    const existing = await Wishlist.findOne({ user: userId });
    if (existing) return existing;
    return Wishlist.create({ user: userId, products: [] });
};

/** @route GET /api/wishlist */
export const getWishlist = asyncHandler(async (req, res) => {
    const wishlist = await getOrCreateWishlist(req.user._id);

    await wishlist.populate({
        path: "products",
        match: { isActive: true },
        select: "name slug price compareAtPrice images stock brand vehicleModel pieces category",
        populate: { path: "category", select: "name slug" },
    });

    // populate(match) yields null for products that no longer qualify —
    // strip them from the stored list so it doesn't accumulate dead refs.
    const live = wishlist.products.filter(Boolean);
    if (live.length !== wishlist.products.length) {
        wishlist.products = live.map((p) => p._id);
        await wishlist.save();
    }

    const products = live.map((p) => ({
        _id: p._id,
        name: p.name,
        slug: p.slug,
        price: p.price,
        compareAtPrice: p.compareAtPrice,
        image: p.images?.[0]?.url || null,
        brand: p.brand,
        vehicleModel: p.vehicleModel,
        pieces: p.pieces,
        category: p.category,
        inStock: p.stock > 0,
        stock: p.stock,
    }));

    return ok(res, { products, count: products.length }, "Wishlist fetched.");
});

/**
 * @route POST /api/wishlist   Body: { productId }
 * Idempotent — adding the same product twice is a no-op, not an error.
 */
export const addToWishlist = asyncHandler(async (req, res) => {
    requireFields(req.body, ["productId"]);
    const productId = assertObjectId(req.body.productId, "productId");

    const product = await Product.findById(productId).select("name isActive");
    if (!product || !product.isActive) throw notFound("Product not found.");

    const wishlist = await getOrCreateWishlist(req.user._id);
    const already = wishlist.products.some((p) => String(p) === String(productId));

    if (!already) {
        wishlist.products.push(productId);
        await wishlist.save();
    }

    return ok(
        res,
        { productId, count: wishlist.products.length, alreadyPresent: already },
        already ? `"${product.name}" is already in your wishlist.` : `"${product.name}" added to wishlist.`,
    );
});

/** @route DELETE /api/wishlist/:productId */
export const removeFromWishlist = asyncHandler(async (req, res) => {
    const productId = assertObjectId(req.params.productId, "productId");

    const wishlist = await getOrCreateWishlist(req.user._id);
    const before = wishlist.products.length;
    wishlist.products = wishlist.products.filter((p) => String(p) !== String(productId));

    if (wishlist.products.length === before) {
        throw notFound("That product is not in your wishlist.");
    }

    await wishlist.save();
    return ok(res, { count: wishlist.products.length }, "Removed from wishlist.");
});

/**
 * @route POST /api/wishlist/:productId/move-to-cart   Body: { quantity }
 * Moves an item across in one call — the "Move to bag" button.
 */
export const moveToCart = asyncHandler(async (req, res) => {
    const productId = assertObjectId(req.params.productId, "productId");
    const quantity = parseInt(req.body?.quantity, 10) || 1;

    const wishlist = await getOrCreateWishlist(req.user._id);
    if (!wishlist.products.some((p) => String(p) === String(productId))) {
        throw notFound("That product is not in your wishlist.");
    }

    const product = await Product.findById(productId);
    if (!product || !product.isActive) throw notFound("Product is no longer available.");
    if (product.stock < quantity) {
        throw badRequest(
            product.stock === 0
                ? `"${product.name}" is out of stock.`
                : `Only ${product.stock} unit(s) of "${product.name}" are available.`,
        );
    }

    let cart = await Cart.findOne({ user: req.user._id });
    if (!cart) cart = await Cart.create({ user: req.user._id, items: [] });

    const existing = cart.items.find((i) => String(i.product) === String(productId));
    const desired = existing ? existing.quantity + quantity : quantity;

    if (desired > product.stock) {
        throw badRequest(`Only ${product.stock} unit(s) of "${product.name}" are available.`);
    }

    if (existing) existing.quantity = desired;
    else cart.items.push({ product: productId, quantity, addedAt: new Date() });

    await cart.save();

    wishlist.products = wishlist.products.filter((p) => String(p) !== String(productId));
    await wishlist.save();

    return ok(
        res,
        { productId, cartQuantity: desired, wishlistCount: wishlist.products.length },
        `"${product.name}" moved to your cart.`,
    );
});

/** @route DELETE /api/wishlist */
export const clearWishlist = asyncHandler(async (req, res) => {
    const wishlist = await getOrCreateWishlist(req.user._id);
    wishlist.products = [];
    await wishlist.save();
    return ok(res, { count: 0 }, "Wishlist cleared.");
});
