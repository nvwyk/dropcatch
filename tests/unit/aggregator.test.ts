import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { aggregate } from "../../src/core/availability/AvailabilityAggregator.ts";
import { AvailabilityService, type Backoff } from "../../src/core/availability/AvailabilityService.ts";
import { rdapPlugin } from "../../src/providers/rdap/RdapProvider.ts";
import { RateLimiter } from "../../src/providers/RateLimiter.ts";
import type { AvailabilityResult, AvailabilityStatus, SourceKind } from "../../src/core/types.ts";

const r = (provider: string, status: AvailabilityStatus, sourceKind: SourceKind = "registrar", at = 1): AvailabilityResult => ({
  provider,
  providerType: provider,
  sourceKind,
  domain: "example.pl",
  status,
  startedAt: new Date(at).toISOString(),
  checkedAt: new Date(at).toISOString(),
  latencyMs: 10,
});

describe("availability aggregation", () => {
  it("timeouts, 429 and errors never count as unavailable (plan section 39)", () => {
    const res = aggregate([r("a", "error"), r("b", "available"), r("c", "rate_limited")], "any", 1, true);
    assert.equal(res.decision, "positive");
    assert.equal(res.indeterminate.length, 2);
    const none = aggregate([r("a", "error"), r("c", "rate_limited")], "any", 1, true);
    assert.equal(none.decision, "inconclusive");
  });

  it("any: positive as soon as enough sources agree, even before others answer", () => {
    assert.equal(aggregate([r("a", "available")], "any", 1, false).decision, "positive");
    assert.equal(aggregate([r("a", "available")], "any", 2, false).decision, "inconclusive");
    assert.equal(aggregate([r("a", "available"), r("b", "unavailable")], "any", 2, true).decision, "negative");
  });

  it("majority: needs a strict majority of definitive answers and waits for all", () => {
    assert.equal(aggregate([r("a", "available"), r("b", "unavailable")], "majority", 1, true).decision, "negative");
    assert.equal(aggregate([r("a", "available"), r("b", "available"), r("c", "unavailable")], "majority", 1, true).decision, "positive");
    assert.equal(aggregate([r("a", "available"), r("b", "available")], "majority", 1, false).decision, "inconclusive");
    assert.equal(aggregate([r("a", "available"), r("b", "error")], "majority", 1, true).decision, "positive");
  });

  it("registry-confirmed: needs both a registry and a registrar signal", () => {
    assert.equal(aggregate([r("rdap", "available", "registry")], "registry-confirmed", 1, true).decision, "inconclusive");
    assert.equal(aggregate([r("rdap", "available", "registry"), r("pb", "unavailable")], "registry-confirmed", 1, true).decision, "negative");
    assert.equal(aggregate([r("rdap", "available", "registry"), r("pb", "available")], "registry-confirmed", 1, true).decision, "positive");
  });

  it("orders positives by time so the first detector is reported", () => {
    const res = aggregate([r("slow", "available", "registrar", 50), r("fast", "available", "registrar", 10)], "any", 1, true);
    assert.equal(res.available[0]!.provider, "fast");
  });
});

describe("rate-limit back-off", () => {
  /** Runs one check per tick, each as soon as the limiter allows, and records the back-off after it. */
  async function backoffs(statuses: AvailabilityStatus[]): Promise<Array<Backoff | undefined>> {
    let t = 1_000_000;
    const now = (): number => t;
    const limiter = new RateLimiter({}, now);
    const script = [...statuses];
    const seen: Array<Backoff | undefined> = [];
    const service = new AvailabilityService(
      [{ id: "rdap", plugin: rdapPlugin, limiter, instance: { check: async () => r("rdap", script.shift()!, "registry", t) } }],
      { mode: "any", minimumConfirmations: 1, timeoutMs: 1000, now, onResult: (_result, backoff) => seen.push(backoff) },
    );
    while (script.length) {
      t = limiter.nextAvailableAt();
      await service.tick("qusim.pl", new AbortController().signal, 10_000);
    }
    return seen;
  }

  it("doubles up to 5 minutes, then eases back in one step per answer (NASK blocks again at full speed)", async () => {
    const seen = await backoffs([...Array<AvailabilityStatus>(9).fill("rate_limited"), "unavailable", "unavailable"]);
    assert.deepEqual(seen.map((b) => b?.retryInMs), [5000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000, 160_000, 80_000]);
    assert.deepEqual(seen.map((b) => b?.level), [1, 2, 3, 4, 5, 6, 7, 7, 7, 6, 5]);
  });

  it("a single 429 costs one step: the next answer is back at the configured pace", async () => {
    const seen = await backoffs(["rate_limited", "available", "unavailable"]);
    assert.deepEqual(seen, [{ level: 1, retryInMs: 5000 }, undefined, undefined]);
  });
});
