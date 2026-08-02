import express from "express";
import {
    getCart,
    addToCart,
    updateCartItem,
    removeFromCart,
    clearCart,
} from "../controllers/cartController.js";
import { requireAuth, requireVerifiedEmail } from "../middlewares/auth.middleware.js";

const router = express.Router();

// A cart belongs to a verified account — every route here is gated.
router.use(requireAuth, requireVerifiedEmail);

router.get("/", getCart);
router.post("/items", addToCart);
router.patch("/items/:productId", updateCartItem);
router.delete("/items/:productId", removeFromCart);
router.delete("/", clearCart);

export default router;
