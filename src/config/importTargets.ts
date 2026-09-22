import { isMap, isSeq } from "yaml";
import { isValidTimeZone, parseInstant } from "../core/time.ts";
import { normalizeDomain } from "../domain/normalize.ts";
import type { ConfigFile } from "./ConfigFile.ts";

export interface ImportDefaults {
  mode: "notify-only" | "confirm" | "auto-buy";
  maxPrice?: number;
  currency: string;
  /** Registration accounts, in order. */
  registrars: string[];
  /** Availability sources. */
  sources: string[];
  timezone: string;
  preWindowSeconds: number;
  postWindowSeconds: number;
}

export interface ImportRow {
  line: number;
  raw: string;
  id?: string;
  domain?: string;
  /** UTC ISO instant, when a drop time was given. */
  expectedAt?: string;
  action: "create" | "update" | "skip" | "error";
  reason?: string;
  target?: Record<string, unknown>;
}

const HEADER_ALIASES: Record<string, string> = {
  domain: "domain",
  name: "domain",
  expectedat: "expectedAt",
  expected: "expectedAt",
  drop: "expectedAt",
  date: "expectedAt",
  time: "expectedAt",
  when: "expectedAt",
  timezone: "timezone",
  tz: "timezone",
  mode: "mode",
  maxprice: "maxPrice",
  max: "maxPrice",
  budget: "maxPrice",
  currency: "currency",
  registrars: "registrars",
  registrar: "registrars",
  providers: "registrars",
  sources: "sources",
  id: "id",
  pre: "preWindowSeconds",
  prewindowseconds: "preWindowSeconds",
  post: "postWindowSeconds",
  postwindowseconds: "postWindowSeconds",
};

/** Split one CSV line, honouring double quotes. */
export function splitCsvLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function detectDelimiter(header: string): string {
  const counts = [",", ";", "\t"].map((d) => [d, header.split(d).length] as const);
  return counts.sort((a, b) => b[1] - a[1])[0]![0];
}

const slug = (domain: string): string => domain.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const list = (v: string | undefined): string[] | undefined => (v ? v.split(/[|\s]+/).map((s) => s.trim()).filter(Boolean) : undefined);

/**
 * Parse a CSV (header with a "domain" column) or plain lines ("domain [time]").
 * Lines starting with # are ignored. Rows are validated individually so the operator sees
 * every problem at once; the whole import is still validated again as one config.
 */
export function parseImport(text: string, defaults: ImportDefaults, existing: { ids: Set<string>; domains: Map<string, string> }, update: boolean): ImportRow[] {
  const lines = text.split(/\r?\n/).map((raw, i) => ({ raw, line: i + 1 })).filter((l) => l.raw.trim() && !l.raw.trim().startsWith("#"));
  if (!lines.length) return [];
  const first = lines[0]!.raw;
  const delimiter = detectDelimiter(first);
  const headerCells = splitCsvLine(first, delimiter).map((c) => HEADER_ALIASES[c.toLowerCase().replace(/[^a-z]/g, "")]);
  const hasHeader = headerCells.includes("domain");
  const body = hasHeader ? lines.slice(1) : lines;
  const seenIds = new Set<string>();
  const seenDomains = new Set<string>();

  return body.map(({ raw, line }): ImportRow => {
    let cells: Record<string, string | undefined> = {};
    if (hasHeader) {
      const values = splitCsvLine(raw, delimiter);
      headerCells.forEach((key, i) => {
        if (key && values[i]) cells[key] = values[i];
      });
    } else {
      const m = /^\s*([^\s,;]+)[\s,;]*(.*)$/.exec(raw);
      cells = { domain: m?.[1], expectedAt: m?.[2]?.trim() || undefined };
    }
    const row: ImportRow = { line, raw, action: "create" };
    try {
      const domain = normalizeDomain(cells.domain ?? "").ascii;
      row.domain = domain;
      const id = cells.id?.trim() || slug(domain);
      row.id = id;
      if (seenIds.has(id) || seenDomains.has(domain)) throw new Error("duplicate in this import");
      seenIds.add(id);
      seenDomains.add(domain);
      const owner = existing.domains.get(domain);
      if (owner && owner !== id) throw new Error(`already watched by target "${owner}"`);
      if (existing.ids.has(id)) {
        if (!update) return { ...row, action: "skip", reason: "target already exists (use update to overwrite)" };
        row.action = "update";
      }

      const timezone = cells.timezone || defaults.timezone;
      if (!isValidTimeZone(timezone)) throw new Error(`unknown timezone "${timezone}"`);
      if (cells.expectedAt) {
        const text = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}$/.test(cells.expectedAt) ? `${cells.expectedAt}:00` : cells.expectedAt;
        row.expectedAt = new Date(parseInstant(text, timezone).utcMs).toISOString();
      }
      const mode = (cells.mode ?? defaults.mode) as ImportDefaults["mode"];
      if (!["notify-only", "confirm", "auto-buy"].includes(mode)) throw new Error(`mode must be notify-only, confirm or auto-buy`);
      const maxPrice = cells.maxPrice !== undefined ? Number(cells.maxPrice) : defaults.maxPrice;
      if (maxPrice !== undefined && !(maxPrice > 0)) throw new Error("maxPrice must be a positive number");
      const registrars = list(cells.registrars) ?? defaults.registrars;
      const sources = list(cells.sources) ?? defaults.sources;
      const pre = cells.preWindowSeconds !== undefined ? Number(cells.preWindowSeconds) : defaults.preWindowSeconds;
      const post = cells.postWindowSeconds !== undefined ? Number(cells.postWindowSeconds) : defaults.postWindowSeconds;
      const buying = mode !== "notify-only";
      row.target = {
        id,
        domain,
        ...(row.expectedAt ? { drop: { expectedAt: row.expectedAt, preWindowSeconds: pre, postWindowSeconds: post } } : {}),
        availability: { providers: sources },
        registration: {
          enabled: buying,
          mode,
          providers: registrars,
          budget: { ...(maxPrice !== undefined ? { maxRegistrationPrice: maxPrice } : {}), currency: (cells.currency ?? defaults.currency).toUpperCase() },
        },
      };
      return row;
    } catch (err) {
      return { ...row, action: "error", reason: (err as Error).message };
    }
  });
}

/** Apply parsed rows to the config text (not saved). Throws if any row has an error. */
export function applyImport(file: ConfigFile, rows: ImportRow[]): string {
  const bad = rows.filter((r) => r.action === "error");
  if (bad.length) throw new Error(`${bad.length} row(s) have errors; fix them first`);
  return file.edit((doc) => {
    let seq = doc.get("targets", true);
    if (!isSeq(seq)) {
      doc.set("targets", doc.createNode([]));
      seq = doc.get("targets", true);
    }
    const items = (seq as { items: unknown[] }).items;
    for (const row of rows) {
      if (row.action !== "create" && row.action !== "update") continue;
      const node = doc.createNode(row.target);
      const index = items.findIndex((item) => isMap(item) && item.get("id") === row.id);
      if (index >= 0) items[index] = node;
      else items.push(node);
    }
  });
}
