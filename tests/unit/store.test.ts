import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { canTransition, predecessorsOf } from "../../src/core/registration/state.ts";
import type { RegistrationResult } from "../../src/core/types.ts";
import { Store } from "../../src/persistence/Store.ts";
import { tempDir } from "../helpers/fakes.ts";

const result = (status: RegistrationResult["status"]): RegistrationResult => ({
  provider: "pb",
  providerType: "porkbun",
  domain: "a.com",
  status,
  startedAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
  latencyMs: 1,
});

describe("registration state machine", () => {
  it("only allows purchase states to be reached in order", () => {
    assert.ok(canTransition("VERIFYING", "REGISTERING"));
    assert.ok(!canTransition("CHECKING", "REGISTERING"));
    assert.ok(!canTransition("SUCCEEDED", "ARMED"));
    assert.ok(!canTransition("AMBIGUOUS", "REGISTERING"));
    assert.deepEqual(predecessorsOf("REGISTERING"), ["VERIFYING", "REGISTERING"]);
  });
});

describe("store", () => {
  it("persists across reopen and claims a purchase exactly once (CAS + write-ahead)", () => {
    const path = join(tempDir(), "s.sqlite");
    const a = new Store(path);
    assert.deepEqual(a.arm("t", "a.com"), { ok: true });
    assert.ok(a.transition("t", "a.com", "CHECKING"));
    assert.ok(a.transition("t", "a.com", "AVAILABLE"));
    assert.ok(a.transition("t", "a.com", "VERIFYING"));
    const b = new Store(path);
    assert.equal(a.claimRegistration({ attemptId: "1", targetId: "t", domain: "a.com", provider: "pb" }), true);
    assert.equal(b.claimRegistration({ attemptId: "2", targetId: "t", domain: "a.com", provider: "pb" }), false, "second process loses the race");
    assert.equal(b.getState("t")!.state, "REGISTERING");
    assert.equal(b.attempts("t")[0]!.status, "in_flight");
    a.close();
    b.close();
  });

  it("turns a crash during registration into AMBIGUOUS and refuses to re-arm", () => {
    const path = join(tempDir(), "s.sqlite");
    const s = new Store(path);
    s.arm("t", "a.com");
    s.transition("t", "a.com", "CHECKING");
    s.transition("t", "a.com", "AVAILABLE");
    s.transition("t", "a.com", "VERIFYING");
    s.claimRegistration({ attemptId: "x", targetId: "t", domain: "a.com", provider: "pb" });
    s.close();
    const restarted = new Store(path);
    const armed = restarted.arm("t", "a.com");
    assert.equal(armed.ok, false);
    assert.equal(!armed.ok && armed.state, "AMBIGUOUS");
    assert.equal(!armed.ok && armed.convertedFromRegistering, true);
    assert.equal(restarted.attempts("t")[0]!.status, "unknown");
    assert.equal(restarted.arm("t", "a.com").ok, false, "still blocked on the next start");
    restarted.close();
  });

  it("counts real attempts, ignores dry runs and restarts counting after a reset", () => {
    const s = new Store(":memory:");
    s.arm("t", "a.com");
    s.transition("t", "a.com", "CHECKING");
    s.transition("t", "a.com", "AVAILABLE");
    s.transition("t", "a.com", "VERIFYING");
    s.recordSimulatedAttempt({ attemptId: "d", targetId: "t", domain: "a.com", provider: "pb", result: { ...result("success"), simulated: true } });
    assert.equal(s.countAttempts("t"), 0);
    s.claimRegistration({ attemptId: "r", targetId: "t", domain: "a.com", provider: "pb" });
    s.finishAttempt("r", result("failed"));
    assert.equal(s.countAttempts("t"), 1);
    assert.equal(s.countAttempts("t", "pb"), 1);
    assert.equal(s.countAttempts("t", "other"), 0);
    s.resolve("t", "a.com", "IDLE", "reset", true);
    assert.equal(s.countAttempts("t"), 0);
    assert.equal(s.attempts("t").length, 2, "history is kept");
    assert.equal(s.arm("t", "a.com").ok, true);
    s.close();
  });

  it("keeps dashboard sessions by hash with sliding expiry", () => {
    const s = new Store(":memory:");
    assert.equal(s.createAdmin("hash1"), true);
    assert.equal(s.createAdmin("hash2"), false, "first setup only");
    s.createSession("abc", Date.now() + 60_000, "127.0.0.1", "ua");
    assert.equal(s.touchSession("abc", Date.now() + 120_000), true);
    s.createSession("old", Date.now() - 1, undefined, undefined);
    assert.equal(s.touchSession("old", Date.now() + 1000), false);
    assert.equal(s.deleteOtherSessions("abc"), 1);
    s.close();
  });
});
