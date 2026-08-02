import express from "express";
import {
    createOrder,
    verifyPayment,
    listMyOrders,
    getOrder,
    cancelOrder,
    listAllOrders,
    getOrderStats,
    updateOrderStatus,
} from "../controllers/orderController.js";
import { requireAuth, requireVerifiedEmail, requireRole } from "../middlewares/auth.middleware.js";

const router = express.Router();

router.use(requireAuth, requireVerifiedEmail);

// Admin routes are declared before /:id so "admin" isn't parsed as an order id.
router.get("/admin/all", requireRole("admin"), listAllOrders);
router.get("/admin/stats", requireRole("admin"), getOrderStats);

router.post("/", createOrder);
router.get("/", listMyOrders);
router.get("/:id", getOrder);
router.post("/:id/verify-payment", verifyPayment);
router.patch("/:id/cancel", cancelOrder);

router.patch("/:id/status", requireRole("admin"), updateOrderStatus);

export default router;
