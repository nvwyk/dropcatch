import { readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { upsertEnvFile, envFileKeys } from "../config/envFile.ts";
import type { ResolvedTarget } from "../config/loader.ts";
import { RDAP_ACCOUNT } from "../config/loader.ts";
import { renderConfig, type RegistrarChoice } from "../config/template.ts";
import { AppError, ConfigError } from "../core/errors.ts";
import { withTimeout } from "../core/clock.ts";
import { isValidTimeZone, parseInstant } from "../core/time.ts";
import { intervalFor, phaseAt } from "../core/watcher/schedule.ts";
import { normalizeDomain } from "../domain/normalize.ts";
import { runCheck } from "../cli/commands/check.ts";
import { accountReports, pluginMatrix } from "../cli/commands/providers.ts";
import { resolveTarget, type ResolveAs } from "../cli/commands/resolve.ts";
import { VERSION } from "../version.ts";
import {
  hashPassword,
  LoginThrottle,
  newToken,
  passwordProblem,
  safeEqual,
  tokenHash,
  verifyPassword,
} from "./auth.ts";
import type { DashboardApp } from "./DashboardApp.ts";

const PUBLIC_DIR = fileURLToPath(new URL("../../dashboard/public/", import.meta.url));
const COOKIE = "dropcatch_session";
const MAX_BODY = 1024 * 1024;
/** Returned by handlers that keep the response open (server-sent events). */
const STREAMING = Symbol("streaming");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "x-robots-tag": "noindex, nofollow, noarchive",
};

class HttpError extends Error {
  readonly status: number;
  readonly extra: Record<string, unknown>;

  constructor(status: number, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

interface Ctx {
  app: DashboardApp;
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  body: Record<string, unknown>;
  ip: string;
  secure: boolean;
  sessionHash?: string;
}

type Handler = (ctx: Ctx) => Promise<unknown> | unknown;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  auth: boolean;
  handler: Handler;
}

const routes: Route[] = [];

function route(method: string, path: string, auth: boolean, handler: Handler): void {
  const keys: string[] = [];
  const pattern = new RegExp(`^${path.replace(/:(\w+)/g, (_, key: string) => {
    keys.push(key);
    return "([^/]+)";
  })}$`);
  routes.push({ method, pattern, keys, auth, handler });
}

function loadStatic(): Map<string, { type: string; body: Buffer }> {
  const files = new Map<string, { type: string; body: Buffer }>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else {
        const type = CONTENT_TYPES[extname(name)];
        if (type) files.set(`/${relative(PUBLIC_DIR, full).split(sep).join("/")}`, { type, body: readFileSync(full) });
      }
    }
  };
  walk(PUBLIC_DIR);
  return files;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "Request body too large");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "Body must be a JSON object");
  }
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { ...SECURITY_HEADERS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(payload);
}

