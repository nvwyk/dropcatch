import { sleep } from "../core/clock.ts";
import type { DropEvent, EventSink, EventType } from "../core/events.ts";
import type { Logger } from "../logging/logger.ts";
import type { Store } from "../persistence/Store.ts";
import { observeEvent, observeNotification } from "../observability/metrics.ts";
import { parseJson, type HttpTransport } from "../transport/HttpTransport.ts";
import { describeEvent, discordPayload } from "./format.ts";

export interface NotificationChannel {
  id: string;
  send(event: DropEvent): Promise<void>;
}

export interface DiscordChannelOptions {
  webhookUrl: string;
  username: string;
  mentionRoleId?: string;
  timeZone: string;
  transport: HttpTransport;
  proxy?: string;
  timeoutMs?: number;
  /** Base back-off between delivery attempts (tests shorten it). */
  retryDelayMs?: number;
}

/** Discord webhook with bounded retries: honours 429 retry_after, backs off on 5xx/network. */
export class DiscordChannel implements NotificationChannel {
  readonly id = "discord";
  private readonly o: DiscordChannelOptions;

  constructor(options: DiscordChannelOptions) {
    this.o = options;
  }

  async send(event: DropEvent): Promise<void> {
    await this.post(discordPayload(event, { username: this.o.username, mentionRoleId: this.o.mentionRoleId, timeZone: this.o.timeZone }));
  }

  async sendText(title: string, description: string): Promise<void> {
    await this.post({
      username: this.o.username,
      allowed_mentions: { parse: [] },
      embeds: [{ title, description, color: 0x3498db, timestamp: new Date().toISOString() }],
    });
  }

  private async post(body: Record<string, unknown>): Promise<void> {
    const url = this.o.webhookUrl.includes("?") ? `${this.o.webhookUrl}&wait=true` : `${this.o.webhookUrl}?wait=true`;
    let lastError = "unknown error";
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const res = await this.o.transport.request({
          method: "POST",
          url,
          json: body,
          timeoutMs: this.o.timeoutMs ?? 5000,
          proxy: this.o.proxy,
          label: "discord.webhook",
        });
        if (res.status >= 200 && res.status < 300) return;
        if (res.status === 429) {
          const retry = parseJson<{ retry_after?: number }>(res)?.retry_after;
          lastError = "rate limited by Discord";
          await sleep(Math.min(10_000, Math.max(250, (retry ?? 1) * 1000)));
          continue;
        }
        if (res.status >= 500) {
          lastError = `Discord HTTP ${res.status}`;
          await sleep((this.o.retryDelayMs ?? 500) * attempt);
          continue;
        }
        throw new Error(`Discord rejected the webhook call (HTTP ${res.status})`);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("Discord rejected")) throw err;
        lastError = err instanceof Error ? err.message : String(err);
        await sleep((this.o.retryDelayMs ?? 500) * attempt);
      }
    }
    throw new Error(`Discord delivery failed: ${lastError}`);
  }
}

const CRITICAL: ReadonlySet<EventType> = new Set([
  "availability_detected",
  "registration_started",
  "registration_succeeded",
  "registration_failed",
  "registration_pending",
  "registration_ambiguous",
  "purchase_blocked",
  "budget_exceeded",
]);
const DEDUP: ReadonlySet<EventType> = new Set(["provider_error", "rate_limited"]);
const DEDUP_WINDOW_MS = 5 * 60_000;
const MAX_QUEUE = 200;

export interface NotifierRoute {
  channels: Array<{ channel: NotificationChannel; events: ReadonlySet<EventType> }>;
}

/**
 * Non-blocking notification queue (plan section 21). `enqueue` returns immediately; a single
 * worker delivers in order. A failing channel is logged and never affects the purchase path.
 */
export class Notifier {
  private readonly routes: Map<string, NotifierRoute>;
  private readonly logger: Logger;
  private readonly queue: Array<{ event: DropEvent; channel: NotificationChannel }> = [];
  private readonly lastSent = new Map<string, number>();
  private working?: Promise<void>;
  sent = 0;
  failed = 0;

  constructor(routes: Map<string, NotifierRoute>, logger: Logger) {
    this.routes = routes;
    this.logger = logger;
  }

  enqueue(event: DropEvent): void {
    const route = this.routes.get(event.targetId);
    if (!route) return;
    if (DEDUP.has(event.type)) {
      const key = `${event.targetId}|${event.type}|${String(event.data.provider)}|${String(event.data.errorCode)}`;
      const last = this.lastSent.get(key);
      if (last !== undefined && event.at - last < DEDUP_WINDOW_MS) return;
      this.lastSent.set(key, event.at);
    }
    for (const { channel, events } of route.channels) {
      if (!events.has(event.type)) continue;
      if (this.queue.length >= MAX_QUEUE) {
        const dropIndex = this.queue.findIndex((q) => !CRITICAL.has(q.event.type));
        if (dropIndex === -1 && !CRITICAL.has(event.type)) continue;
        this.queue.splice(dropIndex === -1 ? 0 : dropIndex, 1);
      }
      this.queue.push({ event, channel });
    }
    this.working ??= this.work().finally(() => {
      this.working = undefined;
    });
  }

  private async work(): Promise<void> {
    while (this.queue.length) {
      const job = this.queue.shift()!;
      try {
        await job.channel.send(job.event);
        this.sent++;
        observeNotification(job.channel.id, true);
      } catch (err) {
        this.failed++;
        observeNotification(job.channel.id, false);
        this.logger.warn(`Notification via ${job.channel.id} failed: ${(err as Error).message}`, { event: job.event.type });
      }
    }
  }

  /** Wait for queued notifications, at most `timeoutMs`. */
  async drain(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while ((this.working || this.queue.length) && Date.now() < deadline) {
      const current = this.working;
      if (!current) break;
      const timer = new AbortController();
      await Promise.race([current, sleep(Math.max(1, deadline - Date.now()), timer.signal)]);
      timer.abort();
    }
    if (this.queue.length) this.logger.warn(`${this.queue.length} notification(s) not delivered before shutdown`);
  }
}

/** Fan-out sink: SQLite audit (synchronous), terminal log, then the async notifier. */
export class EventPublisher implements EventSink {
  private readonly store?: Store;
  private readonly logger: Logger;
  private readonly notifier?: Notifier;
  private readonly timeZone: string;

  constructor(opts: { store?: Store; logger: Logger; notifier?: Notifier; timeZone: string }) {
    this.store = opts.store;
    this.logger = opts.logger;
    this.notifier = opts.notifier;
    this.timeZone = opts.timeZone;
  }

  emit(input: Omit<DropEvent, "at"> & { at?: number }): void {
    const event: DropEvent = { ...input, at: input.at ?? Date.now() };
    observeEvent(event);
    try {
      this.store?.recordEvent(event);
    } catch (err) {
      this.logger.error(`Failed to persist event ${event.type}: ${(err as Error).message}`);
    }
    const view = describeEvent(event, this.timeZone);
    const level = view.severity === "danger" ? "error" : view.severity === "warning" ? "warn" : "info";
    this.logger[level](view.summary, { target: event.targetId, event: event.type });
    this.notifier?.enqueue(event);
  }
}
