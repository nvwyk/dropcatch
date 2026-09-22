import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { silentLogger } from "../../src/logging/logger.ts";
import { DiscordChannel, EventPublisher, Notifier } from "../../src/notifications/Notifier.ts";
import { mockStats, resetMockStats } from "../../src/providers/mock/MockProvider.ts";
import { UndiciTransport } from "../../src/transport/HttpTransport.ts";
import { ProxyRouter } from "../../src/transport/ProxyRouter.ts";
import { harness, mockConfig, tempDir } from "../helpers/fakes.ts";

const signal = (ms = 10_000): AbortSignal => AbortSignal.timeout(ms);
const autoBuy = (providers: string[], extra: Record<string, unknown> = {}) => ({
  enabled: true,
  mode: "auto-buy",
  providers,
  budget: { maxRegistrationPrice: 20 },
  ...extra,
});

beforeEach(() => resetMockStats());

describe("drop orchestration (plan step J simulations)", () => {
  it("domain remains unavailable: the watch stops when the window closes", async () => {
    const drop = new Date(Date.now() + 1000).toISOString();
    const h = harness(mockConfig({
      accounts: { a: { scenario: "always-unavailable" } },
      target: { drop: { expectedAt: drop, preWindowSeconds: 1, postWindowSeconds: 1 }, monitoring: { warmupIntervalMs: 100, hotIntervalMs: 50, hotWindowSeconds: 0, requestTimeoutMs: 500 }, availability: { providers: ["a"] } },
    }));
    const outcome = await h.orchestrator("t1").run(signal());
    assert.equal(outcome, "window_expired");
    assert.ok(mockStats.get("a")!.checks >= 5);
    assert.equal(h.store.getState("t1")!.state, "IDLE");
    assert.ok(h.sink.types().includes("drop_window_entered"));
  });

  it("notify-only: detects and stops without touching registration", async () => {
    const h = harness(mockConfig({ accounts: { a: { availableAfterChecks: 2 } }, target: { availability: { providers: ["a"] } } }));
    assert.equal(await h.orchestrator("t1").run(signal()), "detected");
    assert.equal(mockStats.get("a")!.registrations, 0);
    assert.ok(h.sink.types().includes("availability_detected"));
  });

  it("dry run never reaches register(): it uses the preflight and records a simulated attempt", async () => {
    const h = harness(mockConfig({ dryRun: true, accounts: { a: { availableAfterChecks: 1 } }, target: { availability: { providers: ["a"] }, registration: autoBuy(["a"]) } }));
    assert.equal(await h.orchestrator("t1").run(signal()), "dry_run");
    assert.equal(mockStats.get("a")!.registrations, 0);
    assert.equal(mockStats.get("a")!.preflights, 1);
    const attempt = h.store.attempts("t1")[0]!;
    assert.deepEqual([attempt.status, attempt.dryRun], ["simulated", true]);
    assert.equal(h.store.countAttempts("t1"), 0);
  });

  it("domain becomes available: registers once, persists SUCCEEDED and refuses to arm again", async () => {
    const h = harness(mockConfig({ accounts: { a: { availableAfterChecks: 2, price: 9.73 } }, target: { availability: { providers: ["a"] }, registration: autoBuy(["a"]) } }));
    assert.equal(await h.orchestrator("t1").run(signal()), "succeeded");
    assert.equal(mockStats.get("a")!.registrations, 1);
    assert.equal(h.store.getState("t1")!.state, "SUCCEEDED");
    const types = h.sink.types();
    assert.ok(types.indexOf("availability_detected") < types.indexOf("registration_started"));
    assert.ok(types.indexOf("registration_started") < types.indexOf("registration_succeeded"));
    assert.equal(await h.orchestrator("t1").run(signal()), "blocked_state");
    assert.equal(mockStats.get("a")!.registrations, 1, "no second purchase");
  });

  it("provider A fails, provider B succeeds (fallback only after a confirmed failure)", async () => {
    const h = harness(mockConfig({
      accounts: { a: { availableAfterChecks: 0, registration: "failure" }, b: { availableAfterChecks: 0 } },
      target: { availability: { providers: ["a"] }, registration: autoBuy(["a", "b"], { maxTotalAttempts: 2 }) },
    }));
    assert.equal(await h.orchestrator("t1").run(signal()), "succeeded");
    assert.equal(mockStats.get("a")!.registrations, 1);
    assert.equal(mockStats.get("b")!.registrations, 1);
    assert.ok(h.sink.types().includes("registration_failed"));
  });

  it("registration times out: AMBIGUOUS, and provider B is NEVER tried", async () => {
    const h = harness(mockConfig({
      accounts: { a: { availableAfterChecks: 0, registration: "timeout" }, b: { availableAfterChecks: 0 } },
      target: { availability: { providers: ["a"] }, registration: autoBuy(["a", "b"], { maxTotalAttempts: 3 }) },
    }));
    assert.equal(await h.orchestrator("t1").run(signal()), "ambiguous");
    assert.equal(mockStats.get("b")?.registrations ?? 0, 0);
    assert.equal(h.store.getState("t1")!.state, "AMBIGUOUS");
    assert.ok(h.sink.types().includes("registration_ambiguous"));
    assert.equal(await h.orchestrator("t1").run(signal()), "blocked_state");
  });

  it("registration succeeds but the response is lost: ownership lookup confirms SUCCEEDED", async () => {
    const h = harness(mockConfig({
      accounts: { a: { availableAfterChecks: 0, registration: "unknown", purchaseActuallySucceeds: true } },
      target: { availability: { providers: ["a"] }, registration: autoBuy(["a"]) },
    }));
    assert.equal(await h.orchestrator("t1").run(signal()), "succeeded");
    assert.equal(h.store.getState("t1")!.state, "SUCCEEDED");
    assert.ok(mockStats.get("a")!.ownershipLookups >= 1);
  });

  it("pending registration is followed to completion by status polling", async () => {
    const h = harness(mockConfig({
      accounts: { a: { availableAfterChecks: 0, registration: "pending", pendingResolvesTo: "success" } },
      target: { availability: { providers: ["a"] }, registration: autoBuy(["a"]) },
    }));
    assert.equal(await h.orchestrator("t1").run(signal()), "succeeded");
  });

  it("price above budget: purchase blocked, budget_exceeded emitted, nothing bought", async () => {
    const h = harness(mockConfig({ accounts: { a: { availableAfterChecks: 0, price: 49.99 } }, target: { availability: { providers: ["a"] }, registration: autoBuy(["a"]) } }));
    assert.equal(await h.orchestrator("t1").run(signal()), "aborted");
    assert.equal(mockStats.get("a")!.registrations, 0);
    assert.ok(h.sink.types().includes("budget_exceeded"));
    assert.equal(h.store.getState("t1")!.state, "ABORTED");
  });

  it("a 429 source is not a negative: the other source still triggers detection", async () => {
    const h = harness(mockConfig({ accounts: { limited: { scenario: "rate-limited" }, ok: { availableAfterChecks: 1 } }, target: { availability: { providers: ["limited", "ok"] } } }));
    assert.equal(await h.orchestrator("t1").run(signal()), "detected");
    assert.ok(h.sink.types().includes("rate_limited"));
  });

  it("stale positive (source says free, registrar says taken) triggers once, not in a loop", async () => {
    const h = harness(mockConfig({
      accounts: { stale: { scenario: "always-available" }, reg: { scenario: "always-unavailable" } },
      target: { availability: { providers: ["stale"] }, registration: autoBuy(["reg"]) },
    }));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 1200);
    assert.equal(await h.orchestrator("t1").run(controller.signal), "stopped");
    assert.equal(h.sink.types().filter((t) => t === "availability_detected").length, 1);
    assert.equal(h.sink.types().filter((t) => t === "availability_false_positive").length, 1);
    assert.equal(mockStats.get("reg")!.registrations, 0);
  });

  it("confirm mode: declined means no purchase; confirmed means purchase", async () => {
    const yaml = mockConfig({ accounts: { a: { availableAfterChecks: 0 } }, target: { availability: { providers: ["a"] }, registration: autoBuy(["a"], { mode: "confirm" }) } });
    const declined = harness(yaml);
    assert.equal(await declined.orchestrator("t1", { confirm: async () => false }).run(signal()), "declined");
    assert.equal(mockStats.get("a")!.registrations, 0);
    resetMockStats();
    const confirmed = harness(yaml);
    let asked: string | undefined;
    const outcome = await confirmed.orchestrator("t1", { confirm: async (r) => ((asked = r.domain), true) }).run(signal());
    assert.equal(outcome, "succeeded");
    assert.equal(asked, "catch-me.com");
  });

  it("process restarts during registration: the next start converts to AMBIGUOUS and never buys", async () => {
    const dbPath = join(tempDir(), "restart.sqlite");
    const yaml = mockConfig({ accounts: { a: { availableAfterChecks: 0 } }, target: { availability: { providers: ["a"] }, registration: autoBuy(["a"]) } });
    const first = harness(yaml, { dbPath });
    first.store.arm("t1", "catch-me.com");
    first.store.transition("t1", "catch-me.com", "CHECKING");
    first.store.transition("t1", "catch-me.com", "AVAILABLE");
    first.store.transition("t1", "catch-me.com", "VERIFYING");
    assert.ok(first.store.claimRegistration({ attemptId: "crash", targetId: "t1", domain: "catch-me.com", provider: "a" }));
    first.store.close();
    const second = harness(yaml, { dbPath });
    assert.equal(await second.orchestrator("t1").run(signal()), "blocked_state");
    assert.equal(second.store.getState("t1")!.state, "AMBIGUOUS");
    assert.equal(mockStats.get("a")?.registrations ?? 0, 0);
  });

  it("Discord failing does not affect the purchase", async () => {
    let hits = 0;
    const server = createServer((_req, res) => {
      hits++;
      res.writeHead(500).end("down");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      const h = harness(mockConfig({ accounts: { a: { availableAfterChecks: 0 } }, target: { availability: { providers: ["a"] }, registration: autoBuy(["a"]) } }));
      const router = new ProxyRouter();
      after(() => router.close());
      const channel = new DiscordChannel({ webhookUrl: `http://127.0.0.1:${port}/hook`, username: "t", timeZone: "UTC", transport: new UndiciTransport({ router }), timeoutMs: 500, retryDelayMs: 20 });
      const notifier = new Notifier(new Map([["t1", { channels: [channel], events: new Set(["registration_succeeded", "availability_detected"] as const) }]]), silentLogger);
      const events = new EventPublisher({ store: h.store, logger: silentLogger, notifier, timeZone: "UTC" });
      const o = h.orchestrator("t1", { events });
      const started = Date.now();
      assert.equal(await o.run(signal()), "succeeded");
      assert.ok(Date.now() - started < 3000, "purchase path did not wait for Discord retries");
      await notifier.drain(5_000);
      assert.ok(hits >= 2, "notifier retried");
      assert.ok(notifier.failed >= 1);
    } finally {
      server.close();
    }
  });
});
