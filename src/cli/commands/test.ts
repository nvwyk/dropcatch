import { withTimeout } from "../../core/clock.ts";
import { ConfigError } from "../../core/errors.ts";
import { formatInstant } from "../../core/time.ts";
import { normalizeDomain } from "../../domain/normalize.ts";
import { TelegramChannel } from "../../notifications/Telegram.ts";
import { bad, good, kv, out, printJson } from "../output.ts";
import type { Runtime } from "../runtime.ts";

export async function testDiscord(rt: Runtime, opts: { json?: boolean; target?: string }): Promise<number> {
  const target = opts.target ? rt.config.targets.find((t) => t.id === opts.target) : undefined;
  if (opts.target && !target) throw new ConfigError(`Unknown target "${opts.target}"`);
  const envName = target?.notifications.discord.webhookEnv ?? rt.config.notifications.discord.webhookEnv;
  const channel = rt.discordChannel(envName);
  if (!channel) throw new ConfigError(`${envName} is not set. Put your Discord webhook URL in that environment variable (or .env).`);
  try {
    await channel.sendText(
      "dropcatch test",
      `Test message sent at ${formatInstant(Date.now(), rt.config.app.timezone, { withDate: true, withZone: true })}. Notifications are working.`,
    );
  } catch (err) {
    if (opts.json) printJson({ ok: false, error: (err as Error).message });
    else out(bad(`Discord test failed: ${(err as Error).message}`));
    return 1;
  }
  if (opts.json) printJson({ ok: true });
  else out(good("Discord test message delivered successfully."));
  return 0;
}

export async function testTelegram(rt: Runtime, opts: { json?: boolean; chats?: boolean }): Promise<number> {
  const tg = rt.config.notifications.telegram;
  const token = process.env[tg.botTokenEnv];
  if (!token) throw new ConfigError(`${tg.botTokenEnv} is not set. Create a bot with @BotFather and put its token in that variable (or .env).`);
  if (opts.chats) {
    const chats = await TelegramChannel.recentChats(rt.transport, token);
    if (opts.json) printJson(chats);
    else if (!chats.length) out("No chats yet. Send any message to your bot (or add it to a group), then run this again.");
    else {
      out("Chats that recently messaged the bot (put one in notifications.telegram.chatId):");
      for (const c of chats) kv(String(c.id), `${c.type ?? ""} ${c.title ?? c.username ?? c.first_name ?? ""}`.trim());
    }
    return 0;
  }
  const channel = rt.telegramChannel();
  if (!channel) throw new ConfigError("Telegram is not enabled: set notifications.telegram.enabled: true and notifications.telegram.chatId");
  try {
    await channel.sendText(`dropcatch test message sent at ${formatInstant(Date.now(), rt.config.app.timezone, { withDate: true, withZone: true })}. Notifications are working.`);
  } catch (err) {
    if (opts.json) printJson({ ok: false, error: (err as Error).message });
    else out(bad(`Telegram test failed: ${(err as Error).message}`));
    return 1;
  }
  if (opts.json) printJson({ ok: true });
  else out(good("Telegram test message delivered successfully."));
  return 0;
}

export async function testProvider(rt: Runtime, account: string, opts: { json?: boolean; domain?: string }): Promise<number> {
  const handle = rt.account(account);
  const report: Record<string, unknown> = {
    account,
    provider: handle.config.plugin.id,
    environment: handle.config.environment,
    credentials: handle.missing.length ? { ok: false, missing: handle.missing.map((m) => m.env) } : { ok: true },
  };
  let ok = handle.missing.length === 0 && !handle.error;
  if (handle.instance?.healthCheck) {
    const health = await withTimeout(handle.instance.healthCheck(8000), 10_000).catch((err: Error) => ({ ok: false, detail: err.message }));
    report.connectivity = health;
    ok &&= health.ok;
  } else if (handle.error) {
    report.error = handle.error;
  }
  if (opts.domain && handle.instance?.check) {
    const domain = normalizeDomain(opts.domain).ascii;
    await handle.instance.prepare?.(domain).catch(() => undefined);
    report.sampleCheck = await handle.instance.check({ domain, timeoutMs: 8000 });
  }
  if (opts.json) {
    printJson({ ok, ...report });
    return ok ? 0 : 1;
  }
  out(`${account} (${handle.config.plugin.id}, ${handle.config.environment})`);
  kv("credentials", handle.missing.length ? bad(`MISSING ${handle.missing.map((m) => m.env).join(", ")}`) : good("present"));
  const connectivity = report.connectivity as { ok: boolean; detail?: string; latencyMs?: number } | undefined;
  if (connectivity) {
    kv("connectivity", connectivity.ok ? good(`PASS${connectivity.latencyMs !== undefined ? ` (${connectivity.latencyMs} ms)` : ""}`) : bad("FAIL"));
    if (connectivity.detail) kv("detail", connectivity.detail);
  } else if (handle.error) {
    kv("error", bad(handle.error));
  }
  const sample = report.sampleCheck as { status: string; latencyMs: number } | undefined;
  if (sample) kv("sample check", `${opts.domain}: ${sample.status} (${sample.latencyMs} ms)`);
  out(ok ? good("Provider test passed. Nothing was purchased.") : bad("Provider test failed."));
  return ok ? 0 : 1;
}
