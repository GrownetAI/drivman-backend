import jwt from "jsonwebtoken";
import { User } from "../models/user.model.js";
 
/**
 * Verifies the JWT (from httpOnly cookie or Authorization header),
 * attaches the authenticated user to req.user, and calls next().
 */
export const isAuthenticated = async (req, res, next) => {
    try {
        // Token can come from cookie ("token") or "Bearer <token>" header
        const token =
            req.cookies?.token ||
            (req.headers.authorization?.startsWith("Bearer")
                ? req.headers.authorization.split(" ")[1]
                : null);
 
        if (!token) {
            return res.status(401).json({
                success: false,
                message: "Not authenticated. Please log in."
            });
        }
 
        let decoded;
        try {
            decoded = jwt.verify(token, process.env.JWT_SECRET);
        } catch (err) {
            return res.status(401).json({
                success: false,
                message: "Invalid or expired token. Please log in again."
            });
        }
 
        const user = await User.findById(decoded.id).select("-password");
        if (!user) {
            return res.status(401).json({
                success: false,
                message: "User belonging to this token no longer exists."
            });
        }
 
        req.user = user;
        next();
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: "Something went wrong during authentication.",
            error: error.message
        });
    }
};
 
/**
 * Blocks access until the user has verified their phone (isActive: true).
 * Apply this AFTER isAuthenticated on any route that should be off-limits
 * until OTP verification is complete.
 */
export const requireActiveAccount = (req, res, next) => {
    if (!req.user?.isActive) {
        return res.status(403).json({
            success: false,
            message: "Please verify the OTP sent to your phone to continue.",
            isActive: false
        });
    }
    next();
};
 