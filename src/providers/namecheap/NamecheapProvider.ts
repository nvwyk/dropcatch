import { z } from "zod";
import type { ErrorCode } from "../../core/errors.ts";
import type { Money } from "../../core/types.ts";
import type { HttpResponse } from "../../transport/HttpTransport.ts";
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
} from "../helpers.ts";
import { definePlugin } from "../types.ts";
import { apiErrors, apiStatus, elements } from "./xml.ts";

export const NAMECHEAP_PRODUCTION_URL = "https://api.namecheap.com/xml.response";
export const NAMECHEAP_SANDBOX_URL = "https://api.sandbox.namecheap.com/xml.response";

const contactSchema = z
  .object({
    firstName: z.string().min(1),
    lastName: z.string().min(1),
    organization: z.string().optional(),
    address1: z.string().min(1),
    address2: z.string().optional(),
    city: z.string().min(1),
    stateProvince: z.string().min(1),
    postalCode: z.string().min(1),
    country: z.string().regex(/^[A-Z]{2}$/, "two-letter ISO country code"),
    phone: z.string().regex(/^\+\d{1,3}\.\d{4,14}$/, "format +NNN.NNNNNNNNNN"),
    email: z.email(),
  })
  .strict();

const optionsSchema = z
  .object({
    baseUrl: z.url().optional(),
    /** Registrant contact, applied to the Registrant, Tech, Admin and AuxBilling roles. Required to register. */
    contact: contactSchema.optional(),
    whoisguard: z.boolean().default(true),
  })
  .strict();

export type NamecheapOptions = z.infer<typeof optionsSchema>;

/** Map Namecheap error text onto the internal taxonomy. */
export function namecheapErrorCode(errors: Array<{ number: string; message: string }>): ErrorCode {
  const text = errors.map((e) => `${e.number} ${e.message}`).join(" ").toLowerCase();
  if (text.includes("ip") && (text.includes("whitelist") || text.includes("not allowed"))) return "AUTHENTICATION_FAILED";
  if (text.includes("api key") || text.includes("apiuser") || text.includes("username") || text.includes("authentication")) {
    return "AUTHENTICATION_FAILED";
  }
  if (text.includes("too many") || text.includes("rate")) return "RATE_LIMITED";
  if (text.includes("insufficient") || text.includes("balance") || text.includes("funds")) return "INSUFFICIENT_FUNDS";
  if (text.includes("not available") || text.includes("unavailable") || text.includes("already registered") || text.includes("taken")) {
    return "DOMAIN_UNAVAILABLE";
  }
  if (text.includes("premium")) return "DOMAIN_PREMIUM";
  if (text.includes("not supported") || text.includes("tld")) return "DOMAIN_UNSUPPORTED";
  return "REGISTRATION_REJECTED";
}

/** Price of a 1-year registration from a users.getPricing response (YourPrice plus ICANN fee). */
export function parseRegistrationPrice(xml: string): Money | undefined {
  const prices = elements(xml, "Price");
  const oneYear = prices.find((p) => p.attrs.Duration === "1" && (p.attrs.DurationType ?? "YEAR").toUpperCase() === "YEAR");
  if (!oneYear) return undefined;
  const base = parseDecimal(oneYear.attrs.YourPrice ?? oneYear.attrs.Price);
  if (base === undefined) return undefined;
  const additional = parseDecimal(oneYear.attrs.YourAdditonalCost ?? oneYear.attrs.YourAdditionalCost ?? oneYear.attrs.AdditionalCost) ?? 0;
  return { amount: Math.round((base + additional) * 100) / 100, currency: oneYear.attrs.Currency ?? "USD" };
}

