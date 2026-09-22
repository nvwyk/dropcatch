import type { ResolvedTarget } from "../../config/loader.ts";
import type { Logger } from "../../logging/logger.ts";
import { observeCheck } from "../../observability/metrics.ts";
import type { Store } from "../../persistence/Store.ts";
import type { RateLimiter } from "../../providers/RateLimiter.ts";
import { AvailabilityService, type AvailabilitySource } from "../availability/AvailabilityService.ts";
import type { Clock } from "../clock.ts";
import type { EventSink, EventType } from "../events.ts";
import { describeBlockingState } from "../registration/state.ts";
import {
  RegistrationService,
  type ConfirmFn,
  type RegistrationCandidate,
  type RegistrationOutcome,
} from "../registration/RegistrationService.ts";
import { formatDuration, formatInstant } from "../time.ts";
import type { AvailabilityResult } from "../types.ts";
import { intervalFor, nextTickAt, phaseAt, shouldStop, type Phase } from "../watcher/schedule.ts";

export type WatchOutcome =
  | "succeeded"
  | "already_owned"
  | "pending"
  | "ambiguous"
  | "detected"
  | "dry_run"
  | "failed"
  | "aborted"
  | "declined"
  | "window_expired"
  | "stopped"
  | "blocked_state";

export interface OrchestratorDeps {
  target: ResolvedTarget;
  sources: AvailabilitySource[];
  candidates: RegistrationCandidate[];
  store: Store;
  events: EventSink;
  logger: Logger;
  clock: Clock;
  dryRun: boolean;
  timeZone: string;
  confirm?: ConfirmFn;
  globalLimiter?: RateLimiter;
  /** Registration timings (tests shorten these). */
  registrationTimings?: { verifyAttempts?: number; verifyIntervalMs?: number; pendingPollMs?: number; pendingIntervalMs?: number };
}

const PROBLEM_REPEAT_MS = 60_000;

/**
 * One orchestrator per target: arm, poll on the adaptive schedule, hand a positive
 * detection to the registration service, and leave a persisted, explainable outcome.
 */
export class DropOrchestrator {
  private readonly d: OrchestratorDeps;
  private runId?: string;
  private phase?: Phase;
  private readonly lastStatus = new Map<string, string>();
  private readonly lastProblem = new Map<string, { code: string; at: number }>();
  private readonly lastWarm = new Map<string, number>();

  constructor(deps: OrchestratorDeps) {
    this.d = deps;
  }

  private emit(type: EventType, data: Record<string, unknown> = {}): void {
    const t = this.d.target;
    this.d.events.emit({ type, targetId: t.id, domain: t.domain.ascii, runId: this.runId, at: this.d.clock.now(), data });
  }

  async run(signal: AbortSignal): Promise<WatchOutcome> {
    const { target, store, logger } = this.d;
    const domain = target.domain.ascii;

    store.upsertTarget({ id: target.id, domain, enabled: target.enabled, expectedDropAt: target.drop?.expectedAtMs });
    const armed = store.arm(target.id, domain);
    if (!armed.ok) {
      logger.error(`Target ${target.id} (${domain}) cannot be armed: ${describeBlockingState(armed.state)}.`, {
        state: armed.state,
        detail: armed.detail ?? undefined,
      });
      logger.error(`Inspect with "dropcatch status --target ${target.id}", then settle it with "dropcatch resolve ${target.id}".`);
      return "blocked_state";
    }

    this.runId = store.startRun({ targetId: target.id, mode: target.registration.mode, dryRun: this.d.dryRun });
    this.emit("watch_started", {
      mode: target.registration.mode,
      dryRun: this.d.dryRun,
      expectedAt: target.drop?.expectedAtMs,
      sources: this.d.sources.map((s) => s.id),
      registrars: this.d.candidates.map((c) => c.id),
    });

    let outcome: WatchOutcome | undefined;
    try {
      await this.prepare();
      if (target.registration.active && (await this.alreadyOwned())) {
        outcome = "already_owned";
        return outcome;
      }
      store.transition(target.id, domain, "CHECKING");
      outcome = await this.loop(signal);
      return outcome;
    } finally {
      const final = outcome ?? "stopped";
      if (["detected", "dry_run", "window_expired", "stopped"].includes(final)) {
        store.transition(target.id, domain, "IDLE", final);
      }
      store.finishRun(this.runId, final);
      this.emit("watch_finished", { outcome: final });
    }
  }

