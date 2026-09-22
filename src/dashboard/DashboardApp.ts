import type { ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { findConfigFile } from "../config/loader.ts";
import { ConfigError } from "../core/errors.ts";
import type { DropEvent, EventSink } from "../core/events.ts";
import type { Store } from "../persistence/Store.ts";
import { Store as SqliteStore } from "../persistence/Store.ts";
import { describeEvent } from "../notifications/format.ts";
import { EventPublisher, type Notifier } from "../notifications/Notifier.ts";
import { Runtime, type GlobalOptions } from "../cli/runtime.ts";
import { newToken } from "./auth.ts";
import { ConfigFile } from "./ConfigFile.ts";
import { WatchManager, WebConfirmations } from "./WatchManager.ts";

/** Server-sent events to every open dashboard tab. */
export class LiveBus {
  private readonly clients = new Set<ServerResponse>();
  private readonly heartbeat: ReturnType<typeof setInterval>;

  constructor() {
    this.heartbeat = setInterval(() => {
      for (const res of this.clients) res.write(": ping\n\n");
    }, 25_000);
    this.heartbeat.unref();
  }

  add(res: ServerResponse): void {
    this.clients.add(res);
    res.on("close", () => this.clients.delete(res));
  }

  publish(type: string, data: unknown): void {
    const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.clients) res.write(frame);
  }

  close(): void {
    clearInterval(this.heartbeat);
    for (const res of this.clients) res.end();
    this.clients.clear();
  }
}

export interface DashboardFlags {
  host?: string;
  port?: string;
  public?: boolean;
  watch?: boolean;
}

/** Long-lived state of the dashboard process. Config edits rebuild the runtime in place. */
export class DashboardApp {
  rt: Runtime;
  configError?: string[];
  readonly globals: GlobalOptions;
  readonly store: Store;
  readonly bus = new LiveBus();
  readonly configFile: ConfigFile;
  readonly envPath: string;
  readonly watches: WatchManager;
  readonly confirmations: WebConfirmations;
  readonly startedAt = Date.now();
  /** One-time token required to create the admin password. Undefined once an admin exists. */
  setupToken?: string;
  notifier: Notifier;
  readonly sink: EventSink;

  private constructor(globals: GlobalOptions, rt: Runtime, configError: string[] | undefined, configPath: string) {
    this.globals = globals;
    this.rt = rt;
    this.configError = configError;
    this.configFile = new ConfigFile(configPath);
    this.envPath = rt.envFile ?? join(dirname(configPath), ".env");
    this.store = new SqliteStore(rt.config.app.databasePath, rt.redactor);
    this.watches = new WatchManager(() => this.bus.publish("watch", { running: this.watches.runningIds() }));
    this.confirmations = new WebConfirmations(() => this.bus.publish("confirmation", this.confirmations.list()));
    this.notifier = rt.buildNotifier(rt.config.targets);
    const app = this;
    this.sink = {
      emit(input) {
        const publisher = new EventPublisher({ store: app.store, logger: app.rt.logger, notifier: app.notifier, timeZone: app.rt.config.app.timezone });
        publisher.emit(input);
        const event: DropEvent = { ...input, at: input.at ?? Date.now() };
        const view = describeEvent(event, app.rt.config.app.timezone);
        // Emoji belong to Discord; the dashboard uses its own icons.
        app.bus.publish("event", { ...event, title: view.title.replace(/^[^\p{L}\p{N}]+/u, ""), summary: view.summary, severity: view.severity });
      },
    };
    if (!this.store.getAdminPasswordHash()) this.setupToken = newToken(18);
  }

  static async create(globals: GlobalOptions): Promise<DashboardApp> {
    const configPath = findConfigFile(globals.config) ?? resolve("config.yaml");
    const { rt, error } = await DashboardApp.loadRuntime(globals);
    return new DashboardApp(globals, rt, error, configPath);
  }

  /** Load the config; if it is broken, fall back to defaults so the UI can still fix it. */
  private static async loadRuntime(globals: GlobalOptions): Promise<{ rt: Runtime; error?: string[] }> {
    try {
      return { rt: await Runtime.load(globals, { requireConfig: false }) };
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      const rt = await Runtime.load(globals, { requireConfig: false, skipConfigFile: true });
      rt.logger.error(`Config has errors; dashboard started with defaults so you can fix it: ${err.message}`);
      return { rt, error: err.issues.length ? err.issues : [err.message] };
    }
  }

  /** Re-read config and environment. Running watches keep the settings they started with. */
  async reload(): Promise<void> {
    const { rt, error } = await DashboardApp.loadRuntime(this.globals);
    const previous = this.rt;
    this.rt = rt;
    this.configError = error;
    // Running watches still use the previous runtime's connections; release it only when idle.
    if (this.watches.runningIds().length === 0) await previous.close();
    this.notifier = rt.buildNotifier(rt.config.targets);
    this.bus.publish("config", { error: error ?? null });
  }

  async startWatch(targetId: string): Promise<void> {
    await this.watches.start(this.rt, this.store, this.sink, this.confirmations.confirm, targetId);
  }

  async shutdown(): Promise<void> {
    await this.watches.stopAll();
    await this.notifier.drain(5000);
    this.bus.close();
    this.store.close();
    await this.rt.close();
  }
}
