import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { z } from "zod";
import { ConfigError } from "../core/errors.ts";
import { isValidTimeZone, parseInstant } from "../core/time.ts";
import type { ScheduleConfig } from "../core/watcher/schedule.ts";
import { normalizeDomain, type NormalizedDomain } from "../domain/normalize.ts";
import type { ProviderLimits } from "../providers/RateLimiter.ts";
import type { ProviderRegistry } from "../providers/ProviderRegistry.ts";
import { loadPluginModule } from "../providers/ProviderRegistry.ts";
import type { AnyProviderPlugin, ProviderEnvironment } from "../providers/types.ts";
import { strategyFor, type TldStrategy } from "../tld/strategies.ts";
import {
  configSchema,
  normalizeQuorumMode,
  type BudgetConfig,
  type Config,
  type QuorumMode,
  type RegistrationMode,
} from "./schema.ts";
import { scanForSecrets } from "./secrets.ts";

export const RDAP_ACCOUNT = "rdap";
const CONFIG_CANDIDATES = ["config.yaml", "config.yml", "dropcatch.yaml", "dropcatch.yml", "config.json"];

export interface ResolvedAccount {
  id: string;
  plugin: AnyProviderPlugin;
  environment: ProviderEnvironment;
  enabled: boolean;
  /** credential field -> env var name (defaults applied) */
  credentialEnv: Record<string, string>;
  options: unknown;
  limits: { availability: ProviderLimits; registration: ProviderLimits };
  proxy?: string;
}

export interface ResolvedTarget {
  id: string;
  domain: NormalizedDomain;
  enabled: boolean;
  tld: TldStrategy;
  drop?: {
    expectedAtMs: number;
    input: string;
    timeZone: string;
    ambiguous: boolean;
    preWindowMs: number;
    postWindowMs: number;
  };
  schedule: ScheduleConfig;
  requestTimeoutMs: number;
  availability: { sources: string[]; quorum: QuorumMode; minimumConfirmations: number };
  registration: {
    /** true only when enabled AND mode is confirm/auto-buy. */
    active: boolean;
    mode: RegistrationMode;
    providers: string[];
    maxAttemptsPerProvider: number;
    maxTotalAttempts: number;
    years: number;
    budget: BudgetConfig;
    requestTimeoutMs: number;
    restrictToDropWindow: boolean;
    confirmTimeoutMs: number;
    onFailure: "resume-watch" | "stop";
  };
  notifications: { discord: { enabled: boolean; webhookEnv: string } };
}

export interface ResolvedConfig {
  path?: string;
  baseDir: string;
  profile: Config["profile"];
  app: Config["app"] & { databasePath: string };
  policy: Config["policy"];
  accounts: Record<string, ResolvedAccount>;
  proxies: Config["proxies"];
  notifications: Config["notifications"];
  dashboard: Config["dashboard"];
  plugins: string[];
  targets: ResolvedTarget[];
  warnings: string[];
}

export function findConfigFile(explicit: string | undefined, cwd = process.cwd()): string | undefined {
  if (explicit) return resolve(cwd, explicit);
  if (process.env.DROPCATCH_CONFIG) return resolve(cwd, process.env.DROPCATCH_CONFIG);
  for (const name of CONFIG_CANDIDATES) {
    const candidate = resolve(cwd, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function formatZodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length ? issue.path.join(".") : "(root)";
    return `${path}: ${issue.message}`;
  });
}

export function parseConfigText(text: string, source = "config"): Config {
  const findings = scanForSecrets(text);
  if (findings.length) {
    throw new ConfigError(
      `Refusing to load ${source}: it contains secret-looking values. Move them to environment variables and reference them by name (e.g. webhookEnv: DISCORD_WEBHOOK_URL).`,
      findings.map((f) => `line ${f.line}: ${f.rule}`),
    );
  }
  let data: unknown;
  try {
    data = parseYaml(text, { prettyErrors: true }) ?? {};
  } catch (err) {
    throw new ConfigError(`Cannot parse ${source}: ${(err as Error).message}`);
  }
  const parsed = configSchema.safeParse(data);
  if (!parsed.success) throw new ConfigError(`Invalid configuration in ${source}`, formatZodIssues(parsed.error));
  return parsed.data;
}

