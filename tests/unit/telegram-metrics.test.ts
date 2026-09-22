import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { scanForSecrets } from "../../src/config/secrets.ts";
import type { DropEvent } from "../../src/core/events.ts";
import { TelegramChannel, telegramText } from "../../src/notifications/Telegram.ts";
import { metrics, metricsAllowed, observeCheck, observeEvent, renderMetrics } from "../../src/observability/metrics.ts";
import { Redactor } from "../../src/security/redaction.ts";
import { FakeTransport, response } from "../helpers/fakes.ts";

const event = (over: Partial<DropEvent> = {}): DropEvent => ({
  type: "registration_succeeded",
  targetId: "t1",
  domain: "sklep.pl",
  at: Date.UTC(2026, 9, 1, 12),
  data: { provider: "ovh-main", price: { amount: 16.69, currency: "PLN" }, reason: "<b>x</b> & y" },
  ...over,
});

describe("telegram", () => {
  it("formats HTML safely from the shared event view", () => {
    const text = telegramText(event(), "UTC");
    assert.match(text, /^<b>.*DOMAIN REGISTERED<\/b>/);
    assert.match(text, /Price: <code>16\.69 PLN<\/code>/);
    assert.ok(text.includes("&lt;b&gt;x&lt;/b&gt; &amp; y"));
    assert.ok(!text.includes("<b>x</b>"));
  });

  it("sends to the chat, rings only for important events, and honours retry_after", async () => {
    let calls = 0;
    const t = new FakeTransport(() => (++calls === 1 ? response(429, { ok: false, parameters: { retry_after: 0.01 } }) : response(200, { ok: true })));
    const ch = new TelegramChannel({ botToken: "123456:ABC", chatId: "-1001", timeZone: "UTC", transport: t, retryDelayMs: 1 });
    await ch.send(event());
    assert.equal(t.requests.length, 2);
    const body = t.requests[1]!.json as Record<string, unknown>;
    assert.equal(body.chat_id, "-1001");
    assert.equal(body.parse_mode, "HTML");
    assert.equal(body.disable_notification, false);
    assert.match(t.requests[1]!.url, /\/bot123456:ABC\/sendMessage$/);
    await ch.send(event({ type: "watch_started", data: { mode: "notify-only" } }));
    assert.equal((t.requests[2]!.json as Record<string, unknown>).disable_notification, true);
  });

  it("does not retry a rejected message and lists recent chats", async () => {
    const bad = new TelegramChannel({ botToken: "1:x", chatId: "1", timeZone: "UTC", transport: new FakeTransport(() => response(400, { ok: false, description: "chat not found" })), retryDelayMs: 1 });
    await assert.rejects(bad.send(event()), /chat not found/);
    const t = new FakeTransport(() => response(200, { ok: true, result: [{ message: { chat: { id: 42, type: "private", first_name: "Marta" } } }, { my_chat_member: { chat: { id: -100, type: "group", title: "Drops" } } }] }));
    const chats = await TelegramChannel.recentChats(t, "1:x");
    assert.deepEqual(chats.map((c) => c.id), [42, -100]);
  });

  it("keeps bot tokens out of config files and logs", () => {
    const token = "8123456789:AAFfake_token-value-for-tests-1234567";
    assert.equal(scanForSecrets(`telegram:\n  token: ${token}\n`)[0]?.rule, "Telegram bot token");
    const r = new Redactor();
    const out = r.redact(`POST https://api.telegram.org/bot${token}/sendMessage failed; token ${token}`);
    assert.ok(!out.includes("AAFfake"));
  });
});

describe("metrics", () => {
  beforeEach(() => metrics.reset());

  it("exposes checks, latency histograms, registrations and info in Prometheus format", () => {
    const base = { providerType: "mock", sourceKind: "registrar" as const, domain: "a.pl", startedAt: "", checkedAt: "" };
    observeCheck({ ...base, provider: "ovh-main", status: "available", latencyMs: 80 });
    observeCheck({ ...base, provider: "ovh-main", status: "rate_limited", latencyMs: 5 });
    observeEvent(event({ type: "registration_started" }));
    observeEvent(event());
    const text = renderMetrics("9.9.9");
    assert.match(text, /# TYPE dropcatch_availability_checks_total counter/);
    assert.match(text, /dropcatch_availability_checks_total\{provider="ovh-main",status="available"\} 1/);
    assert.match(text, /dropcatch_provider_latency_ms_bucket\{provider="ovh-main",le="100"\} 1/);
    assert.match(text, /dropcatch_provider_latency_ms_bucket\{provider="ovh-main",le="50"\} 0/);
    assert.match(text, /dropcatch_provider_rate_limits_total\{provider="ovh-main"\} 1/);
    assert.match(text, /dropcatch_registrations_total\{provider="ovh-main",outcome="succeeded"\} 1/);
    assert.match(text, /dropcatch_info\{version="9\.9\.9"\} 1/);
  });

  it("allows loopback, a matching bearer token, or a session", () => {
    assert.equal(metricsAllowed("127.0.0.1", undefined, undefined, false), true);
    assert.equal(metricsAllowed("::ffff:127.0.0.1", undefined, undefined, false), true);
    assert.equal(metricsAllowed("10.0.0.7", undefined, "s3cret", false), false);
    assert.equal(metricsAllowed("10.0.0.7", "Bearer s3cret", "s3cret", false), true);
    assert.equal(metricsAllowed("10.0.0.7", "Bearer wrong!", "s3cret", false), false);
    assert.equal(metricsAllowed("10.0.0.7", undefined, undefined, true), true);
  });
});
