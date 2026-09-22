import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { boundaries, intervalFor, nextTickAt, phaseAt, shouldStop, type ScheduleConfig } from "../../src/core/watcher/schedule.ts";

const T = Date.UTC(2026, 9, 1, 12);
const cfg: ScheduleConfig = {
  dropAt: T,
  strategy: "adaptive",
  preWindowMs: 600_000,
  hotWindowMs: 10_000,
  postWindowMs: 300_000,
  initialIntervalMs: 30_000,
  warmupIntervalMs: 1000,
  hotIntervalMs: 250,
  fixedIntervalMs: 5000,
  alignToDrop: true,
  stopAfterWindow: true,
};

describe("schedule", () => {
  it("computes phases around the drop", () => {
    assert.equal(phaseAt(T - 3_600_000, cfg), "idle");
    assert.equal(phaseAt(T - 600_000, cfg), "warm");
    assert.equal(phaseAt(T - 10_001, cfg), "warm");
    assert.equal(phaseAt(T - 10_000, cfg), "hot");
    assert.equal(phaseAt(T, cfg), "hot");
    assert.equal(phaseAt(T + 9_999, cfg), "hot");
    assert.equal(phaseAt(T + 10_000, cfg), "post");
    assert.equal(phaseAt(T + 300_000, cfg), "expired");
    assert.equal(shouldStop(T + 300_000, cfg), true);
    assert.equal(shouldStop(T + 300_000, { ...cfg, stopAfterWindow: false }), false);
  });

  it("maps phases to intervals, and fixed strategy ignores phases", () => {
    assert.equal(intervalFor("idle", cfg), 30_000);
    assert.equal(intervalFor("warm", cfg), 1000);
    assert.equal(intervalFor("hot", cfg), 250);
    assert.equal(intervalFor("post", cfg), 1000);
    assert.equal(intervalFor("hot", { ...cfg, strategy: "fixed" }), 5000);
  });

  it("aligns ticks to a grid anchored at the drop instant, so one tick lands exactly on T", () => {
    let t = T - 2_000 + 37;
    const ticks: number[] = [];
    for (let i = 0; i < 20; i++) {
      t = nextTickAt(t, cfg);
      ticks.push(t);
    }
    assert.ok(ticks.includes(T), "a tick lands exactly on the drop");
    for (const tick of ticks) assert.equal(Math.abs((tick - T) % 250), 0);
  });

  it("never jumps over a phase boundary", () => {
    const b = boundaries({ ...cfg, dropAt: T });
    assert.equal(nextTickAt(b.warmStart - 5, cfg), b.warmStart);
    assert.equal(nextTickAt(b.hotStart - 400, cfg), b.hotStart);
    assert.equal(nextTickAt(b.postEnd - 3, cfg), b.postEnd);
  });

  it("clamps windows when hot is wider than pre/post", () => {
    const b = boundaries({ ...cfg, dropAt: T, preWindowMs: 5_000, postWindowMs: 2_000 });
    assert.equal(b.hotStart, T - 5_000);
    assert.equal(b.hotEnd, T + 2_000);
  });

  it("polls continuously with the fixed interval when there is no drop time", () => {
    const c = { ...cfg, dropAt: undefined };
    assert.equal(phaseAt(123, c), "continuous");
    assert.equal(nextTickAt(1000, c), 6000);
    assert.equal(shouldStop(Number.MAX_SAFE_INTEGER, c), false);
  });

  it("recovers from clock jumps by recomputing from now", () => {
    const afterJump = T + 1_000_000;
    assert.equal(phaseAt(afterJump, cfg), "expired");
    const beforeJump = T - 10 * 86_400_000;
    assert.ok(nextTickAt(beforeJump, cfg) - beforeJump <= 30_000);
  });
});
