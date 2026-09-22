import type { ResolvedTarget } from "../../config/loader.ts";
import { RDAP_ACCOUNT } from "../../config/loader.ts";
import type { QuorumMode } from "../../config/schema.ts";
import { aggregate, type AggregateResult } from "../../core/availability/AvailabilityAggregator.ts";
import type { AvailabilityResult } from "../../core/types.ts";
import { formatMoney } from "../../core/types.ts";
import { displayDomain, normalizeDomain } from "../../domain/normalize.ts";
import { strategyFor } from "../../tld/strategies.ts";
import { bad, bold, dim, good, kv, out, printJson, warn } from "../output.ts";
import type { Runtime } from "../runtime.ts";

export interface CheckReport {
  domain: string;
  unicode: string;
  results: AvailabilityResult[];
  skipped: Array<{ account: string; reason: string }>;
  decision: AggregateResult["decision"];
  basis: string;
  quorum: QuorumMode;
  tldNotes: string[];
  clockSkewMs?: number;
}

/** One-shot availability check across sources. Shared by the CLI and the dashboard. */
export async function runCheck(rt: Runtime, input: string, providers?: string[]): Promise<CheckReport> {
  const domain = normalizeDomain(input);
  const target: ResolvedTarget | undefined = rt.config.targets.find((t) => t.domain.ascii === domain.ascii);
  const candidates = providers?.length
    ? providers
    : Object.values(rt.config.accounts)
      .filter((a) => a.enabled && a.plugin.capabilities.availability)
      .map((a) => a.id);

  const skipped: CheckReport["skipped"] = [];
  const usable: Array<{ id: string; check: NonNullable<ReturnType<Runtime["account"]>["instance"]> }> = [];
  for (const id of candidates) {
    const handle = rt.account(id);
    if (!handle.instance?.check) {
      skipped.push({ account: id, reason: handle.error ?? "no availability check" });
      continue;
    }
    usable.push({ id, check: handle.instance });
  }
  await Promise.allSettled(usable.map((u) => u.check.prepare?.(domain.ascii)));
  const timeoutMs = target?.requestTimeoutMs ?? 5000;
  const signal = AbortSignal.timeout(timeoutMs * 3);
  const results = await Promise.all(usable.map((u) => u.check.check!({ domain: domain.ascii, timeoutMs, signal })));
  const quorum = target?.availability.quorum ?? "any";
  const agg = aggregate(results, quorum, target?.availability.minimumConfirmations ?? 1, true);
  const skews = results.map((r) => r.clockSkewMs).filter((s): s is number => s !== undefined);
  return {
    domain: domain.ascii,
    unicode: domain.unicode,
    results,
    skipped,
    decision: agg.decision,
    basis: agg.basis,
    quorum,
    tldNotes: strategyFor(domain).semantics.notes,
    clockSkewMs: skews.length ? Math.round(skews.reduce((a, b) => a + b, 0) / skews.length) : undefined,
  };
}

function statusText(r: AvailabilityResult): string {
  switch (r.status) {
    case "available":
      return r.sourceKind === "registry" ? good("not found in registry (possible availability)") : good("available");
    case "unavailable":
      return bad("unavailable");
    default:
      return warn(r.status);
  }
}

export async function checkCommand(rt: Runtime, input: string, opts: { provider?: string[]; json?: boolean }): Promise<number> {
  const report = await runCheck(rt, input, opts.provider);
  if (opts.json) {
    printJson(report);
    return 0;
  }
  out(`${bold("Domain:")} ${displayDomain(normalizeDomain(report.domain))}`);
  for (const r of report.results) {
    out();
    out(bold(r.provider === RDAP_ACCOUNT ? "RDAP" : `${r.provider} ${dim(`(${r.providerType})`)}`));
    kv("status", statusText(r));
    if (r.price) kv("price", formatMoney(r.price));
    if (r.premium !== undefined) kv("premium", r.premium ? warn("yes") : "no");
    if (r.registrable === false && r.status === "available") kv("registrable", warn("no (via this API)"));
    if (r.reason) kv("detail", r.reason);
    if (r.errorCode) kv("error", r.errorCode);
    if (r.advisory) kv("note", warn("registry data may lag; not proof of registrability"));
    kv("latency", `${r.latencyMs} ms`);
  }
  for (const s of report.skipped) {
    out();
    out(`${bold(s.account)} ${dim("skipped")}`);
    kv("reason", s.reason);
  }
  out();
  out(bold(`Decision (${report.quorum}):`));
  const label = report.decision === "positive" ? good("POSITIVE") : report.decision === "negative" ? bad("NEGATIVE") : warn("INCONCLUSIVE");
  kv("registrable signal", `${label} ${dim(report.basis)}`);
  if (report.clockSkewMs !== undefined && Math.abs(report.clockSkewMs) > 1500) {
    out();
    out(warn(`Clock: servers report a time about ${(report.clockSkewMs / 1000).toFixed(1)} s away from this machine. Check NTP.`));
  }
  if (report.tldNotes.length && report.results.some((r) => r.sourceKind === "registry")) {
    out();
    for (const note of report.tldNotes) out(dim(`Note: ${note}`));
  }
  return 0;
}
