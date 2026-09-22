import { timingSafeEqual } from "node:crypto";
import type { DropEvent } from "../core/events.ts";
import type { AvailabilityResult } from "../core/types.ts";

type Labels = Record<string, string>;
type Kind = "counter" | "gauge" | "histogram";

interface Family {
  kind: Kind;
  help: string;
  values: Map<string, { labels: Labels; value: number }>;
  buckets?: number[];
  hist?: Map<string, { labels: Labels; counts: number[]; sum: number; count: number }>;
}

const LATENCY_BUCKETS_MS = [25, 50, 100, 250, 500, 1000, 2500, 5000];

const key = (labels: Labels): string =>
  Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join(",");

const escapeLabel = (v: string): string => v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
const fmtLabels = (labels: Labels): string => {
  const entries = Object.entries(labels);
  return entries.length ? `{${entries.map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(",")}}` : "";
};

/** Tiny Prometheus registry (text format 0.0.4). No dependency, process-wide. */
export class Metrics {
  private readonly families = new Map<string, Family>();

  private family(name: string, kind: Kind, help: string, buckets?: number[]): Family {
    let f = this.families.get(name);
    if (!f) {
      f = { kind, help, values: new Map(), buckets, hist: buckets ? new Map() : undefined };
      this.families.set(name, f);
    }
    return f;
  }

  inc(name: string, help: string, labels: Labels = {}, by = 1): void {
    const f = this.family(name, "counter", help);
    const k = key(labels);
    const cur = f.values.get(k);
    f.values.set(k, { labels, value: (cur?.value ?? 0) + by });
  }

  set(name: string, help: string, labels: Labels, value: number): void {
    this.family(name, "gauge", help).values.set(key(labels), { labels, value });
  }

  observe(name: string, help: string, labels: Labels, value: number, buckets = LATENCY_BUCKETS_MS): void {
    const f = this.family(name, "histogram", help, buckets);
    const k = key(labels);
    let h = f.hist!.get(k);
    if (!h) {
      h = { labels, counts: buckets.map(() => 0), sum: 0, count: 0 };
      f.hist!.set(k, h);
    }
    buckets.forEach((b, i) => {
      if (value <= b) h!.counts[i]!++;
    });
    h.sum += value;
    h.count++;
  }

  get(name: string, labels: Labels = {}): number | undefined {
    return this.families.get(name)?.values.get(key(labels))?.value;
  }

  reset(): void {
    this.families.clear();
  }

  render(): string {
    const lines: string[] = [];
    for (const [name, f] of [...this.families.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`# HELP ${name} ${f.help}`, `# TYPE ${name} ${f.kind}`);
      if (f.kind === "histogram") {
        for (const h of f.hist!.values()) {
          f.buckets!.forEach((b, i) => lines.push(`${name}_bucket${fmtLabels({ ...h.labels, le: String(b) })} ${h.counts[i]}`));
          lines.push(`${name}_bucket${fmtLabels({ ...h.labels, le: "+Inf" })} ${h.count}`);
          lines.push(`${name}_sum${fmtLabels(h.labels)} ${h.sum}`, `${name}_count${fmtLabels(h.labels)} ${h.count}`);
        }
      } else {
        for (const v of f.values.values()) lines.push(`${name}${fmtLabels(v.labels)} ${v.value}`);
      }
    }
    return `${lines.join("\n")}\n`;
  }
}

export const metrics = new Metrics();
const startedAt = Date.now();

export function observeCheck(r: AvailabilityResult): void {
  metrics.inc("dropcatch_availability_checks_total", "Availability checks by source and result", { provider: r.provider, status: r.status });
  if (r.status === "available" || r.status === "unavailable") {
    metrics.observe("dropcatch_provider_latency_ms", "Latency of definitive availability answers in milliseconds", { provider: r.provider }, r.latencyMs);
  }
  if (r.status === "rate_limited") metrics.inc("dropcatch_provider_rate_limits_total", "429 responses by source", { provider: r.provider });
}

const REGISTRATION_OUTCOMES: Partial<Record<DropEvent["type"], string>> = {
  registration_succeeded: "succeeded",
  registration_failed: "failed",
  registration_pending: "pending",
  registration_ambiguous: "ambiguous",
  dry_run_registration: "dry_run",
};

export function observeEvent(e: DropEvent): void {
  const provider = typeof e.data.provider === "string" ? e.data.provider : "none";
  if (e.type === "availability_detected") metrics.inc("dropcatch_detections_total", "Positive availability decisions", { target: e.targetId });
  if (e.type === "registration_started") metrics.inc("dropcatch_registration_attempts_total", "Real registration requests sent", { provider });
  const outcome = REGISTRATION_OUTCOMES[e.type];
  if (outcome) metrics.inc("dropcatch_registrations_total", "Registration outcomes", { provider, outcome });
  if (e.type === "purchase_blocked") metrics.inc("dropcatch_purchases_blocked_total", "Purchases refused by the gate", { provider });
}

export function observeNotification(channel: string, ok: boolean): void {
  metrics.inc("dropcatch_notifications_total", "Notification deliveries", { channel, result: ok ? "sent" : "failed" });
}

export function setWatchesRunning(n: number): void {
  metrics.set("dropcatch_watches_running", "Targets currently being watched in this process", {}, n);
}

export function setClockOffset(ms: number | undefined): void {
  if (ms !== undefined) metrics.set("dropcatch_clock_offset_ms", "Measured NTP offset of the system clock in milliseconds", {}, ms);
}

/** Full exposition including process info. */
export function renderMetrics(version: string): string {
  metrics.set("dropcatch_info", "Build information", { version }, 1);
  metrics.set("dropcatch_uptime_seconds", "Seconds since the process started", {}, Math.round((Date.now() - startedAt) / 1000));
  return metrics.render();
}

/** /metrics access: loopback clients, a valid bearer token, or a signed-in dashboard session. */
export function metricsAllowed(remoteAddress: string | undefined, authorization: string | undefined, token: string | undefined, hasSession: boolean): boolean {
  if (hasSession) return true;
  const addr = (remoteAddress ?? "").replace(/^::ffff:/, "");
  if (addr === "127.0.0.1" || addr === "::1") return true;
  if (!token || !authorization) return false;
  const a = Buffer.from(authorization);
  const b = Buffer.from(`Bearer ${token}`);
  return a.length === b.length && timingSafeEqual(a, b);
}
