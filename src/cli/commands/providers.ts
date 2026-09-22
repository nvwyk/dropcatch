import { withTimeout } from "../../core/clock.ts";
import type { HealthResult } from "../../core/types.ts";
import type { AnyProviderPlugin, ProviderCapabilities } from "../../providers/types.ts";
import { bad, bold, dim, good, kv, out, printJson, table, warn, yesNo } from "../output.ts";
import type { Runtime } from "../runtime.ts";

const CAPABILITY_LABELS: Array<[keyof ProviderCapabilities, string]> = [
  ["availability", "Availability check"],
  ["pricing", "Pricing"],
  ["registration", "Registration"],
  ["preflight", "Server-side dry run"],
  ["ownershipLookup", "Ownership lookup"],
  ["registrationStatus", "Async status"],
  ["sandbox", "Sandbox"],
  ["premiumRegistration", "Premium via API"],
];

export interface AccountReport {
  id: string;
  provider: string;
  environment: string;
  enabled: boolean;
  credentials: Array<{ field: string; env: string; set: boolean; required: boolean }>;
  usable: boolean;
  error?: string;
  health?: HealthResult;
  proxy: string;
  limits: unknown;
}

export function pluginMatrix(plugins: AnyProviderPlugin[]): Array<Record<string, unknown>> {
  return plugins.map((p) => ({
    id: p.id,
    name: p.displayName,
    sourceKind: p.sourceKind,
    description: p.description,
    capabilities: p.capabilities,
    credentials: p.credentials.map((c) => ({ name: c.name, defaultEnv: c.defaultEnv, required: c.required, secret: c.secret, description: c.description })),
    defaultLimits: p.defaultLimits,
    docs: p.docs ?? [],
  }));
}

export async function accountReports(rt: Runtime, opts: { health: boolean; only?: string[] }): Promise<AccountReport[]> {
  const ids = opts.only ?? Object.keys(rt.config.accounts);
  return Promise.all(
    ids.map(async (id) => {
      const handle = rt.account(id);
      const cfg = handle.config;
      let health: HealthResult | undefined;
      if (opts.health && handle.instance?.healthCheck) {
        health = await withTimeout(handle.instance.healthCheck(8000), 10_000).catch((err: Error) => ({ ok: false, detail: err.message }));
      }
      return {
        id,
        provider: cfg.plugin.id,
        environment: cfg.environment,
        enabled: cfg.enabled,
        credentials: cfg.plugin.credentials.map((c) => ({
          field: c.name,
          env: cfg.credentialEnv[c.name]!,
          set: Boolean(process.env[cfg.credentialEnv[c.name]!]),
          required: c.required,
        })),
        usable: Boolean(handle.instance),
        error: handle.error,
        health,
        proxy: cfg.proxy ?? "direct",
        limits: cfg.limits,
      };
    }),
  );
}

export async function providersCommand(rt: Runtime, opts: { json?: boolean; offline?: boolean }): Promise<number> {
  const plugins = rt.registry.list();
  const accounts = await accountReports(rt, { health: !opts.offline });
  if (opts.json) {
    printJson({ providers: pluginMatrix(plugins), accounts });
    return 0;
  }
  out(bold("Provider capabilities"));
  table(
    ["Capability", ...plugins.map((p) => p.id)],
    CAPABILITY_LABELS.map(([key, label]) => [label, ...plugins.map((p) => (p.capabilities[key] ? good("yes") : dim("no")))]),
  );
  out();
  out(bold("Configured accounts"));
  if (accounts.length === 0) out(dim("  none (add some under `accounts:` in your config)"));
  for (const a of accounts) {
    out();
    out(`${bold(a.id)} ${dim(`(${a.provider}, ${a.environment}${a.enabled ? "" : ", disabled"})`)}`);
    const missing = a.credentials.filter((c) => c.required && !c.set);
    kv("credentials", a.credentials.length === 0 ? dim("none needed") : missing.length ? bad(`MISSING ${missing.map((m) => m.env).join(", ")}`) : good("OK"));
    if (a.error && !missing.length) kv("error", bad(a.error));
    if (a.health) {
      kv("API connectivity", a.health.ok ? good(`OK${a.health.latencyMs !== undefined ? ` ${a.health.latencyMs} ms` : ""}`) : bad("FAIL"));
      if (a.health.detail) kv("detail", a.health.detail);
    } else if (opts.offline) {
      kv("API connectivity", dim("not checked (--offline)"));
    }
    const plugin = rt.registry.require(a.provider);
    kv("availability", yesNo(plugin.capabilities.availability));
    kv("registration", plugin.capabilities.registration ? good("supported") : dim("no"));
    kv("proxy", a.proxy);
  }
  if (accounts.some((a) => a.health && !a.health.ok)) {
    out();
    out(warn("Some accounts failed their health check. Auto-buy will refuse to start with failing registration accounts."));
  }
  return 0;
}
