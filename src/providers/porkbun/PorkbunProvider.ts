import { z } from "zod";
import { ConfigError, type ErrorCode } from "../../core/errors.ts";
import type { Money, RegistrationRequest, RegistrationResult } from "../../core/types.ts";
import { parseJson, retryAfterMs, type HttpResponse } from "../../transport/HttpTransport.ts";
import {
  AVAILABILITY_RETRY,
  READ_RETRY,
  REGISTRATION_RETRY,
  type RetryPolicy,
} from "../../transport/RetryPolicy.ts";
import {
  availability,
  availabilityFromError,
  availabilityFromHttpStatus,
  clockSkew,
  flag,
  parseDecimal,
  registration,
  registrationFromError,
  registrationStatusForHttp,
  startCall,
  type CallMeta,
} from "../helpers.ts";
import { definePlugin } from "../types.ts";

export const PORKBUN_BASE_URL = "https://api.porkbun.com/api/json/v3";

const optionsSchema = z
  .object({
    baseUrl: z.url().optional(),
    /** Override the account-level WHOIS privacy default for new registrations. */
    whoisPrivacy: z.boolean().optional(),
  })
  .strict();

export type PorkbunOptions = z.infer<typeof optionsSchema>;

interface PorkbunEnvelope {
  status?: string;
  code?: string;
  message?: string;
  ttlRemaining?: number;
  response?: { avail?: unknown; price?: unknown; premium?: unknown; regularPrice?: unknown };
  dryRun?: boolean;
  wouldSucceed?: boolean;
  cost?: number;
  orderId?: number | string;
  domains?: Array<{ domain?: string }>;
  credentialsValid?: boolean;
  yourIp?: string;
}

/** Map a Porkbun error envelope onto the internal taxonomy. */
export function porkbunErrorCode(env: PorkbunEnvelope): ErrorCode {
  const code = (env.code ?? "").toUpperCase();
  const message = (env.message ?? "").toLowerCase();
  if (code.startsWith("INVALID_API_KEYS") || code.includes("AUTH") || message.includes("api key")) return "AUTHENTICATION_FAILED";
  if (code === "RATE_LIMIT_EXCEEDED" || message.includes("rate limit")) return "RATE_LIMITED";
  if (code === "DOMAIN_NOT_AVAILABLE" || message.includes("not available")) return "DOMAIN_UNAVAILABLE";
  if (code === "INVALID_DOMAIN") return "INVALID_DOMAIN";
  if (code.includes("FUNDS") || code.includes("CREDIT") || message.includes("insufficient") || message.includes("credit")) {
    return "INSUFFICIENT_FUNDS";
  }
  if (code.includes("COST") || code.includes("PRICE") || message.includes("cost")) return "PRICE_CHANGED";
  if (code.includes("PREMIUM") || message.includes("premium")) return "DOMAIN_PREMIUM";
  if (code.includes("TLD") || message.includes("not supported") || message.includes("unsupported")) return "DOMAIN_UNSUPPORTED";
  return "REGISTRATION_REJECTED";
}

