import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfigText, resolveConfig, type ResolvedConfig, type ResolvedTarget } from "../../src/config/loader.ts";
import type { AvailabilitySource } from "../../src/core/availability/AvailabilityService.ts";
import { systemClock } from "../../src/core/clock.ts";
import { MemorySink, type EventSink } from "../../src/core/events.ts";
import { DropOrchestrator } from "../../src/core/orchestration/DropOrchestrator.ts";
import type { ConfirmFn, RegistrationCandidate } from "../../src/core/registration/RegistrationService.ts";
import { silentLogger } from "../../src/logging/logger.ts";
import { Store } from "../../src/persistence/Store.ts";
import { builtinRegistry } from "../../src/providers/ProviderRegistry.ts";
import { RateLimiter } from "../../src/providers/RateLimiter.ts";
import type { AnyProviderPlugin, ProviderContext, ProviderInstance } from "../../src/providers/types.ts";
import { TransportError, type HttpRequest, type HttpResponse, type HttpTransport } from "../../src/transport/HttpTransport.ts";

export function response(status: number, body: unknown = "", headers: Record<string, string> = {}): HttpResponse {
  const now = Date.now();
  return {
    status,
    headers,
    text: typeof body === "string" ? body : JSON.stringify(body),
    startedAt: now - 5,
    finishedAt: now,
    latencyMs: 5,
    attempts: 1,
    requestId: "test",
  };
}

type Responder = (req: HttpRequest) => HttpResponse | Promise<HttpResponse>;

/** Records every request and answers with the given function. */
export class FakeTransport implements HttpTransport {
  readonly requests: HttpRequest[] = [];
  private readonly responder: Responder;

  constructor(responder: Responder) {
    this.responder = responder;
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    this.requests.push(req);
    return this.responder(req);
  }
}

export const timeoutAfterSend = (): never => {
  throw new TransportError("NETWORK_TIMEOUT", "maybe", "request timed out after connecting", 100);
};

export const connectionRefused = (): never => {
  throw new TransportError("NETWORK_ERROR", "no", "connection failed (ECONNREFUSED)", 1);
};

export function providerCtx<T>(
  plugin: AnyProviderPlugin,
  opts: { transport: HttpTransport; options?: unknown; credentials?: Record<string, string>; environment?: ProviderContext["environment"]; accountId?: string },
): ProviderContext<T> {
  const parsed = plugin.optionsSchema ? plugin.optionsSchema.parse(opts.options ?? {}) : (opts.options ?? {});
  return {
    accountId: opts.accountId ?? plugin.id,
    environment: opts.environment ?? "production",
    credentials: opts.credentials ?? {},
    options: parsed as T,
    http: (req) => opts.transport.request(req),
    logger: silentLogger,
    now: Date.now,
  };
}

export function tempDir(prefix = "dropcatch-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export interface Harness {
  config: ResolvedConfig;
  store: Store;
  sink: MemorySink;
  instances: Map<string, ProviderInstance>;
  target(id: string): ResolvedTarget;
  orchestrator(id: string, opts?: { dryRun?: boolean; confirm?: ConfirmFn; events?: EventSink }): DropOrchestrator;
  candidates(id: string): RegistrationCandidate[];
}

/** Build a real orchestrator stack (mock providers, temp SQLite) from YAML. */
export function harness(yaml: string, opts: { dbPath?: string } = {}): Harness {
  const registry = builtinRegistry();
  const config = resolveConfig(parseConfigText(yaml), { registry, baseDir: tempDir(), env: {} });
  const store = new Store(opts.dbPath ?? join(tempDir(), "test.sqlite"));
  const sink = new MemorySink();
  const noNetwork = new FakeTransport(() => {
    throw new Error("network not allowed in tests");
  });
  const instances = new Map<string, ProviderInstance>();
  const limiters = new Map<string, { a: RateLimiter; r: RateLimiter }>();
  for (const acct of Object.values(config.accounts)) {
    instances.set(acct.id, acct.plugin.create(providerCtx(acct.plugin, { transport: noNetwork, options: acct.options, accountId: acct.id, environment: acct.environment })));
    limiters.set(acct.id, { a: new RateLimiter(acct.limits.availability), r: new RateLimiter(acct.limits.registration) });
  }
  const target = (id: string): ResolvedTarget => {
    const t = config.targets.find((x) => x.id === id);
    if (!t) throw new Error(`no target ${id}`);
    return t;
  };
  const sources = (t: ResolvedTarget): AvailabilitySource[] =>
    t.availability.sources.map((s) => ({ id: s, plugin: config.accounts[s]!.plugin, instance: instances.get(s)!, limiter: limiters.get(s)!.a }));
  const candidates = (id: string): RegistrationCandidate[] =>
    target(id).registration.providers.map((p) => ({
      id: p,
      plugin: config.accounts[p]!.plugin,
      instance: instances.get(p)!,
      availabilityLimiter: limiters.get(p)!.a,
      registrationLimiter: limiters.get(p)!.r,
      credentialsValid: true,
    }));
  return {
    config,
    store,
    sink,
    instances,
    target,
    candidates,
    orchestrator(id, o = {}) {
      const t = target(id);
      return new DropOrchestrator({
        target: t,
        sources: sources(t),
        candidates: t.registration.active ? candidates(id) : [],
        store,
        events: o.events ?? sink,
        logger: silentLogger,
        clock: systemClock,
        dryRun: o.dryRun ?? config.app.dryRun,
        timeZone: "UTC",
        confirm: o.confirm,
        registrationTimings: { verifyAttempts: 2, verifyIntervalMs: 5, pendingPollMs: 60, pendingIntervalMs: 5 },
      });
    },
  };
}

/** Minimal valid config for mock-based scenarios. Profile testing allows mocks and live mode. */
export function mockConfig(opts: {
  accounts: Record<string, Record<string, unknown>>;
  target: Record<string, unknown>;
  dryRun?: boolean;
}): string {
  const accounts = Object.entries(opts.accounts)
    .map(([id, options]) => `  ${id}:\n    provider: mock\n    options: ${JSON.stringify(options)}`)
    .join("\n");
  return [
    "profile: testing",
    "app:",
    `  dryRun: ${opts.dryRun ?? false}`,
    "rdap:",
    "  enabled: false",
    "notifications:",
    "  discord:",
    "    enabled: false",
    "accounts:",
    accounts,
    "targets:",
    `  - ${JSON.stringify({ id: "t1", domain: "catch-me.com", monitoring: { fixedIntervalMs: 100, requestTimeoutMs: 500 }, ...opts.target })}`,
  ].join("\n");
}
