import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { DashboardApp } from "../../src/dashboard/DashboardApp.ts";
import { createDashboardServer } from "../../src/dashboard/server.ts";
import { TransportError, UndiciTransport } from "../../src/transport/HttpTransport.ts";
import { ProxyRouter } from "../../src/transport/ProxyRouter.ts";
import { AVAILABILITY_RETRY, REGISTRATION_RETRY } from "../../src/transport/RetryPolicy.ts";
import { tempDir } from "../helpers/fakes.ts";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("undici transport", () => {
  let base: string;
  let hits = 0;
  const server = createServer((req, res) => {
    hits++;
    if (req.url === "/flaky") {
      res.writeHead(hits % 2 === 1 ? 503 : 200, { "content-type": "application/json", date: new Date().toUTCString() }).end('{"ok":true}');
    } else if (req.url === "/slow") {
      setTimeout(() => res.end("late"), 400);
    } else {
      res.writeHead(503).end("down");
    }
  });
  const router = new ProxyRouter();
  before(async () => {
    base = await listen(server);
  });
  after(async () => {
    server.close();
    await router.close();
  });

  it("retries transient 5xx for availability, never for registration", async () => {
    const t = new UndiciTransport({ router });
    hits = 0;
    const ok = await t.request({ method: "GET", url: `${base}/flaky`, timeoutMs: 1000, retry: AVAILABILITY_RETRY });
    assert.equal(ok.status, 200);
    assert.equal(ok.attempts, 2);
    assert.ok(ok.serverDate);
    hits = 0;
    const reg = await t.request({ method: "POST", url: `${base}/down`, timeoutMs: 1000, retry: REGISTRATION_RETRY });
    assert.equal(reg.status, 503);
    assert.equal(hits, 1, "a registration POST is sent exactly once");
  });

  it("reports a timeout after connecting as possibly-sent, and a refused connection as not sent", async () => {
    const t = new UndiciTransport({ router });
    await assert.rejects(t.request({ method: "GET", url: `${base}/slow`, timeoutMs: 100 }), (e: unknown) => e instanceof TransportError && e.code === "NETWORK_TIMEOUT" && e.sent === "maybe");
    const closed = createServer();
    const url = await listen(closed);
    closed.close();
    await new Promise((r) => setTimeout(r, 50));
    await assert.rejects(t.request({ method: "GET", url, timeoutMs: 8000 }), (e: unknown) => e instanceof TransportError && e.sent === "no");
  });
});

