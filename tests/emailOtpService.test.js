import test from "node:test";
import assert from "node:assert/strict";

// Must be set before the service is imported — hashing reads it.
process.env.OTP_HASH_SECRET = "test-otp-secret-value";
process.env.NODE_ENV = "test";

const {
    createEmailOtpService,
    generateOtpCode,
    hashOtpCode,
    OTP_TTL_MINUTES,
    MAX_VERIFY_ATTEMPTS,
    MAX_REQUESTS_PER_HOUR,
    RESEND_COOLDOWN_SECONDS,
} = await import("../src/services/emailOtpService.js");

const {
    createMemoryOtpStore,
    createMailerMock,
    createUsersMock,
    createClock,
    silentLogger,
} = await import("./helpers/fakes.js");

const MINUTE = 60 * 1000;

const REGISTERED = {
    email: "rider@drivman.test",
    fullName: "Test Rider",
    isEmailVerified: false,
};

/** Builds a service wired entirely to fakes. */
const setup = ({ seedUsers = [REGISTERED], failWith = null } = {}) => {
    const store = createMemoryOtpStore();
    const emails = createMailerMock({ failWith });
    const users = createUsersMock(seedUsers);
    const clock = createClock();

    const service = createEmailOtpService({
        store,
        emails,
        users,
        logger: silentLogger,
        now: clock.now,
        wait: async () => {}, // skip the anti-timing-leak padding
    });

    return { service, store, emails, users, clock };
};

/** Pulls the code out of the mailer mock — the only place it legitimately appears. */
const lastSentCode = (emails) => emails.sent.at(-1).code;

// --- Code generation ---------------------------------------------------------

test("generateOtpCode always produces a 6-digit numeric string", () => {
    for (let i = 0; i < 2000; i += 1) {
        const code = generateOtpCode();
        assert.match(code, /^\d{6}$/, `unexpected code: ${code}`);
    }
});

test("generateOtpCode covers the full range including leading zeros", () => {
    const codes = new Set();
    for (let i = 0; i < 5000; i += 1) codes.add(generateOtpCode());
    // A 10^6 space sampled 5000 times should almost never repeat heavily.
    assert.ok(codes.size > 4900, `suspiciously low entropy: ${codes.size} unique`);
});

test("hashOtpCode is deterministic, keyed, and bound to the address", () => {
    const a = hashOtpCode("123456", "someone@drivman.test");
    assert.equal(a, hashOtpCode("123456", "someone@drivman.test"));
    assert.equal(a.length, 64);
    assert.notEqual(a, hashOtpCode("123456", "other@drivman.test"));
    assert.notEqual(a, hashOtpCode("654321", "someone@drivman.test"));
});

// --- Requesting a code -------------------------------------------------------

test("requestOtp emails a code to a registered, unverified address", async () => {
    const { service, emails } = setup();

    const result = await service.requestOtp({ email: REGISTERED.email });

    assert.equal(emails.sent.length, 1);
    assert.equal(emails.sent[0].to, REGISTERED.email);
    assert.equal(emails.sent[0].ttlMinutes, OTP_TTL_MINUTES);
    assert.match(emails.sent[0].code, /^\d{6}$/);
    assert.equal(result.dispatched, true);
});

test("requestOtp stores only a hash — never the code itself", async () => {
    const { service, store, emails } = setup();

    await service.requestOtp({ email: REGISTERED.email });

    const [row] = store.rows;
    const code = lastSentCode(emails);

    assert.equal(row.codeHash, hashOtpCode(code, REGISTERED.email));
    assert.ok(!JSON.stringify(row).includes(code), "plaintext code leaked into the row");
});

test("requestOtp normalises the address before storing it", async () => {
    const { service, store } = setup();

    await service.requestOtp({ email: "  RIDER@DRIVMAN.TEST  " });

    assert.equal(store.rows[0].email, REGISTERED.email);
});

test("requestOtp sends nothing for an unknown address but still records the request", async () => {
    const { service, store, emails } = setup();

    const result = await service.requestOtp({ email: "nobody@drivman.test" });

    assert.equal(emails.sent.length, 0);
    assert.equal(result.dispatched, false);
    // The row must exist, or the rate limiter would behave differently for
    // unknown addresses and become an account-existence oracle.
    assert.equal(store.rows.length, 1);
    assert.equal(store.rows[0].codeHash, null);
});

