import { createHash } from "node:crypto";
import { z } from "zod";
import type { ErrorCode } from "../../core/errors.ts";
import type { Money, RegistrationRequest, RegistrationResult } from "../../core/types.ts";
import { parseJson, retryAfterMs, TransportError, type HttpResponse } from "../../transport/HttpTransport.ts";
import { AVAILABILITY_RETRY, NO_RETRY, READ_RETRY, REGISTRATION_RETRY, type RetryPolicy } from "../../transport/RetryPolicy.ts";
import {
  availability,
  availabilityFromError,
  availabilityFromHttpStatus,
  clockSkew,
  registration,
  registrationFromError,
  registrationStatusForHttp,
  startCall,
  type CallMeta,
} from "../helpers.ts";
import { definePlugin } from "../types.ts";

export const OVH_ENDPOINTS = {
  "ovh-eu": "https://eu.api.ovh.com/1.0",
  "ovh-ca": "https://ca.api.ovh.com/1.0",
  "ovh-us": "https://api.us.ovhcloud.com/1.0",
} as const;

const configValue = z.union([z.string(), z.boolean(), z.number()]);

const optionsSchema = z
  .object({
    endpoint: z.enum(["ovh-eu", "ovh-ca", "ovh-us"]).default("ovh-eu"),
    baseUrl: z.url().optional(),
    /** Subsidiary that sells to you. PL prices .pl in PLN. */
    ovhSubsidiary: z.string().regex(/^[A-Z]{2}$/, "two-letter subsidiary such as PL").default("PL"),
    /** Owner contact id from /me/contact (e.g. 12345 or "/me/contact/12345"). Required to register. */
    ownerContact: z.union([z.string().min(1), z.number().int().positive()]).optional(),
    /** Admin/tech NIC handle. Defaults to the API account's own handle. */
    nicHandle: z.string().min(1).optional(),
    /** Answer ACCEPT_CONDITIONS automatically when a TLD asks for it. */
    acceptConditions: z.boolean().default(false),
    /** Pay the order with the account's default payment method. false = order is created unpaid. */
    autoPay: z.boolean().default(true),
    /** Values for TLD-specific required configurations, by label. */
    extraConfiguration: z.record(z.string(), configValue).default({}),
  })
  .strict();

export type OvhOptions = z.infer<typeof optionsSchema>;

/** OVH API signature: "$1$" + sha1(secret+consumer+METHOD+url+body+timestamp). */
export function ovhSignature(secret: string, consumer: string, method: string, url: string, body: string, timestamp: number): string {
  return `$1$${createHash("sha1").update([secret, consumer, method.toUpperCase(), url, body, String(timestamp)].join("+")).digest("hex")}`;
}

interface OvhPrice {
  label?: string;
  price?: { value?: number; currencyCode?: string; text?: string };
}

export interface OvhOffer {
  action?: string;
  offer?: string;
  orderable?: boolean;
  pricingMode?: string;
  duration?: string[];
  prices?: OvhPrice[];
}

interface OvhOrderPreview {
  orderId?: number;
  url?: string;
  prices?: { withoutTax?: { value?: number; currencyCode?: string }; withTax?: { value?: number; currencyCode?: string; text?: string } };
  details?: Array<{ domain?: string; description?: string }>;
}

/** Pick the "create" offer and its first-year price (TOTAL, else PRICE), excluding VAT. */
export function parseOffers(offers: OvhOffer[]): { offer?: OvhOffer; price?: Money; premium: boolean; transferOnly: boolean } {
  const create = offers.find((o) => o.action === "create");
  const transferOnly = !create && offers.some((o) => o.action === "transfer");
  if (!create) return { premium: false, transferOnly };
  const priced = create.prices?.find((p) => p.label === "TOTAL") ?? create.prices?.find((p) => p.label === "PRICE");
  const value = priced?.price?.value;
  const price = typeof value === "number" && Number.isFinite(value) ? { amount: value, currency: priced?.price?.currencyCode ?? "EUR" } : undefined;
  return { offer: create, price, premium: /premium/i.test(create.pricingMode ?? ""), transferOnly };
}

export function ovhErrorCode(status: number, message: string): ErrorCode {
  const m = message.toLowerCase();
  if (status === 401 || status === 403 || m.includes("invalid signature") || m.includes("invalid key") || m.includes("credential")) return "AUTHENTICATION_FAILED";
  if (status === 429) return "RATE_LIMITED";
  if (m.includes("not available") || m.includes("unavailable") || m.includes("already registered") || m.includes("not orderable")) return "DOMAIN_UNAVAILABLE";
  if (m.includes("premium")) return "DOMAIN_PREMIUM";
  if (m.includes("payment") || m.includes("insufficient")) return "INSUFFICIENT_FUNDS";
  return "REGISTRATION_REJECTED";
}

