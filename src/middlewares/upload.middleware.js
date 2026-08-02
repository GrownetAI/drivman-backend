import multer from "multer";
import { badRequest } from "../utils/ApiError.js";

/**
 * Memory storage: uploads are streamed straight on to Cloudinary, so writing
 * them to the server's disk first would only create files nobody cleans up.
 */
const MAX_FILE_BYTES = Number(process.env.MAX_UPLOAD_BYTES) || 5 * 1024 * 1024;
export const MAX_PRODUCT_IMAGES = 6;

const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp", "image/avif"];

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_BYTES, files: MAX_PRODUCT_IMAGES },
    fileFilter(_req, file, cb) {
        if (!ALLOWED_MIME.includes(file.mimetype)) {
            return cb(badRequest(`Unsupported image type: ${file.mimetype}. Use JPEG, PNG, WebP or AVIF.`));
        }
        cb(null, true);
    },
});

/**
 * Accepts the form's file input under either name — "images" for the
 * multi-file picker, "image" for a single replacement.
 */
export const uploadProductImages = (req, res, next) =>
    upload.fields([
        { name: "images", maxCount: MAX_PRODUCT_IMAGES },
        { name: "image", maxCount: 1 },
    ])(req, res, (err) => {
        if (!err) return next();

        // Multer's own errors are client mistakes, not bugs — translate them
        // into 400s instead of letting them fall through as 500s.
        if (err instanceof multer.MulterError) {
            if (err.code === "LIMIT_FILE_SIZE") {
                const mb = Math.round(MAX_FILE_BYTES / (1024 * 1024));
                return next(badRequest(`Each image must be ${mb}MB or smaller.`));
            }
            if (err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE") {
                return next(
                    badRequest(
                        `Upload up to ${MAX_PRODUCT_IMAGES} images, using the field name "images".`,
                    ),
                );
            }
            return next(badRequest(err.message));
        }

        next(err);
    });
