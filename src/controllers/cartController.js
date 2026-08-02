import { Cart } from "../models/cart.model.js";
import { Product } from "../models/product.model.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ok } from "../utils/ApiResponse.js";
import { badRequest, notFound } from "../utils/ApiError.js";
import { requireFields, assertObjectId } from "../utils/validators.js";

const MAX_QTY_PER_ITEM = 10;

const getOrCreateCart = async (userId) => {
    const existing = await Cart.findOne({ user: userId });
    if (existing) return existing;
    return Cart.create({ user: userId, items: [] });
};

/**
 * Builds the client-facing cart. Prices come from the live Product, never from
 * the cart document, so a price change is reflected immediately.
 *
 * Products that were deleted or deactivated since being added are dropped from
 * the response AND pruned from the stored cart — a cart should never reference
 * something the user can no longer buy.
 */
const buildCartResponse = async (cart) => {
    await cart.populate({
        path: "items.product",
        select: "name slug price compareAtPrice images stock isActive brand vehicleModel pieces",
    });

    const validItems = [];
    const removed = [];

    for (const item of cart.items) {
        if (!item.product || !item.product.isActive) {
            removed.push(item.product?.name || "An unavailable product");
            continue;
        }
        validItems.push(item);
    }

    if (removed.length !== 0) {
        cart.items = cart.items.filter((i) => i.product && i.product.isActive);
        await cart.save();
    }

    const items = validItems.map((item) => {
        const p = item.product;
        // Cap the displayed quantity at available stock so the shown subtotal
        // matches what checkout will actually charge.
        const quantity = Math.min(item.quantity, p.stock);
        return {
            product: {
                _id: p._id,
                name: p.name,
                slug: p.slug,
                price: p.price,
                compareAtPrice: p.compareAtPrice,
                image: p.images?.[0]?.url || null,
                brand: p.brand,
                vehicleModel: p.vehicleModel,
                pieces: p.pieces,
                stock: p.stock,
            },
            quantity: item.quantity,
            availableQuantity: quantity,
            hasStockIssue: item.quantity > p.stock,
            unitPrice: p.price,
            subtotal: Number((p.price * quantity).toFixed(2)),
            addedAt: item.addedAt,
        };
    });

    const itemsTotal = Number(items.reduce((sum, i) => sum + i.subtotal, 0).toFixed(2));
    const totalQuantity = items.reduce((sum, i) => sum + i.availableQuantity, 0);

    return {
        cartId: cart._id,
        items,
        summary: {
            distinctItems: items.length,
            totalQuantity,
            itemsTotal,
        },
        ...(removed.length !== 0 && {
            notice: `${removed.length} unavailable item(s) were removed from your cart.`,
        }),
    };
};

/** @route GET /api/cart */
export const getCart = asyncHandler(async (req, res) => {
    const cart = await getOrCreateCart(req.user._id);
    return ok(res, await buildCartResponse(cart), "Cart fetched.");
});

/**
 * @route POST /api/cart/items   Body: { productId, quantity }
 * Adding a product already in the cart increments its quantity.
 */
export const addToCart = asyncHandler(async (req, res) => {
    requireFields(req.body, ["productId"]);
    const productId = assertObjectId(req.body.productId, "productId");
    const quantity = parseInt(req.body.quantity, 10) || 1;

    if (quantity < 1) throw badRequest("Quantity must be at least 1.");

    const product = await Product.findById(productId);
    if (!product || !product.isActive) throw notFound("Product not found.");
    if (product.stock < 1) throw badRequest(`"${product.name}" is out of stock.`);

    const cart = await getOrCreateCart(req.user._id);
    const existing = cart.items.find((i) => String(i.product) === String(productId));

    const desired = existing ? existing.quantity + quantity : quantity;

    if (desired > product.stock) {
        throw badRequest(
            `Only ${product.stock} unit(s) of "${product.name}" are available.` +
                (existing ? ` You already have ${existing.quantity} in your cart.` : ""),
        );
    }
    if (desired > MAX_QTY_PER_ITEM) {
        throw badRequest(`You can order at most ${MAX_QTY_PER_ITEM} units of a single product.`);
    }

    if (existing) {
        existing.quantity = desired;
    } else {
        cart.items.push({ product: productId, quantity, addedAt: new Date() });
    }

    await cart.save();
    return ok(res, await buildCartResponse(cart), `"${product.name}" added to cart.`);
});

/**
 * @route PATCH /api/cart/items/:productId   Body: { quantity }
 * Sets an absolute quantity. Quantity 0 removes the line.
 */
export const updateCartItem = asyncHandler(async (req, res) => {
    const productId = assertObjectId(req.params.productId, "productId");
    requireFields(req.body, ["quantity"]);

    const quantity = parseInt(req.body.quantity, 10);
    if (Number.isNaN(quantity) || quantity < 0) {
        throw badRequest("Quantity must be a non-negative number.");
    }

    const cart = await getOrCreateCart(req.user._id);
    const item = cart.items.find((i) => String(i.product) === String(productId));
    if (!item) throw notFound("That product is not in your cart.");

    if (quantity === 0) {
        cart.items = cart.items.filter((i) => String(i.product) !== String(productId));
        await cart.save();
        return ok(res, await buildCartResponse(cart), "Item removed from cart.");
    }

    const product = await Product.findById(productId);
    if (!product || !product.isActive) throw notFound("Product is no longer available.");
    if (quantity > product.stock) {
        throw badRequest(`Only ${product.stock} unit(s) of "${product.name}" are available.`);
    }
    if (quantity > MAX_QTY_PER_ITEM) {
        throw badRequest(`You can order at most ${MAX_QTY_PER_ITEM} units of a single product.`);
    }

    item.quantity = quantity;
    await cart.save();
    return ok(res, await buildCartResponse(cart), "Cart updated.");
});

/** @route DELETE /api/cart/items/:productId */
export const removeFromCart = asyncHandler(async (req, res) => {
    const productId = assertObjectId(req.params.productId, "productId");

    const cart = await getOrCreateCart(req.user._id);
    const before = cart.items.length;
    cart.items = cart.items.filter((i) => String(i.product) !== String(productId));

    if (cart.items.length === before) throw notFound("That product is not in your cart.");

    await cart.save();
    return ok(res, await buildCartResponse(cart), "Item removed from cart.");
});

/** @route DELETE /api/cart */
export const clearCart = asyncHandler(async (req, res) => {
    const cart = await getOrCreateCart(req.user._id);
    cart.items = [];
    await cart.save();
    return ok(res, await buildCartResponse(cart), "Cart cleared.");
});
