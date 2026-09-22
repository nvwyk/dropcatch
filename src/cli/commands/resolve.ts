import { ConfigError } from "../../core/errors.ts";
import type { Store } from "../../persistence/Store.ts";
import { bold, good, kv, out, printJson, warn } from "../output.ts";
import type { Runtime } from "../runtime.ts";

export type ResolveAs = "succeeded" | "failed" | "reset" | "auto";

export interface ResolveReport {
  target: string;
  before: string;
  after: string;
  note: string;
}

/**
 * Settle a blocked target. "auto" asks the registrar that handled the last attempt whether
 * the domain is now in the account. Only a positive "owned" is applied automatically.
 */
export async function resolveTarget(rt: Runtime, store: Store, targetId: string, as: ResolveAs): Promise<ResolveReport> {
  const state = store.getState(targetId);
  const cfg = rt.config.targets.find((t) => t.id === targetId);
  if (!state && !cfg) throw new ConfigError(`Unknown target "${targetId}"`);
  const domain = cfg?.domain.ascii ?? state!.domain;
  const before = state?.state ?? "IDLE";

  if (as === "succeeded") {
    store.resolve(targetId, domain, "SUCCEEDED", "manually marked as registered", false);
    return { target: targetId, before, after: "SUCCEEDED", note: "marked as registered" };
  }
  if (as === "failed") {
    store.resolve(targetId, domain, "FAILED", "manually marked as not registered", false);
    return { target: targetId, before, after: "FAILED", note: "marked as not registered; attempt counters unchanged" };
  }
  if (as === "reset") {
    store.resolve(targetId, domain, "IDLE", "manual reset", true);
    return { target: targetId, before, after: "IDLE", note: "re-armable; attempt counters restart from zero (history kept)" };
  }

  const last = store.attempts(targetId, 1)[0];
  if (!last || last.dryRun) {
    return { target: targetId, before, after: before, note: "no real attempt to verify; use --as succeeded|failed|reset" };
  }
  const handle = rt.account(last.provider);
  const lookup = handle.instance?.lookupOwnership;
  if (!lookup) {
    return { target: targetId, before, after: before, note: `${last.provider} cannot look up ownership; check the account and use --as` };
  }
  const owned = await lookup.call(handle.instance, domain, 15_000);
  if (owned === "owned") {
    store.resolve(targetId, domain, "SUCCEEDED", `ownership confirmed in ${last.provider}`, false);
    return { target: targetId, before, after: "SUCCEEDED", note: `${domain} is in account ${last.provider}` };
  }
  return {
    target: targetId,
    before,
    after: before,
    note: owned === "not-owned"
      ? `${domain} is not in ${last.provider} yet. Registrars can lag; if you are sure, run with --as failed`
      : `could not determine ownership at ${last.provider}`,
  };
}

export async function resolveCommand(rt: Runtime, targetId: string, opts: { as?: string; json?: boolean }): Promise<number> {
  const as = (opts.as ?? "auto") as ResolveAs;
  if (!["succeeded", "failed", "reset", "auto"].includes(as)) throw new ConfigError("--as must be succeeded, failed, reset or auto");
  const store = rt.openStore();
  const report = await resolveTarget(rt, store, targetId, as);
  if (opts.json) printJson(report);
  else {
    out(bold(`Resolve ${targetId}`));
    kv("before", report.before);
    kv("after", report.after === report.before ? warn(report.after) : good(report.after));
    kv("note", report.note);
  }
  return 0;
}
