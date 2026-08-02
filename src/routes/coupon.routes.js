import express from "express";
import {
    listCoupons,
    getCoupon,
    createCoupon,
    updateCoupon,
    setCouponStatus,
    deleteCoupon,
} from "../controllers/couponController.js";
import { requireAuth, requireRole } from "../middlewares/auth.middleware.js";

const router = express.Router();

// Coupons are an admin-only resource — codes are not browsable by customers,
// so the gate goes on the whole router rather than route by route.
router.use(requireAuth, requireRole("admin"));

router.get("/", listCoupons);
router.post("/", createCoupon);
router.get("/:idOrCode", getCoupon);
router.patch("/:id", updateCoupon);
router.patch("/:id/status", setCouponStatus);
router.delete("/:id", deleteCoupon);

export default router;
