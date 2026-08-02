import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";

import authRoutes from "./routes/auth.routes.js";
import userRoutes from "./routes/user.routes.js";
import categoryRoutes from "./routes/category.routes.js";
import productRoutes from "./routes/product.routes.js";
import cartRoutes from "./routes/cart.routes.js";
import wishlistRoutes from "./routes/wishlist.routes.js";
import orderRoutes from "./routes/order.routes.js";
import couponRoutes from "./routes/coupon.routes.js";

import { notFoundHandler, errorHandler } from "./middlewares/error.middleware.js";
import { requestId } from "./middlewares/requestId.middleware.js";

const app = express();

// First in the chain so every later log line — email sends especially — can be
// tied back to the request that caused it.
app.use(requestId);

// Behind a proxy (Render/Railway/nginx), req.ip must come from
// X-Forwarded-For or every request looks like it's from the proxy —
// which would make IP rate limiting useless.
app.set("trust proxy", 1);

// --- CORS --------------------------------------------------------------------
// credentials:true is required for the httpOnly auth cookies to be sent, and
// that forbids a wildcard origin — hence the explicit allowlist.
const allowedOrigins = (process.env.CLIENT_URL || "http://localhost:3000")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

app.use(
    cors({
        origin(origin, callback) {
            // No origin = same-origin, curl, or Postman — allow it.
            if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
            return callback(new Error(`Origin ${origin} is not allowed by CORS.`));
        },
        credentials: true,
        methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    }),
);

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.use(cookieParser());

// Baseline flood protection. Per-endpoint limits in auth.routes.js are stricter.
app.use(
    "/api",
    rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 500,
        message: { success: false, message: "Too many requests. Please slow down." },
        standardHeaders: true,
        legacyHeaders: false,
    }),
);

app.get("/health", (_req, res) =>
    res.status(200).json({
        success: true,
        message: "DRIVMAN API is running.",
        environment: process.env.NODE_ENV || "development",
        timestamp: new Date().toISOString(),
    }),
);

app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/categories", categoryRoutes);
app.use("/api/products", productRoutes);
app.use("/api/cart", cartRoutes);
app.use("/api/wishlist", wishlistRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/coupons", couponRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
