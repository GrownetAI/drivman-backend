import express from "express";
import {
    getWishlist,
    addToWishlist,
    removeFromWishlist,
    moveToCart,
    clearWishlist,
} from "../controllers/wishlistController.js";
import { requireAuth, requireVerifiedEmail } from "../middlewares/auth.middleware.js";

const router = express.Router();

router.use(requireAuth, requireVerifiedEmail);

router.get("/", getWishlist);
router.post("/", addToWishlist);
router.delete("/", clearWishlist);
router.post("/:productId/move-to-cart", moveToCart);
router.delete("/:productId", removeFromWishlist);

export default router;
