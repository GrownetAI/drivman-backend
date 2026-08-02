import express from "express";
import {
    listCategories,
    getCategory,
    getCategoryProducts,
    createCategory,
    updateCategory,
    deleteCategory,
} from "../controllers/categoryController.js";
import { requireAuth, requireRole } from "../middlewares/auth.middleware.js";

const router = express.Router();

// Public browsing
router.get("/", listCategories);
router.get("/:idOrSlug", getCategory);
router.get("/:idOrSlug/products", getCategoryProducts);

// Admin management
router.post("/", requireAuth, requireRole("admin"), createCategory);
router.patch("/:id", requireAuth, requireRole("admin"), updateCategory);
router.delete("/:id", requireAuth, requireRole("admin"), deleteCategory);

export default router;
