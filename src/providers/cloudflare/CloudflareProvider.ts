import { z } from "zod";
import type { ErrorCode } from "../../core/errors.ts";
import type { RegistrationResult } from "../../core/types.ts";
import { parseJson, retryAfterMs, type HttpResponse } from "../../transport/HttpTransport.ts";
import { AVAILABILITY_RETRY, READ_RETRY, REGISTRATION_RETRY } from "../../transport/RetryPolicy.ts";
import {
  availability,
  availabilityFromError,
  availabilityFromHttpStatus,
  clockSkew,
  parseDecimal,
  registration,
  registrationFromError,
  registrationStatusForHttp,
  startCall,
  type CallMeta,
} from "../helpers.ts";
import { definePlugin } from "../types.ts";

export const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

const optionsSchema = z
  .object({
    baseUrl: z.url().optional(),
    autoRenew: z.boolean().default(false),
    privacyMode: z.enum(["redaction", "off"]).default("redaction"),
    /** Passed through verbatim as `contacts` (required by the sandbox). See Cloudflare's registration schema. */
    contacts: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type CloudflareOptions = z.infer<typeof optionsSchema>;

interface CfEnvelope<T> {
  success?: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result?: T;
}

interface CfCheckDomain {
  name?: string;
  registrable?: boolean;
  tier?: string;
  reason?: string;
  pricing?: { currency?: string; registration_cost?: string | number };
}

interface CfWorkflow {
  state?: string;
  completed?: boolean;
  links?: { self?: string; resource?: string };
  error?: { code?: string; message?: string };
}

function cfErrorText(env: CfEnvelope<unknown> | undefined): string {
  return (env?.errors ?? []).map((e) => `${e.code ?? ""} ${e.message ?? ""}`.trim()).join("; ");
}

export function cloudflareErrorCode(env: CfEnvelope<unknown> | undefined, status: number): ErrorCode {
  const text = cfErrorText(env).toLowerCase();
  if (status === 429) return "RATE_LIMITED";
  if (status === 401 || status === 403 || text.includes("authentication") || text.includes("10000")) return "AUTHENTICATION_FAILED";
  if (text.includes("not available") || text.includes("unavailable")) return "DOMAIN_UNAVAILABLE";
  if (text.includes("premium")) return "DOMAIN_PREMIUM";
  if (text.includes("extension") || text.includes("not supported")) return "DOMAIN_UNSUPPORTED";
  if (text.includes("insufficient") || text.includes("payment") || text.includes("billing")) return "INSUFFICIENT_FUNDS";
  return "REGISTRATION_REJECTED";
}

/** Map a Cloudflare workflow state onto a registration status. */
export function workflowStatus(state: string | undefined): RegistrationResult["status"] {
  switch (state) {
    case "succeeded":
      return "success";
    case "failed":
      return "failed";
    case "pending":
    case "in_progress":
    case "action_required":
    case "blocked":
      return "pending";
    default:
      return "unknown";
  }
}

export const cloudflarePlugin = definePlugin<CloudflareOptions>({
  id: "cloudflare",
  displayName: "Cloudflare Registrar",
  description: "Cloudflare Registrar API (beta, subset of TLDs). Registrations are non-refundable.",
  sourceKind: "registrar",
  capabilities: {
    availability: true,
    registration: true,
    pricing: true,
    preflight: false,
    ownershipLookup: true,
    registrationStatus: true,
    sandbox: true,
    premiumRegistration: false,
  },
  credentials: [
    { name: "apiToken", defaultEnv: "CLOUDFLARE_API_TOKEN", required: true, secret: true, description: "API token with Registrar write permission" },
    { name: "accountId", defaultEnv: "CLOUDFLARE_ACCOUNT_ID", required: true, secret: false, description: "Account ID" },
  ],
  defaultLimits: {
    availability: { minIntervalMs: 1000, maxConcurrentRequests: 1, requestsPerMinute: 60 },
    registration: { minIntervalMs: 1000, maxConcurrentRequests: 1 },
  },
  optionsSchema,
  docs: [
    "https://developers.cloudflare.com/registrar/registrar-api/",
    "https://developers.cloudflare.com/api/resources/registrar/",
    "https://developers.cloudflare.com/api/resources/registrar_sandbox/",
  ],
  create(ctx) {
    const root = ctx.options.baseUrl ?? CLOUDFLARE_API;
    const scope = ctx.environment === "sandbox" ? "registrar-sandbox" : "registrar";
    const base = `${root}/accounts/${encodeURIComponent(ctx.credentials.accountId ?? "")}/${scope}`;
    const auth = { authorization: `Bearer ${ctx.credentials.apiToken ?? ""}` };

    function workflowResult(meta: CallMeta, res: HttpResponse): RegistrationResult {
      const env = parseJson<CfEnvelope<CfWorkflow>>(res);
      const ok = res.status >= 200 && res.status < 300;
      // A 2xx we cannot read, or a 2xx that claims failure, may still hide a completed order.
      if (ok && (!env || env.success === false)) {
        return registration(meta, "unknown", { errorCode: "REGISTRATION_UNKNOWN", reason: cfErrorText(env) || "unreadable response" }, res.finishedAt);
      }
      if (!ok || !env) {
        const mapped = registrationStatusForHttp(res.status);
        return registration(meta, mapped.status, {
          errorCode: mapped.status === "failed" ? cloudflareErrorCode(env, res.status) : mapped.code,
          reason: cfErrorText(env) || `HTTP ${res.status}`,
        }, res.finishedAt);
      }
      const wf = env.result ?? {};
      const status = workflowStatus(wf.state);
      return registration(meta, status, {
        providerReference: wf.links?.self,
        errorCode: status === "failed" ? cloudflareErrorCode({ errors: [{ message: wf.error?.message }] }, 400) : undefined,
        reason: wf.error?.message ?? (wf.state ? `workflow ${wf.state}` : undefined),
      }, res.finishedAt);
    }

    return {
      async check(req) {
        const meta = startCall(ctx.accountId, "cloudflare", req.domain, ctx.now());
        try {
          const res = await ctx.http({
            method: "POST",
            url: `${base}/domain-check`,
            headers: auth,
            json: { domains: [req.domain] },
            timeoutMs: req.timeoutMs,
            signal: req.signal,
            retry: AVAILABILITY_RETRY,
            label: "cloudflare.check",
          });
          const skew = clockSkew(res);
          const httpIssue = availabilityFromHttpStatus(meta, "registrar", res, retryAfterMs(res));
          if (httpIssue) return { ...httpIssue, reason: cfErrorText(parseJson(res)) || httpIssue.reason };
          const env = parseJson<CfEnvelope<{ domains?: CfCheckDomain[] }>>(res);
          const item = env?.result?.domains?.find((d) => d.name?.toLowerCase() === req.domain);
          if (!env?.success || !item) {
            return availability(meta, "registrar", "error", { errorCode: "INVALID_RESPONSE", reason: cfErrorText(env) || "no result for domain" }, res.finishedAt);
          }
          const premium = item.tier === "premium" || item.reason === "domain_premium";
          if (item.registrable) {
            const amount = parseDecimal(item.pricing?.registration_cost);
            return availability(meta, "registrar", "available", {
              registrable: !premium,
              premium,
              price: amount !== undefined ? { amount, currency: item.pricing?.currency ?? "USD" } : undefined,
              reason: premium ? "premium tier (needs fee acknowledgement, not enabled)" : undefined,
              clockSkewMs: skew,
            }, res.finishedAt);
          }
          switch (item.reason) {
            case "domain_premium":
              return availability(meta, "registrar", "available", { registrable: false, premium: true, reason: item.reason, clockSkewMs: skew }, res.finishedAt);
            case "extension_not_supported_via_api":
            case "extension_not_supported":
            case "extension_disallows_registration":
              return availability(meta, "registrar", "unsupported", { errorCode: "DOMAIN_UNSUPPORTED", reason: item.reason, clockSkewMs: skew }, res.finishedAt);
            default:
              return availability(meta, "registrar", "unavailable", { registrable: false, reason: item.reason, clockSkewMs: skew }, res.finishedAt);
          }
        } catch (err) {
          return availabilityFromError(meta, "registrar", err);
        }
      },

      async register(req) {
        const meta = startCall(ctx.accountId, "cloudflare", req.domain, ctx.now());
        const body: Record<string, unknown> = {
          domain_name: req.domain,
          years: req.years,
          auto_renew: ctx.options.autoRenew,
          privacy_mode: ctx.options.privacyMode,
        };
        if (ctx.options.contacts) body.contacts = ctx.options.contacts;
        try {
          const res = await ctx.http({
            method: "POST",
            url: `${base}/registrations`,
            headers: auth,
            json: body,
            timeoutMs: req.timeoutMs,
            retry: REGISTRATION_RETRY,
            label: "cloudflare.register",
          });
          return workflowResult(meta, res);
        } catch (err) {
          return registrationFromError(meta, err);
        }
      },

      async getRegistrationStatus(domain, _reference, timeoutMs) {
        const meta = startCall(ctx.accountId, "cloudflare", domain, ctx.now());
        try {
          const res = await ctx.http({
            method: "GET",
            url: `${base}/registrations/${domain}/registration-status`,
            headers: auth,
            timeoutMs,
            retry: READ_RETRY,
            label: "cloudflare.registrationStatus",
          });
          return workflowResult(meta, res);
        } catch (err) {
          return registrationFromError(meta, err);
        }
      },

      async lookupOwnership(domain, timeoutMs) {
        try {
          const res = await ctx.http({
            method: "GET",
            url: `${base}/registrations/${domain}`,
            headers: auth,
            timeoutMs,
            retry: READ_RETRY,
            label: "cloudflare.getRegistration",
          });
          if (res.status === 404) return "not-owned";
          const env = parseJson<CfEnvelope<unknown>>(res);
          return res.status === 200 && env?.success ? "owned" : "unknown";
        } catch {
          return "unknown";
        }
      },

      async healthCheck(timeoutMs) {
        try {
          const res = await ctx.http({
            method: "GET",
            url: `${base}/registrations?per_page=1`,
            headers: auth,
            timeoutMs,
            retry: READ_RETRY,
            label: "cloudflare.health",
          });
          const env = parseJson<CfEnvelope<unknown>>(res);
          const ok = res.status === 200 && env?.success === true;
          return { ok, latencyMs: res.latencyMs, detail: ok ? `token valid (${scope})` : cfErrorText(env) || `HTTP ${res.status}` };
        } catch (err) {
          return { ok: false, detail: (err as Error).message };
        }
      },
    };
  },
});