test("requestOtp sends nothing to an already-verified address", async () => {
    const { service, emails, store } = setup({
        seedUsers: [{ ...REGISTERED, isEmailVerified: true }],
    });

    await service.requestOtp({ email: REGISTERED.email });

    assert.equal(emails.sent.length, 0);
    assert.equal(store.rows.length, 1);
});

test("a new code retires the previous one", async () => {
    const { service, store, emails, clock } = setup();

    await service.requestOtp({ email: REGISTERED.email });
    const firstCode = lastSentCode(emails);

    clock.advance(RESEND_COOLDOWN_SECONDS * 1000 + 1);
    await service.requestOtp({ email: REGISTERED.email });

    assert.ok(store.rows[0].consumedAt, "the first code should have been invalidated");

    await assert.rejects(
        service.verifyOtp({ email: REGISTERED.email, code: firstCode }),
        (error) => error.statusCode === 400,
    );
});

// --- Per-email rate limiting -------------------------------------------------

test("a second request inside the cooldown is rejected", async () => {
    const { service } = setup();

    await service.requestOtp({ email: REGISTERED.email });

    await assert.rejects(
        service.requestOtp({ email: REGISTERED.email }),
        (error) => error.statusCode === 429 && /wait/i.test(error.message),
    );
});

test("a request is allowed once the cooldown elapses", async () => {
    const { service, emails, clock } = setup();

    await service.requestOtp({ email: REGISTERED.email });
    clock.advance(RESEND_COOLDOWN_SECONDS * 1000 + 1);
    await service.requestOtp({ email: REGISTERED.email });

    assert.equal(emails.sent.length, 2);
});

test("the hourly cap holds after the cooldown stops applying", async () => {
    const { service, emails, clock } = setup();

    for (let i = 0; i < MAX_REQUESTS_PER_HOUR; i += 1) {
        await service.requestOtp({ email: REGISTERED.email });
        clock.advance(RESEND_COOLDOWN_SECONDS * 1000 + 1);
    }
    assert.equal(emails.sent.length, MAX_REQUESTS_PER_HOUR);

    await assert.rejects(
        service.requestOtp({ email: REGISTERED.email }),
        (error) => error.statusCode === 429 && /hour/i.test(error.message),
    );
});

test("the hourly window rolls forward", async () => {
    const { service, clock } = setup();

    for (let i = 0; i < MAX_REQUESTS_PER_HOUR; i += 1) {
        await service.requestOtp({ email: REGISTERED.email });
        clock.advance(RESEND_COOLDOWN_SECONDS * 1000 + 1);
    }

    clock.advance(61 * MINUTE);
    const result = await service.requestOtp({ email: REGISTERED.email });
    assert.equal(result.dispatched, true);
});

test("rate limits apply identically to unregistered addresses", async () => {
    const { service } = setup();

    // Same cooldown behaviour as a real account — otherwise the 429 itself
    // would reveal which addresses are registered.
    await service.requestOtp({ email: "ghost@drivman.test" });

    await assert.rejects(
        service.requestOtp({ email: "ghost@drivman.test" }),
        (error) => error.statusCode === 429,
    );
});

test("a failed send does not burn the user's quota", async () => {
    const { service, store } = setup({ failWith: new Error("Resend is down") });

    await assert.rejects(
        service.requestOtp({ email: REGISTERED.email }),
        /Resend is down/,
    );

    // Row consumed, so the next attempt isn't blocked by our own outage.
    assert.ok(store.rows[0].consumedAt);
});

// --- Verification ------------------------------------------------------------

test("the correct code verifies the account and stamps the time", async () => {
    const { service, emails, users, clock } = setup();

    await service.requestOtp({ email: REGISTERED.email });
    const { user } = await service.verifyOtp({
        email: REGISTERED.email,
        code: lastSentCode(emails),
    });

    assert.equal(user.isEmailVerified, true);
    assert.deepEqual(user.emailVerifiedAt, new Date(clock.now()));
    assert.equal(users.users[0].isEmailVerified, true);
});

test("verification accepts a code with stray whitespace", async () => {
    const { service, emails } = setup();

    await service.requestOtp({ email: REGISTERED.email });
    const { user } = await service.verifyOtp({
        email: REGISTERED.email,
        code: `  ${lastSentCode(emails)} `,
    });

    assert.equal(user.isEmailVerified, true);
});

test("a code is single-use", async () => {
    const { service, emails } = setup();

    await service.requestOtp({ email: REGISTERED.email });
    const code = lastSentCode(emails);

    await service.verifyOtp({ email: REGISTERED.email, code });

    await assert.rejects(
        service.verifyOtp({ email: REGISTERED.email, code }),
        (error) => error.statusCode === 400,
    );
});

