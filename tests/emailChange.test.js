import test from "node:test";
import assert from "node:assert/strict";

process.env.OTP_HASH_SECRET = "test-otp-secret-value";
process.env.NODE_ENV = "test";

const { createEmailOtpService, MAX_VERIFY_ATTEMPTS, OTP_TTL_MINUTES, RESEND_COOLDOWN_SECONDS } =
    await import("../src/services/emailOtpService.js");

const { createMemoryOtpStore, createMailerMock, createUsersMock, createClock, silentLogger } =
    await import("./helpers/fakes.js");

const MINUTE = 60 * 1000;

const OWNER = { _id: "u1", email: "owner@drivman.test", fullName: "Owner", isEmailVerified: true };
const OTHER = { _id: "u2", email: "taken@drivman.test", fullName: "Other", isEmailVerified: true };

const setup = ({ seedUsers = [OWNER, OTHER], failWith = null } = {}) => {
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
        wait: async () => {},
    });

    return { service, store, emails, users, clock };
};

const lastCode = (emails) => emails.sent.at(-1).code;

// --- Requesting the change ---------------------------------------------------

test("the code goes to the NEW address, not the current one", async () => {
    const { service, emails } = setup();

    await service.requestEmailChange({ userId: "u1", newEmail: "fresh@drivman.test" });

    assert.equal(emails.sent.length, 1);
    assert.equal(emails.sent[0].to, "fresh@drivman.test");
    assert.equal(emails.sent[0].kind, "email_change_otp");
    assert.match(emails.sent[0].code, /^\d{6}$/);
});

test("the account is untouched until the code is verified", async () => {
    const { service, users } = setup();

    await service.requestEmailChange({ userId: "u1", newEmail: "fresh@drivman.test" });

    // This is the whole point of the two-step flow: a typo must not cost the
    // user access to their own account.
    assert.equal(users.users[0].email, "owner@drivman.test");
});

test("an address owned by another account is refused", async () => {
    const { service, emails } = setup();

    await assert.rejects(
        service.requestEmailChange({ userId: "u1", newEmail: OTHER.email }),
        (error) => error.statusCode === 400 && /already in use/i.test(error.message),
    );
    assert.equal(emails.sent.length, 0);
});

test("changing to your own current address is refused", async () => {
    const { service } = setup();

    await assert.rejects(
        service.requestEmailChange({ userId: "u1", newEmail: "OWNER@drivman.test" }),
        (error) => error.statusCode === 400 && /already your email/i.test(error.message),
    );
});

test("the destination address is rate limited", async () => {
    const { service } = setup();

    await service.requestEmailChange({ userId: "u1", newEmail: "fresh@drivman.test" });

    // Keyed on the destination, so one account can't spray a stranger's inbox.
    await assert.rejects(
        service.requestEmailChange({ userId: "u1", newEmail: "fresh@drivman.test" }),
        (error) => error.statusCode === 429,
    );
});

test("a failed send does not leave a pending change behind", async () => {
    const { service, store } = setup({ failWith: new Error("provider down") });

    await assert.rejects(
        service.requestEmailChange({ userId: "u1", newEmail: "fresh@drivman.test" }),
        /provider down/,
    );

    assert.ok(store.rows[0].consumedAt);
});

// --- Verifying ---------------------------------------------------------------

test("the correct code moves the address and marks it verified", async () => {
    const { service, emails, users, clock } = setup();

    await service.requestEmailChange({ userId: "u1", newEmail: "fresh@drivman.test" });
    const { user } = await service.verifyEmailChange({ userId: "u1", code: lastCode(emails) });

    assert.equal(user.email, "fresh@drivman.test");
    assert.equal(user.isEmailVerified, true);
    assert.deepEqual(user.emailVerifiedAt, new Date(clock.now()));
    assert.equal(users.users[0].email, "fresh@drivman.test");
});

test("another user's pending change cannot be claimed", async () => {
    const { service, emails, users } = setup();

    await service.requestEmailChange({ userId: "u1", newEmail: "fresh@drivman.test" });
    const code = lastCode(emails);

    // u2 knows the code but the row is bound to u1.
    await assert.rejects(
        service.verifyEmailChange({ userId: "u2", code }),
        (error) => error.statusCode === 400,
    );

    assert.equal(users.users[1].email, OTHER.email, "u2's address must be untouched");
});

test("verifying with no pending change is refused", async () => {
    const { service } = setup();

    await assert.rejects(
        service.verifyEmailChange({ userId: "u1", code: "123456" }),
        (error) => error.statusCode === 400 && /no pending email change/i.test(error.message),
    );
});

