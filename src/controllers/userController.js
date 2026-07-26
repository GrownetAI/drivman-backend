import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { User } from "../models/user.model.js";
import {
  sendOtpSms,
  checkOtp,
  OTP_EXPIRY_MINUTES,
} from "../services/otpServices.js";

const PENDING_VERIFICATION_TOKEN_EXPIRY = `${OTP_EXPIRY_MINUTES}m`;

// Normal session token, issued after verification / on login
const FULL_SESSION_TOKEN_EXPIRY = process.env.JWT_EXPIRES_IN || "7d";

const generateToken = (id, expiresIn = FULL_SESSION_TOKEN_EXPIRY) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn });
};

const cookieOptions = (maxAgeMs = 7 * 24 * 60 * 60 * 1000) => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production", // HTTPS only in prod
  sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
  maxAge: maxAgeMs,
});

/**
 * Shared helper: issues JWT + cookie + response for any successful
 * signup or login. Defaults to a full 7-day session token.
 * Pass a shorter tokenExpiresIn (e.g. "2m") for the pending-verification
 * token issued right after signup.
 */
const issueSession = (
  res,
  user,
  message,
  statusCode = 200,
  tokenExpiresIn = FULL_SESSION_TOKEN_EXPIRY,
) => {
  const token = generateToken(user._id, tokenExpiresIn);

  const userResponse = user.toObject();
  delete userResponse.password;
  delete userResponse.otp;
  delete userResponse.otpExpiresAt;

  // Cookie maxAge in ms — mirror the token's own lifetime so the cookie
  // doesn't outlive the JWT it holds (2 min for pending, 7 days for full)
  const cookieMaxAgeMs =
    tokenExpiresIn === PENDING_VERIFICATION_TOKEN_EXPIRY
      ? OTP_EXPIRY_MINUTES * 60 * 1000
      : 7 * 24 * 60 * 60 * 1000;

  res.cookie("token", token, cookieOptions(cookieMaxAgeMs));

  return res.status(statusCode).json({
    success: true,
    message,
    user: userResponse,
    token,
    expiresIn: tokenExpiresIn,
  });
};

/**
 * @route POST /api/users/signup
 * Creates the account and issues a short-lived (2 min) pending token —
 * enough to call verify-signup-otp, but it expires on its own if the
 * user doesn't verify in time. isActive stays false, and protected
 * routes stay locked, until verification succeeds.
 */
export const signup = async (req, res) => {
  try {
    const { fullName, email, phone, password } = req.body;

    if (!fullName || !email || !phone || !password) {
      return res.status(400).json({
        success: false,
        message: "fullName, email, phone and password are all required.",
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 6 characters long.",
      });
    }

    const existingUser = await User.findOne({
      $or: [{ email: email.toLowerCase() }, { phone }],
    });

    if (existingUser) {
      return res.status(409).json({
        success: false,
        message:
          existingUser.email === email.toLowerCase()
            ? "Email is already registered."
            : "Phone number is already registered.",
      });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const newUser = await User.create({
      fullName,
      email,
      phone,
      password: hashedPassword,
      // isActive stays false until OTP is verified
    });

    // Everything past this point is "post-creation" — if any of it
    // throws, we roll back the user we just created rather than
    // leaving an orphaned account blocking future signups with
    // this email/phone.
    try {
      // Trigger Twilio Verify to generate + send the OTP.
      // Twilio owns the OTP's storage and expiry from here — we don't.
      sendOtpSms(phone).catch(() => {
        // Non-fatal: user can request a fresh OTP later via /send-otp.
        // Not awaited so a slow/failed SMS provider never blocks signup.
      });

      return issueSession(
        res,
        newUser,
        `Account created. Please verify the OTP sent to your phone within ${OTP_EXPIRY_MINUTES} minutes.`,
        201,
        PENDING_VERIFICATION_TOKEN_EXPIRY,
      );
    } catch (postCreateError) {
      await User.deleteOne({ _id: newUser._id });
      throw postCreateError; // let the outer catch below format the response
    }
  } catch (error) {
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern)[0];
      return res.status(409).json({
        success: false,
        message: `${field} is already registered.`,
      });
    }
    return res.status(500).json({
      success: false,
      message: "Signup failed.",
      error: error.message,
    });
  }
};

