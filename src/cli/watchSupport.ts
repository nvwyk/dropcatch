import type { ResolvedTarget } from "../config/loader.ts";
import { systemClock, withTimeout } from "../core/clock.ts";
import { ConfigError } from "../core/errors.ts";
import type { EventSink } from "../core/events.ts";
import { DropOrchestrator, type WatchOutcome } from "../core/orchestration/DropOrchestrator.ts";
import type { ConfirmFn } from "../core/registration/RegistrationService.ts";
import type { Store } from "../persistence/Store.ts";
import type { Runtime } from "./runtime.ts";

export interface PrepareOptions {
  store: Store;
  events: EventSink;
  dryRun: boolean;
  confirm?: ConfirmFn;
}

/**
 * Build a ready-to-run orchestrator. For a LIVE purchase path, every registration account must
 * pass its health check first (plan section 62): never arm auto-buy on broken credentials.
 */
export async function prepareWatch(rt: Runtime, target: ResolvedTarget, opts: PrepareOptions): Promise<DropOrchestrator> {
  const sources = rt.sourcesFor(target);
  const candidates = target.registration.active ? rt.candidatesFor(target) : [];

  if (target.registration.mode === "confirm" && !opts.dryRun && !opts.confirm) {
    throw new ConfigError(`Target ${target.id} uses confirm mode, which needs an interactive terminal or the dashboard`);
  }
  if (target.registration.active && !opts.dryRun) {
    if (!opts.store.persistent) {
      throw new ConfigError("Live registration needs a persistent database (app.database must not be :memory:)");
    }
    for (const c of candidates) {
      if (!c.instance.healthCheck) continue;
      const health = await withTimeout(c.instance.healthCheck(8000), 10_000).catch((err: Error) => ({ ok: false, detail: err.message }));
      if (!health.ok) {
        throw new ConfigError(`Registration account "${c.id}" failed its health check (${health.detail ?? "no detail"}). Refusing to arm a live purchase.`);
      }
    }
  }

  return new DropOrchestrator({
    target,
    sources,
    candidates,
    store: opts.store,
    events: opts.events,
    logger: rt.logger.child({ target: target.id }),
    clock: systemClock,
    dryRun: opts.dryRun,
    timeZone: rt.config.app.timezone,
    confirm: opts.confirm,
    globalLimiter: rt.globalLimiter,
  });
}

const SEVERITY: Record<WatchOutcome, number> = {
  succeeded: 0,
  already_owned: 0,
  detected: 0,
  dry_run: 0,
  stopped: 0,
  pending: 3,
  ambiguous: 3,
  failed: 4,
  aborted: 4,
  declined: 4,
  blocked_state: 4,
  window_expired: 5,
};

/** 0 ok, 3 needs attention (pending/ambiguous), 4 failed/aborted, 5 window over without detection. */
export function exitCodeFor(outcomes: WatchOutcome[]): number {
  return outcomes.reduce((worst, o) => (SEVERITY[o] > worst ? SEVERITY[o] : worst), 0);
}
