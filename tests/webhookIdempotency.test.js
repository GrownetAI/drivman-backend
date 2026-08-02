import test from "node:test";
import assert from "node:assert/strict";

const { createWebhookIdempotencyGuard } = await import("../src/services/webhookIdempotency.js");

/** Mirrors a unique-indexed collection: a second insert of the same key throws E11000. */
const createMemoryEventStore = () => {
    const seen = new Set();
    return {
        seen,
        insert: async (eventId) => {
            if (seen.has(eventId)) {
                const err = new Error("duplicate key");
                err.code = 11000;
                throw err;
            }
            seen.add(eventId);
        },
    };
};

test("claim returns true the first time an event id is seen", async () => {
    const guard = createWebhookIdempotencyGuard(createMemoryEventStore());
    assert.equal(await guard.claim("evt_1", "payment.captured"), true);
});

test("claim returns false for a replayed event id, without a second insert taking effect", async () => {
    const store = createMemoryEventStore();
    const guard = createWebhookIdempotencyGuard(store);

    assert.equal(await guard.claim("evt_1", "payment.captured"), true);
    assert.equal(await guard.claim("evt_1", "payment.captured"), false);
    assert.equal(await guard.claim("evt_1", "payment.captured"), false);
    assert.equal(store.seen.size, 1);
});

test("distinct event ids are each claimed independently", async () => {
    const guard = createWebhookIdempotencyGuard(createMemoryEventStore());

    assert.equal(await guard.claim("evt_1", "payment.captured"), true);
    assert.equal(await guard.claim("evt_2", "payment.failed"), true);
});

test("a non-duplicate-key error from the store propagates instead of being swallowed", async () => {
    const store = {
        insert: async () => {
            throw new Error("connection lost");
        },
    };
    const guard = createWebhookIdempotencyGuard(store);

    await assert.rejects(() => guard.claim("evt_1", "payment.captured"), /connection lost/);
});
