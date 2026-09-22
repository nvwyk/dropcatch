import type { Logger } from "../logging/logger.ts";
import { setClockOffset } from "../observability/metrics.ts";
import { sleep, type Clock } from "./clock.ts";
import { measureClockOffset, type NtpSample } from "./ntp.ts";

export interface ClockSyncConfig {
  ntp: boolean;
  servers: string[];
  /** Schedule drops against NTP time instead of the (possibly wrong) system clock. */
  correct: boolean;
  warnMs: number;
  /** Offsets larger than this are reported but never applied: fix the system clock instead. */
  maxCorrectionMs: number;
  intervalMs: number;
}

export interface ClockStatus {
  offsetMs?: number;
  rttMs?: number;
  server?: string;
  measuredAt?: number;
  applied: boolean;
  error?: string;
}

/**
 * Measures how far the system clock is from NTP time and, if enabled, hands out a clock
 * that runs on NTP time. A drop at 12:00:00 is then polled at 12:00:00 in reality even if
 * this machine is a second or two off.
 */
export class ClockSync {
  private readonly cfg: ClockSyncConfig;
  private readonly logger: Logger;
  private sample?: NtpSample;
  private measuredAt?: number;
  private error?: string;
  private timer?: ReturnType<typeof setInterval>;
  private started?: Promise<void>;

  constructor(cfg: ClockSyncConfig, logger: Logger) {
    this.cfg = cfg;
    this.logger = logger;
  }

  private get applicable(): boolean {
    return this.cfg.correct && this.sample !== undefined && Math.abs(this.sample.offsetMs) <= this.cfg.maxCorrectionMs;
  }

  /** Offset applied to scheduling (0 when disabled, unmeasured or implausible). */
  get appliedOffsetMs(): number {
    return this.applicable ? this.sample!.offsetMs : 0;
  }

  status(): ClockStatus {
    return {
      offsetMs: this.sample?.offsetMs,
      rttMs: this.sample?.rttMs,
      server: this.sample?.server,
      measuredAt: this.measuredAt,
      applied: this.applicable,
      error: this.error,
    };
  }

  async measure(): Promise<void> {
    if (!this.cfg.ntp) return;
    try {
      const sample = await measureClockOffset(this.cfg.servers);
      const first = this.sample === undefined;
      this.sample = sample;
      this.measuredAt = Date.now();
      this.error = undefined;
      setClockOffset(sample.offsetMs);
      const abs = Math.abs(sample.offsetMs);
      const detail = { server: sample.server, rttMs: sample.rttMs };
      if (abs > this.cfg.maxCorrectionMs) {
        this.logger.error(`System clock is ${(sample.offsetMs / 1000).toFixed(1)} s off NTP time. Not correcting that much: fix NTP on this machine.`, detail);
      } else if (abs > this.cfg.warnMs) {
        this.logger.warn(`System clock is ${(sample.offsetMs / 1000).toFixed(2)} s ${sample.offsetMs > 0 ? "behind" : "ahead of"} NTP time${this.applicable ? "; scheduling uses NTP time" : ""}.`, detail);
      } else if (first) {
        this.logger.info(`Clock within ${abs} ms of NTP time`, detail);
      }
    } catch (err) {
      this.error = (err as Error).message;
      this.logger.warn(`NTP check failed (${this.error}); using the system clock as is.`);
    }
  }

  /** First measurement (bounded to 4 s so startup never hangs), then periodic re-checks. */
  start(): Promise<void> {
    if (!this.cfg.ntp) return Promise.resolve();
    this.started ??= (async () => {
      const timeout = new AbortController();
      await Promise.race([this.measure(), sleep(4000, timeout.signal)]);
      timeout.abort();
      this.timer = setInterval(() => void this.measure(), this.cfg.intervalMs);
      this.timer.unref();
    })();
    return this.started;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** A Clock whose now() is corrected by the measured offset. */
  clock(): Clock {
    return {
      now: () => Date.now() + this.appliedOffsetMs,
      sleep,
    };
  }
}