  /** Warm caches (bootstrap, pricing) so the hot window is not spent on setup. */
  private async prepare(): Promise<void> {
    const domain = this.d.target.domain.ascii;
    const instances = [...this.d.sources.map((s) => s.instance), ...this.d.candidates.map((c) => c.instance)];
    await Promise.allSettled(instances.map((i) => i.prepare?.(domain)));
  }

  /** "Already owned" pre-check (plan section 17). */
  private async alreadyOwned(): Promise<boolean> {
    const domain = this.d.target.domain.ascii;
    for (const c of this.d.candidates) {
      if (!c.instance.lookupOwnership) continue;
      const owned = await c.instance.lookupOwnership(domain, 10_000).catch(() => "unknown" as const);
      if (owned === "owned") {
        this.d.store.resolve(this.d.target.id, domain, "SUCCEEDED", `already owned in account ${c.id}`, false);
        this.d.logger.warn(`${domain} is already in account ${c.id}; nothing to do.`);
        return true;
      }
    }
    return false;
  }

  private async loop(signal: AbortSignal): Promise<WatchOutcome> {
    const { target, clock, store, logger } = this.d;
    const domain = target.domain.ascii;
    const availability = new AvailabilityService(this.d.sources, {
      mode: target.availability.quorum,
      minimumConfirmations: target.availability.minimumConfirmations,
      timeoutMs: target.requestTimeoutMs,
      globalLimiter: this.d.globalLimiter,
      // Freshness and rate-limit pauses compare against provider timestamps, which use the system clock.
      onResult: (r) => this.onResult(r),
    });

    while (!signal.aborted) {
      const now = clock.now();
      if (shouldStop(now, target.schedule)) {
        logger.info(`Drop window for ${domain} is over without a positive detection.`);
        return "window_expired";
      }
      this.onPhase(phaseAt(now, target.schedule));
      const interval = intervalFor(this.phase!, target.schedule);

      const tick = await availability.tick(domain, signal, Math.max(3 * interval, 2000));
      if (signal.aborted) break;

      if (tick.aggregate.decision === "positive") {
        const first = tick.aggregate.available[0]!;
        const detectedAt = Date.parse(first.checkedAt);
        store.markDetected(this.runId!, detectedAt);
        store.transition(target.id, domain, "AVAILABLE", tick.aggregate.basis);
        this.emit("availability_detected", {
          provider: first.provider,
          latencyMs: first.latencyMs,
          price: first.price,
          detectedAt,
          expectedAt: target.drop?.expectedAtMs,
          reason: tick.aggregate.basis,
          advisory: first.advisory === true,
        });
        if (!target.registration.active) return "detected";

        const registration = new RegistrationService({
          target,
          candidates: this.d.candidates,
          store,
          events: this.d.events,
          logger,
          clock,
          dryRun: this.d.dryRun,
          confirm: this.d.confirm,
          runId: this.runId,
          ...this.d.registrationTimings,
        });
        const result = await registration.execute(signal);
        const next = this.afterRegistration(result);
        if (next !== "continue") return next;
        // The registrar disagreed with these sources: stop re-triggering on the same stale signal.
        const positives = tick.aggregate.available.map((r) => r.provider);
        availability.suppress(positives);
        logger.warn(`Ignoring "available" from ${positives.join(", ")} until their answer changes (the registrar disagreed).`);
        availability.reset();
      }

      this.warmRegistrars();
      const wakeAt = nextTickAt(clock.now(), target.schedule);
      await clock.sleep(wakeAt - clock.now(), signal);
      const drift = clock.now() - wakeAt;
      if (!signal.aborted && Math.abs(drift) > 1000) {
        this.emit("clock_jump", { reason: `woke ${formatDuration(drift)} off schedule (clock change or event-loop stall)` });
      }
    }
    return "stopped";
  }

