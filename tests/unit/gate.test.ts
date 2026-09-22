import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluatePurchaseGate, type PurchaseGateInput } from "../../src/core/registration/PurchaseGate.ts";

function input(over: Partial<PurchaseGateInput> & { a?: Partial<PurchaseGateInput["availability"]> } = {}): PurchaseGateInput {
  const { a, ...rest } = over;
  return {
    expectedDomain: "example.pl",
    domain: "example.pl",
    provider: { id: "pb", canRegister: true, premiumRegistration: false, credentialsValid: true },
    availability: {
      provider: "pb",
      providerType: "porkbun",
      sourceKind: "registrar",
      domain: "example.pl",
      status: "available",
      registrable: true,
      premium: false,
      price: { amount: 9.73, currency: "USD" },
      startedAt: "",
      checkedAt: "",
      latencyMs: 1,
      ...a,
    },
    budget: { maxRegistrationPrice: 20, currency: "USD", allowPremium: false, requireExactPrice: false },
    requireBudget: true,
    attempts: { total: 0, provider: 0, maxTotal: 1, maxPerProvider: 1 },
    targetEnabled: true,
    ...rest,
  };
}

const reasons = (i: PurchaseGateInput): string[] => evaluatePurchaseGate(i).reasons;

describe("purchase gate", () => {
  it("allows a clean purchase and passes the verified price through", () => {
    const res = evaluatePurchaseGate(input());
    assert.equal(res.allowed, true);
    assert.deepEqual(res.price, { amount: 9.73, currency: "USD" });
  });

  it("refuses the wrong domain", () => {
    assert.deepEqual(reasons(input({ domain: "examp1e.pl" })), ["DOMAIN_MISMATCH"]);
    assert.deepEqual(reasons(input({ a: { domain: "other.pl" } })), ["DOMAIN_MISMATCH"]);
  });

  it("refuses over-budget, unknown, mismatched and wrong-currency prices", () => {
    assert.deepEqual(reasons(input({ a: { price: { amount: 20.01, currency: "USD" } } })), ["PRICE_TOO_HIGH"]);
    assert.equal(evaluatePurchaseGate(input({ a: { price: { amount: 20, currency: "USD" } } })).allowed, true);
    assert.deepEqual(reasons(input({ a: { price: undefined } })), ["PRICE_UNKNOWN"]);
    assert.deepEqual(reasons(input({ a: { price: { amount: 9, currency: "EUR" } } })), ["CURRENCY_MISMATCH"]);
    assert.deepEqual(
      reasons(input({ budget: { maxRegistrationPrice: 20, currency: "USD", allowPremium: false, requireExactPrice: true, expectedPrice: 10.99 } })),
      ["PRICE_MISMATCH"],
    );
  });

  it("requires a budget for auto-buy", () => {
    assert.ok(reasons(input({ budget: { currency: "USD", allowPremium: false, requireExactPrice: false } })).includes("NO_BUDGET"));
  });

  it("blocks premium names unless allowed and supported", () => {
    assert.deepEqual(reasons(input({ a: { premium: true, registrable: false } })), ["PREMIUM_DOMAIN"]);
    const allowed = input({ a: { premium: true }, budget: { maxRegistrationPrice: 20, currency: "USD", allowPremium: true, requireExactPrice: false } });
    assert.deepEqual(reasons(allowed), ["PROVIDER_UNSUPPORTED"]);
  });

  it("refuses when the final check is not a positive from the registering provider", () => {
    assert.deepEqual(reasons(input({ a: { status: "unavailable" } })), ["NOT_AVAILABLE"]);
    assert.deepEqual(reasons(input({ a: { provider: "rdap" } })), ["UNVERIFIED_PROVIDER"]);
    assert.deepEqual(reasons(input({ a: { registrable: false } })), ["NOT_REGISTRABLE"]);
  });

  it("enforces attempt caps, target state, credentials and the optional window", () => {
    assert.deepEqual(reasons(input({ attempts: { total: 1, provider: 0, maxTotal: 1, maxPerProvider: 2 } })), ["DUPLICATE_ATTEMPT"]);
    assert.deepEqual(reasons(input({ targetEnabled: false })), ["TARGET_DISABLED"]);
    assert.deepEqual(reasons(input({ provider: { id: "pb", canRegister: true, premiumRegistration: false, credentialsValid: false } })), ["CREDENTIALS_INVALID"]);
    assert.deepEqual(reasons(input({ window: { now: 50, start: 100, end: 200, enforce: true } })), ["OUTSIDE_DROP_WINDOW"]);
    assert.equal(evaluatePurchaseGate(input({ window: { now: 50, start: 100, end: 200, enforce: false } })).allowed, true);
  });
});
