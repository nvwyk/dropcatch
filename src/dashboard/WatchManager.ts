import { randomUUID } from "node:crypto";
import { ConfigError } from "../core/errors.ts";
import type { EventSink } from "../core/events.ts";
import type { WatchOutcome } from "../core/orchestration/DropOrchestrator.ts";
import type { ConfirmFn, ConfirmRequest } from "../core/registration/RegistrationService.ts";
import type { Money } from "../core/types.ts";
import type { Store } from "../persistence/Store.ts";
import type { Runtime } from "../cli/runtime.ts";
import { prepareWatch } from "../cli/watchSupport.ts";

export interface PendingConfirmation {
  id: string;
  domain: string;
  provider: string;
  price?: Money;
  expiresAt: number;
}

/**
 * Confirm-mode purchases answered from the dashboard: the operator must type the domain.
 * Unanswered requests expire (declined) after the target's confirmTimeoutSeconds.
 */
export class WebConfirmations {
  private readonly pending = new Map<string, { info: PendingConfirmation; resolve: (ok: boolean) => void }>();
  private readonly onChange: () => void;

  constructor(onChange: () => void) {
    this.onChange = onChange;
  }

  readonly confirm: ConfirmFn = (request: ConfirmRequest) =>
    new Promise<boolean>((resolve) => {
      const id = randomUUID();
      const info: PendingConfirmation = {
        id,
        domain: request.domain,
        provider: request.provider,
        price: request.price,
        expiresAt: Date.now() + request.timeoutMs,
      };
      const finish = (ok: boolean): void => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", onAbort);
        resolve(ok);
        this.onChange();
      };
      const onAbort = (): void => finish(false);
      const timer = setTimeout(() => finish(false), request.timeoutMs);
      request.signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, { info, resolve: finish });
      this.onChange();
    });

  list(): PendingConfirmation[] {
    return [...this.pending.values()].map((p) => p.info);
  }

  answer(id: string, typedDomain: string | undefined, decline: boolean): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    const ok = !decline && (typedDomain ?? "").trim().toLowerCase().replace(/\.$/, "") === entry.info.domain;
    entry.resolve(ok);
    return true;
  }
}

interface Running {
  controller: AbortController;
  startedAt: number;
  dryRun: boolean;
  promise: Promise<WatchOutcome>;
}

/** Runs watches inside the dashboard process and remembers how each one ended. */
export class WatchManager {
  private readonly running = new Map<string, Running>();
  readonly outcomes = new Map<string, { outcome: WatchOutcome | "error"; at: number; error?: string }>();
  private readonly onChange: () => void;

  constructor(onChange: () => void) {
    this.onChange = onChange;
  }

  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  info(id: string): { startedAt: number; dryRun: boolean } | undefined {
    const r = this.running.get(id);
    return r ? { startedAt: r.startedAt, dryRun: r.dryRun } : undefined;
  }

  runningIds(): string[] {
    return [...this.running.keys()];
  }

  async start(rt: Runtime, store: Store, events: EventSink, confirm: ConfirmFn, targetId: string): Promise<void> {
    if (this.running.has(targetId)) throw new ConfigError(`Target ${targetId} is already being watched`);
    const target = rt.config.targets.find((t) => t.id === targetId);
    if (!target) throw new ConfigError(`Unknown target "${targetId}"`);
    if (!target.enabled) throw new ConfigError(`Target ${targetId} is disabled in the config`);
    const dryRun = rt.config.app.dryRun;
    const orchestrator = await prepareWatch(rt, target, { store, events, dryRun, confirm });
    const controller = new AbortController();
    const promise = orchestrator.run(controller.signal);
    this.running.set(targetId, { controller, startedAt: Date.now(), dryRun, promise });
    this.onChange();
    promise
      .then((outcome) => this.outcomes.set(targetId, { outcome, at: Date.now() }))
      .catch((err: Error) => {
        rt.logger.error(`Watch for ${targetId} crashed: ${err.message}`);
        this.outcomes.set(targetId, { outcome: "error", at: Date.now(), error: err.message });
      })
      .finally(() => {
        this.running.delete(targetId);
        this.onChange();
      });
  }

  stop(targetId: string): boolean {
    const r = this.running.get(targetId);
    if (!r) return false;
    r.controller.abort();
    return true;
  }

  /** Abort every watch; in-flight registrations are allowed to finish. */
  async stopAll(): Promise<void> {
    const all = [...this.running.values()];
    for (const r of all) r.controller.abort();
    await Promise.allSettled(all.map((r) => r.promise));
  }
}
