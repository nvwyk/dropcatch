import { z } from "zod";
import { EVENT_TYPES } from "../core/events.ts";
import { LOG_LEVELS } from "../logging/logger.ts";

export const envVarName = z
  .string()
  .regex(/^[A-Z_][A-Z0-9_]*$/, "must be an environment variable NAME such as PORKBUN_API_KEY, never the secret itself");

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, "letters, digits, '.', '_' and '-' only");

export const limitsSchema = z
  .object({
    minIntervalMs: z.number().int().min(0).optional(),
    maxConcurrentRequests: z.number().int().min(1).max(32).optional(),
    requestsPerMinute: z.number().int().min(1).optional(),
  })
  .strict();

export const accountSchema = z
  .object({
    provider: z.string().min(1),
    /** Explicit, never inferred from the target (plan section 42). */
    environment: z.enum(["production", "sandbox", "mock"]).optional(),
    enabled: z.boolean().default(true),
    /** credential field -> environment variable name */
    credentials: z.record(z.string(), envVarName).default({}),
    options: z.record(z.string(), z.unknown()).default({}),
    limits: z.object({ availability: limitsSchema.optional(), registration: limitsSchema.optional() }).strict().optional(),
    /** Proxy pool name or "direct". */
    proxy: z.string().optional(),
  })
  .strict();

const proxyEntry = z.union([z.string().min(1), z.object({ urlEnv: envVarName }).strict()]);

export const proxiesSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** Pool used by accounts that do not set `proxy`. */
    defaultPool: z.string().optional(),
    pools: z
      .record(
        z.string(),
        z
          .object({
            strategy: z.enum(["static", "round-robin", "random", "failover"]).default("static"),
            proxies: z.array(proxyEntry).min(1),
          })
          .strict(),
      )
      .default({}),
  })
  .strict();

export const QUORUM_MODES = ["any", "first-positive", "race", "any-confirmed", "majority", "registry-confirmed"] as const;
export type QuorumModeInput = (typeof QUORUM_MODES)[number];
export type QuorumMode = "any" | "majority" | "registry-confirmed";

export function normalizeQuorumMode(mode: QuorumModeInput): QuorumMode {
  return mode === "majority" || mode === "registry-confirmed" ? mode : "any";
}

const monitoringSchema = z
  .object({
    strategy: z.enum(["adaptive", "fixed"]).default("adaptive"),
    /** Interval before the pre-drop window (and after it, if the watch continues). */
    initialIntervalMs: z.number().int().min(250).default(30_000),
    warmupIntervalMs: z.number().int().min(100).default(1000),
    hotIntervalMs: z.number().int().min(50).default(250),
    hotWindowSeconds: z.number().int().min(0).default(10),
    fixedIntervalMs: z.number().int().min(100).default(5000),
    requestTimeoutMs: z.number().int().min(100).max(60_000).default(2500),
    alignToDrop: z.boolean().default(true),
    stopAfterWindow: z.boolean().default(true),
  })
  .strict();

const budgetSchema = z
  .object({
    maxRegistrationPrice: z.number().positive("must be greater than 0").optional(),
    currency: z.string().regex(/^[A-Z]{3}$/, "ISO 4217 code such as USD").default("USD"),
    allowPremium: z.boolean().default(false),
    expectedPrice: z.number().positive().optional(),
    requireExactPrice: z.boolean().default(false),
  })
  .strict();

const registrationProviderRef = z.union([z.string().min(1), z.object({ account: z.string().min(1) }).strict()]);

const registrationSchema = z
  .object({
    enabled: z.boolean().default(false),
    mode: z.enum(["notify-only", "confirm", "auto-buy"]).default("notify-only"),
    /** Accounts tried in order. The next one is used only after a CONFIRMED failure. */
    providers: z.array(registrationProviderRef).default([]),
    maxAttemptsPerProvider: z.number().int().min(1).max(10).default(1),
    maxTotalAttempts: z.number().int().min(1).max(20).default(1),
    years: z.number().int().min(1).max(10).default(1),
    budget: budgetSchema.prefault({}),
    requestTimeoutMs: z.number().int().min(1000).max(120_000).default(30_000),
    /** Refuse to buy outside [expectedAt - preWindow, expectedAt + postWindow]. */
    restrictToDropWindow: z.boolean().default(false),
    confirmTimeoutSeconds: z.number().int().min(5).max(3600).default(300),
    /** After a confirmed failure: go back to watching (if attempts remain) or stop. */
    onFailure: z.enum(["resume-watch", "stop"]).default("resume-watch"),
  })
  .strict();

