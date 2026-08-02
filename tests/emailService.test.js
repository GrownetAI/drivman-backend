import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

const { createEmailService } = await import("../src/services/emailService.js");
const { EmailDeliveryError, isRetryableStatus } = await import(
    "../src/services/email/deliveryError.js"
);
const { silentLogger, createWaitSpy } = await import("./helpers/fakes.js");

const config = () => ({
    provider: "resend",
    from: "DRIVMAN <no-reply@drivman.test>",
    replyTo: undefined,
    clientUrl: "https://drivman.test",
});

/** A provider that fails a set number of times before succeeding. */
const createProviderMock = ({ failures = [], succeedAfter = true } = {}) => {
    const calls = [];
    return {
        calls,
        name: "mock",
        async send(payload) {
            calls.push(payload);
            const failure = failures[calls.length - 1];
            if (failure) throw failure;
            if (!succeedAfter) throw new Error("unexpected extra call");
            return { id: `mock-${calls.length}` };
        },
    };
};

const transient = () =>
    new EmailDeliveryError("Resend is having a moment", {
        retryable: true,
        statusCode: 503,
    });

const permanent = () =>
    new EmailDeliveryError("Invalid recipient address", {
        retryable: false,
        statusCode: 422,
    });

const build = (provider, wait) =>
    createEmailService({ provider, config, logger: silentLogger, wait });

// --- Retry classification ----------------------------------------------------

test("isRetryableStatus retries 5xx, 429 and transport failures only", () => {
    assert.equal(isRetryableStatus(500), true);
    assert.equal(isRetryableStatus(503), true);
    assert.equal(isRetryableStatus(429), true);
    assert.equal(isRetryableStatus(null), true); // network / timeout
    assert.equal(isRetryableStatus(undefined), true);

    assert.equal(isRetryableStatus(400), false);
    assert.equal(isRetryableStatus(401), false);
    assert.equal(isRetryableStatus(422), false);
});

// --- Retry behaviour ---------------------------------------------------------

test("a transient failure is retried and can succeed", async () => {
    const provider = createProviderMock({ failures: [transient()] });
    const wait = createWaitSpy();

    const result = await build(provider, wait).sendOtpEmail({
        to: "rider@drivman.test",
        code: "123456",
        ttlMinutes: 10,
        fullName: "Test Rider",
    });

    assert.equal(provider.calls.length, 2);
    assert.equal(result.id, "mock-2");
    assert.deepEqual(wait.delays, [300]);
});

test("retries stop after two attempts and the error propagates", async () => {
    const provider = createProviderMock({
        failures: [transient(), transient(), transient()],
    });
    const wait = createWaitSpy();

    await assert.rejects(
        build(provider, wait).sendOtpEmail({
            to: "rider@drivman.test",
            code: "123456",
            ttlMinutes: 10,
        }),
        /Resend is having a moment/,
    );

    // 3 attempts total: the original plus two retries.
    assert.equal(provider.calls.length, 3);
    assert.deepEqual(wait.delays, [300, 600], "backoff should be exponential");
});

test("a 4xx is not retried", async () => {
    const provider = createProviderMock({ failures: [permanent()] });
    const wait = createWaitSpy();

    await assert.rejects(
        build(provider, wait).sendOtpEmail({
            to: "bad-address",
            code: "123456",
            ttlMinutes: 10,
        }),
        /Invalid recipient/,
    );

    assert.equal(provider.calls.length, 1);
    assert.deepEqual(wait.delays, []);
});

test("a plain Error from a provider is not retried", async () => {
    // Anything that isn't an EmailDeliveryError hasn't been classified, so
    // retrying it would be guessing.
    const provider = createProviderMock({ failures: [new Error("boom")] });
    const wait = createWaitSpy();

    await assert.rejects(build(provider, wait).sendEmail({ to: "x@y.test", subject: "s" }), /boom/);
    assert.equal(provider.calls.length, 1);
});

// --- Message construction ----------------------------------------------------

test("the OTP email shows the code and its expiry, and uses the configured sender", async () => {
    const provider = createProviderMock();
    await build(provider, createWaitSpy()).sendOtpEmail({
        to: "rider@drivman.test",
        code: "428193",
        ttlMinutes: 10,
        fullName: "Test Rider",
    });

    const [sent] = provider.calls;
    assert.equal(sent.from, "DRIVMAN <no-reply@drivman.test>");
    assert.equal(sent.to, "rider@drivman.test");
    assert.ok(sent.html.includes("428193"));
    assert.ok(sent.text.includes("428193"));
    assert.ok(/10 minutes/.test(sent.html));
    // Transactional only — no marketing footer.
    assert.ok(!/unsubscribe/i.test(sent.html));
});

test("templates escape user-controlled values", async () => {
    const provider = createProviderMock();
    await build(provider, createWaitSpy()).sendOtpEmail({
        to: "rider@drivman.test",
        code: "111111",
        ttlMinutes: 10,
        fullName: '<script>alert("xss")</script>',
    });

    const [sent] = provider.calls;
    assert.ok(!sent.html.includes("<script>"), "raw markup reached the email body");
    assert.ok(sent.html.includes("&lt;script&gt;"));
});

test("link emails build URLs from the configured client origin", async () => {
    const provider = createProviderMock();
    await build(provider, createWaitSpy()).sendPasswordResetEmail({
        to: "rider@drivman.test",
        fullName: "Test Rider",
        token: "abc123",
        ttlMinutes: 15,
    });

    assert.ok(provider.calls[0].html.includes("https://drivman.test/reset-password?token=abc123"));
});

test("an unknown provider name fails loudly instead of silently dropping mail", async () => {
    const service = createEmailService({
        config: () => ({ ...config(), provider: "carrier-pigeon" }),
        logger: silentLogger,
        wait: createWaitSpy(),
    });

    await assert.rejects(
        service.sendEmail({ to: "x@y.test", subject: "s", text: "t" }),
        /Unknown email provider/,
    );
});
