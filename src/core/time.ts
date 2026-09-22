/**
 * UTC-first time helpers. Everything internal is epoch milliseconds (UTC).
 * Timezones are used only to parse naive user input and to display times.
 */

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function wallClock(utcMs: number, timeZone: string): WallClock {
  const parts = partsFormatter(timeZone).formatToParts(new Date(utcMs));
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") % 24,
    minute: get("minute"),
    second: get("second"),
  };
}

/** Offset of `timeZone` from UTC at the given instant, in ms (e.g. +7200000 for CEST). */
export function timeZoneOffsetMs(utcMs: number, timeZone: string): number {
  const w = wallClock(utcMs, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  const flooredToSecond = Math.floor(utcMs / 1000) * 1000;
  return asUtc - flooredToSecond;
}

export interface ZonedConversion {
  utcMs: number;
  /** The wall time occurred twice (DST fall-back). The earlier instant was chosen. */
  ambiguous: boolean;
}

/** Convert a wall-clock time in `timeZone` to a UTC instant. Throws for times skipped by DST. */
export function zonedTimeToUtc(
  wall: WallClock & { millisecond?: number },
  timeZone: string,
): ZonedConversion {
  const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second, wall.millisecond ?? 0);
  const candidates = new Set<number>();
  // Probe offsets around the naive instant; any offset that round-trips is a valid interpretation.
  for (const probe of [naive - 86_400_000, naive, naive + 86_400_000]) {
    const offset = timeZoneOffsetMs(probe, timeZone);
    const utc = naive - offset;
    if (utc + timeZoneOffsetMs(utc, timeZone) === naive) candidates.add(utc);
  }
  if (candidates.size === 0) {
    throw new Error(`time does not exist in ${timeZone} (skipped by a daylight-saving change)`);
  }
  const sorted = [...candidates].sort((a, b) => a - b);
  return { utcMs: sorted[0]!, ambiguous: sorted.length > 1 };
}

const ISO_WITH_ZONE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:?\d{2})$/i;
const NAIVE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;

export interface ParsedInstant {
  utcMs: number;
  ambiguous: boolean;
  /** true when the input carried no zone and `timeZone` was applied. */
  usedTimeZone: boolean;
}

function checkRanges(y: number, mo: number, d: number, h: number, mi: number, s: number, input: string): void {
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (
    mo < 1 || mo > 12 || h > 23 || mi > 59 || s > 59 ||
    probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d
  ) {
    throw new Error(`"${input}" is not a valid calendar date/time`);
  }
}

/**
 * Parse "2026-10-01T12:00:00.000Z", "2026-10-01T14:00:00+02:00" or a naive
 * "2026-10-01 14:00:00" (interpreted in `timeZone`).
 */
export function parseInstant(input: string, timeZone = "UTC"): ParsedInstant {
  const text = input.trim();
  const zoned = ISO_WITH_ZONE.exec(text);
  if (zoned) {
    const [, y, mo, d, h, mi, s = "0", ms = "0", zone] = zoned;
    checkRanges(+y!, +mo!, +d!, +h!, +mi!, +s, text);
    const millis = Number(ms.padEnd(3, "0"));
    const base = Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +s, millis);
    let offsetMs = 0;
    if (zone!.toUpperCase() !== "Z") {
      const sign = zone!.startsWith("-") ? -1 : 1;
      const digits = zone!.slice(1).replace(":", "");
      offsetMs = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4))) * 60_000;
    }
    return { utcMs: base - offsetMs, ambiguous: false, usedTimeZone: false };
  }
  const naive = NAIVE.exec(text);
  if (naive) {
    if (!isValidTimeZone(timeZone)) throw new Error(`unknown timezone "${timeZone}"`);
    const [, y, mo, d, h, mi, s = "0", ms = "0"] = naive;
    checkRanges(+y!, +mo!, +d!, +h!, +mi!, +s, text);
    const result = zonedTimeToUtc(
      { year: +y!, month: +mo!, day: +d!, hour: +h!, minute: +mi!, second: +s, millisecond: Number(ms.padEnd(3, "0")) },
      timeZone,
    );
    return { ...result, usedTimeZone: true };
  }
  throw new Error(`"${input}" is not an ISO-8601 date/time (expected e.g. 2026-10-01T12:00:00Z)`);
}

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

/** "2026-10-01 14:00:00.000 CEST" (withDate) or "14:00:00.000". */
export function formatInstant(
  utcMs: number,
  timeZone = "UTC",
  opts: { withDate?: boolean; withZone?: boolean } = {},
): string {
  const w = wallClock(utcMs, timeZone);
  const millis = ((utcMs % 1000) + 1000) % 1000;
  const time = `${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}.${pad(millis, 3)}`;
  let out = opts.withDate ? `${w.year}-${pad(w.month)}-${pad(w.day)} ${time}` : time;
  if (opts.withZone) out += ` ${zoneLabel(utcMs, timeZone)}`;
  return out;
}

function zoneLabel(utcMs: number, timeZone: string): string {
  if (timeZone === "UTC" || timeZone === "Etc/UTC") return "UTC";
  const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" })
    .formatToParts(new Date(utcMs))
    .find((p) => p.type === "timeZoneName")?.value;
  return name ?? timeZone;
}

/** Human duration: "1h 02m", "4m 05s", "2.35s", "180ms". */
export function formatDuration(ms: number): string {
  const sign = ms < 0 ? "-" : "";
  const abs = Math.abs(ms);
  if (abs < 1000) return `${sign}${Math.round(abs)}ms`;
  if (abs < 60_000) return `${sign}${(abs / 1000).toFixed(2)}s`;
  const totalSeconds = Math.floor(abs / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${sign}${h}h ${pad(m)}m`;
  return `${sign}${m}m ${pad(s)}s`;
}