describe("dashboard server", () => {
  const dir = tempDir("dropcatch-dash-");
  const configPath = join(dir, "config.yaml");
  let app: DashboardApp;
  let base: string;
  let server: Server;
  let cookie = "";

  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", "x-dropcatch": "1", cookie, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0]!;
    return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> };
  };

  before(async () => {
    app = await DashboardApp.create({ config: configPath, logLevel: "silent" });
    server = createDashboardServer(app, { host: "127.0.0.1", port: 0, trustProxy: false });
    base = await listen(server);
  });
  after(async () => {
    server.close();
    await app.shutdown();
  });

  it("serves the app with strict security headers and noindex", async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-security-policy")!, /script-src 'self'/);
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.match(res.headers.get("x-robots-tag")!, /noindex/);
    assert.equal((await fetch(`${base}/../package.json`)).status, 404);
  });

  it("guards against DNS rebinding and cross-site requests", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const r = httpRequest(`${base}/api/session`, { headers: { host: "attacker.example" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      r.on("error", reject);
      r.end();
    });
    assert.equal(status, 421);
    assert.equal((await call("POST", "/api/setup", {}, { "x-dropcatch": "0" })).status, 403);
    assert.equal((await call("POST", "/api/setup", {}, { origin: "https://evil.example" })).status, 403);
  });

  it("first-time setup requires the terminal token, then sign-in is required", async () => {
    assert.equal((await call("GET", "/api/session")).body.setupRequired, true);
    assert.equal((await call("GET", "/api/overview")).status, 401);
    assert.equal((await call("POST", "/api/setup", { token: "wrong", password: "long enough pw" })).status, 403);
    assert.equal((await call("POST", "/api/setup", { token: app.setupToken, password: "short" })).status, 400);
    const ok = await call("POST", "/api/setup", { token: app.setupToken, password: "correct horse battery" });
    assert.equal(ok.status, 200);
    assert.equal(app.setupToken, undefined);
    assert.equal((await call("POST", "/api/setup", { token: "x", password: "correct horse battery" })).status, 409);
    assert.equal((await call("GET", "/api/overview")).status, 200);
    await call("POST", "/api/logout");
    assert.equal((await call("GET", "/api/overview")).status, 401);
    assert.equal((await call("POST", "/api/login", { password: "wrong password!" })).status, 401);
    assert.equal((await call("POST", "/api/login", { password: "correct horse battery" })).status, 200);
  });

  it("creates a config via quick setup and validates every edit", async () => {
    const qs = await call("POST", "/api/config/quickstart", { domain: "Example-Drop.com", timezone: "Europe/Warsaw", expectedAt: "2026-10-01T14:00", registrars: ["porkbun"], mode: "notify-only" });
    assert.equal(qs.status, 200, JSON.stringify(qs.body));
    assert.ok(existsSync(configPath));
    assert.match(readFileSync(configPath, "utf8"), /dryRun: true/);
    const bad = await call("PUT", "/api/config/targets/x", { target: { id: "x", domain: "" } });
    assert.equal(bad.status, 422);
    const secret = await call("PUT", "/api/config", { yaml: "notifications:\n  discord:\n    webhookEnv: X\n# https://discord.com/api/webhooks/1/abcdefghijklmnopqrstuvwxyz0123\n" });
    assert.equal(secret.status, 422);
    const plugins = await call("PUT", "/api/config", { yaml: `${readFileSync(configPath, "utf8")}\nplugins: ["./x.js"]\n` });
    assert.equal(plugins.status, 422);
    const live = await call("PATCH", "/api/config/app", { dryRun: false });
    assert.equal(live.status, 400);
    assert.equal(live.body.field, "confirmLive");
  });

  it("writes secrets to .env without ever returning them", async () => {
    const set = await call("PUT", "/api/secrets/PORKBUN_API_KEY", { value: "pk1_dashboardtestvalue" });
    assert.equal(set.status, 200);
    assert.match(readFileSync(join(dir, ".env"), "utf8"), /PORKBUN_API_KEY="pk1_dashboardtestvalue"/);
    const list = await call("GET", "/api/secrets");
    assert.ok(!JSON.stringify(list.body).includes("dashboardtestvalue"));
    assert.equal(((list.body.secrets as Array<{ name: string; set: boolean }>).find((s) => s.name === "PORKBUN_API_KEY"))!.set, true);
    assert.equal((await call("PUT", "/api/secrets/NODE_OPTIONS", { value: "--require x" })).status, 400);
  });

  it("serves health and metrics for monitoring", async () => {
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    assert.equal(((await health.json()) as { status: string }).status, "ok");
    const m = await fetch(`${base}/metrics`);
    assert.equal(m.status, 200, "loopback scrapers are allowed");
    assert.match(await m.text(), /dropcatch_info\{version=/);
  });

  it("imports targets in bulk and exposes them in the calendar", async () => {
    const text = ["imported-one.pl 2026-12-01 10:00", "imported-two.com"].join("\n");
    const preview = await call("POST", "/api/import", { text, defaults: { mode: "notify-only", timezone: "Europe/Warsaw" } });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.deepEqual([preview.body.applied, (preview.body.counts as { create: number }).create], [false, 2]);
    const applied = await call("POST", "/api/import", { text, apply: true, defaults: { mode: "notify-only", timezone: "Europe/Warsaw" } });
    assert.equal(applied.body.applied, true);
    const cal = await call("GET", "/api/calendar");
    assert.ok((cal.body.entries as Array<{ id: string }>).some((e) => e.id === "imported-one-pl"));
    const ics = await fetch(`${base}/api/calendar.ics`, { headers: { cookie } });
    assert.match(ics.headers.get("content-type")!, /text\/calendar/);
    assert.match(await ics.text(), /SUMMARY:Drop: imported-one\.pl/);
  });

  it("guides Telegram setup when the bot token is missing", async () => {
    const chats = await call("GET", "/api/telegram/chats");
    assert.equal(chats.status, 400);
    assert.match(String(chats.body.error), /TELEGRAM_BOT_TOKEN/);
  });

  it("locks out an IP after repeated wrong passwords", async () => {
    for (let i = 0; i < 5; i++) await call("POST", "/api/login", { password: `wrong-${i}-password` });
    assert.equal((await call("POST", "/api/login", { password: "correct horse battery" })).status, 429);
  });

  it("starts with defaults and reports errors when the config file is broken", async () => {
    const brokenDir = tempDir("dropcatch-broken-");
    writeFileSync(join(brokenDir, "config.yaml"), "targets:\n  - id: t\n    domain: \"\"\n");
    const broken = await DashboardApp.create({ config: join(brokenDir, "config.yaml"), logLevel: "silent" });
    assert.ok(broken.configError?.some((i) => i.includes("domain")));
    await broken.shutdown();
  });
});
