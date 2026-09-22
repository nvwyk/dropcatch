import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  findConfigFile,
  loadConfigFile,
  parseConfigText,
  permissionWarning,
  resolveConfig,
  type ResolvedAccount,
  type ResolvedConfig,
  type ResolvedTarget,
} from "../config/loader.ts";
import type { AvailabilitySource } from "../core/availability/AvailabilityService.ts";
import { DEFAULT_NOTIFY_EVENTS, type EventType } from "../core/events.ts";
import { ConfigError } from "../core/errors.ts";
import type { RegistrationCandidate } from "../core/registration/RegistrationService.ts";
import { createLogger, type LogLevel, type Logger } from "../logging/logger.ts";
import { DiscordChannel, Notifier, type NotificationChannel, type NotifierRoute } from "../notifications/Notifier.ts";
import { Store } from "../persistence/Store.ts";
import { builtinRegistry, type ProviderRegistry } from "../providers/ProviderRegistry.ts";
import { RateLimiter } from "../providers/RateLimiter.ts";
import type { ProviderInstance } from "../providers/types.ts";
import { Redactor } from "../security/redaction.ts";
import { UndiciTransport } from "../transport/HttpTransport.ts";
import { ProxyRouter, type ProxyPoolConfig } from "../transport/ProxyRouter.ts";
import { NO_RETRY } from "../transport/RetryPolicy.ts";
import { VERSION } from "../version.ts";
import { setColor } from "./output.ts";

export interface GlobalOptions {
  config?: string;
  envFile?: string;
  logLevel?: LogLevel;
  json?: boolean;
  color?: boolean;
}

export interface AccountHandle {
  config: ResolvedAccount;
  credentials: Record<string, string>;
  missing: Array<{ field: string; env: string }>;
  instance?: ProviderInstance;
  error?: string;
  availabilityLimiter: RateLimiter;
  registrationLimiter: RateLimiter;
}

function loadEnvFile(explicit: string | undefined, configPath: string | undefined, warnings: string[]): string | undefined {
  if (explicit) {
    const path = resolve(explicit);
    if (!existsSync(path)) throw new ConfigError(`Env file not found: ${path}`);
    process.loadEnvFile(path);
    return path;
  }
  const candidates = [resolve(".env")];
  if (configPath) candidates.push(join(dirname(configPath), ".env"));
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      const perms = permissionWarning(candidate);
      if (perms) warnings.push(perms);
      return candidate;
    }
  }
  return undefined;
}

/** Everything a command needs, assembled once from config + environment. */
export class Runtime {
  readonly config: ResolvedConfig;
  readonly logger: Logger;
  readonly redactor: Redactor;
  readonly registry: ProviderRegistry;
  readonly router: ProxyRouter;
  readonly transport: UndiciTransport;
  readonly envFile?: string;
  readonly globalLimiter: RateLimiter;
  private readonly accounts = new Map<string, AccountHandle>();
  private store?: Store;

  private constructor(init: {
    config: ResolvedConfig;
    logger: Logger;
    redactor: Redactor;
    registry: ProviderRegistry;
    router: ProxyRouter;
    transport: UndiciTransport;
    envFile?: string;
  }) {
    this.config = init.config;
    this.logger = init.logger;
    this.redactor = init.redactor;
    this.registry = init.registry;
    this.router = init.router;
    this.transport = init.transport;
    this.envFile = init.envFile;
    this.globalLimiter = new RateLimiter({ maxConcurrentRequests: init.config.policy.maxConcurrentRequests });
  }

  static async load(
    opts: GlobalOptions,
    { requireConfig, skipConfigFile = false }: { requireConfig: boolean; skipConfigFile?: boolean },
  ): Promise<Runtime> {
    if (opts.color === false) setColor(false);
    const warnings: string[] = [];
    const configPath = findConfigFile(opts.config);
    const envFile = loadEnvFile(opts.envFile, configPath, warnings);
    const registry = builtinRegistry();

    let config: ResolvedConfig;
    if (configPath && !skipConfigFile && existsSync(configPath)) {
      config = await loadConfigFile(configPath, { registry });
    } else if (requireConfig) {
      throw new ConfigError('No config file found (looked for ./config.yaml). Run "dropcatch init" or pass --config <path>.');
    } else {
      config = resolveConfig(parseConfigText("", "defaults"), { registry, baseDir: configPath ? dirname(configPath) : process.cwd() });
    }
    config.warnings.unshift(...warnings);

    const redactor = new Redactor();
    for (const account of Object.values(config.accounts)) {
      for (const envName of Object.values(account.credentialEnv)) redactor.addSecret(process.env[envName]);
    }
    redactor.addSecret(process.env[config.notifications.discord.webhookEnv]);
    for (const target of config.targets) redactor.addSecret(process.env[target.notifications.discord.webhookEnv]);

    const pools: Record<string, ProxyPoolConfig> = {};
    if (config.proxies.enabled) {
      for (const [name, pool] of Object.entries(config.proxies.pools)) {
        const urls = pool.proxies.map((entry) => {
          if (typeof entry === "string") return entry;
          const value = process.env[entry.urlEnv];
          if (!value) throw new ConfigError(`proxies.pools.${name}: environment variable ${entry.urlEnv} is not set`);
          redactor.addSecret(value);
          return value;
        });
        pools[name] = { strategy: pool.strategy, urls };
      }
    }

    const logger = createLogger({
      level: opts.logLevel ?? config.app.logLevel,
      format: opts.json ? "json" : config.app.logFormat,
      timeZone: config.app.timezone,
      redactor,
      color: opts.color === false ? false : undefined,
    });
    for (const warning of config.warnings) logger.warn(warning);

    const router = new ProxyRouter(pools);
    const transport = new UndiciTransport({ router, logger, userAgent: `dropcatch/${VERSION}` });
    return new Runtime({ config, logger, redactor, registry, router, transport, envFile });
  }

