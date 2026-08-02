import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

const { connectDB, disconnectDB } = await import("../config/db.js");
const { Category, slugify } = await import("../models/category.model.js");
const { Product } = await import("../models/product.model.js");
const { User } = await import("../models/user.model.js");
const { CATALOG, DEFAULT_COLOUR, DEFAULT_STOCK } = await import("./catalog.data.js");

/**
 * Seeds the DRIVMAN catalog: one category per car make, one product per model.
 *
 * Idempotent — re-running updates existing rows (matched on SKU) instead of
 * duplicating them. Pass --fresh to wipe categories and products first.
 *
 *   npm run seed
 *   npm run seed -- --fresh
 *   npm run seed -- --admin
 */

const FRESH = process.argv.includes("--fresh");
const WITH_ADMIN = process.argv.includes("--admin");

/** Pulls "(3 ROW)" / "(4 ROW)" / "WITH DICKY" / "WITH BOOT" out of a model name. */
const parseModelMeta = (modelName) => {
    const rowMatch = modelName.match(/\((\d)\s*-?\s*ROW\)/i);
    const rows = rowMatch ? Number(rowMatch[1]) : null;
    const hasDicky = /DICKY|BOOT/i.test(modelName);
    // The display name keeps the row suffix — it's how customers identify the trim.
    return { rows, hasDicky };
};

const buildDescription = (brand, model, pieces, rows, hasDicky) => {
    const parts = [
        `Custom-fit dashboard cover for the ${brand} ${model}.`,
        `Supplied as a set of ${pieces} pieces in ${DEFAULT_COLOUR}.`,
    ];
    if (rows) parts.push(`Covers all ${rows} seating rows.`);
    if (hasDicky) parts.push("Includes boot/dicky section coverage.");
    parts.push("Precision-cut for an exact fit, anti-slip backing, easy to install and remove.");
    return parts.join(" ");
};

const run = async () => {
    await connectDB();

    if (FRESH) {
        console.log("--fresh: clearing existing categories and products...");
        await Promise.all([Category.deleteMany({}), Product.deleteMany({})]);
    }

    let categoriesCreated = 0;
    let productsCreated = 0;
    let productsUpdated = 0;

    let sortOrder = 0;

    for (const [brand, models] of Object.entries(CATALOG)) {
        const slug = slugify(brand);

        let category = await Category.findOne({ slug });
        if (!category) {
            category = await Category.create({
                name: brand,
                slug,
                description: `Custom-fit dashboard covers for ${brand} vehicles.`,
                parent: null,
                sortOrder: sortOrder++,
                isActive: true,
            });
            categoriesCreated += 1;
        }

        for (const [model, mrp, pieces] of models) {
            const { rows, hasDicky } = parseModelMeta(model);
            // Deterministic SKU is what makes re-seeding an update, not a duplicate.
            const sku = `DRV-${slugify(brand).toUpperCase()}-${slugify(model).toUpperCase()}`;
            const name = `${brand} ${model} Dashboard Cover`;

            const payload = {
                name,
                description: buildDescription(brand, model, pieces, rows, hasDicky),
                brand,
                category: category._id,
                price: mrp,
                stock: DEFAULT_STOCK,
                sku,
                vehicleModel: model,
                colour: DEFAULT_COLOUR,
                pieces,
                rows,
                hasDicky,
                isActive: true,
                images: [],
            };

            const existing = await Product.findOne({ sku });
            if (existing) {
                Object.assign(existing, payload);
                await existing.save();
                productsUpdated += 1;
            } else {
                await Product.create({ ...payload, slug: `${slugify(name)}` });
                productsCreated += 1;
            }
        }

        console.log(`  ${brand}: ${models.length} model(s)`);
    }

    if (WITH_ADMIN) {
        const email = (process.env.ADMIN_EMAIL || "admin@drivman.com").toLowerCase();
        const password = process.env.ADMIN_PASSWORD || "Admin@12345";
        const phone = process.env.ADMIN_PHONE || "+919999999999";

        const existing = await User.findOne({ email });
        if (existing) {
            existing.role = "admin";
            existing.isEmailVerified = true;
            await existing.save({ validateBeforeSave: false });
            console.log(`Admin already existed — promoted: ${email}`);
        } else {
            await User.create({
                fullName: "DRIVMAN Admin",
                email,
                phone,
                password,
                role: "admin",
                isEmailVerified: true,
                isPhoneVerified: true,
            });
            console.log(`Admin created: ${email} / ${password}`);
        }
    }

    const [totalCategories, totalProducts] = await Promise.all([
        Category.countDocuments(),
        Product.countDocuments(),
    ]);

    console.log("\n--- Seed complete ---");
    console.log(`Categories created: ${categoriesCreated} (total: ${totalCategories})`);
    console.log(`Products created:   ${productsCreated}`);
    console.log(`Products updated:   ${productsUpdated} (total: ${totalProducts})`);

    await disconnectDB();
    process.exit(0);
};

run().catch(async (err) => {
    console.error("Seed failed:", err);
    await mongoose.connection.close().catch(() => {});
    process.exit(1);
});
