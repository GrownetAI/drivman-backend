import { v2 as cloudinary } from "cloudinary";
import { logger } from "../utils/logger.js";

/**
 * Product image storage on Cloudinary.
 *
 * Configuration is read on first use rather than at import time — server.js
 * loads dotenv before importing the app, but the seed scripts and tests import
 * models directly, and they must not blow up over an unset image key.
 */
const log = logger.child({ service: "imageUpload" });

const FOLDER = process.env.CLOUDINARY_FOLDER || "drivman/products";

let configured = false;

export const isImageUploadConfigured = () =>
    Boolean(
        process.env.CLOUDINARY_CLOUD_NAME &&
            process.env.CLOUDINARY_API_KEY &&
            process.env.CLOUDINARY_API_SECRET,
    );

const ensureConfigured = () => {
    if (configured) return;
    cloudinary.config({
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key: process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET,
        secure: true,
    });
    configured = true;
};

/**
 * Uploads one in-memory file and resolves to the image shape the Product model
 * stores: { url, publicId, alt }.
 */
export const uploadImageBuffer = (buffer, { alt = "", folder = FOLDER } = {}) => {
    ensureConfigured();

    return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
            {
                folder,
                resource_type: "image",
                // Strip metadata and let Cloudinary pick the best format/quality —
                // catalog photos come straight off a phone and are needlessly large.
                transformation: [{ quality: "auto", fetch_format: "auto" }],
            },
            (error, result) => {
                if (error) return reject(error);
                resolve({ url: result.secure_url, publicId: result.public_id, alt });
            },
        );

        stream.end(buffer);
    });
};

/**
 * Best-effort delete. Losing an asset is not worth failing the request that
 * replaced it, so failures are logged and swallowed.
 */
export const destroyImage = async (publicId) => {
    if (!publicId || !isImageUploadConfigured()) return false;

    try {
        ensureConfigured();
        await cloudinary.uploader.destroy(publicId);
        return true;
    } catch (error) {
        log.warn("Failed to delete image from Cloudinary.", { publicId, error: error.message });
        return false;
    }
};

export const destroyImages = async (publicIds = []) => {
    await Promise.all(publicIds.filter(Boolean).map(destroyImage));
};
