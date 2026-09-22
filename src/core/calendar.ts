import type { ResolvedTarget } from "../config/loader.ts";

export interface DropEntry {
  id: string;
  domain: string;
  unicode: string;
  expectedAt: number;
  windowStart: number;
  windowEnd: number;
  mode: string;
  enabled: boolean;
}

/** Targets that have a drop time, soonest first. */
export function dropEntries(targets: ResolvedTarget[]): DropEntry[] {
  return targets
    .filter((t) => t.drop)
    .map((t) => ({
      id: t.id,
      domain: t.domain.ascii,
      unicode: t.domain.unicode,
      expectedAt: t.drop!.expectedAtMs,
      windowStart: t.drop!.expectedAtMs - t.drop!.preWindowMs,
      windowEnd: t.drop!.expectedAtMs + t.drop!.postWindowMs,
      mode: t.registration.mode,
      enabled: t.enabled,
    }))
    .sort((a, b) => a.expectedAt - b.expectedAt);
}

const icsDate = (ms: number): string => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/** RFC 5545 text escaping. */
const icsText = (s: string): string => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/** Fold lines longer than 75 octets (RFC 5545 section 3.1). */
function fold(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let start = 0;
  let first = true;
  while (start < bytes.length) {
    let end = Math.min(bytes.length, start + (first ? 75 : 74));
    // Never split a UTF-8 sequence.
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    parts.push((first ? "" : " ") + bytes.subarray(start, end).toString("utf8"));
    start = end;
    first = false;
  }
  return parts.join("\r\n");
}

/** iCalendar feed of drop windows, with a reminder 15 minutes before each window opens. */
export function toIcs(entries: DropEntry[], now = Date.now()): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//dropcatch//drop calendar//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-CALNAME:dropcatch drops"];
  for (const e of entries) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${e.id}-${icsDate(e.expectedAt)}@dropcatch`,
      `DTSTAMP:${icsDate(now)}`,
      `DTSTART:${icsDate(e.windowStart)}`,
      `DTEND:${icsDate(Math.max(e.windowEnd, e.windowStart + 60_000))}`,
      `SUMMARY:${icsText(`Drop: ${e.unicode}`)}`,
      `DESCRIPTION:${icsText(`Expected release ${new Date(e.expectedAt).toISOString()} (UTC). Mode: ${e.mode}. Target ${e.id}.`)}`,
      "TRANSP:TRANSPARENT",
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      `DESCRIPTION:${icsText(`Drop window for ${e.unicode} opens in 15 minutes`)}`,
      "TRIGGER:-PT15M",
      "END:VALARM",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(fold).join("\r\n")}\r\n`;
}
