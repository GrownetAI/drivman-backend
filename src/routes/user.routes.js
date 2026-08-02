import express from "express";
import {
    getProfile,
    updateProfile,
    listAddresses,
    addAddress,
    updateAddress,
    deleteAddress,
    setDefaultAddress,
    listUsers,
    listCustomers,
    setUserStatus,
} from "../controllers/userController.js";
import { requireAuth, requireRole } from "../middlewares/auth.middleware.js";

const router = express.Router();

router.use(requireAuth);

router.get("/profile", getProfile);
router.patch("/profile", updateProfile);

router.get("/addresses", listAddresses);
router.post("/addresses", addAddress);
router.patch("/addresses/:addressId", updateAddress);
router.delete("/addresses/:addressId", deleteAddress);
router.patch("/addresses/:addressId/default", setDefaultAddress);

// Admin
router.get("/admin/customers", requireRole("admin"), listCustomers);
router.get("/", requireRole("admin"), listUsers);
router.patch("/:id/status", requireRole("admin"), setUserStatus);

export default router;
