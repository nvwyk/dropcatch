import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatDuration, formatInstant, isValidTimeZone, parseInstant, timeZoneOffsetMs } from "../../src/core/time.ts";

describe("time", () => {
  it("parses UTC and offset ISO timestamps with milliseconds", () => {
    assert.equal(parseInstant("2026-10-01T12:00:00.000Z").utcMs, Date.UTC(2026, 9, 1, 12));
    assert.equal(parseInstant("2026-10-01T14:00:00.250+02:00").utcMs, Date.UTC(2026, 9, 1, 12, 0, 0, 250));
    assert.equal(parseInstant("2026-10-01 07:00-0500").utcMs, Date.UTC(2026, 9, 1, 12));
  });

  it("interprets naive times in the configured timezone (CEST and CET)", () => {
    assert.equal(parseInstant("2026-10-01 14:00", "Europe/Warsaw").utcMs, Date.UTC(2026, 9, 1, 12));
    assert.equal(parseInstant("2026-12-01T14:00:00", "Europe/Warsaw").utcMs, Date.UTC(2026, 11, 1, 13));
    assert.equal(parseInstant("2026-10-01T12:00:00", "UTC").usedTimeZone, true);
  });

  it("rejects wall times skipped by a DST change", () => {
    assert.throws(() => parseInstant("2026-03-29T02:30:00", "Europe/Warsaw"), /does not exist/);
  });

  it("flags wall times that occur twice and picks the earlier instant", () => {
    const r = parseInstant("2026-10-25T02:30:00", "Europe/Warsaw");
    assert.equal(r.ambiguous, true);
    assert.equal(r.utcMs, Date.UTC(2026, 9, 25, 0, 30));
  });

  it("rejects invalid dates, strings and timezones", () => {
    assert.throws(() => parseInstant("not-a-date"));
    assert.throws(() => parseInstant("2026-02-30T10:00:00Z"));
    assert.throws(() => parseInstant("2026-10-01T25:00:00Z"));
    assert.throws(() => parseInstant("2026-10-01T10:00:00", "Mars/Olympus"));
    assert.equal(isValidTimeZone("Europe/Warsaw"), true);
    assert.equal(isValidTimeZone("Nowhere/Land"), false);
  });

  it("computes offsets and formats with milliseconds", () => {
    assert.equal(timeZoneOffsetMs(Date.UTC(2026, 6, 1), "Europe/Warsaw"), 2 * 3_600_000);
    assert.equal(formatInstant(Date.UTC(2026, 9, 1, 12, 0, 1, 231), "UTC"), "12:00:01.231");
    assert.equal(formatInstant(Date.UTC(2026, 9, 1, 12), "Europe/Warsaw", { withDate: true }), "2026-10-01 14:00:00.000");
    assert.equal(formatDuration(182), "182ms");
    assert.equal(formatDuration(3_725_000), "1h 02m");
  });
});
