import { existsSync } from "node:fs";
import { ConfigError } from "../../core/errors.ts";
import { formatInstant } from "../../core/time.ts";
import type { Store } from "../../persistence/Store.ts";
import { bad, bold, dim, good, kv, out, printJson, table, warn } from "../output.ts";
import type { Runtime } from "../runtime.ts";

function stateColor(state: string): string {
  if (state === "SUCCEEDED") return good(state);
  if (["AMBIGUOUS", "REGISTERING", "REGISTRATION_PENDING", "FAILED"].includes(state)) return bad(state);
  if (["ABORTED"].includes(state)) return warn(state);
  return state;
}

export function openExistingStore(rt: Runtime): Store | undefined {
  const path = rt.config.app.databasePath;
  if (path !== ":memory:" && !existsSync(path)) return undefined;
  return rt.openStore();
}

export async function statusCommand(rt: Runtime, opts: { target?: string; json?: boolean; events?: string }): Promise<number> {
  const store = openExistingStore(rt);
  if (!store) {
    if (opts.json) printJson({ targets: [], note: "no database yet" });
    else out(dim(`No history yet (${rt.config.app.databasePath} does not exist). Run "dropcatch watch" first.`));
    return 0;
  }
  const tz = rt.config.app.timezone;
  const when = (iso: string | null): string => (iso ? formatInstant(Date.parse(iso), tz, { withDate: true }) : "-");
  const limit = Number(opts.events ?? 25);

  if (opts.target) {
    const cfg = rt.config.targets.find((t) => t.id === opts.target);
    const state = store.getState(opts.target);
    if (!cfg && !state) throw new ConfigError(`Unknown target "${opts.target}"`);
    const payload = {
      target: opts.target,
      domain: cfg?.domain.ascii ?? state?.domain,
      state: state ?? null,
      attempts: store.attempts(opts.target, 20),
      runs: store.runs(opts.target, 10),
      events: store.events(opts.target, limit),
    };
    if (opts.json) {
      printJson(payload);
      return 0;
    }
    out(`${bold(opts.target)} ${dim(payload.domain ?? "")}`);
    kv("state", state ? stateColor(state.state) : dim("never armed"));
    if (state?.detail) kv("detail", state.detail);
    if (state) kv("updated", when(state.updatedAt));
    if (cfg) kv("real attempts", `${store.countAttempts(opts.target)} / ${cfg.registration.maxTotalAttempts}`);
    out();
    out(bold("Registration attempts"));
    if (payload.attempts.length === 0) out(dim("  none"));
    else {
      table(
        ["started", "provider", "status", "price", "ref / error"],
        payload.attempts.map((a) => [
          when(a.startedAt),
          a.provider,
          a.dryRun ? dim(`${a.status} (dry run)`) : stateColor(a.status.toUpperCase()),
          a.priceAmount !== null ? `${a.priceAmount.toFixed(2)} ${a.priceCurrency ?? ""}` : "-",
          a.providerReference ?? a.errorCode ?? "",
        ]),
      );
    }
    out();
    out(bold("Runs"));
    if (payload.runs.length === 0) out(dim("  none"));
    else {
      table(
        ["started", "ended", "mode", "outcome", "first detection"],
        payload.runs.map((r) => [when(r.startedAt), when(r.endedAt), `${r.mode}${r.dryRun ? " (dry)" : ""}`, r.status, when(r.detectedAt)]),
      );
    }
    out();
    out(bold("Timeline"));
    for (const e of payload.events) {
      const detail = [e.payload.provider, e.payload.status, e.payload.errorCode, e.payload.outcome, e.payload.reason]
        .filter((x) => x !== undefined && x !== null && x !== "")
        .join(" ");
      out(`  ${dim(when(e.timestamp))} ${e.type.toUpperCase()} ${dim(String(detail))}`);
    }
    return 0;
  }

  const states = store.listStates();
  const byId = new Map(states.map((s) => [s.targetId, s]));
  const ids = [...new Set([...rt.config.targets.map((t) => t.id), ...states.map((s) => s.targetId)])];
  const rows = ids.map((id) => {
    const cfg = rt.config.targets.find((t) => t.id === id);
    const s = byId.get(id);
    const lastRun = store.runs(id, 1)[0];
    return {
      id,
      domain: cfg?.domain.ascii ?? s?.domain ?? "",
      state: s?.state ?? "IDLE",
      detail: s?.detail ?? null,
      attempts: store.countAttempts(id),
      lastRun: lastRun ? { status: lastRun.status, startedAt: lastRun.startedAt, detectedAt: lastRun.detectedAt } : null,
      inConfig: Boolean(cfg),
    };
  });
  const stats = store.latencyStats();
  if (opts.json) {
    printJson({ targets: rows, providerLatency: stats });
    return 0;
  }
  out(bold("Targets"));
  table(
    ["target", "domain", "state", "attempts", "last run", "detail"],
    rows.map((r) => [r.inConfig ? r.id : dim(`${r.id} (not in config)`), r.domain, stateColor(r.state), String(r.attempts), r.lastRun ? `${r.lastRun.status} ${dim(when(r.lastRun.startedAt))}` : "-", r.detail ?? ""]),
  );
  if (stats.length) {
    out();
    out(bold("Provider latency (definitive answers)"));
    table(["provider", "checks", "errors", "avg", "p50", "p95"], stats.map((s) => [s.provider, String(s.checks), String(s.errors), `${s.avgMs} ms`, `${s.p50Ms} ms`, `${s.p95Ms} ms`]));
  }
  return 0;
}
