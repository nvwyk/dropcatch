import { sleep } from "../core/clock.ts";

export interface ProviderLimits {
  minIntervalMs?: number;
  maxConcurrentRequests?: number;
  requestsPerMinute?: number;
}

export type Release = () => void;

/**
 * Per-provider request limiter. `tryAcquire` never waits: the watch loop skips a source
 * that is not allowed yet instead of queueing a check that would be stale by the time it runs.
 * `acquire` waits, and is used for the final pre-registration check and the registration itself.
 */
export class RateLimiter {
  private readonly limits: Required<ProviderLimits>;
  private readonly now: () => number;
  private inFlight = 0;
  private lastStart = Number.NEGATIVE_INFINITY;
  private starts: number[] = [];
  private pausedUntil = 0;

  constructor(limits: ProviderLimits = {}, now: () => number = Date.now) {
    this.limits = {
      minIntervalMs: limits.minIntervalMs ?? 0,
      maxConcurrentRequests: limits.maxConcurrentRequests ?? 1,
      requestsPerMinute: limits.requestsPerMinute ?? Number.POSITIVE_INFINITY,
    };
    this.now = now;
  }

  get busy(): boolean {
    return this.inFlight > 0;
  }

  /** Earliest time a new request may start, ignoring concurrency. */
  nextAvailableAt(): number {
    const t = this.now();
    let at = Math.max(t, this.pausedUntil, this.lastStart + this.limits.minIntervalMs);
    this.prune(t);
    if (this.starts.length >= this.limits.requestsPerMinute) {
      at = Math.max(at, this.starts[0]! + 60_000);
    }
    return at;
  }

  tryAcquire(): Release | null {
    const t = this.now();
    if (this.inFlight >= this.limits.maxConcurrentRequests) return null;
    if (this.nextAvailableAt() > t) return null;
    this.inFlight++;
    this.lastStart = t;
    this.starts.push(t);
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.inFlight--;
      }
    };
  }

  async acquire(signal?: AbortSignal): Promise<Release> {
    for (;;) {
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
      const release = this.tryAcquire();
      if (release) return release;
      const wait = this.inFlight >= this.limits.maxConcurrentRequests ? 5 : this.nextAvailableAt() - this.now();
      await sleep(Math.max(1, wait), signal);
    }
  }

  /** Honour a provider's Retry-After. */
  pauseUntil(epochMs: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, epochMs);
  }

  private prune(t: number): void {
    while (this.starts.length && this.starts[0]! <= t - 60_000) this.starts.shift();
  }
}