/** Map GET /me/order/{id}/status onto a registration status. */
export function ovhOrderStatus(status: string | undefined): RegistrationResult["status"] {
  switch (status) {
    case "delivered":
      return "success";
    case "cancelled":
    case "cancelling":
      return "failed";
    case "checking":
    case "delivering":
    case "documentsRequested":
    case "notPaid":
    case "unpaid":
      return "pending";
    default:
      return "unknown";
  }
}

export const ovhPlugin = definePlugin<OvhOptions>({
  id: "ovh",
  displayName: "OVHcloud",
  description: "OVHcloud API (cart based). Sells .pl and .com.pl via OVHcloud Poland. Server-side checkout preview for dry runs.",
  sourceKind: "registrar",
  capabilities: {
    availability: true,
    registration: true,
    pricing: true,
    preflight: true,
    ownershipLookup: true,
    registrationStatus: true,
    sandbox: false,
    premiumRegistration: false,
  },
  credentials: [
    { name: "applicationKey", defaultEnv: "OVH_APPLICATION_KEY", required: true, secret: true, description: "Application key" },
    { name: "applicationSecret", defaultEnv: "OVH_APPLICATION_SECRET", required: true, secret: true, description: "Application secret" },
    { name: "consumerKey", defaultEnv: "OVH_CONSUMER_KEY", required: true, secret: true, description: "Consumer key" },
  ],
  // OVH does not publish API rate limits; stay conservative.
  defaultLimits: {
    availability: { minIntervalMs: 1000, maxConcurrentRequests: 1, requestsPerMinute: 60 },
    registration: { minIntervalMs: 1000, maxConcurrentRequests: 1 },
  },
  optionsSchema,
  validateAccount(options, usage) {
    return usage.registration && options.ownerContact === undefined
      ? ["options.ownerContact is required to register (an id from GET /me/contact)"]
      : [];
  },
  docs: ["https://docs.ovhcloud.com/en/guides/web-cloud/domains/api-domain-order", "https://eu.api.ovh.com/createToken/"],
  create(ctx) {
    const base = ctx.options.baseUrl ?? OVH_ENDPOINTS[ctx.options.endpoint];
    const ak = ctx.credentials.applicationKey ?? "";
    const as = ctx.credentials.applicationSecret ?? "";
    const ck = ctx.credentials.consumerKey ?? "";
    let timeDelta: number | undefined;
    let nicHandle = ctx.options.nicHandle;
    let lookupCart: { id: string; expires: number } | undefined;
    let buyCart: { id: string; expires: number } | undefined;

    async function syncTime(): Promise<void> {
      const res = await ctx.http({ method: "GET", url: `${base}/auth/time`, timeoutMs: 5000, retry: READ_RETRY, label: "ovh.time" });
      const server = Number(res.text);
      if (!Number.isFinite(server)) throw new Error(`cannot read OVH server time (HTTP ${res.status})`);
      timeDelta = server - Math.floor(Date.now() / 1000);
    }

    async function call(
      method: "GET" | "POST" | "DELETE",
      path: string,
      opts: { body?: unknown; timeoutMs: number; retry: RetryPolicy; label: string; signal?: AbortSignal },
    ): Promise<HttpResponse> {
      if (timeDelta === undefined) await syncTime();
      const url = `${base}${path}`;
      const body = opts.body === undefined ? "" : JSON.stringify(opts.body);
      const ts = Math.floor(Date.now() / 1000) + (timeDelta ?? 0);
      const headers: Record<string, string> = {
        "x-ovh-application": ak,
        "x-ovh-consumer": ck,
        "x-ovh-timestamp": String(ts),
        "x-ovh-signature": ovhSignature(as, ck, method, url, body, ts),
      };
      if (body) headers["content-type"] = "application/json";
      return ctx.http({ method, url, headers, body: body || undefined, timeoutMs: opts.timeoutMs, retry: opts.retry, label: opts.label, signal: opts.signal });
    }

    const message = (res: HttpResponse): string => parseJson<{ message?: string }>(res)?.message ?? `HTTP ${res.status}`;

    async function newCart(): Promise<{ id: string; expires: number }> {
      const res = await call("POST", "/order/cart", { body: { ovhSubsidiary: ctx.options.ovhSubsidiary, description: "dropcatch" }, timeoutMs: 8000, retry: READ_RETRY, label: "ovh.cart" });
      const cart = parseJson<{ cartId?: string; expire?: string }>(res);
      if (res.status !== 200 || !cart?.cartId) throw new Error(`cannot create OVH cart: ${message(res)}`);
      const assign = await call("POST", `/order/cart/${cart.cartId}/assign`, { timeoutMs: 8000, retry: READ_RETRY, label: "ovh.assign" });
      if (assign.status >= 300) throw new Error(`cannot assign OVH cart: ${message(assign)}`);
      const expires = cart.expire ? Date.parse(cart.expire) : Date.now() + 86_400_000;
      return { id: cart.cartId, expires };
    }

    /** Carts expire; renew an hour before. The lookup cart never receives items. */
    async function cartFor(kind: "lookup" | "buy"): Promise<string> {
      const current = kind === "lookup" ? lookupCart : buyCart;
      if (current && current.expires - Date.now() > 3_600_000) return current.id;
      const cart = await newCart();
      if (kind === "lookup") lookupCart = cart;
      else buyCart = cart;
      return cart.id;
    }

    async function myNicHandle(): Promise<string | undefined> {
      if (nicHandle) return nicHandle;
      const res = await call("GET", "/me", { timeoutMs: 8000, retry: READ_RETRY, label: "ovh.me" });
      nicHandle = parseJson<{ nichandle?: string }>(res)?.nichandle;
      return nicHandle;
    }

    function configValueFor(label: string): string | boolean | number | undefined {
      const extra = ctx.options.extraConfiguration[label];
      if (extra !== undefined) return extra;
      switch (label) {
        case "OWNER_CONTACT": {
          const c = ctx.options.ownerContact;
          if (c === undefined) return undefined;
          return /^\d+$/.test(String(c)) ? `/me/contact/${c}` : String(c);
        }
        case "ADMIN_ACCOUNT":
        case "TECH_ACCOUNT":
          return nicHandle;
        case "OWNER_LEGAL_AGE":
          return true;
        case "ACCEPT_CONDITIONS":
          return ctx.options.acceptConditions ? true : undefined;
        default:
          return undefined;
      }
    }

    /**
     * Build the order in the dedicated buy cart. Nothing is purchased until the final POST
     * checkout, so every failure before it is a CONFIRMED failure (no order exists).
     */
    async function order(req: RegistrationRequest, finalize: boolean): Promise<RegistrationResult> {
      const meta = startCall(ctx.accountId, "ovh", req.domain, ctx.now());
      const extra = finalize ? {} : { simulated: true };
      const fail = (code: ErrorCode, reason: string, finishedMs?: number): RegistrationResult =>
        registration(meta, "failed", { ...extra, errorCode: code, reason }, finishedMs);
      let cartId: string;
      let itemId: number | undefined;
      const cleanup = async (): Promise<void> => {
        if (itemId === undefined) return;
        await call("DELETE", `/order/cart/${cartId}/item/${itemId}`, { timeoutMs: 5000, retry: READ_RETRY, label: "ovh.removeItem" }).catch(() => undefined);
      };
      try {
        cartId = await cartFor("buy");
        await myNicHandle();
        const add = await call("POST", `/order/cart/${cartId}/domain`, { body: { domain: req.domain, duration: `P${req.years}Y` }, timeoutMs: 8000, retry: NO_RETRY, label: "ovh.addDomain" });
        const item = parseJson<{ itemId?: number }>(add);
        if (add.status >= 300 || item?.itemId === undefined) return fail(ovhErrorCode(add.status, message(add)), message(add), add.finishedAt);
        itemId = item.itemId;

        const reqCfg = await call("GET", `/order/cart/${cartId}/item/${itemId}/requiredConfiguration`, { timeoutMs: 8000, retry: READ_RETRY, label: "ovh.requiredConfiguration" });
        const required = (parseJson<Array<{ label?: string; required?: boolean }>>(reqCfg) ?? []).filter((c) => c.required && c.label);
        const missing: string[] = [];
        const values: Array<{ label: string; value: string | boolean | number }> = [];
        for (const c of required) {
          const value = configValueFor(c.label!);
          if (value === undefined) missing.push(c.label!);
          else values.push({ label: c.label!, value });
        }
        if (missing.length) {
          await cleanup();
          return fail("CONFIGURATION_ERROR", `OVH requires ${missing.join(", ")}: set accounts.<id>.options (ownerContact, acceptConditions or extraConfiguration)`);
        }
        const configured = await Promise.all(values.map((v) =>
          call("POST", `/order/cart/${cartId}/item/${itemId}/configuration`, { body: { label: v.label, value: String(v.value) }, timeoutMs: 8000, retry: NO_RETRY, label: "ovh.configure" })));
        const badCfg = configured.find((r) => r.status >= 300);
        if (badCfg) {
          await cleanup();
          return fail("CONFIGURATION_ERROR", `configuration rejected: ${message(badCfg)}`, badCfg.finishedAt);
        }

        // Server-side validation of the whole order without creating it.
        const preview = await call("GET", `/order/cart/${cartId}/checkout`, { timeoutMs: 10_000, retry: READ_RETRY, label: "ovh.checkoutPreview" });
        const p = parseJson<OvhOrderPreview>(preview);
        if (preview.status >= 300 || !p) {
          await cleanup();
          return fail(ovhErrorCode(preview.status, message(preview)), `checkout validation failed: ${message(preview)}`, preview.finishedAt);
        }
        const foreign = (p.details ?? []).filter((d) => d.domain && d.domain.toLowerCase() !== req.domain);
        if (foreign.length) {
          await cleanup();
          return fail("REGISTRATION_REJECTED", `the OVH cart contains other items (${foreign.map((d) => d.domain).join(", ")}); refusing to check out`);
        }
        const net = p.prices?.withoutTax;
        if (typeof net?.value !== "number" || (net.currencyCode && net.currencyCode !== req.price.currency) || net.value > req.price.amount + 0.01) {
          await cleanup();
          return fail("PRICE_CHANGED", `order total ${net?.value ?? "?"} ${net?.currencyCode ?? ""} does not match the verified price ${req.price.amount} ${req.price.currency}`, preview.finishedAt);
        }
        const gross = p.prices?.withTax?.text ?? `${p.prices?.withTax?.value ?? "?"} ${p.prices?.withTax?.currencyCode ?? ""}`;
        const price: Money = { amount: net.value, currency: net.currencyCode ?? req.price.currency };
        if (!finalize) {
          await cleanup();
          return registration(meta, "success", { simulated: true, price, reason: `OVH checkout preview passed: ${price.amount.toFixed(2)} ${price.currency} net, ${gross} with VAT. No order was created.` }, preview.finishedAt);
        }

        // The purchase. From here on, anything unclear is "unknown".
        let placed: HttpResponse;
        try {
          placed = await call("POST", `/order/cart/${cartId}/checkout`, {
            body: { autoPayWithPreferredPaymentMethod: ctx.options.autoPay, waiveRetractationPeriod: true },
            timeoutMs: req.timeoutMs,
            retry: REGISTRATION_RETRY,
            label: "ovh.checkout",
          });
        } catch (err) {
          buyCart = undefined;
          return registrationFromError(meta, err);
        }
        buyCart = undefined; // a checked-out cart is read-only
        const orderInfo = parseJson<OvhOrderPreview>(placed);
        if (placed.status >= 200 && placed.status < 300 && orderInfo?.orderId !== undefined) {
          return registration(meta, "pending", {
            price,
            providerReference: `order:${orderInfo.orderId}`,
            reason: ctx.options.autoPay ? `order ${orderInfo.orderId} placed (${gross} with VAT), waiting for delivery` : `order ${orderInfo.orderId} created UNPAID (autoPay is off): pay it at ${orderInfo.url ?? "the OVH console"}`,
          }, placed.finishedAt);
        }
        if (placed.status >= 200 && placed.status < 300) {
          return registration(meta, "unknown", { errorCode: "REGISTRATION_UNKNOWN", reason: "checkout answered without an order id" }, placed.finishedAt);
        }
        const mapped = registrationStatusForHttp(placed.status);
        return registration(meta, mapped.status, {
          errorCode: mapped.status === "failed" ? ovhErrorCode(placed.status, message(placed)) : mapped.code,
          reason: message(placed),
        }, placed.finishedAt);
      } catch (err) {
        // Only reachable before the final checkout: no order can exist, so this is a confirmed failure.
        await cleanup();
        const reason = err instanceof Error ? err.message : String(err);
        return fail(err instanceof TransportError ? err.code : "PROVIDER_ERROR", reason);
      }
    }

    return {
      async prepare() {
        await syncTime();
        await cartFor("lookup");
        await cartFor("buy").catch(() => undefined);
        await myNicHandle().catch(() => undefined);
      },

      async warmup() {
        // Unauthenticated, cheap, and keeps both the connection and the time delta fresh.
        await syncTime();
      },

      async check(req) {
        const meta = startCall(ctx.accountId, "ovh", req.domain, ctx.now());
        try {
          const cartId = await cartFor("lookup");
          const res = await call("GET", `/order/cart/${cartId}/domain?domain=${encodeURIComponent(req.domain)}`, {
            timeoutMs: req.timeoutMs,
            retry: AVAILABILITY_RETRY,
            label: "ovh.check",
            signal: req.signal,
          });
          const skew = clockSkew(res);
          if (res.status === 404) lookupCart = undefined;
          const httpIssue = availabilityFromHttpStatus(meta, "registrar", res, retryAfterMs(res));
          if (httpIssue) return { ...httpIssue, reason: message(res), errorCode: res.status === 400 ? "DOMAIN_UNSUPPORTED" : httpIssue.errorCode, status: res.status === 400 ? "unsupported" : httpIssue.status };
          const offers = parseJson<OvhOffer[]>(res);
          if (!Array.isArray(offers)) {
            return availability(meta, "registrar", "error", { errorCode: "INVALID_RESPONSE", reason: "unreadable offers" }, res.finishedAt);
          }
          const { offer, price, premium, transferOnly } = parseOffers(offers);
          if (!offer) {
            return availability(meta, "registrar", "unavailable", { reason: transferOnly ? "registered (transfer offer only)" : "no create offer", clockSkewMs: skew }, res.finishedAt);
          }
          const orderable = offer.orderable === true;
          return availability(meta, "registrar", orderable ? "available" : "unavailable", {
            price,
            premium,
            registrable: orderable && !premium,
            reason: premium ? `premium pricing (${offer.pricingMode})` : orderable ? "price excludes VAT" : "not orderable",
            clockSkewMs: skew,
          }, res.finishedAt);
        } catch (err) {
          return availabilityFromError(meta, "registrar", err);
        }
      },

      register(req) {
        return order(req, true);
      },

      preflight(req) {
        return order(req, false);
      },

      async getRegistrationStatus(domain, reference, timeoutMs) {
        const meta: CallMeta = startCall(ctx.accountId, "ovh", domain, ctx.now());
        const orderId = reference?.replace(/^order:/, "");
        if (!orderId) return registration(meta, "unknown", { errorCode: "REGISTRATION_UNKNOWN", reason: "no order reference" });
        try {
          const res = await call("GET", `/me/order/${orderId}/status`, { timeoutMs, retry: READ_RETRY, label: "ovh.orderStatus" });
          // OVH answers a JSON string ("delivered"); accept a bare word too.
          const parsed = parseJson<unknown>(res);
          const status = typeof parsed === "string" ? parsed : res.text.trim().replace(/^"|"$/g, "") || undefined;
          const mapped = res.status === 200 ? ovhOrderStatus(status) : "unknown";
          return registration(meta, mapped, {
            providerReference: reference,
            errorCode: mapped === "failed" ? "REGISTRATION_REJECTED" : undefined,
            reason: `order status ${String(status)}`,
          }, res.finishedAt);
        } catch (err) {
          return registrationFromError(meta, err);
        }
      },

      async lookupOwnership(domain, timeoutMs) {
        try {
          const res = await call("GET", `/domain/${encodeURIComponent(domain)}`, { timeoutMs, retry: READ_RETRY, label: "ovh.domain" });
          if (res.status === 200) return "owned";
          if (res.status === 404) return "not-owned";
          return "unknown";
        } catch {
          return "unknown";
        }
      },

      async healthCheck(timeoutMs) {
        try {
          const res = await call("GET", "/me", { timeoutMs, retry: READ_RETRY, label: "ovh.health" });
          const me = parseJson<{ nichandle?: string; currency?: { code?: string } }>(res);
          const ok = res.status === 200 && Boolean(me?.nichandle);
          return {
            ok,
            latencyMs: res.latencyMs,
            detail: ok ? `authenticated as ${me!.nichandle}, clock delta ${timeDelta ?? 0} s, subsidiary ${ctx.options.ovhSubsidiary}` : message(res),
          };
        } catch (err) {
          return { ok: false, detail: (err as Error).message };
        }
      },
    };
  },
});