export interface LoadOptions {
  registry: ProviderRegistry;
  now?: number;
  env?: NodeJS.ProcessEnv;
}

/** Read, scan, parse and semantically validate a config file. Throws ConfigError with every issue found. */
export async function loadConfigFile(path: string, options: LoadOptions): Promise<ResolvedConfig> {
  if (!existsSync(path)) throw new ConfigError(`Config file not found: ${path}. Run "dropcatch init" or copy config/example.yaml.`);
  const text = readFileSync(path, "utf8");
  const config = parseConfigText(text, path);
  const baseDir = dirname(path);
  for (const plugin of config.plugins) {
    const loaded = await loadPluginModule(plugin, baseDir);
    if (!options.registry.get(loaded.id)) options.registry.register(loaded);
  }
  const resolved = resolveConfig(config, { ...options, baseDir, path });
  const perms = permissionWarning(path);
  if (perms) resolved.warnings.push(perms);
  return resolved;
}

export function permissionWarning(path: string): string | undefined {
  if (process.platform === "win32") return undefined;
  try {
    const mode = statSync(path).mode;
    if (mode & 0o077) {
      return `${path} is readable by group/others (mode ${(mode & 0o777).toString(8)}). Consider chmod 600.`;
    }
  } catch {
    // ignore
  }
  return undefined;
}

function parseOptions(plugin: AnyProviderPlugin, raw: unknown, where: string, errors: string[]): unknown {
  if (!plugin.optionsSchema) return raw;
  const parsed = plugin.optionsSchema.safeParse(raw ?? {});
  if (parsed.success) return parsed.data;
  for (const issue of parsed.error.issues) {
    errors.push(`${where}.options${issue.path.length ? `.${issue.path.join(".")}` : ""}: ${issue.message}`);
  }
  return raw;
}