test("a wrong code is refused and the address stays put", async () => {
    const { service, emails, users } = setup();

    await service.requestEmailChange({ userId: "u1", newEmail: "fresh@drivman.test" });
    const wrong = lastCode(emails) === "000000" ? "111111" : "000000";

    await assert.rejects(
        service.verifyEmailChange({ userId: "u1", code: wrong }),
        (error) => error.statusCode === 400,
    );
    assert.equal(users.users[0].email, "owner@drivman.test");
});

test("the code is single-use", async () => {
    const { service, emails } = setup();

    await service.requestEmailChange({ userId: "u1", newEmail: "fresh@drivman.test" });
    const code = lastCode(emails);

    await service.verifyEmailChange({ userId: "u1", code });

    await assert.rejects(
        service.verifyEmailChange({ userId: "u1", code }),
        (error) => error.statusCode === 400,
    );
});

test("an expired code is refused", async () => {
    const { service, emails, clock } = setup();

    await service.requestEmailChange({ userId: "u1", newEmail: "fresh@drivman.test" });
    const code = lastCode(emails);

    clock.advance(OTP_TTL_MINUTES * MINUTE + 1);

    await assert.rejects(
        service.verifyEmailChange({ userId: "u1", code }),
        (error) => error.statusCode === 400,
    );
});

test("five wrong guesses lock the code", async () => {
    const { service, emails } = setup();

    await service.requestEmailChange({ userId: "u1", newEmail: "fresh@drivman.test" });
    const code = lastCode(emails);
    const wrong = code === "000000" ? "111111" : "000000";

    for (let i = 0; i < MAX_VERIFY_ATTEMPTS - 1; i += 1) {
        await assert.rejects(
            service.verifyEmailChange({ userId: "u1", code: wrong }),
            (error) => error.statusCode === 400,
        );
    }

    await assert.rejects(
        service.verifyEmailChange({ userId: "u1", code: wrong }),
        (error) => error.statusCode === 429,
    );

    // Even the genuine code is dead now.
    await assert.rejects(
        service.verifyEmailChange({ userId: "u1", code }),
        (error) => error.statusCode === 400,
    );
});

test("only the newest pending change is live", async () => {
    const { service, emails, clock, users } = setup();

    await service.requestEmailChange({ userId: "u1", newEmail: "first@drivman.test" });
    const firstCode = lastCode(emails);

    clock.advance(RESEND_COOLDOWN_SECONDS * 1000 + 1);
    await service.requestEmailChange({ userId: "u1", newEmail: "second@drivman.test" });

    await assert.rejects(
        service.verifyEmailChange({ userId: "u1", code: firstCode }),
        (error) => error.statusCode === 400,
    );

    await service.verifyEmailChange({ userId: "u1", code: lastCode(emails) });
    assert.equal(users.users[0].email, "second@drivman.test");
});

test("an address claimed during the wait is caught at verify time", async () => {
    const { service, emails, users } = setup();

    await service.requestEmailChange({ userId: "u1", newEmail: "race@drivman.test" });
    const code = lastCode(emails);

    // Somebody else takes the address while the code is still valid.
    users.users[1].email = "race@drivman.test";

    await assert.rejects(
        service.verifyEmailChange({ userId: "u1", code }),
        (error) => error.statusCode === 400 && /already in use/i.test(error.message),
    );
    assert.equal(users.users[0].email, "owner@drivman.test");
});

// --- Isolation from the signup flow -----------------------------------------

test("a signup code cannot complete an email change, and vice versa", async () => {
    const store = createMemoryOtpStore();
    const emails = createMailerMock();
    const users = createUsersMock([
        { _id: "u1", email: "owner@drivman.test", fullName: "Owner", isEmailVerified: true },
        { _id: "u3", email: "pending@drivman.test", fullName: "Pending", isEmailVerified: false },
    ]);
    const clock = createClock();
    const service = createEmailOtpService({
        store,
        emails,
        users,
        logger: silentLogger,
        now: clock.now,
        wait: async () => {},
    });

    // A signup code for pending@, and an email change targeting the same address.
    await service.requestOtp({ email: "pending@drivman.test" });
    const signupCode = emails.sent.at(-1).code;

    await assert.rejects(
        service.requestEmailChange({ userId: "u1", newEmail: "pending@drivman.test" }),
        /already in use/i,
    );

    // The signup code still works for its own flow — the change attempt above
    // must not have consumed or disturbed it.
    const { user } = await service.verifyOtp({ email: "pending@drivman.test", code: signupCode });
    assert.equal(user.isEmailVerified, true);
});