export const namecheapPlugin = definePlugin<NamecheapOptions>({
  id: "namecheap",
  displayName: "Namecheap",
  description: "Namecheap XML API. Requires a whitelisted client IP. Standard prices come from users.getPricing.",
  sourceKind: "registrar",
  capabilities: {
    availability: true,
    registration: true,
    pricing: true,
    preflight: false,
    ownershipLookup: true,
    registrationStatus: false,
    sandbox: true,
    premiumRegistration: false,
  },
  credentials: [
    { name: "apiUser", defaultEnv: "NAMECHEAP_API_USER", required: true, secret: false, description: "ApiUser" },
    { name: "apiKey", defaultEnv: "NAMECHEAP_API_KEY", required: true, secret: true, description: "ApiKey" },
    { name: "userName", defaultEnv: "NAMECHEAP_USERNAME", required: false, secret: false, description: "UserName (defaults to ApiUser)" },
    { name: "clientIp", defaultEnv: "NAMECHEAP_CLIENT_IP", required: true, secret: false, description: "Whitelisted IPv4 the requests come from" },
  ],
  // Documented: 50/min, 700/hour, 8000/day per key.
  defaultLimits: {
    availability: { minIntervalMs: 2000, maxConcurrentRequests: 1, requestsPerMinute: 25 },
    registration: { minIntervalMs: 1000, maxConcurrentRequests: 1, requestsPerMinute: 10 },
  },
  optionsSchema,
  validateAccount(options, usage) {
    return usage.registration && !options.contact ? ["options.contact is required because the account is used for registration"] : [];
  },
  docs: [
    "https://www.namecheap.com/support/api/intro/",
    "https://www.namecheap.com/support/api/methods/domains/check/",
    "https://www.namecheap.com/support/api/methods/domains/create/",
  ],
  create(ctx) {
    const base = ctx.options.baseUrl ?? (ctx.environment === "sandbox" ? NAMECHEAP_SANDBOX_URL : NAMECHEAP_PRODUCTION_URL);
    const global = {
      ApiUser: ctx.credentials.apiUser ?? "",
      ApiKey: ctx.credentials.apiKey ?? "",
      UserName: ctx.credentials.userName || ctx.credentials.apiUser || "",
      ClientIp: ctx.credentials.clientIp ?? "",
    };
    const priceCache = new Map<string, Money>();

    function call(command: string, params: Record<string, string>, timeoutMs: number, retry: RetryPolicy, signal?: AbortSignal): Promise<HttpResponse> {
      // POST keeps the ApiKey out of URLs (and therefore out of any proxy/access logs).
      return ctx.http({
        method: "POST",
        url: base,
        form: { ...global, Command: command, ...params },
        headers: { accept: "application/xml, text/xml" },
        timeoutMs,
        retry,
        signal,
        label: `namecheap.${command.replace("namecheap.", "")}`,
      });
    }

    async function tldPrice(tld: string): Promise<Money | undefined> {
      const cached = priceCache.get(tld);
      if (cached) return cached;
      const res = await call(
        "namecheap.users.getPricing",
        { ProductType: "DOMAIN", ProductCategory: "REGISTER", ActionName: "REGISTER", ProductName: tld },
        10_000,
        READ_RETRY,
      );
      if (apiStatus(res.text) !== "OK") return undefined;
      const price = parseRegistrationPrice(res.text);
      if (price) priceCache.set(tld, price);
      return price;
    }

    const tldOf = (domain: string): string => domain.slice(domain.indexOf(".") + 1);

    return {
      async warmup() {
        // HEAD on the host root: no credentials sent, nothing counted against the API key.
        await ctx.http({ method: "HEAD", url: `${new URL(base).origin}/`, timeoutMs: 3000, label: "namecheap.warmup" });
      },

      async prepare(domain) {
        await tldPrice(tldOf(domain)).catch(() => undefined);
      },

      async check(req) {
        const meta = startCall(ctx.accountId, "namecheap", req.domain, ctx.now());
        try {
          const res = await call("namecheap.domains.check", { DomainList: req.domain }, req.timeoutMs, AVAILABILITY_RETRY, req.signal);
          const skew = clockSkew(res);
          const httpIssue = availabilityFromHttpStatus(meta, "registrar", res);
          if (httpIssue) return httpIssue;
          const status = apiStatus(res.text);
          if (status === "ERROR") {
            const code = namecheapErrorCode(apiErrors(res.text));
            return availability(meta, "registrar", code === "RATE_LIMITED" ? "rate_limited" : code === "DOMAIN_UNSUPPORTED" ? "unsupported" : "error", {
              errorCode: code === "REGISTRATION_REJECTED" ? "PROVIDER_ERROR" : code,
              reason: apiErrors(res.text).map((e) => e.message).join("; "),
              clockSkewMs: skew,
            }, res.finishedAt);
          }
          const result = elements(res.text, "DomainCheckResult").find((e) => e.attrs.Domain?.toLowerCase() === req.domain);
          if (status !== "OK" || !result) {
            return availability(meta, "registrar", "error", { errorCode: "INVALID_RESPONSE", reason: "no DomainCheckResult" }, res.finishedAt);
          }
          if (result.attrs.ErrorNo && result.attrs.ErrorNo !== "0") {
            return availability(meta, "registrar", "unknown", { errorCode: "PROVIDER_ERROR", reason: result.attrs.Description }, res.finishedAt);
          }
          const available = flag(result.attrs.Available);
          const premium = flag(result.attrs.IsPremiumName);
          const eap = parseDecimal(result.attrs.EapFee) ?? 0;
          let price: Money | undefined;
          if (premium) {
            const premiumPrice = parseDecimal(result.attrs.PremiumRegistrationPrice);
            const icann = parseDecimal(result.attrs.IcannFee) ?? 0;
            if (premiumPrice !== undefined) price = { amount: premiumPrice + icann + eap, currency: "USD" };
          } else {
            const standard = priceCache.get(tldOf(req.domain));
            if (standard) price = { amount: Math.round((standard.amount + eap) * 100) / 100, currency: standard.currency };
          }
          return availability(meta, "registrar", available ? "available" : "unavailable", {
            premium,
            price,
            registrable: available ? !premium : false,
            reason: premium ? "premium name (premium purchase not enabled for Namecheap)" : undefined,
            clockSkewMs: skew,
          }, res.finishedAt);
        } catch (err) {
          return availabilityFromError(meta, "registrar", err);
        }
      },

      async register(req) {
        const meta = startCall(ctx.accountId, "namecheap", req.domain, ctx.now());
        const contact = ctx.options.contact;
        if (!contact) {
          return registration(meta, "failed", { errorCode: "CONFIGURATION_ERROR", reason: "accounts.<id>.options.contact is required to register with Namecheap" });
        }
        const params: Record<string, string> = {
          DomainName: req.domain,
          Years: String(req.years),
          AddFreeWhoisguard: ctx.options.whoisguard ? "yes" : "no",
          WGEnabled: ctx.options.whoisguard ? "yes" : "no",
        };
        for (const role of ["Registrant", "Tech", "Admin", "AuxBilling"]) {
          params[`${role}FirstName`] = contact.firstName;
          params[`${role}LastName`] = contact.lastName;
          if (contact.organization) params[`${role}OrganizationName`] = contact.organization;
          params[`${role}Address1`] = contact.address1;
          if (contact.address2) params[`${role}Address2`] = contact.address2;
          params[`${role}City`] = contact.city;
          params[`${role}StateProvince`] = contact.stateProvince;
          params[`${role}PostalCode`] = contact.postalCode;
          params[`${role}Country`] = contact.country;
          params[`${role}Phone`] = contact.phone;
          params[`${role}EmailAddress`] = contact.email;
        }
        try {
          const res = await call("namecheap.domains.create", params, req.timeoutMs, REGISTRATION_RETRY);
          if (res.status >= 300) {
            const mapped = registrationStatusForHttp(res.status);
            return registration(meta, mapped.status, { errorCode: mapped.code, reason: `HTTP ${res.status}` }, res.finishedAt);
          }
          const status = apiStatus(res.text);
          if (status === "ERROR") {
            const errors = apiErrors(res.text);
            return registration(meta, "failed", {
              errorCode: namecheapErrorCode(errors),
              reason: errors.map((e) => e.message).join("; ") || "rejected",
            }, res.finishedAt);
          }
          const created = elements(res.text, "DomainCreateResult")[0];
          if (status !== "OK" || !created) {
            return registration(meta, "unknown", { errorCode: "REGISTRATION_UNKNOWN", reason: "unreadable response" }, res.finishedAt);
          }
          const charged = parseDecimal(created.attrs.ChargedAmount);
          const reference = created.attrs.OrderID ? `order:${created.attrs.OrderID}` : created.attrs.TransactionID;
          if (!flag(created.attrs.Registered)) {
            return registration(meta, "unknown", { errorCode: "REGISTRATION_UNKNOWN", reason: "Registered=false in an OK response", providerReference: reference }, res.finishedAt);
          }
          return registration(meta, flag(created.attrs.NonRealTimeDomain) ? "pending" : "success", {
            price: charged !== undefined ? { amount: charged, currency: "USD" } : undefined,
            providerReference: reference,
          }, res.finishedAt);
        } catch (err) {
          return registrationFromError(meta, err);
        }
      },

      async lookupOwnership(domain, timeoutMs) {
        try {
          const res = await call("namecheap.domains.getList", { SearchTerm: domain, PageSize: "20" }, timeoutMs, READ_RETRY);
          if (apiStatus(res.text) !== "OK") return "unknown";
          return elements(res.text, "Domain").some((d) => d.attrs.Name?.toLowerCase() === domain) ? "owned" : "not-owned";
        } catch {
          return "unknown";
        }
      },

      async healthCheck(timeoutMs) {
        try {
          const res = await call("namecheap.users.getBalances", {}, timeoutMs, READ_RETRY);
          const status = apiStatus(res.text);
          if (status === "OK") {
            const balance = elements(res.text, "UserGetBalancesResult")[0]?.attrs;
            return {
              ok: true,
              latencyMs: res.latencyMs,
              detail: balance?.AvailableBalance ? `balance ${balance.AvailableBalance} ${balance.Currency ?? ""}`.trim() : "credentials valid",
            };
          }
          return { ok: false, latencyMs: res.latencyMs, detail: apiErrors(res.text).map((e) => e.message).join("; ") || `HTTP ${res.status}` };
        } catch (err) {
          return { ok: false, detail: (err as Error).message };
        }
      },
    };
  },
});