export function resolveConfig(
  config: Config,
  opts: LoadOptions & { baseDir?: string; path?: string },
): ResolvedConfig {
  const errors: string[] = [];
  const warnings: string[] = [];
  const now = opts.now ?? Date.now();
  const env = opts.env ?? process.env;
  const baseDir = opts.baseDir ?? process.cwd();
  const registry = opts.registry;

  // ---- app / profile ----------------------------------------------------------
  if (!isValidTimeZone(config.app.timezone)) errors.push(`app.timezone: unknown IANA timezone "${config.app.timezone}"`);
  let dryRun = config.app.dryRun;
  if (config.profile === "development" && !dryRun) {
    warnings.push('profile "development" forces app.dryRun = true');
    dryRun = true;
  }
  const databasePath = config.app.database === ":memory:"
    ? ":memory:"
    : isAbsolute(config.app.database) ? config.app.database : resolve(baseDir, config.app.database);

  // ---- proxies ------------------------------------------------------------------
  const poolNames = new Set(Object.keys(config.proxies.pools));
  if (config.proxies.defaultPool && !poolNames.has(config.proxies.defaultPool)) {
    errors.push(`proxies.defaultPool: unknown pool "${config.proxies.defaultPool}"`);
  }
  const checkProxyRef = (ref: string | undefined, where: string): void => {
    if (!ref || ref === "direct") return;
    if (!poolNames.has(ref)) errors.push(`${where}: unknown proxy pool "${ref}"`);
    else if (!config.proxies.enabled) warnings.push(`${where}: proxy pool "${ref}" is ignored because proxies.enabled is false`);
  };
  const routeFor = (ref: string | undefined): string | undefined => {
    if (!config.proxies.enabled) return undefined;
    return ref ?? config.proxies.defaultPool;
  };

  // ---- accounts -------------------------------------------------------------------
  const accounts: Record<string, ResolvedAccount> = {};
  const mergeLimits = (defaults: ProviderLimits, custom?: ProviderLimits): ProviderLimits =>
    config.policy.respectProviderLimits ? { ...defaults, ...custom } : { ...custom };
  if (!config.policy.respectProviderLimits) {
    warnings.push("policy.respectProviderLimits is false: documented provider limits are not enforced. You are responsible for staying within them.");
  }

  if (config.accounts[RDAP_ACCOUNT]) errors.push(`accounts.${RDAP_ACCOUNT}: "rdap" is reserved; configure it with the top-level "rdap" block`);
  if (config.rdap.enabled) {
    const plugin = registry.require("rdap");
    checkProxyRef(config.rdap.proxy, "rdap.proxy");
    accounts[RDAP_ACCOUNT] = {
      id: RDAP_ACCOUNT,
      plugin,
      environment: "production",
      enabled: true,
      credentialEnv: {},
      options: parseOptions(plugin, {
        servers: config.rdap.servers,
        bootstrap: config.rdap.bootstrap,
        ...(config.rdap.bootstrapUrl ? { bootstrapUrl: config.rdap.bootstrapUrl } : {}),
      }, "rdap", errors),
      limits: { availability: mergeLimits(plugin.defaultLimits.availability, config.rdap.limits), registration: {} },
      proxy: routeFor(config.rdap.proxy),
    };
  }

  for (const [id, account] of Object.entries(config.accounts)) {
    if (id === RDAP_ACCOUNT) continue;
    const where = `accounts.${id}`;
    const plugin = registry.get(account.provider);
    if (!plugin) {
      errors.push(`${where}.provider: unknown provider "${account.provider}" (known: ${registry.list().map((p) => p.id).join(", ")})`);
      continue;
    }
    const environment: ProviderEnvironment = account.environment ?? (plugin.id === "mock" ? "mock" : "production");
    if (environment === "mock" && plugin.id !== "mock") errors.push(`${where}.environment: "mock" is only valid for provider "mock"`);
    if (plugin.id === "mock" && environment !== "mock") errors.push(`${where}.environment: provider "mock" must use environment "mock"`);
    if (environment === "sandbox" && !plugin.capabilities.sandbox) errors.push(`${where}.environment: ${plugin.displayName} has no sandbox`);
    if (config.profile === "production" && environment === "mock") {
      errors.push(`${where}: mock providers are not allowed in profile "production" (use profile: development or testing)`);
    }
    if (config.profile === "testing" && environment === "production") {
      errors.push(`${where}: profile "testing" requires sandbox or mock accounts`);
    }

    const knownFields = new Set(plugin.credentials.map((c) => c.name));
    for (const key of Object.keys(account.credentials)) {
      if (!knownFields.has(key)) {
        errors.push(`${where}.credentials.${key}: unknown credential for ${plugin.id} (expected: ${[...knownFields].join(", ") || "none"})`);
      }
    }
    const credentialEnv: Record<string, string> = {};
    for (const field of plugin.credentials) credentialEnv[field.name] = account.credentials[field.name] ?? field.defaultEnv;

    checkProxyRef(account.proxy, `${where}.proxy`);
    accounts[id] = {
      id,
      plugin,
      environment,
      enabled: account.enabled,
      credentialEnv,
      options: parseOptions(plugin, account.options, where, errors),
      limits: {
        availability: mergeLimits(plugin.defaultLimits.availability, account.limits?.availability),
        registration: mergeLimits(plugin.defaultLimits.registration, account.limits?.registration),
      },
      proxy: routeFor(account.proxy),
    };
  }

  checkProxyRef(config.notifications.discord.proxy, "notifications.discord.proxy");

  // ---- targets -------------------------------------------------------------------
  const targets: ResolvedTarget[] = [];
  const seenIds = new Set<string>();
  const seenDomains = new Map<string, string>();
  const usedForRegistration = new Set<string>();

  config.targets.forEach((t, index) => {
    const where = `targets[${index}] (${t.id})`;
    if (seenIds.has(t.id)) errors.push(`${where}.id: duplicate target id`);
    seenIds.add(t.id);

    let domain: NormalizedDomain;
    try {
      domain = normalizeDomain(t.domain);
    } catch (err) {
      errors.push(`${where}.domain: ${(err as Error).message}`);
      return;
    }
    const other = seenDomains.get(domain.ascii);
    if (other) errors.push(`${where}.domain: ${domain.ascii} is already watched by target "${other}" (two targets could buy it twice)`);
    seenDomains.set(domain.ascii, t.id);
    const tld = strategyFor(domain);

    // drop window
    let drop: ResolvedTarget["drop"];
    if (t.drop) {
      const timeZone = t.drop.timezone ?? config.app.timezone;
      if (!isValidTimeZone(timeZone)) {
        errors.push(`${where}.drop.timezone: unknown IANA timezone "${timeZone}"`);
      } else {
        try {
          const parsed = parseInstant(t.drop.expectedAt, timeZone);
          drop = {
            expectedAtMs: parsed.utcMs,
            input: t.drop.expectedAt,
            timeZone,
            ambiguous: parsed.ambiguous,
            preWindowMs: t.drop.preWindowSeconds * 1000,
            postWindowMs: t.drop.postWindowSeconds * 1000,
          };
          if (parsed.ambiguous) {
            warnings.push(`${where}.drop.expectedAt: "${t.drop.expectedAt}" occurs twice in ${timeZone} (DST); the earlier instant was used. Use an explicit offset.`);
          }
          if (parsed.utcMs + drop.postWindowMs < now && t.monitoring.stopAfterWindow) {
            warnings.push(`${where}: the drop window ended at ${new Date(parsed.utcMs + drop.postWindowMs).toISOString()}; watch will stop immediately`);
          }
        } catch (err) {
          errors.push(`${where}.drop.expectedAt: ${(err as Error).message}`);
        }
      }
    }

    const m = t.monitoring;
    if (m.strategy === "adaptive" && !(m.hotIntervalMs <= m.warmupIntervalMs && m.warmupIntervalMs <= m.initialIntervalMs)) {
      warnings.push(`${where}.monitoring: expected hotIntervalMs <= warmupIntervalMs <= initialIntervalMs`);
    }
    if (m.strategy === "adaptive" && !t.drop) {
      warnings.push(`${where}: no drop.expectedAt, so adaptive monitoring falls back to fixedIntervalMs (${m.fixedIntervalMs} ms)`);
    }

    // availability sources
    const sources = [...new Set(t.availability.providers)];
    for (const source of sources) {
      const acct = accounts[source];
      if (!acct) {
        errors.push(`${where}.availability.providers: unknown account "${source}"${source === RDAP_ACCOUNT ? " (rdap.enabled is false)" : ""}`);
      } else if (!acct.plugin.capabilities.availability) {
        errors.push(`${where}.availability.providers: "${source}" (${acct.plugin.id}) cannot check availability`);
      } else if (!acct.enabled) {
        errors.push(`${where}.availability.providers: account "${source}" is disabled`);
      }
    }
    const quorum = normalizeQuorumMode(t.availability.quorum.mode);
    const minimumConfirmations = t.availability.quorum.minimumConfirmations;
    if (minimumConfirmations > sources.length) {
      errors.push(`${where}.availability.quorum.minimumConfirmations (${minimumConfirmations}) exceeds the number of sources (${sources.length})`);
    }
    const kinds = sources.map((s) => accounts[s]?.plugin.sourceKind);
    if (quorum === "registry-confirmed" && (!kinds.includes("registry") || !kinds.includes("registrar"))) {
      errors.push(`${where}.availability.quorum.mode: "registry-confirmed" needs at least one registry source (rdap) and one registrar source`);
    }
    if (quorum === "majority" && sources.length < 2) warnings.push(`${where}: "majority" with one source behaves like "any"`);

    // registration
    const r = t.registration;
    const active = r.enabled && r.mode !== "notify-only";
    if (r.enabled && r.mode === "notify-only") warnings.push(`${where}.registration: enabled but mode is notify-only; nothing will be bought`);
    if (!r.enabled && r.mode !== "notify-only") warnings.push(`${where}.registration: mode "${r.mode}" is ignored because registration.enabled is false`);
    const providers = [...new Set(r.providers.map((p) => (typeof p === "string" ? p : p.account)))];
    if (active) {
      if (providers.length === 0) errors.push(`${where}.registration.providers: at least one registration account is required`);
      for (const id of providers) {
        const acct = accounts[id];
        if (!acct) errors.push(`${where}.registration.providers: unknown account "${id}"`);
        else if (!acct.plugin.capabilities.registration) errors.push(`${where}.registration.providers: "${id}" (${acct.plugin.id}) cannot register domains`);
        else if (!acct.enabled) errors.push(`${where}.registration.providers: account "${id}" is disabled`);
        else usedForRegistration.add(id);
      }
      const budget = r.budget;
      if (budget.maxRegistrationPrice === undefined) {
        if (r.mode === "auto-buy") errors.push(`${where}.registration.budget.maxRegistrationPrice is required for auto-buy`);
        else warnings.push(`${where}: confirm mode without budget.maxRegistrationPrice; you will be the only price check`);
      }
      if (budget.requireExactPrice && budget.expectedPrice === undefined) {
        errors.push(`${where}.registration.budget.requireExactPrice needs budget.expectedPrice`);
      }
      if (budget.expectedPrice !== undefined && budget.maxRegistrationPrice !== undefined && budget.expectedPrice > budget.maxRegistrationPrice) {
        errors.push(`${where}.registration.budget.expectedPrice exceeds maxRegistrationPrice`);
      }
      if (r.maxTotalAttempts > 1 && providers.length > 1) {
        warnings.push(`${where}: several registrars with maxTotalAttempts > 1. A second registrar is only used after a confirmed failure, never after an ambiguous one.`);
      }
      if (r.mode === "auto-buy") {
        const discordOn = config.notifications.discord.enabled && t.notifications.discord.enabled;
        const hookEnv = t.notifications.discord.webhookEnv ?? config.notifications.discord.webhookEnv;
        if (!discordOn) warnings.push(`${where}: AUTO-BUY is enabled but Discord notifications are disabled`);
        else if (!env[hookEnv]) warnings.push(`${where}: AUTO-BUY is enabled but ${hookEnv} is not set`);
        if (databasePath === ":memory:" && !dryRun) {
          errors.push(`${where}: live AUTO-BUY needs a persistent app.database (duplicate-purchase protection must survive restarts)`);
        }
      }
    }

    for (const warning of tld.review({
      domain,
      availabilitySourceTypes: sources.map((s) => accounts[s]?.plugin.id ?? s),
      registrationProviderTypes: active ? providers.map((p) => accounts[p]?.plugin.id ?? p) : [],
      registrationActive: active,
      quorumMode: quorum,
      postWindowSeconds: t.drop?.postWindowSeconds,
    })) {
      warnings.push(warning);
    }

    targets.push({
      id: t.id,
      domain,
      enabled: t.enabled,
      tld,
      drop,
      schedule: {
        dropAt: drop?.expectedAtMs,
        strategy: drop ? m.strategy : "fixed",
        preWindowMs: drop?.preWindowMs ?? 0,
        hotWindowMs: m.hotWindowSeconds * 1000,
        postWindowMs: drop?.postWindowMs ?? 0,
        initialIntervalMs: m.initialIntervalMs,
        warmupIntervalMs: m.warmupIntervalMs,
        hotIntervalMs: m.hotIntervalMs,
        fixedIntervalMs: m.fixedIntervalMs,
        alignToDrop: m.alignToDrop,
        stopAfterWindow: m.stopAfterWindow,
      },
      requestTimeoutMs: m.requestTimeoutMs,
      availability: { sources, quorum, minimumConfirmations },
      registration: {
        active,
        mode: active ? r.mode : "notify-only",
        providers,
        maxAttemptsPerProvider: r.maxAttemptsPerProvider,
        maxTotalAttempts: r.maxTotalAttempts,
        years: r.years,
        budget: r.budget,
        requestTimeoutMs: r.requestTimeoutMs,
        restrictToDropWindow: r.restrictToDropWindow,
        confirmTimeoutMs: r.confirmTimeoutSeconds * 1000,
        onFailure: r.onFailure,
      },
      notifications: {
        discord: {
          enabled: config.notifications.discord.enabled && t.notifications.discord.enabled,
          webhookEnv: t.notifications.discord.webhookEnv ?? config.notifications.discord.webhookEnv,
        },
      },
    });
  });

  // plugin-specific account requirements (e.g. Namecheap needs a contact to register)
  for (const acct of Object.values(accounts)) {
    const problems = acct.plugin.validateAccount?.(acct.options, { registration: usedForRegistration.has(acct.id) }) ?? [];
    for (const problem of problems) errors.push(`accounts.${acct.id}: ${problem}`);
  }

  if (errors.length) throw new ConfigError("Configuration is invalid", errors);

  return {
    path: opts.path,
    baseDir,
    profile: config.profile,
    app: { ...config.app, dryRun, databasePath },
    policy: config.policy,
    accounts,
    proxies: config.proxies,
    notifications: config.notifications,
    dashboard: config.dashboard,
    plugins: config.plugins,
    targets,
    warnings,
  };
}