/**
 * @route POST /api/users/verify-signup-otp
 * Body: { phone, otp }
 * Asks Twilio Verify to confirm the OTP, then marks the phone as
 * verified (isActive: true) and issues a fresh full-length session token.
 */
export const verifySignupOtp = async (req, res) => {
  try {
    const { phone, otp } = req.body;

    if (!phone || !otp) {
      return res.status(400).json({
        success: false,
        message: "Phone number and OTP are required.",
      });
    }

    const user = await User.findOne({ phone });
    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Invalid or expired OTP.",
      });
    }

    const isApproved = await checkOtp(phone, otp);
    if (!isApproved) {
      return res.status(401).json({
        success: false,
        message: "Invalid or expired OTP. Please request a new one.",
      });
    }

    user.isActive = true;
    await user.save({ validateBeforeSave: false });

    return issueSession(
      res,
      user,
      "Phone number verified successfully. You now have full access.",
      200,
      // no tokenExpiresIn override — defaults to full 7-day session
    );
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "OTP verification failed.",
      error: error.message,
    });
  }
};

/**
 * @route POST /api/users/login
 * Returning-user login. Body must include "phone", plus EITHER
 * "password" OR "otp" — whichever the user chooses.
 * Email-based login is intentionally not supported here since the
 * product flow is phone + password/OTP only.
 */
export const login = async (req, res) => {
  try {
    const { phone, password, otp } = req.body;

    if (!phone || (!password && !otp)) {
      return res.status(400).json({
        success: false,
        message: "Phone number and either a password or OTP are required.",
      });
    }

    if (password && otp) {
      return res.status(400).json({
        success: false,
        message: "Provide either a password or an OTP, not both.",
      });
    }

    if (password) {
      const user = await User.findOne({ phone }).select("+password");

      if (!user) {
        return res.status(401).json({
          success: false,
          message: "Invalid credentials.",
        });
      }

      const isMatch = await bcrypt.compare(password, user.password);
      if (!isMatch) {
        return res.status(401).json({
          success: false,
          message: "Invalid credentials.",
        });
      }

      return issueSession(res, user, "Logged in successfully.");
    }

    // OTP path
    const user = await User.findOne({ phone });
    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Invalid or expired OTP.",
      });
    }

    const isApproved = await checkOtp(phone, otp);
    if (!isApproved) {
      return res.status(401).json({
        success: false,
        message: "Invalid or expired OTP.",
      });
    }

    return issueSession(res, user, "Logged in successfully.");
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Login failed.",
      error: error.message,
    });
  }
};

/**
 * @route POST /api/users/logout
 */
export const logout = async (req, res) => {
  try {
    res.clearCookie("token", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    });

    return res.status(200).json({
      success: true,
      message: "Logged out successfully.",
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Logout failed.",
      error: error.message,
    });
  }
};

/**
 * @route GET /api/users/me
 * Requires isAuthenticated middleware — returns current logged-in user
 */
export const getMe = async (req, res) => {
  try {
    return res.status(200).json({
      success: true,
      user: req.user,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Could not fetch user.",
      error: error.message,
    });
  }
};

/**
 * @route POST /api/users/send-otp
 * Body: { phone: "+919876543210" }
 * Triggers Twilio Verify to generate + send a fresh OTP.
 * If the user isn't verified yet, also reissues a fresh short-lived
 * pending token (their original signup token may have already expired).
 */
export const sendOtp = async (req, res) => {
  try {
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({
        success: false,
        message: "Phone number is required.",
      });
    }

    // Same generic response whether user exists or not —
    // prevents attackers from using this endpoint to discover
    // which phone numbers are registered.
    const user = await User.findOne({ phone });

    if (user) {
      try {
        await sendOtpSms(phone);
      } catch (smsError) {
        return res.status(502).json({
          success: false,
          message: "Failed to send OTP. Please try again.",
        });
      }

      // Not yet verified (still mid-signup) — give them a fresh
      // pending token too, since their original one may have expired.
      if (!user.isActive) {
        return issueSession(
          res,
          user,
          `A new OTP has been sent. Please verify within ${OTP_EXPIRY_MINUTES} minutes.`,
          200,
          PENDING_VERIFICATION_TOKEN_EXPIRY,
        );
      }
    }

    return res.status(200).json({
      success: true,
      message: "If this phone number is registered, an OTP has been sent.",
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Could not process OTP request.",
      error: error.message,
    });
  }
};