export const porkbunPlugin = definePlugin<PorkbunOptions>({
  id: "porkbun",
  displayName: "Porkbun",
  description: "Porkbun API v3. Real-time check, registration with exact-cost guard, server-side dry run, sandbox keys.",
  sourceKind: "registrar",
  capabilities: {
    availability: true,
    registration: true,
    pricing: true,
    preflight: true,
    ownershipLookup: true,
    registrationStatus: false,
    sandbox: true,
    premiumRegistration: false,
  },
  credentials: [
    { name: "apiKey", defaultEnv: "PORKBUN_API_KEY", required: true, secret: true, description: "API key (pk1_...)" },
    { name: "secretApiKey", defaultEnv: "PORKBUN_SECRET_API_KEY", required: true, secret: true, description: "Secret API key (sk1_...)" },
  ],
  // Documented: 10 checks / 10 s per account, 1 create attempt / s.
  defaultLimits: {
    availability: { minIntervalMs: 1000, maxConcurrentRequests: 1, requestsPerMinute: 60 },
    registration: { minIntervalMs: 1000, maxConcurrentRequests: 1 },
  },
  optionsSchema,
  docs: ["https://porkbun.com/api/json/v3/documentation", "https://porkbun.com/llms-full.txt"],
  create(ctx) {
    const apiKey = ctx.credentials.apiKey ?? "";
    const secretApiKey = ctx.credentials.secretApiKey ?? "";
    const isSandboxKey = apiKey.startsWith("pk1_sb_");
    if (ctx.environment === "sandbox" && !isSandboxKey) {
      throw new ConfigError(`Account "${ctx.accountId}" is marked sandbox but its Porkbun key is not a sandbox key (pk1_sb_...)`);
    }
    if (ctx.environment === "production" && isSandboxKey) {
      ctx.logger.warn("Porkbun account uses a sandbox key while environment is production; purchases will be simulated by Porkbun", {
        account: ctx.accountId,
      });
    }
    const base = ctx.options.baseUrl ?? PORKBUN_BASE_URL;

    function post(path: string, body: Record<string, unknown>, timeoutMs: number, retry: RetryPolicy, label: string, signal?: AbortSignal): Promise<HttpResponse> {
      return ctx.http({
        method: "POST",
        url: `${base}${path}`,
        json: { apikey: apiKey, secretapikey: secretApiKey, ...body },
        timeoutMs,
        retry,
        label,
        signal,
      });
    }

    function createBody(req: RegistrationRequest): Record<string, unknown> | RegistrationResult {
      if (req.price.currency !== "USD") {
        throw new ConfigError(`Porkbun prices are USD; refusing a ${req.price.currency} price`);
      }
      const body: Record<string, unknown> = { cost: Math.round(req.price.amount * 100), agreeToTerms: "yes" };
      if (ctx.options.whoisPrivacy !== undefined) body.whoisPrivacy = ctx.options.whoisPrivacy;
      return body;
    }

    function parseCreate(meta: CallMeta, res: HttpResponse, simulated: boolean): RegistrationResult {
      const env = parseJson<PorkbunEnvelope>(res);
      const extra = simulated ? { simulated: true } : {};
      if (res.status >= 500) {
        return registration(meta, "unknown", { ...extra, errorCode: "REGISTRATION_UNKNOWN", reason: `HTTP ${res.status}` }, res.finishedAt);
      }
      if (env?.status === "SUCCESS") {
        if (simulated) {
          const ok = env.dryRun === true && env.wouldSucceed === true;
          return registration(meta, ok ? "success" : "failed", {
            simulated: true,
            price: typeof env.cost === "number" ? { amount: env.cost / 100, currency: "USD" } : undefined,
            reason: env.message ?? (ok ? "Porkbun preflight: would succeed" : "Porkbun preflight: would fail"),
            errorCode: ok ? undefined : "REGISTRATION_REJECTED",
          }, res.finishedAt);
        }
        if (env.dryRun) {
          return registration(meta, "failed", { errorCode: "REGISTRATION_REJECTED", reason: "unexpected dry-run response; nothing was registered" }, res.finishedAt);
        }
        return registration(meta, "success", {
          price: typeof env.cost === "number" ? { amount: env.cost / 100, currency: "USD" } : undefined,
          providerReference: env.orderId !== undefined ? String(env.orderId) : undefined,
        }, res.finishedAt);
      }
      if (env?.status === "ERROR") {
        return registration(meta, "failed", {
          ...extra,
          errorCode: porkbunErrorCode(env),
          reason: env.message ?? env.code ?? "rejected",
        }, res.finishedAt);
      }
      if (res.status >= 200 && res.status < 300) {
        // 2xx without a readable verdict: the order may exist.
        return registration(meta, "unknown", { ...extra, errorCode: "REGISTRATION_UNKNOWN", reason: "unreadable success response" }, res.finishedAt);
      }
      const mapped = registrationStatusForHttp(res.status);
      return registration(meta, mapped.status, { ...extra, errorCode: mapped.code, reason: `HTTP ${res.status}` }, res.finishedAt);
    }

    return {
      async check(req) {
        const meta = startCall(ctx.accountId, "porkbun", req.domain, ctx.now());
        try {
          const res = await post(`/domain/checkDomain/${req.domain}`, {}, req.timeoutMs, AVAILABILITY_RETRY, "porkbun.check", req.signal);
          const env = parseJson<PorkbunEnvelope>(res);
          const skew = clockSkew(res);
          if (res.status === 429 || env?.code === "RATE_LIMIT_EXCEEDED") {
            const after = retryAfterMs(res) ?? (env?.ttlRemaining !== undefined ? env.ttlRemaining * 1000 : undefined);
            return availability(meta, "registrar", "rate_limited", { errorCode: "RATE_LIMITED", retryAfterMs: after, reason: env?.message }, res.finishedAt);
          }
          if (env?.status === "SUCCESS" && env.response) {
            const avail = flag(env.response.avail);
            const premium = flag(env.response.premium);
            const amount = parseDecimal(env.response.price);
            const price: Money | undefined = amount !== undefined ? { amount, currency: "USD" } : undefined;
            return availability(meta, "registrar", avail ? "available" : "unavailable", {
              premium,
              price,
              registrable: avail ? !premium : false,
              reason: premium ? "premium name (Porkbun cannot register premium names via API)" : undefined,
              clockSkewMs: skew,
            }, res.finishedAt);
          }
          if (env?.status === "ERROR") {
            const code = porkbunErrorCode(env);
            return availability(meta, "registrar", code === "DOMAIN_UNSUPPORTED" ? "unsupported" : "error", {
              errorCode: code === "REGISTRATION_REJECTED" ? "PROVIDER_ERROR" : code,
              reason: env.message ?? env.code,
              clockSkewMs: skew,
            }, res.finishedAt);
          }
          return availabilityFromHttpStatus(meta, "registrar", res, retryAfterMs(res))
            ?? availability(meta, "registrar", "error", { errorCode: "INVALID_RESPONSE", reason: "unreadable response" }, res.finishedAt);
        } catch (err) {
          return availabilityFromError(meta, "registrar", err);
        }
      },

      async register(req) {
        const meta = startCall(ctx.accountId, "porkbun", req.domain, ctx.now());
        let body: Record<string, unknown> | RegistrationResult;
        try {
          body = createBody(req);
        } catch (err) {
          return registration(meta, "failed", { errorCode: "CONFIGURATION_ERROR", reason: (err as Error).message });
        }
        try {
          const res = await post(`/domain/create/${req.domain}`, body as Record<string, unknown>, req.timeoutMs, REGISTRATION_RETRY, "porkbun.create");
          return parseCreate(meta, res, false);
        } catch (err) {
          return registrationFromError(meta, err);
        }
      },

      async preflight(req) {
        const meta = startCall(ctx.accountId, "porkbun", req.domain, ctx.now());
        try {
          const body = createBody(req) as Record<string, unknown>;
          const res = await post(`/domain/create/${req.domain}`, { ...body, dryRun: true }, req.timeoutMs, READ_RETRY, "porkbun.preflight");
          return parseCreate(meta, res, true);
        } catch (err) {
          return { ...registrationFromError(meta, err), simulated: true };
        }
      },

      async lookupOwnership(domain, timeoutMs) {
        try {
          const res = await post("/domain/listAll", { domain }, timeoutMs, READ_RETRY, "porkbun.listAll");
          const env = parseJson<PorkbunEnvelope>(res);
          if (env?.status !== "SUCCESS" || !Array.isArray(env.domains)) return "unknown";
          return env.domains.some((d) => d.domain?.toLowerCase() === domain) ? "owned" : "not-owned";
        } catch {
          return "unknown";
        }
      },

      async healthCheck(timeoutMs) {
        try {
          const res = await post("/ping", {}, timeoutMs, READ_RETRY, "porkbun.ping");
          const env = parseJson<PorkbunEnvelope>(res);
          const ok = env?.status === "SUCCESS" && env.credentialsValid !== false;
          return {
            ok,
            latencyMs: res.latencyMs,
            detail: ok
              ? `credentials valid${isSandboxKey ? " (sandbox key)" : ""}${env?.yourIp ? `, egress IP ${env.yourIp}` : ""}`
              : env?.message ?? `HTTP ${res.status}`,
          };
        } catch (err) {
          return { ok: false, detail: (err as Error).message };
        }
      },
    };
  },
});
