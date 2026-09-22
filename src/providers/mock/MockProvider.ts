import { z } from "zod";
import { sleep } from "../../core/clock.ts";
import { availability, registration, startCall } from "../helpers.ts";
import { definePlugin } from "../types.ts";

/**
 * Deterministic fake registrar for development, dry-run rehearsals and tests (plan step F).
 * Scenarios cover every failure mode the orchestration has to survive.
 */
const optionsSchema = z
  .object({
    scenario: z
      .enum([
        "always-unavailable",
        "always-available",
        "available-after-checks",
        "available-at",
        "timeout",
        "rate-limited",
        "server-error",
        "unsupported",
      ])
      .default("available-after-checks"),
    availableAfterChecks: z.number().int().min(0).default(3),
    /** ISO instant at which "available-at" flips to available. */
    availableAt: z.string().optional(),
    price: z.number().positive().default(9.99),
    currency: z.string().default("USD"),
    premium: z.boolean().default(false),
    latencyMs: z.number().int().min(0).default(5),
    registration: z.enum(["success", "failure", "unknown", "pending", "timeout"]).default("success"),
    registrationLatencyMs: z.number().int().min(0).default(5),
    /** For "unknown"/"timeout": whether the purchase actually went through (ownership lookup reveals it). */
    purchaseActuallySucceeds: z.boolean().default(false),
    /** What getRegistrationStatus reports for a pending registration. */
    pendingResolvesTo: z.enum(["success", "failed", "pending"]).default("success"),
    failureCode: z.enum(["DOMAIN_UNAVAILABLE", "INSUFFICIENT_FUNDS", "REGISTRATION_REJECTED"]).default("DOMAIN_UNAVAILABLE"),
    healthy: z.boolean().default(true),
  })
  .strict();

export type MockOptions = z.infer<typeof optionsSchema>;

export interface MockStats {
  checks: number;
  registrations: number;
  preflights: number;
  ownershipLookups: number;
  warmups: number;
  owned: Set<string>;
}

/** Observable counters per account id, used by tests to prove e.g. that dry-run never registers. */
export const mockStats = new Map<string, MockStats>();

export function resetMockStats(): void {
  mockStats.clear();
}

function statsFor(accountId: string): MockStats {
  let s = mockStats.get(accountId);
  if (!s) {
    s = { checks: 0, registrations: 0, preflights: 0, ownershipLookups: 0, warmups: 0, owned: new Set() };
    mockStats.set(accountId, s);
  }
  return s;
}

export const mockPlugin = definePlugin<MockOptions>({
  id: "mock",
  displayName: "Mock registrar",
  description: "Deterministic fake provider for rehearsals and tests. Never touches the network.",
  sourceKind: "registrar",
  capabilities: {
    availability: true,
    registration: true,
    pricing: true,
    preflight: true,
    ownershipLookup: true,
    registrationStatus: true,
    sandbox: true,
    premiumRegistration: true,
  },
  credentials: [],
  defaultLimits: { availability: {}, registration: {} },
  optionsSchema,
  create(ctx) {
    const o = ctx.options;
    const stats = statsFor(ctx.accountId);
    const flipAt = o.availableAt ? Date.parse(o.availableAt) : undefined;

    function isAvailable(checkNumber: number): boolean {
      switch (o.scenario) {
        case "always-available":
          return true;
        case "available-after-checks":
          return checkNumber > o.availableAfterChecks;
        case "available-at":
          return flipAt !== undefined && ctx.now() >= flipAt;
        default:
          return false;
      }
    }

    return {
      async warmup() {
        stats.warmups++;
      },

      async check(req) {
        const meta = startCall(ctx.accountId, "mock", req.domain, ctx.now());
        stats.checks++;
        const n = stats.checks;
        if (o.scenario === "timeout") {
          await sleep(req.timeoutMs, req.signal);
          return availability(meta, "registrar", "error", { errorCode: "NETWORK_TIMEOUT", reason: "simulated timeout" });
        }
        await sleep(o.latencyMs, req.signal);
        switch (o.scenario) {
          case "rate-limited":
            return availability(meta, "registrar", "rate_limited", { errorCode: "RATE_LIMITED", retryAfterMs: 1000 });
          case "server-error":
            return availability(meta, "registrar", "error", { errorCode: "PROVIDER_UNAVAILABLE", reason: "HTTP 503" });
          case "unsupported":
            return availability(meta, "registrar", "unsupported", { errorCode: "DOMAIN_UNSUPPORTED" });
        }
        if (stats.owned.has(req.domain)) return availability(meta, "registrar", "unavailable", { reason: "registered (by you)" });
        const available = isAvailable(n);
        return availability(meta, "registrar", available ? "available" : "unavailable", {
          price: { amount: o.price, currency: o.currency },
          premium: o.premium,
          registrable: available,
        });
      },

      async register(req) {
        const meta = startCall(ctx.accountId, "mock", req.domain, ctx.now());
        stats.registrations++;
        await sleep(o.registrationLatencyMs);
        switch (o.registration) {
          case "success":
            stats.owned.add(req.domain);
            return registration(meta, "success", { price: req.price, providerReference: `mock-${stats.registrations}` });
          case "pending":
            return registration(meta, "pending", { providerReference: `mock-${stats.registrations}` });
          case "failure":
            return registration(meta, "failed", { errorCode: o.failureCode, reason: "simulated rejection" });
          case "unknown":
          case "timeout":
            if (o.purchaseActuallySucceeds) stats.owned.add(req.domain);
            return registration(meta, "unknown", {
              errorCode: "REGISTRATION_UNKNOWN",
              reason: o.registration === "timeout" ? "simulated timeout after send" : "simulated unreadable response",
            });
        }
      },

      async preflight(req) {
        const meta = startCall(ctx.accountId, "mock", req.domain, ctx.now());
        stats.preflights++;
        return registration(meta, "success", { simulated: true, price: req.price, reason: "mock preflight: would succeed" });
      },

      async lookupOwnership(domain) {
        stats.ownershipLookups++;
        return stats.owned.has(domain) ? "owned" : "not-owned";
      },

      async getRegistrationStatus(domain, reference) {
        const meta = startCall(ctx.accountId, "mock", domain, ctx.now());
        if (o.pendingResolvesTo === "success") stats.owned.add(domain);
        return registration(meta, o.pendingResolvesTo, { providerReference: reference });
      },

      async healthCheck() {
        return o.healthy ? { ok: true, latencyMs: 0, detail: `mock (${o.scenario})` } : { ok: false, detail: "mock unhealthy" };
      },
    };
  },
});
