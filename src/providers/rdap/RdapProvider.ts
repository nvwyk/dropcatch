import { z } from "zod";
import { withTimeout } from "../../core/clock.ts";
import { normalizeDomain } from "../../domain/normalize.ts";
import { strategyFor } from "../../tld/strategies.ts";
import { parseJson } from "../../transport/HttpTransport.ts";
import { AVAILABILITY_RETRY, READ_RETRY } from "../../transport/RetryPolicy.ts";
import { retryAfterMs } from "../../transport/HttpTransport.ts";
import {
  availability,
  availabilityFromError,
  availabilityFromHttpStatus,
  clockSkew,
  startCall,
} from "../helpers.ts";
import { definePlugin, type BoundHttp } from "../types.ts";

export const IANA_BOOTSTRAP_URL = "https://data.iana.org/rdap/dns.json";

const optionsSchema = z
  .object({
    /** Per-TLD RDAP base URLs, overriding bootstrap and built-in strategies. */
    servers: z.record(z.string(), z.url()).default({}),
    bootstrap: z.boolean().default(true),
    bootstrapUrl: z.url().default(IANA_BOOTSTRAP_URL),
  })
  .strict();

export type RdapOptions = z.infer<typeof optionsSchema>;

interface BootstrapFile {
  services?: Array<[string[], string[]]>;
}

const withSlash = (url: string): string => (url.endsWith("/") ? url : `${url}/`);

/** Parse the IANA bootstrap file into tld -> base URL (https preferred). */
export function parseBootstrap(file: BootstrapFile): Map<string, string> {
  const map = new Map<string, string>();
  for (const service of file.services ?? []) {
    const [tlds, urls] = service;
    if (!Array.isArray(tlds) || !Array.isArray(urls) || urls.length === 0) continue;
    const url = urls.find((u) => u.startsWith("https://")) ?? urls[0]!;
    for (const tld of tlds) map.set(tld.toLowerCase(), withSlash(url));
  }
  return map;
}

class BootstrapCache {
  private map?: Map<string, string>;
  private loading?: Promise<Map<string, string>>;
  private readonly http: BoundHttp;
  private readonly url: string;

  constructor(http: BoundHttp, url: string) {
    this.http = http;
    this.url = url;
  }

  async get(): Promise<Map<string, string>> {
    if (this.map) return this.map;
    this.loading ??= (async () => {
      const res = await this.http({ method: "GET", url: this.url, timeoutMs: 10_000, retry: READ_RETRY, label: "rdap.bootstrap" });
      const file = parseJson<BootstrapFile>(res);
      if (res.status !== 200 || !file) throw new Error(`RDAP bootstrap fetch failed (HTTP ${res.status})`);
      this.map = parseBootstrap(file);
      return this.map;
    })().catch((err: unknown) => {
      this.loading = undefined;
      throw err;
    });
    return this.loading;
  }
}

interface RdapDomainObject {
  objectClassName?: string;
  ldhName?: string;
  status?: string[];
}

export const rdapPlugin = definePlugin<RdapOptions>({
  id: "rdap",
  displayName: "RDAP (registry)",
  description: "Registry data via RDAP. A 404 means no registry object, which is a hint, not proof of registrability.",
  sourceKind: "registry",
  capabilities: {
    availability: true,
    registration: false,
    pricing: false,
    preflight: false,
    ownershipLookup: false,
    registrationStatus: false,
    sandbox: false,
    premiumRegistration: false,
  },
  credentials: [],
  defaultLimits: {
    // NASK RDAP answered 429 (no Retry-After) after minutes of 1 req/s polling; stay well below that.
    availability: { minIntervalMs: 2000, maxConcurrentRequests: 1, requestsPerMinute: 20 },
    registration: {},
  },
  optionsSchema,
  docs: ["https://data.iana.org/rdap/dns.json", "https://www.dns.pl/en/RDAP_in_NASK"],
  create(ctx) {
    const bootstrap = new BootstrapCache(ctx.http, ctx.options.bootstrapUrl);

    async function baseUrlFor(domainAscii: string): Promise<{ base?: string; delayMs: number }> {
      const d = normalizeDomain(domainAscii);
      const strategy = strategyFor(d);
      const delayMs = strategy.semantics.registryDataDelayMs;
      const override = ctx.options.servers[d.tld];
      if (override) return { base: withSlash(override), delayMs };
      if (strategy.rdapBaseUrl) return { base: strategy.rdapBaseUrl, delayMs };
      if (!ctx.options.bootstrap) return { delayMs };
      return { base: (await bootstrap.get()).get(d.tld), delayMs };
    }

    return {
      async prepare(domain) {
        await baseUrlFor(domain);
      },

      async check(req) {
        const meta = startCall(ctx.accountId, "rdap", req.domain, ctx.now());
        try {
          const { base, delayMs } = await baseUrlFor(req.domain);
          if (!base) {
            return availability(meta, "registry", "unsupported", {
              errorCode: "DOMAIN_UNSUPPORTED",
              reason: "no RDAP server known for this TLD",
            });
          }
          const res = await ctx.http({
            method: "GET",
            url: `${base}domain/${req.domain}`,
            headers: { accept: "application/rdap+json, application/json" },
            timeoutMs: req.timeoutMs,
            signal: req.signal,
            retry: AVAILABILITY_RETRY,
            label: "rdap.check",
          });
          const skew = clockSkew(res);
          if (res.status === 404) {
            return availability(meta, "registry", "available", {
              advisory: delayMs > 0,
              reason: delayMs > 0
                ? `no registry object (RDAP 404; registry data may lag up to ${Math.round(delayMs / 60_000)} min)`
                : "no registry object (RDAP 404)",
              clockSkewMs: skew,
            }, res.finishedAt);
          }
          if (res.status === 200) {
            const obj = parseJson<RdapDomainObject>(res);
            if (!obj || (obj.ldhName && obj.ldhName.toLowerCase().replace(/\.$/, "") !== req.domain)) {
              return availability(meta, "registry", "error", {
                errorCode: "INVALID_RESPONSE",
                reason: "unexpected RDAP payload",
                clockSkewMs: skew,
              }, res.finishedAt);
            }
            const statuses = obj.status ?? [];
            return availability(meta, "registry", "unavailable", {
              reason: statuses.length ? `registered (${statuses.join(", ")})` : "registered",
              clockSkewMs: skew,
            }, res.finishedAt);
          }
          if (res.status === 400) {
            return availability(meta, "registry", "error", { errorCode: "INVALID_DOMAIN", reason: "RDAP rejected the query (HTTP 400)" }, res.finishedAt);
          }
          if (res.status >= 300 && res.status < 400) {
            return availability(meta, "registry", "unknown", { reason: `RDAP redirect (HTTP ${res.status})` }, res.finishedAt);
          }
          return availabilityFromHttpStatus(meta, "registry", res, retryAfterMs(res))
            ?? availability(meta, "registry", "unknown", { reason: `HTTP ${res.status}` }, res.finishedAt);
        } catch (err) {
          return availabilityFromError(meta, "registry", err);
        }
      },

      async healthCheck(timeoutMs) {
        const started = ctx.now();
        if (!ctx.options.bootstrap) return { ok: true, detail: "bootstrap disabled, using configured servers" };
        try {
          const map = await withTimeout(bootstrap.get(), timeoutMs, "bootstrap fetch timed out");
          return { ok: true, latencyMs: ctx.now() - started, detail: `${map.size} TLDs in IANA bootstrap` };
        } catch (err) {
          return { ok: false, latencyMs: ctx.now() - started, detail: err instanceof Error ? err.message : String(err) };
        }
      },
    };
  },
});