  private afterRegistration(result: RegistrationOutcome): WatchOutcome | "continue" {
    const { target, store } = this.d;
    const domain = target.domain.ascii;
    switch (result.kind) {
      case "succeeded":
        return "succeeded";
      case "pending":
        return "pending";
      case "ambiguous":
        return "ambiguous";
      case "dry_run":
        return "dry_run";
      case "lost_lock":
        return "aborted";
      case "declined":
        store.transition(target.id, domain, "ABORTED", "operator declined or confirmation timed out");
        return "declined";
      case "blocked":
        store.transition(target.id, domain, "ABORTED", `purchase blocked: ${result.reasons.join(", ")}`);
        return "aborted";
      case "false_positive":
        this.emit("availability_false_positive", {
          reason: result.checks.map((c) => `${c.provider}: ${c.status}`).join(", ") || "no registrar confirmed availability",
        });
        store.transition(target.id, domain, "CHECKING", "false positive, resumed watching");
        return "continue";
      case "failed":
        if (target.registration.onFailure === "resume-watch" && !result.attemptsExhausted) {
          store.transition(target.id, domain, "CHECKING", "confirmed failure, resumed watching");
          return "continue";
        }
        store.transition(target.id, domain, "FAILED", result.results.map((r) => `${r.provider}: ${r.errorCode ?? r.status}`).join(", "));
        return "failed";
    }
  }

  /**
   * Keep TLS connections to registration-only providers open near the drop, so the final check
   * and the purchase do not pay for a fresh handshake. Sources are kept warm by polling anyway.
   */
  private warmRegistrars(): void {
    if (!this.d.target.registration.active || this.phase === "idle" || this.phase === "expired") return;
    const polled = new Set(this.d.sources.map((s) => s.id));
    const now = Date.now();
    for (const c of this.d.candidates) {
      if (polled.has(c.id) || !c.instance.warmup) continue;
      if (now - (this.lastWarm.get(c.id) ?? 0) < 15_000) continue;
      this.lastWarm.set(c.id, now);
      void c.instance.warmup().catch((err: Error) => this.d.logger.debug(`warmup of ${c.id} failed: ${err.message}`));
    }
  }

  private onPhase(phase: Phase): void {
    if (phase === this.phase) return;
    const previous = this.phase;
    this.phase = phase;
    if (phase === "hot") this.lastWarm.clear();
    const { target, logger, timeZone } = this.d;
    const interval = intervalFor(phase, target.schedule);
    if (phase === "warm" && previous !== undefined) this.emit("drop_window_entered", { phase, reason: `polling every ${interval} ms` });
    else if (phase === "warm") this.emit("drop_window_entered", { phase, reason: `started inside the window, polling every ${interval} ms` });
    else if (phase === "hot") this.emit("hot_window_entered", { phase, reason: `polling every ${interval} ms (provider limits still apply)` });
    else {
      const dropAt = target.drop?.expectedAtMs;
      logger.info(`Phase ${phase}: polling every ${interval} ms`, {
        target: target.id,
        drop: dropAt !== undefined ? formatInstant(dropAt, timeZone, { withDate: true, withZone: true }) : undefined,
      });
    }
  }

  private onResult(r: AvailabilityResult): void {
    const { store, logger } = this.d;
    observeCheck(r);
    store.recordCheck(this.runId, r, this.phase);
    const previous = this.lastStatus.get(r.provider);
    this.lastStatus.set(r.provider, r.status);
    const line = `${r.provider}: ${r.status}${r.price ? ` ${r.price.amount.toFixed(2)} ${r.price.currency}` : ""} (${r.latencyMs} ms)`;
    if (previous !== r.status) logger.info(`Check ${line}`, { reason: r.reason, errorCode: r.errorCode });
    else logger.debug(`Check ${line}`);

    if (r.status === "error" || r.status === "rate_limited") {
      const code = r.errorCode ?? r.status;
      const last = this.lastProblem.get(r.provider);
      const now = this.d.clock.now();
      if (!last || last.code !== code || now - last.at > PROBLEM_REPEAT_MS) {
        this.lastProblem.set(r.provider, { code, at: now });
        this.emit(r.status === "rate_limited" ? "rate_limited" : "provider_error", {
          provider: r.provider,
          errorCode: code,
          reason: r.reason,
          latencyMs: r.latencyMs,
        });
      }
    } else if (this.lastProblem.has(r.provider)) {
      this.lastProblem.delete(r.provider);
      logger.info(`${r.provider} recovered`);
    }
  }
}