const targetSchema = z
  .object({
    id: identifier,
    domain: z.string().min(1, "must not be empty"),
    enabled: z.boolean().default(true),
    drop: z
      .object({
        expectedAt: z.string().min(1),
        timezone: z.string().optional(),
        preWindowSeconds: z.number().int().min(0).default(600),
        postWindowSeconds: z.number().int().min(0).default(300),
      })
      .strict()
      .optional(),
    monitoring: monitoringSchema.prefault({}),
    availability: z
      .object({
        providers: z.array(z.string().min(1)).min(1).default(["rdap"]),
        quorum: z
          .object({
            mode: z.enum(QUORUM_MODES).default("any"),
            minimumConfirmations: z.number().int().min(1).default(1),
          })
          .strict()
          .prefault({}),
      })
      .strict()
      .prefault({}),
    registration: registrationSchema.prefault({}),
    notifications: z
      .object({
        discord: z
          .object({ enabled: z.boolean().default(true), webhookEnv: envVarName.optional() })
          .strict()
          .prefault({}),
      })
      .strict()
      .prefault({}),
  })
  .strict();

export const configSchema = z
  .object({
    profile: z.enum(["development", "testing", "production"]).default("production"),
    app: z
      .object({
        timezone: z.string().default("UTC"),
        /** SQLite path relative to the config file, or ":memory:" for a stateless run. */
        database: z.string().default("./data/dropcatch.sqlite"),
        logLevel: z.enum(LOG_LEVELS).default("info"),
        logFormat: z.enum(["pretty", "json"]).default("pretty"),
        /** New configs are dry-run. Going live is a deliberate edit. */
        dryRun: z.boolean().default(true),
      })
      .strict()
      .prefault({}),
    policy: z
      .object({
        respectProviderLimits: z.boolean().default(true),
        maxConcurrentRequests: z.number().int().min(1).max(64).default(4),
        allowRetries: z.boolean().default(true),
      })
      .strict()
      .prefault({}),
    rdap: z
      .object({
        enabled: z.boolean().default(true),
        servers: z.record(z.string(), z.url()).default({}),
        bootstrap: z.boolean().default(true),
        bootstrapUrl: z.url().optional(),
        limits: limitsSchema.optional(),
        proxy: z.string().optional(),
      })
      .strict()
      .prefault({}),
    accounts: z.record(identifier, accountSchema).default({}),
    proxies: proxiesSchema.prefault({}),
    notifications: z
      .object({
        discord: z
          .object({
            enabled: z.boolean().default(true),
            webhookEnv: envVarName.default("DISCORD_WEBHOOK_URL"),
            username: z.string().min(1).max(80).default("dropcatch"),
            mentionRoleId: z.string().regex(/^\d+$/, "numeric role id").optional(),
            events: z.array(z.enum(EVENT_TYPES)).optional(),
            proxy: z.string().optional(),
          })
          .strict()
          .prefault({}),
      })
      .strict()
      .prefault({}),
    dashboard: z
      .object({
        /** 127.0.0.1 keeps it on this machine. 0.0.0.0 exposes it (put HTTPS in front). */
        host: z.string().min(1).default("127.0.0.1"),
        port: z.number().int().min(1).max(65_535).default(4747),
        /** Trust X-Forwarded-Proto / X-Forwarded-For from a reverse proxy. */
        trustProxy: z.boolean().default(false),
        sessionHours: z.number().int().min(1).max(24 * 90).default(24 * 7),
      })
      .strict()
      .prefault({}),
    /** Extra provider modules (default export = ProviderPlugin), relative to the config file. */
    plugins: z.array(z.string().min(1)).default([]),
    targets: z.array(targetSchema).default([]),
  })
  .strict();

export type Config = z.infer<typeof configSchema>;
export type TargetConfig = z.infer<typeof targetSchema>;
export type AccountConfig = z.infer<typeof accountSchema>;
export type BudgetConfig = z.infer<typeof budgetSchema>;
export type RegistrationMode = TargetConfig["registration"]["mode"];
