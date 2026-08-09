import dotenv from "dotenv";

dotenv.config();

const { connectDB, disconnectDB } = await import("../src/config/db.js");
const { User } = await import("../src/models/user.model.js");

/**
 * Drops the leftover UNIQUE index on users.phone and replaces it with a plain
 * one.
 *
 * Removing `unique: true` from the schema does not touch an index that already
 * exists in MongoDB — the old constraint keeps rejecting inserts, which is why
 * signup still fails with a duplicate-key error even though the code allows
 * shared numbers. This closes that gap.
 *
 * The replacement index is not optional: login, OTP requests and admin search
 * all query by phone, and dropping the index outright would turn each of those
 * into a collection scan.
 *
 * Idempotent — safe to re-run, and safe to run before deploying the code
 * change, since a non-unique index breaks nothing that worked before.
 *
 *   npm run fix:phone-index
 *   npm run fix:phone-index -- --dry-run
 */
const DRY_RUN = process.argv.includes("--dry-run");

const run = async () => {
    await connectDB();
    const collection = User.collection;

    const indexes = await collection.indexes();
    const existing = indexes.find((index) => index.name === "phone_1");

    if (!existing) {
        console.log("No phone_1 index found — creating a non-unique one.");
        if (!DRY_RUN) await collection.createIndex({ phone: 1 });
        return;
    }

    if (!existing.unique) {
        console.log("phone_1 is already non-unique. Nothing to do.");
        return;
    }

    // Duplicates cannot exist yet (the unique index forbade them), but check
    // anyway — this script may be re-run after the constraint is long gone.
    const duplicates = await collection
        .aggregate([
            { $group: { _id: "$phone", count: { $sum: 1 } } },
            { $match: { count: { $gt: 1 } } },
        ])
        .toArray();

    console.log(`Found unique index phone_1. Phones used by >1 account: ${duplicates.length}`);

    if (DRY_RUN) {
        console.log("--dry-run: would drop phone_1 and recreate it without `unique`.");
        return;
    }

    await collection.dropIndex("phone_1");
    console.log("Dropped unique index phone_1.");

    await collection.createIndex({ phone: 1 });
    console.log("Created non-unique index phone_1.");

    const after = await collection.indexes();
    const replacement = after.find((index) => index.name === "phone_1");
    console.log(`Verified: phone_1 unique = ${Boolean(replacement?.unique)}`);
};

try {
    await run();
    console.log("Done.");
} catch (error) {
    console.error("Failed:", error.message);
    process.exitCode = 1;
} finally {
    await disconnectDB();
}
