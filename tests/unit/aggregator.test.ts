import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { aggregate } from "../../src/core/availability/AvailabilityAggregator.ts";
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
