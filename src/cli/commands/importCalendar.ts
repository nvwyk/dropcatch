import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ConfigFile } from "../../config/ConfigFile.ts";
import { applyImport, parseImport, type ImportDefaults, type ImportRow } from "../../config/importTargets.ts";
import { dropEntries, toIcs } from "../../core/calendar.ts";
import { ConfigError } from "../../core/errors.ts";
import { formatDuration, formatInstant } from "../../core/time.ts";
import { bad, bold, dim, good, out, printJson, table, warn } from "../output.ts";
import type { Runtime } from "../runtime.ts";

export interface ImportOverrides {
  mode?: string;
  maxPrice?: string;
  currency?: string;
  registrar?: string[];
  source?: string[];
  timezone?: string;
}

/** Defaults for imported rows: every enabled availability source, registrars only when buying. */
export function importDefaults(rt: Runtime, o: ImportOverrides = {}): ImportDefaults {
  const accounts = Object.values(rt.config.accounts).filter((a) => a.enabled);
  const mode = (o.mode ?? "notify-only") as ImportDefaults["mode"];
  const maxPrice = o.maxPrice !== undefined ? Number(o.maxPrice) : undefined;
  return {
    mode,
    maxPrice,
    currency: (o.currency ?? (accounts.some((a) => a.plugin.id === "ovh") ? "PLN" : "USD")).toUpperCase(),
    registrars: o.registrar?.length ? o.registrar : accounts.filter((a) => a.plugin.capabilities.registration && a.plugin.id !== "mock").map((a) => a.id),
    sources: o.source?.length ? o.source : accounts.filter((a) => a.plugin.capabilities.availability).map((a) => a.id),
    timezone: o.timezone ?? rt.config.app.timezone,
    preWindowSeconds: 600,
    postWindowSeconds: 900,
  };
}

export function existingTargets(rt: Runtime): { ids: Set<string>; domains: Map<string, string> } {
  return {
    ids: new Set(rt.config.targets.map((t) => t.id)),
    domains: new Map(rt.config.targets.map((t) => [t.domain.ascii, t.id])),
  };
}

function printRows(rows: ImportRow[], tz: string): void {
  table(
    ["line", "target", "domain", "drop", "action"],
    rows.map((r) => [
      String(r.line),
      r.id ?? "",
      r.domain ?? r.raw.slice(0, 40),
      r.expectedAt ? formatInstant(Date.parse(r.expectedAt), tz, { withDate: true }).slice(0, 16) : dim("none"),
      r.action === "error" ? bad(`error: ${r.reason}`) : r.action === "skip" ? warn(`skip: ${r.reason}`) : good(r.action),
    ]),
  );
}

export async function importCommand(rt: Runtime, file: string, opts: ImportOverrides & { dryRun?: boolean; update?: boolean; json?: boolean }): Promise<number> {
  if (!rt.config.path) throw new ConfigError("import needs a config file to write to (run dropcatch init first)");
  const text = file === "-" ? readFileSync(0, "utf8") : readFileSync(resolve(file), "utf8");
  const rows = parseImport(text, importDefaults(rt, opts), existingTargets(rt), opts.update === true);
  const counts = { create: 0, update: 0, skip: 0, error: 0 };
  for (const r of rows) counts[r.action]++;
  if (!opts.json) printRows(rows, rt.config.app.timezone);

  if (opts.dryRun || counts.error > 0 || counts.create + counts.update === 0) {
    if (opts.json) printJson({ applied: false, counts, rows });
    else {
      out();
      out(counts.error ? bad(`${counts.error} row(s) have errors; nothing was imported.`) : dim(opts.dryRun ? "Dry run: nothing was written." : "Nothing to import."));
    }
    return counts.error ? 2 : 0;
  }
  const configFile = new ConfigFile(rt.config.path);
  const report = await configFile.save(applyImport(configFile, rows));
  if (opts.json) printJson({ applied: true, counts, rows, warnings: report.warnings });
  else {
    out();
    out(good(`Imported ${counts.create} new and ${counts.update} updated target(s)`) + (counts.skip ? dim(`, ${counts.skip} skipped`) : "") + dim(` into ${rt.config.path}`));
  }
  return 0;
}

export async function calendarCommand(rt: Runtime, opts: { ics?: string; days?: string; json?: boolean }): Promise<number> {
  const entries = dropEntries(rt.config.targets);
  if (opts.ics) {
    const path = resolve(opts.ics);
    writeFileSync(path, toIcs(entries));
    if (!opts.json) out(good(`Wrote ${entries.length} drop(s) to ${path}`));
  }
  const horizon = Date.now() + Number(opts.days ?? 30) * 86_400_000;
  const upcoming = entries.filter((e) => e.windowEnd >= Date.now() && e.expectedAt <= horizon);
  if (opts.json) {
    printJson(upcoming);
    return 0;
  }
  if (opts.ics) return 0;
  const tz = rt.config.app.timezone;
  out(bold(`Upcoming drops (next ${opts.days ?? 30} days, ${tz})`));
  if (!upcoming.length) {
    out(dim("  none"));
    return 0;
  }
  table(
    ["when", "in", "domain", "mode", "target"],
    upcoming.map((e) => [
      formatInstant(e.expectedAt, tz, { withDate: true }).slice(0, 16),
      e.expectedAt > Date.now() ? formatDuration(e.expectedAt - Date.now()) : warn("window open"),
      e.unicode,
      e.mode,
      e.enabled ? e.id : dim(`${e.id} (disabled)`),
    ]),
  );
  return 0;
}
