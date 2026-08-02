import dotenv from "dotenv";

// Loaded before any other import that reads process.env at module scope.
dotenv.config();

const { default: app } = await import("./src/app.js");
const { connectDB, disconnectDB } = await import("./src/config/db.js");
const { assertEmailConfig } = await import("./src/config/email.config.js");

const PORT = process.env.PORT || 5000;

const REQUIRED_ENV = ["MONGO_URI", "JWT_SECRET"];
const missing = REQUIRED_ENV.filter((key) => !process.env[key]);

if (missing.length) {
    console.error(`Missing required environment variable(s): ${missing.join(", ")}`);
    process.exit(1);
}

if (process.env.JWT_SECRET.length < 32) {
    console.warn("JWT_SECRET is shorter than 32 characters — use a longer random secret.");
}

// Razorpay itself stays optional — an unconfigured store just falls back to
// COD-only checkout (see paymentService.isRazorpayConfigured). But a *partial*
// config, or online payments with no way to verify webhooks, is always a
// mistake worth stopping the deploy for rather than surfacing as a runtime 500.
const razorpayKeyCount = [process.env.RAZORPAY_KEY_ID, process.env.RAZORPAY_KEY_SECRET].filter(
    Boolean,
).length;

if (razorpayKeyCount === 1) {
    console.error(
        "Razorpay is partially configured — set both RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET, or neither.",
    );
    process.exit(1);
}
if (razorpayKeyCount === 2 && !process.env.RAZORPAY_WEBHOOK_SECRET) {
    console.error(
        "RAZORPAY_WEBHOOK_SECRET is required when Razorpay is configured — " +
            "without it, incoming webhooks cannot be verified.",
    );
    process.exit(1);
}

// Signup depends on email, so a missing API key has to stop the deploy rather
// than surface as a 500 on the first signup of the day.
try {
    const { provider } = assertEmailConfig();
    console.log(`Email provider: ${provider}`);
} catch (error) {
    console.error(error.message);
    process.exit(1);
}

let server;

try {
    // Connect first: serving requests before the database is up produces
    // confusing 500s on every data route.
    await connectDB();

    server = app.listen(PORT, () => {
        console.log(`DRIVMAN API listening on port ${PORT} [${process.env.NODE_ENV || "development"}]`);
    });
} catch (error) {
    console.error("Failed to start server:", error.message);
    process.exit(1);
}

/** Finishes in-flight requests before exiting, so no client gets a dropped socket. */
const shutdown = async (signal) => {
    console.log(`\n${signal} received — shutting down gracefully.`);
    server?.close(async () => {
        await disconnectDB();
        console.log("Closed out remaining connections.");
        process.exit(0);
    });

    setTimeout(() => {
        console.error("Could not close connections in time — forcing exit.");
        process.exit(1);
    }, 10_000).unref();
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
    console.error("Unhandled promise rejection:", reason);
    shutdown("unhandledRejection");
});
