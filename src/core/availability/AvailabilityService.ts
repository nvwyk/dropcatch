import type { QuorumMode } from "../../config/schema.ts";
import type { RateLimiter, Release } from "../../providers/RateLimiter.ts";
import type { AnyProviderPlugin, ProviderInstance } from "../../providers/types.ts";
import type { AvailabilityResult } from "../types.ts";
import { nowIso } from "../types.ts";
import { aggregate, type AggregateResult } from "./AvailabilityAggregator.ts";

export interface AvailabilitySource {
  id: string;
  plugin: AnyProviderPlugin;
  instance: ProviderInstance;
  limiter: RateLimiter;
}

export interface TickResult {
  aggregate: AggregateResult;
  /** Results that arrived during this tick (stragglers are reported via onResult later). */
  results: AvailabilityResult[];
  /** Sources skipped this tick (rate limit, still in flight, global concurrency). */
  skipped: string[];
}

export interface AvailabilityServiceOptions {
  mode: QuorumMode;
  minimumConfirmations: number;
  timeoutMs: number;
  /** Shared across all targets: caps simultaneous availability requests. */
  globalLimiter?: RateLimiter;
  onResult?: (result: AvailabilityResult) => void;
  now?: () => number;
}

/**
 * Runs one round of availability checks across all sources concurrently, honouring each
 * source's limiter without queueing, and resolves as early as the quorum allows.
 */
export class AvailabilityService {
  private readonly sources: AvailabilitySource[];
  private readonly opts: AvailabilityServiceOptions;
  private readonly inFlight = new Set<string>();
  private readonly latest = new Map<string, AvailabilityResult>();
  /** Sources whose "available" was contradicted by a registrar; ignored until their status changes. */
  private readonly suppressed = new Set<string>();
  /** Consecutive 429s per source, for exponential back-off when no Retry-After is given. */
  private readonly strikes = new Map<string, number>();
  private readonly now: () => number;

  constructor(sources: AvailabilitySource[], opts: AvailabilityServiceOptions) {
    this.sources = sources;
    this.opts = opts;
    this.now = opts.now ?? Date.now;
  }

  /** Forget previous results (after a detection was acted upon). */
  reset(): void {
    this.latest.clear();
  }

  /**
   * Stop trusting these sources' positive signal. Without this, a source that keeps saying
   * "available" while the registrar says "taken" (e.g. RDAP 404 on a name the registry still
   * holds) would trigger a detection on every tick. The source is trusted again as soon as it
   * reports anything other than "available", i.e. once its answer actually changes.
   */
  suppress(sourceIds: readonly string[]): void {
    for (const id of sourceIds) this.suppressed.add(id);
  }

  isSuppressed(sourceId: string): boolean {
    return this.suppressed.has(sourceId);
  }

  async tick(domain: string, signal: AbortSignal, freshnessMs: number): Promise<TickResult> {
    const skipped: string[] = [];
    const launched: Array<{ source: AvailabilitySource; release: Release; globalRelease?: Release }> = [];
    for (const source of this.sources) {
      if (this.inFlight.has(source.id)) {
        skipped.push(source.id);
        continue;
      }
      const release = source.limiter.tryAcquire();
      if (!release) {
        skipped.push(source.id);
        continue;
      }
      let globalRelease: Release | undefined;
      if (this.opts.globalLimiter) {
        const g = this.opts.globalLimiter.tryAcquire();
        if (!g) {
          release();
          skipped.push(source.id);
          continue;
        }
        globalRelease = g;
      }
      launched.push({ source, release, globalRelease });
    }

    const roundResults: AvailabilityResult[] = [];
    if (launched.length === 0) {
      return { aggregate: this.aggregateLatest(freshnessMs, true), results: roundResults, skipped };
    }

    return new Promise<TickResult>((resolve) => {
      let pending = launched.length;
      let settled = false;
      for (const { source, release, globalRelease } of launched) {
        this.inFlight.add(source.id);
        this.checkOne(source, domain, signal)
          .then((result) => {
            this.latest.set(source.id, result);
            roundResults.push(result);
            if (result.status !== "available") this.suppressed.delete(source.id);
            if (result.status === "rate_limited") {
              const strike = (this.strikes.get(source.id) ?? 0) + 1;
              this.strikes.set(source.id, strike);
              // Some servers (e.g. NASK RDAP) send 429 without Retry-After and keep blocking while
              // polled, so back off exponentially: 5 s, 10 s, 20 s ... capped at 5 minutes.
              const backoff = Math.min(300_000, 5000 * 2 ** (strike - 1));
              source.limiter.pauseUntil(this.now() + Math.max(result.retryAfterMs ?? 0, backoff));
            } else if (result.status === "available" || result.status === "unavailable") {
              this.strikes.delete(source.id);
            }
            this.opts.onResult?.(result);
          })
          .finally(() => {
            release();
            globalRelease?.();
            this.inFlight.delete(source.id);
            pending--;
            if (settled) return;
            const agg = this.aggregateLatest(freshnessMs, pending === 0);
            if (agg.decision === "positive" || pending === 0) {
              settled = true;
              resolve({ aggregate: agg, results: [...roundResults], skipped });
            }
          });
      }
    });
  }

  private aggregateLatest(freshnessMs: number, complete: boolean): AggregateResult {
    const cutoff = this.now() - freshnessMs;
    const fresh = [...this.latest.values()].filter(
      (r) => Date.parse(r.checkedAt) >= cutoff && !(r.status === "available" && this.suppressed.has(r.provider)),
    );
    return aggregate(fresh, this.opts.mode, this.opts.minimumConfirmations, complete);
  }

  private async checkOne(source: AvailabilitySource, domain: string, signal: AbortSignal): Promise<AvailabilityResult> {
    const started = this.now();
    try {
      if (!source.instance.check) throw new Error(`${source.plugin.id} has no availability check`);
      return await source.instance.check({ domain, timeoutMs: this.opts.timeoutMs, signal });
    } catch (err) {
      // Adapters should never throw, but the engine must survive one that does.
      const finished = this.now();
      return {
        provider: source.id,
        providerType: source.plugin.id,
        sourceKind: source.plugin.sourceKind,
        domain,
        status: "error",
        errorCode: "PROVIDER_ERROR",
        reason: err instanceof Error ? err.message : String(err),
        startedAt: nowIso(started),
        checkedAt: nowIso(finished),
        latencyMs: finished - started,
      };
    }
  }
}