test("a wrong code is rejected and counts an attempt", async () => {
    const { service, store, emails } = setup();

    await service.requestOtp({ email: REGISTERED.email });
    const wrong = lastSentCode(emails) === "000000" ? "111111" : "000000";

    await assert.rejects(
        service.verifyOtp({ email: REGISTERED.email, code: wrong }),
        (error) => error.statusCode === 400,
    );

    assert.equal(store.rows[0].attempts, 1);
});

test("an expired code is rejected", async () => {
    const { service, emails, clock } = setup();

    await service.requestOtp({ email: REGISTERED.email });
    const code = lastSentCode(emails);

    clock.advance(OTP_TTL_MINUTES * MINUTE + 1);

    await assert.rejects(
        service.verifyOtp({ email: REGISTERED.email, code }),
        (error) => error.statusCode === 400,
    );
});

test("verifying with no outstanding request is rejected", async () => {
    const { service } = setup();

    await assert.rejects(
        service.verifyOtp({ email: REGISTERED.email, code: "123456" }),
        (error) => error.statusCode === 400,
    );
});

test("a missing code is rejected rather than matching a null hash", async () => {
    const { service } = setup();

    await service.requestOtp({ email: "nobody@drivman.test" });

    await assert.rejects(
        service.verifyOtp({ email: "nobody@drivman.test", code: undefined }),
        (error) => error.statusCode === 400,
    );
});

// --- Lockout -----------------------------------------------------------------

test("the code locks out after the attempt limit, and the real code stops working", async () => {
    const { service, emails } = setup();

    await service.requestOtp({ email: REGISTERED.email });
    const code = lastSentCode(emails);
    const wrong = code === "000000" ? "111111" : "000000";

    for (let i = 0; i < MAX_VERIFY_ATTEMPTS - 1; i += 1) {
        await assert.rejects(
            service.verifyOtp({ email: REGISTERED.email, code: wrong }),
            (error) => error.statusCode === 400,
        );
    }

    // The final wrong guess trips the lockout.
    await assert.rejects(
        service.verifyOtp({ email: REGISTERED.email, code: wrong }),
        (error) => error.statusCode === 429 && /request a new code/i.test(error.message),
    );

    // Even the genuine code is dead now — a fresh request is required.
    await assert.rejects(
        service.verifyOtp({ email: REGISTERED.email, code }),
        (error) => error.statusCode === 400,
    );
});

test("a fresh request clears the lockout", async () => {
    const { service, emails, clock } = setup();

    await service.requestOtp({ email: REGISTERED.email });
    const wrong = lastSentCode(emails) === "000000" ? "111111" : "000000";

    for (let i = 0; i < MAX_VERIFY_ATTEMPTS; i += 1) {
        await assert.rejects(service.verifyOtp({ email: REGISTERED.email, code: wrong }));
    }

    clock.advance(RESEND_COOLDOWN_SECONDS * 1000 + 1);
    await service.requestOtp({ email: REGISTERED.email });

    const { user } = await service.verifyOtp({
        email: REGISTERED.email,
        code: lastSentCode(emails),
    });
    assert.equal(user.isEmailVerified, true);
});

// --- Account enumeration -----------------------------------------------------

test("wrong-code responses are identical for registered and unknown addresses", async () => {
    const { service, emails } = setup();

    await service.requestOtp({ email: REGISTERED.email });
    const wrong = lastSentCode(emails) === "000000" ? "111111" : "000000";
    const registered = await service
        .verifyOtp({ email: REGISTERED.email, code: wrong })
        .catch((error) => error);

    await service.requestOtp({ email: "ghost@drivman.test" });
    const unknown = await service
        .verifyOtp({ email: "ghost@drivman.test", code: wrong })
        .catch((error) => error);

    assert.equal(registered.message, unknown.message);
    assert.equal(registered.statusCode, unknown.statusCode);
});

test("lockout behaves identically for an unknown address", async () => {
    const { service } = setup();

    await service.requestOtp({ email: "ghost@drivman.test" });

    for (let i = 0; i < MAX_VERIFY_ATTEMPTS - 1; i += 1) {
        await assert.rejects(
            service.verifyOtp({ email: "ghost@drivman.test", code: "000000" }),
            (error) => error.statusCode === 400,
        );
    }

    await assert.rejects(
        service.verifyOtp({ email: "ghost@drivman.test", code: "000000" }),
        (error) => error.statusCode === 429,
    );
});