function sessionCookie(token: string, maxAgeSeconds: number, secure: boolean): string {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

// ---- views -------------------------------------------------------------------------

function targetView(app: DashboardApp, t: ResolvedTarget, now: number): Record<string, unknown> {
  const state = app.store.getState(t.id);
  const phase = phaseAt(now, t.schedule);
  return {
    id: t.id,
    domain: t.domain.ascii,
    unicode: t.domain.unicode,
    enabled: t.enabled,
    tld: t.tld.id,
    tldNotes: t.tld.semantics.notes,
    mode: t.registration.mode,
    registrationActive: t.registration.active,
    drop: t.drop
      ? {
        expectedAt: t.drop.expectedAtMs,
        timeZone: t.drop.timeZone,
        preWindowMs: t.drop.preWindowMs,
        postWindowMs: t.drop.postWindowMs,
        hotWindowMs: t.schedule.hotWindowMs,
      }
      : null,
    schedule: t.schedule,
    phase,
    intervalMs: intervalFor(phase, t.schedule),
    state: state?.state ?? "IDLE",
    stateDetail: state?.detail ?? null,
    stateUpdatedAt: state?.updatedAt ?? null,
    watching: app.watches.info(t.id) ?? null,
    lastOutcome: app.watches.outcomes.get(t.id) ?? null,
    sources: t.availability.sources,
    quorum: t.availability.quorum,
    registrars: t.registration.providers,
    budget: t.registration.budget,
    attempts: app.store.countAttempts(t.id),
    maxTotalAttempts: t.registration.maxTotalAttempts,
    checks: app.store.latestChecks(t.domain.ascii),
    lastRun: app.store.runs(t.id, 1)[0] ?? null,
    discord: t.notifications.discord.enabled && Boolean(process.env[t.notifications.discord.webhookEnv]),
  };
}

const SECRET_PREFIX = /^(PORKBUN|NAMECHEAP|CLOUDFLARE|DISCORD|DROPCATCH|PROXY)_[A-Z0-9_]+$/;

function secretCatalog(app: DashboardApp): Array<{ name: string; set: boolean; inFile: boolean; secret: boolean; usedBy: string[] }> {
  const rt = app.rt;
  const entries = new Map<string, { secret: boolean; usedBy: string[] }>();
  const add = (name: string, usedBy: string, secret: boolean): void => {
    const e = entries.get(name) ?? { secret: false, usedBy: [] };
    e.secret ||= secret;
    e.usedBy.push(usedBy);
    entries.set(name, e);
  };
  for (const acct of Object.values(rt.config.accounts)) {
    for (const field of acct.plugin.credentials) add(acct.credentialEnv[field.name]!, `${acct.id}: ${field.description}`, field.secret);
  }
  add(rt.config.notifications.discord.webhookEnv, "Discord webhook", true);
  for (const t of rt.config.targets) {
    if (t.notifications.discord.webhookEnv !== rt.config.notifications.discord.webhookEnv) add(t.notifications.discord.webhookEnv, `${t.id}: Discord webhook`, true);
  }
  const raw = app.configFile.raw() as { proxies?: { pools?: Record<string, { proxies?: unknown[] }> } };
  for (const [pool, cfg] of Object.entries(raw.proxies?.pools ?? {})) {
    for (const entry of cfg.proxies ?? []) {
      const urlEnv = (entry as { urlEnv?: unknown }).urlEnv;
      if (typeof urlEnv === "string") add(urlEnv, `proxy pool ${pool}`, true);
    }
  }
  const inFile = envFileKeys(app.envPath);
  return [...entries.entries()]
    .map(([name, e]) => ({ name, set: Boolean(process.env[name]), inFile: inFile.has(name), secret: e.secret, usedBy: e.usedBy }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function saveAndReload(app: DashboardApp, text: string): Promise<Record<string, unknown>> {
  const report = await app.configFile.save(text);
  await app.reload();
  return { ok: true, warnings: report.warnings, restartNeeded: app.watches.runningIds() };
}

// ---- auth & session ---------------------------------------------------------------

const throttle = new LoginThrottle();

async function startSession(ctx: Ctx): Promise<void> {
  const token = newToken();
  const hours = ctx.app.rt.config.dashboard.sessionHours;
  ctx.app.store.pruneSessions();
  ctx.app.store.createSession(tokenHash(token), Date.now() + hours * 3_600_000, ctx.ip, str(ctx.req.headers["user-agent"]));
  ctx.res.setHeader("set-cookie", sessionCookie(token, hours * 3600, ctx.secure));
}

route("GET", "/api/session", false, (ctx) => ({
  version: VERSION,
  setupRequired: !ctx.app.store.getAdminPasswordHash(),
  authenticated: Boolean(ctx.sessionHash),
}));

route("POST", "/api/setup", false, async (ctx) => {
  const app = ctx.app;
  if (app.store.getAdminPasswordHash() || !app.setupToken) throw new HttpError(409, "Setup is already complete. Sign in instead.");
  const wait = throttle.retryAfter(ctx.ip);
  if (wait > 0) throw new HttpError(429, "Too many attempts. Try again later.", { retryAfterMs: wait });
  const token = str(ctx.body.token)?.trim() ?? "";
  if (!safeEqual(token, app.setupToken)) {
    throttle.fail(ctx.ip);
    throw new HttpError(403, "That setup token is not valid. Copy it from the terminal that started the dashboard.", { field: "token" });
  }
  const problem = passwordProblem(ctx.body.password);
  if (problem) throw new HttpError(400, problem, { field: "password" });
  if (!app.store.createAdmin(await hashPassword(str(ctx.body.password)!))) throw new HttpError(409, "Setup is already complete.");
  app.setupToken = undefined;
  throttle.succeed(ctx.ip);
  await startSession(ctx);
  app.rt.logger.info("Dashboard admin password created");
  return { ok: true, configExists: app.configFile.exists() };
});

route("POST", "/api/login", false, async (ctx) => {
  const hash = ctx.app.store.getAdminPasswordHash();
  if (!hash) throw new HttpError(409, "Finish first-time setup first.");
  const wait = throttle.retryAfter(ctx.ip);
  if (wait > 0) throw new HttpError(429, `Too many failed attempts. Try again in ${Math.ceil(wait / 60_000)} min.`, { retryAfterMs: wait });
  const ok = await verifyPassword(str(ctx.body.password) ?? "", hash);
  if (!ok) {
    throttle.fail(ctx.ip);
    await new Promise((r) => setTimeout(r, 400));
    throw new HttpError(401, "Wrong password.", { field: "password" });
  }
  throttle.succeed(ctx.ip);
  await startSession(ctx);
  return { ok: true };
});

route("POST", "/api/logout", true, (ctx) => {
  ctx.app.store.deleteSession(ctx.sessionHash!);
  ctx.res.setHeader("set-cookie", sessionCookie("", 0, ctx.secure));
  return { ok: true };
});

route("POST", "/api/password", true, async (ctx) => {
  const hash = ctx.app.store.getAdminPasswordHash()!;
  if (!(await verifyPassword(str(ctx.body.current) ?? "", hash))) throw new HttpError(401, "Current password is wrong.", { field: "current" });
  const problem = passwordProblem(ctx.body.next);
  if (problem) throw new HttpError(400, problem, { field: "next" });
  ctx.app.store.updateAdminPassword(await hashPassword(str(ctx.body.next)!));
  const revoked = ctx.app.store.deleteOtherSessions(ctx.sessionHash!);
  return { ok: true, revokedSessions: revoked };
});

route("POST", "/api/sessions/revoke-others", true, (ctx) => ({ ok: true, revoked: ctx.app.store.deleteOtherSessions(ctx.sessionHash!) }));

// ---- insight -------------------------------------------------------------------------

route("GET", "/api/overview", true, (ctx) => {
  const app = ctx.app;
  const rt = app.rt;
  const now = Date.now();
  const configured = new Set(rt.config.targets.map((t) => t.id));
  return {
    now,
    version: VERSION,
    app: {
      dryRun: rt.config.app.dryRun,
      profile: rt.config.profile,
      timezone: rt.config.app.timezone,
      configPath: app.configFile.path,
      configExists: app.configFile.exists(),
      configError: app.configError ?? null,
      warnings: rt.config.warnings,
      database: rt.config.app.databasePath,
      startedAt: app.startedAt,
    },
    targets: rt.config.targets.map((t) => targetView(app, t, now)),
    orphanStates: app.store.listStates().filter((s) => !configured.has(s.targetId)),
    events: app.store.events(undefined, 40),
    latency: app.store.latencyStats(),
    confirmations: app.confirmations.list(),
    notifications: { sent: app.notifier.sent, failed: app.notifier.failed },
    checks24h: app.store.checkCount(new Date(now - 86_400_000).toISOString()),
  };
});

route("GET", "/api/targets/:id", true, (ctx) => {
  const app = ctx.app;
  const t = app.rt.config.targets.find((x) => x.id === ctx.params.id);
  const raw = ((app.configFile.raw().targets as unknown[]) ?? []).find((x) => (x as { id?: unknown }).id === ctx.params.id) ?? null;
  if (!t && !raw) throw new HttpError(404, "Unknown target");
  return {
    target: t ? targetView(app, t, Date.now()) : null,
    raw,
    attempts: app.store.attempts(ctx.params.id, 30),
    runs: app.store.runs(ctx.params.id, 15),
    events: app.store.events(ctx.params.id, 150),
  };
});

route("GET", "/api/events", true, (ctx) => ({
  events: ctx.app.store.events(ctx.query.get("target") || undefined, Math.min(500, Number(ctx.query.get("limit") ?? 100))),
  attempts: ctx.app.store.attempts(ctx.query.get("target") || undefined, 50),
}));

route("GET", "/api/stream", true, (ctx) => {
  ctx.res.writeHead(200, {
    ...SECURITY_HEADERS,
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  ctx.res.write("retry: 3000\n\n");
  ctx.app.bus.add(ctx.res);
  return STREAMING;
});

// ---- actions ---------------------------------------------------------------------------

route("POST", "/api/targets/:id/start", true, async (ctx) => {
  await ctx.app.startWatch(ctx.params.id!);
  return { ok: true };
});

route("POST", "/api/targets/:id/stop", true, (ctx) => ({ ok: ctx.app.watches.stop(ctx.params.id!) }));

route("POST", "/api/targets/:id/resolve", true, async (ctx) => {
  if (ctx.app.watches.isRunning(ctx.params.id!)) throw new HttpError(409, "Stop the watch before resolving this target.");
  const as = (str(ctx.body.as) ?? "auto") as ResolveAs;
  if (!["succeeded", "failed", "reset", "auto"].includes(as)) throw new HttpError(400, "Invalid resolution");
  return resolveTarget(ctx.app.rt, ctx.app.store, ctx.params.id!, as);
});

route("GET", "/api/confirmations", true, (ctx) => ctx.app.confirmations.list());

route("POST", "/api/confirmations/:id", true, (ctx) => {
  const ok = ctx.app.confirmations.answer(ctx.params.id!, str(ctx.body.domain), ctx.body.decline === true);
  if (!ok) throw new HttpError(404, "This confirmation already expired or was answered.");
  return { ok: true };
});

route("POST", "/api/check", true, async (ctx) => {
  const domain = str(ctx.body.domain);
  if (!domain) throw new HttpError(400, "Enter a domain.", { field: "domain" });
  const providers = Array.isArray(ctx.body.providers) ? (ctx.body.providers as unknown[]).filter((p): p is string => typeof p === "string") : undefined;
  return runCheck(ctx.app.rt, domain, providers?.length ? providers : undefined);
});

route("GET", "/api/providers", true, async (ctx) => ({
  providers: pluginMatrix(ctx.app.rt.registry.list()),
  accounts: await accountReports(ctx.app.rt, { health: false }),
}));

route("POST", "/api/providers/:id/test", true, async (ctx) => {
  const [report] = await accountReports(ctx.app.rt, { health: true, only: [ctx.params.id!] });
  return report;
});

route("POST", "/api/discord/test", true, async (ctx) => {
  const channel = ctx.app.rt.discordChannel();
  if (!channel) throw new HttpError(400, `${ctx.app.rt.config.notifications.discord.webhookEnv} is not set. Add the webhook URL first.`);
  await withTimeout(channel.sendText("dropcatch test", "Test message from the dropcatch dashboard. Notifications are working."), 20_000);
  return { ok: true };
});

// ---- configuration ---------------------------------------------------------------------

route("GET", "/api/config", true, (ctx) => {
  const app = ctx.app;
  return {
    path: app.configFile.path,
    exists: app.configFile.exists(),
    yaml: app.configFile.read(),
    raw: app.configFile.raw(),
    error: app.configError ?? null,
    warnings: app.rt.config.warnings,
    providers: pluginMatrix(app.rt.registry.list()),
    accounts: Object.values(app.rt.config.accounts).map((a) => ({
      id: a.id,
      provider: a.plugin.id,
      availability: a.plugin.capabilities.availability,
      registration: a.plugin.capabilities.registration,
      builtin: a.id === RDAP_ACCOUNT,
    })),
    envPath: app.envPath,
    running: app.watches.runningIds(),
  };
});

route("POST", "/api/config/validate", true, async (ctx) => ctx.app.configFile.validate(str(ctx.body.yaml) ?? ""));

route("PUT", "/api/config", true, async (ctx) => {
  const yaml = str(ctx.body.yaml);
  if (yaml === undefined) throw new HttpError(400, "yaml is required");
  return saveAndReload(ctx.app, yaml);
});

route("POST", "/api/config/quickstart", true, async (ctx) => {
  const app = ctx.app;
  if (app.configFile.exists()) throw new HttpError(409, "A config file already exists. Edit it instead.");
  const b = ctx.body;
  const timezone = str(b.timezone) ?? "UTC";
  if (!isValidTimeZone(timezone)) throw new HttpError(400, `Unknown timezone "${timezone}"`, { field: "timezone" });
  let domain: string;
  try {
    domain = normalizeDomain(str(b.domain) ?? "").ascii;
  } catch (err) {
    throw new HttpError(400, (err as Error).message, { field: "domain" });
  }
  let expectedAt: string | undefined;
  const when = str(b.expectedAt);
  if (when) {
    try {
      expectedAt = new Date(parseInstant(when.length === 16 ? `${when}:00` : when, timezone).utcMs).toISOString();
    } catch (err) {
      throw new HttpError(400, (err as Error).message, { field: "expectedAt" });
    }
  }
  const registrars = (Array.isArray(b.registrars) ? b.registrars : []).filter((r): r is RegistrarChoice => r === "porkbun" || r === "namecheap" || r === "cloudflare");
  const mode = b.mode === "confirm" || b.mode === "auto-buy" ? b.mode : "notify-only";
  const max = Number(b.maxPrice);
  if (mode !== "notify-only" && !(max > 0)) throw new HttpError(400, "Set a maximum price for confirm or auto-buy mode.", { field: "maxPrice" });
  if (mode !== "notify-only" && registrars.includes("namecheap")) {
    throw new HttpError(400, "Namecheap registration needs contact details. Start with notify-only, then add them under Providers.", { field: "registrars" });
  }
  const text = renderConfig({
    timezone,
    target: { id: domain.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""), domain, expectedAt, strategy: "adaptive" },
    registrars,
    mode,
    budget: mode === "notify-only" ? undefined : { max, currency: (str(b.currency) ?? "USD").toUpperCase() },
    discord: b.discord !== false,
  });
  return saveAndReload(app, text);
});

route("PUT", "/api/config/targets/:id", true, async (ctx) => {
  const target = ctx.body.target;
  if (!target || typeof target !== "object") throw new HttpError(400, "target is required");
  return saveAndReload(ctx.app, ctx.app.configFile.upsertTarget(ctx.params.id!, target as Record<string, unknown>));
});

route("DELETE", "/api/config/targets/:id", true, async (ctx) => {
  if (ctx.app.watches.isRunning(ctx.params.id!)) throw new HttpError(409, "Stop the watch before deleting this target.");
  return saveAndReload(ctx.app, ctx.app.configFile.removeTarget(ctx.params.id!));
});

route("PUT", "/api/config/accounts/:id", true, async (ctx) => {
  const id = ctx.params.id!;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(id) || id === RDAP_ACCOUNT) throw new HttpError(400, "Invalid account id", { field: "id" });
  const b = ctx.body;
  let options: unknown;
  const optionsYaml = str(b.optionsYaml);
  if (optionsYaml?.trim()) {
    try {
      options = parseYaml(optionsYaml);
    } catch (err) {
      throw new HttpError(400, `Options are not valid YAML: ${(err as Error).message}`, { field: "optionsYaml" });
    }
  }
  const account = {
    provider: str(b.provider),
    environment: str(b.environment),
    enabled: b.enabled !== false,
    credentials: b.credentials && typeof b.credentials === "object" ? b.credentials : undefined,
    options,
    proxy: str(b.proxy),
  };
  return saveAndReload(ctx.app, ctx.app.configFile.setIn(["accounts", id], account));
});

route("DELETE", "/api/config/accounts/:id", true, async (ctx) =>
  saveAndReload(ctx.app, ctx.app.configFile.setIn(["accounts", ctx.params.id!], undefined)));

route("PATCH", "/api/config/app", true, async (ctx) => {
  const b = ctx.body;
  const raw = ctx.app.configFile.raw() as { app?: { dryRun?: unknown } };
  const currentlyDry = raw.app?.dryRun !== false;
  if (b.dryRun === false && currentlyDry && b.confirmLive !== "GO LIVE") {
    throw new HttpError(400, 'Type GO LIVE to allow real purchases.', { field: "confirmLive" });
  }
  const text = ctx.app.configFile.edit((doc) => {
    const app: Record<string, unknown> = {
      timezone: str(b.timezone),
      logLevel: str(b.logLevel),
      dryRun: typeof b.dryRun === "boolean" ? b.dryRun : undefined,
    };
    for (const [key, value] of Object.entries(app)) if (value !== undefined) doc.setIn(["app", key], value);
    if (typeof b.profile === "string") doc.set("profile", b.profile);
  });
  return saveAndReload(ctx.app, text);
});

route("PATCH", "/api/config/notifications", true, async (ctx) => {
  const discord = ctx.body.discord;
  if (!discord || typeof discord !== "object") throw new HttpError(400, "discord settings are required");
  return saveAndReload(ctx.app, ctx.app.configFile.merge(["notifications", "discord"], discord as Record<string, unknown>));
});

route("GET", "/api/secrets", true, (ctx) => ({ envPath: ctx.app.envPath, secrets: secretCatalog(ctx.app) }));

route("PUT", "/api/secrets/:name", true, async (ctx) => {
  const name = ctx.params.name!;
  const referenced = secretCatalog(ctx.app).some((s) => s.name === name);
  if (!referenced && !SECRET_PREFIX.test(name)) throw new HttpError(400, `${name} is not used by this config`);
  const value = str(ctx.body.value)?.trim();
  if (!value) throw new HttpError(400, "Enter a value.", { field: "value" });
  upsertEnvFile(ctx.app.envPath, { [name]: value });
  process.env[name] = value;
  ctx.app.rt.redactor.addSecret(value);
  await ctx.app.reload();
  return { ok: true };
});

route("DELETE", "/api/secrets/:name", true, async (ctx) => {
  const name = ctx.params.name!;
  if (!envFileKeys(ctx.app.envPath).has(name)) throw new HttpError(404, `${name} is not in ${ctx.app.envPath}`);
  upsertEnvFile(ctx.app.envPath, { [name]: undefined });
  delete process.env[name];
  await ctx.app.reload();
  return { ok: true };
});

// ---- server -----------------------------------------------------------------------------

export interface ServerOptions {
  host: string;
  port: number;
  trustProxy: boolean;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function createDashboardServer(app: DashboardApp, opts: ServerOptions): Server {
  const staticFiles = loadStatic();
  const loopbackOnly = LOOPBACK_HOSTS.has(opts.host);

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://placeholder");
    const hostHeader = (req.headers.host ?? "").toLowerCase();
    const hostname = hostHeader.startsWith("[") ? hostHeader.slice(0, hostHeader.indexOf("]") + 1) : hostHeader.split(":")[0]!;
    // DNS-rebinding guard: a loopback-bound dashboard only answers to loopback host names.
    if (loopbackOnly && !LOOPBACK_HOSTS.has(hostname)) {
      res.writeHead(421, SECURITY_HEADERS).end("Misdirected request");
      return;
    }
    const forwardedProto = opts.trustProxy ? String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]?.trim() : undefined;
    const secure = forwardedProto === "https";
    const ip = (opts.trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim() : "") || req.socket.remoteAddress || "unknown";

    if (!url.pathname.startsWith("/api/")) {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, SECURITY_HEADERS).end();
        return;
      }
      const file = staticFiles.get(url.pathname === "/" ? "/index.html" : url.pathname);
      if (!file) {
        res.writeHead(404, { ...SECURITY_HEADERS, "content-type": "text/plain" }).end("Not found");
        return;
      }
      const cache = file.type.startsWith("font/") || file.type === "image/svg+xml" ? "public, max-age=86400" : "no-cache";
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        "content-type": file.type,
        "cache-control": cache,
        ...(secure ? { "strict-transport-security": "max-age=31536000" } : {}),
      });
      res.end(req.method === "HEAD" ? undefined : file.body);
      return;
    }

    const match = routes
      .map((r) => ({ r, m: r.method === req.method ? r.pattern.exec(url.pathname) : null }))
      .find((x) => x.m);
    if (!match) {
      send(res, routes.some((r) => r.pattern.test(url.pathname)) ? 405 : 404, { error: "Not found" });
      return;
    }

    try {
      if (req.method !== "GET") {
        // CSRF: same-origin fetches only (custom header + Origin check). Cookies are SameSite=Strict too.
        if (req.headers["x-dropcatch"] !== "1") throw new HttpError(403, "Missing request header");
        const origin = req.headers.origin;
        if (origin && new URL(origin).host.toLowerCase() !== hostHeader) throw new HttpError(403, "Cross-origin request refused");
      }
      const cookie = parseCookies(req.headers.cookie)[COOKIE];
      let sessionHash: string | undefined;
      if (cookie) {
        const hash = tokenHash(cookie);
        if (app.store.touchSession(hash, Date.now() + app.rt.config.dashboard.sessionHours * 3_600_000)) sessionHash = hash;
      }
      if (match.r.auth && !sessionHash) throw new HttpError(401, "Sign in required", { signIn: true });
      const params: Record<string, string> = {};
      match.r.keys.forEach((key, i) => (params[key] = decodeURIComponent(match.m![i + 1]!)));
      const body = req.method === "GET" || req.method === "HEAD" ? {} : await readBody(req);
      const result = await match.r.handler({ app, req, res, params, query: url.searchParams, body, ip, secure, sessionHash });
      if (result !== STREAMING) send(res, 200, result ?? { ok: true });
    } catch (err) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (err instanceof HttpError) send(res, err.status, { error: err.message, ...err.extra });
      else if (err instanceof ConfigError) send(res, 422, { error: err.summary, issues: err.issues });
      else if (err instanceof AppError) send(res, 400, { error: err.message, code: err.code });
      else {
        app.rt.logger.error(`Dashboard request failed: ${(err as Error).message}`, { path: url.pathname });
        send(res, 500, { error: "Internal error. Check the server log." });
      }
    }
  });
}
