import test from "node:test";
import assert from "node:assert/strict";

// Document validation and virtuals run entirely in memory — no connection,
// no database, same as the rest of the suite.
const { Coupon } = await import("../src/models/coupon.model.js");

const DAY = 24 * 60 * 60 * 1000;

const build = (overrides = {}) =>
    new Coupon({ code: "DRIVE10", discountType: "percentage", discountValue: 10, ...overrides });

const errorsOf = async (doc) => {
    try {
        await doc.validate();
        return null;
    } catch (err) {
        return Object.keys(err.errors);
    }
};

test("codes are uppercased and trimmed", () => {
    assert.equal(build({ code: "  drive10  " }).code, "DRIVE10");
});

test("a valid coupon passes validation", async () => {
    assert.equal(await errorsOf(build({ usageLimit: 500 })), null);
});

test("a percentage discount cannot exceed 100", async () => {
    assert.deepEqual(await errorsOf(build({ discountValue: 150 })), ["discountValue"]);
    // The same value is fine as a flat rupee amount.
    assert.equal(await errorsOf(build({ discountType: "flat", discountValue: 150 })), null);
});

test("discount value must be greater than zero", async () => {
    assert.deepEqual(await errorsOf(build({ discountValue: 0 })), ["discountValue"]);
});

test("codes with spaces or symbols are rejected", async () => {
    for (const code of ["a b", "DR!VE", "AB", "x".repeat(25)]) {
        assert.deepEqual(await errorsOf(build({ code })), ["code"], `expected ${code} to fail`);
    }
});

test("an unknown discount type is rejected", async () => {
    assert.deepEqual(await errorsOf(build({ discountType: "buy-one-get-one" })), ["discountType"]);
});

test("a usage limit below 1 is rejected", async () => {
    assert.deepEqual(await errorsOf(build({ usageLimit: 0 })), ["usageLimit"]);
});

test("remainingUses counts down, and is null when unlimited", () => {
    assert.equal(build({ usageLimit: 500, usedCount: 128 }).remainingUses, 372);
    assert.equal(build().remainingUses, null);
    // Never negative, even if the limit was lowered after the fact.
    assert.equal(build({ usageLimit: 2, usedCount: 5 }).remainingUses, 0);
});

test("status reflects the reason a coupon cannot be used", () => {
    assert.equal(build().status, "active");
    assert.equal(build({ isActive: false }).status, "inactive");
    assert.equal(build({ expiresAt: new Date(Date.now() - DAY) }).status, "expired");
    assert.equal(build({ usageLimit: 5, usedCount: 5 }).status, "exhausted");

    // Switched off wins over every other reason — that's what the toggle says.
    assert.equal(build({ isActive: false, usageLimit: 1, usedCount: 1 }).status, "inactive");
});

test("a future expiry and no limit are both redeemable", () => {
    const coupon = build({ expiresAt: new Date(Date.now() + DAY) });
    assert.equal(coupon.isExpired, false);
    assert.equal(coupon.isExhausted, false);
    assert.equal(coupon.isRedeemable, true);
});

test("usedCount defaults to zero and virtuals survive toJSON", () => {
    const json = build({ usageLimit: 500 }).toJSON();
    assert.equal(json.usedCount, 0);
    assert.equal(json.status, "active");
    assert.equal(json.remainingUses, 500);
});
