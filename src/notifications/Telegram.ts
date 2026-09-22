import { sleep } from "../core/clock.ts";
import type { DropEvent, EventType } from "../core/events.ts";
import { parseJson, type HttpTransport } from "../transport/HttpTransport.ts";
import { describeEvent } from "./format.ts";
import type { NotificationChannel } from "./Notifier.ts";

export const TELEGRAM_API = "https://api.telegram.org";

/** Events that ring the phone. Everything else is delivered silently. */
const LOUD: ReadonlySet<EventType> = new Set([
  "availability_detected",
  "confirmation_requested",
  "registration_succeeded",
  "registration_failed",
  "registration_ambiguous",
  "registration_pending",
  "purchase_blocked",
  "budget_exceeded",
]);

const escapeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Telegram HTML message for an event. Built only from describeEvent, so it never contains secrets. */
export function telegramText(event: DropEvent, timeZone: string): string {
  const view = describeEvent(event, timeZone);
  const lines = [`<b>${escapeHtml(view.title)}</b>`];
  for (const f of view.fields) lines.push(`${escapeHtml(f.name)}: <code>${escapeHtml(f.value)}</code>`);
  lines.push(`<i>target ${escapeHtml(event.targetId)}</i>`);
  return lines.join("\n").slice(0, 4000);
}

export interface TelegramChannelOptions {
  botToken: string;
  chatId: string;
  timeZone: string;
  transport: HttpTransport;
  proxy?: string;
  timeoutMs?: number;
  retryDelayMs?: number;
  apiBase?: string;
}

interface TelegramReply {
  ok?: boolean;
  description?: string;
  parameters?: { retry_after?: number };
  result?: Array<{ message?: { chat?: TelegramChat }; my_chat_member?: { chat?: TelegramChat }; channel_post?: { chat?: TelegramChat } }>;
}

export interface TelegramChat {
  id: number;
  type?: string;
  title?: string;
  username?: string;
  first_name?: string;
}

/** Telegram Bot API channel with bounded retries (honours retry_after). */
export class TelegramChannel implements NotificationChannel {
  readonly id = "telegram";
  private readonly o: TelegramChannelOptions;

  constructor(options: TelegramChannelOptions) {
    this.o = options;
  }

  private url(method: string): string {
    return `${this.o.apiBase ?? TELEGRAM_API}/bot${this.o.botToken}/${method}`;
  }

  async send(event: DropEvent): Promise<void> {
    await this.post(telegramText(event, this.o.timeZone), !LOUD.has(event.type));
  }

  async sendText(text: string): Promise<void> {
    await this.post(escapeHtml(text), false);
  }

  private async post(text: string, silent: boolean): Promise<void> {
    let lastError = "unknown error";
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const res = await this.o.transport.request({
          method: "POST",
          url: this.url("sendMessage"),
          json: { chat_id: this.o.chatId, text, parse_mode: "HTML", disable_web_page_preview: true, disable_notification: silent },
          timeoutMs: this.o.timeoutMs ?? 5000,
          proxy: this.o.proxy,
          label: "telegram.sendMessage",
        });
        const reply = parseJson<TelegramReply>(res);
        if (res.status === 200 && reply?.ok) return;
        if (res.status === 429) {
          lastError = "rate limited by Telegram";
          await sleep(Math.min(30_000, Math.max(250, (reply?.parameters?.retry_after ?? 1) * 1000)));
          continue;
        }
        if (res.status >= 500) {
          lastError = `Telegram HTTP ${res.status}`;
          await sleep((this.o.retryDelayMs ?? 500) * attempt);
          continue;
        }
        throw new Error(`Telegram rejected the message: ${reply?.description ?? `HTTP ${res.status}`}`);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("Telegram rejected")) throw err;
        lastError = err instanceof Error ? err.message : String(err);
        await sleep((this.o.retryDelayMs ?? 500) * attempt);
      }
    }
    throw new Error(`Telegram delivery failed: ${lastError}`);
  }

  /** Chats that recently messaged the bot, so the operator can pick a chat id without guessing. */
  static async recentChats(transport: HttpTransport, botToken: string, apiBase = TELEGRAM_API): Promise<TelegramChat[]> {
    const res = await transport.request({ method: "GET", url: `${apiBase}/bot${botToken}/getUpdates`, timeoutMs: 8000, label: "telegram.getUpdates" });
    const reply = parseJson<TelegramReply>(res);
    if (!reply?.ok) throw new Error(`Telegram getUpdates failed: ${reply?.description ?? `HTTP ${res.status}`}`);
    const chats = new Map<number, TelegramChat>();
    for (const u of reply.result ?? []) {
      const chat = u.message?.chat ?? u.channel_post?.chat ?? u.my_chat_member?.chat;
      if (chat && typeof chat.id === "number") chats.set(chat.id, chat);
    }
    return [...chats.values()];
  }
}
