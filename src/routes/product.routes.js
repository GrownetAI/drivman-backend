import express from "express";
import {
    listProducts,
    listAdminProducts,
    productOptions,
    listBrands,
    featuredProducts,
    getAdminProduct,
    getProduct,
    uploadImages,
    createProduct,
    updateProduct,
    toggleProductVisibility,
    deleteProduct,
} from "../controllers/productController.js";
import { requireAuth, requireRole } from "../middlewares/auth.middleware.js";
import { uploadProductImages } from "../middlewares/upload.middleware.js";

const router = express.Router();

// Every management route sits behind this pair: authenticated *and* role
// "admin". Applied per-route rather than with router.use so the public
// browsing routes below can never accidentally inherit it — or lose it.
const adminOnly = [requireAuth, requireRole("admin")];

// --- Admin: product management ------------------------------------------------
// Declared before the public /:idOrSlug route so "admin", "options" and
// "images" aren't swallowed by the catch-all param route.
router.get("/admin", ...adminOnly, listAdminProducts);
router.get("/admin/:id", ...adminOnly, getAdminProduct);
router.get("/options", ...adminOnly, productOptions);

router.post("/images", ...adminOnly, uploadProductImages, uploadImages);

router.post("/", ...adminOnly, createProduct);
router.patch("/:id", ...adminOnly, updateProduct);
router.patch("/:id/visibility", ...adminOnly, toggleProductVisibility);
router.delete("/:id", ...adminOnly, deleteProduct);

// --- Public storefront browsing ----------------------------------------------
router.get("/", listProducts);
router.get("/brands", listBrands);
router.get("/featured", featuredProducts);
router.get("/:idOrSlug", getProduct);

export default router;
