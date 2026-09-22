/**
 * Pure scheduling math for the watch loop. No timers, no I/O: everything here is a
 * function of `now` so it can be tested exhaustively.
 *
 *            warmStart          hotStart   T   hotEnd              postEnd
 *   idle         |     warm        |    hot|hot   |      post          |  expired
 * ---------------+-----------------+-------+------+--------------------+--------->
 */

export type Phase = "idle" | "warm" | "hot" | "post" | "expired" | "continuous";

export interface ScheduleConfig {
  /** Expected drop instant (UTC ms). Undefined = no known drop, poll continuously. */
  dropAt?: number;
  strategy: "adaptive" | "fixed";
  preWindowMs: number;
  hotWindowMs: number;
  postWindowMs: number;
  initialIntervalMs: number;
  warmupIntervalMs: number;
  hotIntervalMs: number;
  fixedIntervalMs: number;
  alignToDrop: boolean;
  stopAfterWindow: boolean;
}

export interface Boundaries {
  warmStart: number;
  hotStart: number;
  hotEnd: number;
  postEnd: number;
}

export function boundaries(cfg: ScheduleConfig & { dropAt: number }): Boundaries {
  const T = cfg.dropAt;
  const hotBefore = Math.min(cfg.hotWindowMs, cfg.preWindowMs);
  const hotAfter = Math.min(cfg.hotWindowMs, cfg.postWindowMs);
  return {
    warmStart: T - cfg.preWindowMs,
    hotStart: T - hotBefore,
    hotEnd: T + hotAfter,
    postEnd: T + cfg.postWindowMs,
  };
}

export function phaseAt(now: number, cfg: ScheduleConfig): Phase {
  if (cfg.dropAt === undefined) return "continuous";
  const b = boundaries({ ...cfg, dropAt: cfg.dropAt });
  if (now < b.warmStart) return "idle";
  if (now < b.hotStart) return "warm";
  if (now < b.hotEnd) return "hot";
  if (now < b.postEnd) return "post";
  return "expired";
}

export function intervalFor(phase: Phase, cfg: ScheduleConfig): number {
  if (cfg.strategy === "fixed" || phase === "continuous") return cfg.fixedIntervalMs;
  switch (phase) {
    case "idle":
    case "expired":
      return cfg.initialIntervalMs;
    case "warm":
    case "post":
      return cfg.warmupIntervalMs;
    case "hot":
      return cfg.hotIntervalMs;
  }
}

/** Whether the loop should stop because the drop window is over. */
export function shouldStop(now: number, cfg: ScheduleConfig): boolean {
  return cfg.stopAfterWindow && phaseAt(now, cfg) === "expired";
}

/**
 * Next tick strictly after `now`. Ticks sit on a grid anchored at the drop instant, so
 * one tick lands exactly on T. The result never skips over a phase boundary, which means
 * the first hot-phase tick fires exactly at `hotStart`.
 */
export function nextTickAt(now: number, cfg: ScheduleConfig): number {
  const phase = phaseAt(now, cfg);
  const interval = Math.max(1, intervalFor(phase, cfg));
  let next: number;
  if (cfg.dropAt !== undefined && cfg.alignToDrop) {
    const k = Math.floor((now - cfg.dropAt) / interval) + 1;
    next = cfg.dropAt + k * interval;
  } else {
    next = now + interval;
  }
  if (cfg.dropAt !== undefined) {
    const b = boundaries({ ...cfg, dropAt: cfg.dropAt });
    for (const edge of [b.warmStart, b.hotStart, cfg.dropAt, b.hotEnd, b.postEnd]) {
      if (edge > now && edge < next) next = edge;
    }
  }
  return next;
}