  account(id: string): AccountHandle {
    const cached = this.accounts.get(id);
    if (cached) return cached;
    const config = this.config.accounts[id];
    if (!config) throw new ConfigError(`Unknown account "${id}" (known: ${Object.keys(this.config.accounts).join(", ") || "none"})`);
    const credentials: Record<string, string> = {};
    const missing: AccountHandle["missing"] = [];
    for (const field of config.plugin.credentials) {
      const envName = config.credentialEnv[field.name]!;
      const value = process.env[envName]?.trim();
      if (value) credentials[field.name] = value;
      else if (field.required) missing.push({ field: field.name, env: envName });
    }
    const handle: AccountHandle = {
      config,
      credentials,
      missing,
      availabilityLimiter: new RateLimiter(config.limits.availability),
      registrationLimiter: new RateLimiter(config.limits.registration),
    };
    if (missing.length === 0) {
      const transport = this.transport;
      const proxy = config.proxy;
      const allowRetries = this.config.policy.allowRetries;
      try {
        handle.instance = config.plugin.create({
          accountId: id,
          environment: config.environment,
          credentials,
          options: config.options,
          http: (req) => transport.request({ ...req, proxy, retry: allowRetries ? req.retry : NO_RETRY }),
          logger: this.logger.child({ account: id }),
          now: Date.now,
        });
      } catch (err) {
        handle.error = (err as Error).message;
      }
    } else {
      handle.error = `missing environment variable(s): ${missing.map((m) => m.env).join(", ")}`;
    }
    this.accounts.set(id, handle);
    return handle;
  }

  /** Instance for an account, or a ConfigError explaining why it cannot be used. */
  requireInstance(id: string): { handle: AccountHandle; instance: ProviderInstance } {
    const handle = this.account(id);
    if (!handle.instance) throw new ConfigError(`Account "${id}" (${handle.config.plugin.id}) is not usable: ${handle.error}`);
    return { handle, instance: handle.instance };
  }

  sourcesFor(target: ResolvedTarget): AvailabilitySource[] {
    return target.availability.sources.map((id) => {
      const { handle, instance } = this.requireInstance(id);
      return { id, plugin: handle.config.plugin, instance, limiter: handle.availabilityLimiter };
    });
  }

  candidatesFor(target: ResolvedTarget, providers = target.registration.providers): RegistrationCandidate[] {
    return providers.map((id) => {
      const { handle, instance } = this.requireInstance(id);
      return {
        id,
        plugin: handle.config.plugin,
        instance,
        availabilityLimiter: handle.availabilityLimiter,
        registrationLimiter: handle.registrationLimiter,
        credentialsValid: true,
      };
    });
  }

  openStore(): Store {
    this.store ??= new Store(this.config.app.databasePath, this.redactor);
    return this.store;
  }

  /** Notification routes for the given targets. Missing webhooks are warned about, never fatal. */
  buildNotifier(targets: ResolvedTarget[]): Notifier {
    const discord = this.config.notifications.discord;
    const events: ReadonlySet<EventType> = new Set(discord.events ?? DEFAULT_NOTIFY_EVENTS);
    const channels = new Map<string, NotificationChannel>();
    const routes = new Map<string, NotifierRoute>();
    for (const target of targets) {
      const cfg = target.notifications.discord;
      if (!cfg.enabled) {
        routes.set(target.id, { channels: [], events });
        continue;
      }
      const url = process.env[cfg.webhookEnv];
      if (!url) {
        this.logger.warn(`Discord is enabled for ${target.id} but ${cfg.webhookEnv} is not set; notifications will only be logged`);
        routes.set(target.id, { channels: [], events });
        continue;
      }
      let channel = channels.get(url);
      if (!channel) {
        channel = new DiscordChannel({
          webhookUrl: url,
          username: discord.username,
          mentionRoleId: discord.mentionRoleId,
          timeZone: this.config.app.timezone,
          transport: this.transport,
          proxy: this.config.proxies.enabled ? discord.proxy ?? this.config.proxies.defaultPool : undefined,
        });
        channels.set(url, channel);
      }
      routes.set(target.id, { channels: [channel], events });
    }
    return new Notifier(routes, this.logger);
  }

  discordChannel(webhookEnv = this.config.notifications.discord.webhookEnv): DiscordChannel | undefined {
    const url = process.env[webhookEnv];
    if (!url) return undefined;
    const discord = this.config.notifications.discord;
    return new DiscordChannel({
      webhookUrl: url,
      username: discord.username,
      mentionRoleId: discord.mentionRoleId,
      timeZone: this.config.app.timezone,
      transport: this.transport,
      proxy: this.config.proxies.enabled ? discord.proxy ?? this.config.proxies.defaultPool : undefined,
    });
  }

  async close(): Promise<void> {
    this.store?.close();
    await this.router.close();
  }
}
