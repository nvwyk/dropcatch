import type { DropEvent } from "../core/events.ts";
import { formatDuration, formatInstant } from "../core/time.ts";
import { formatMoney } from "../core/types.ts";

export type Severity = "success" | "danger" | "warning" | "info" | "signal";

export interface EventView {
  title: string;
  /** One-line human summary for terminal logs. */
  summary: string;
  severity: Severity;
  fields: Array<{ name: string; value: string; inline?: boolean }>;
}

export const SEVERITY_COLOR: Record<Severity, number> = {
  success: 0x2ecc71,
  danger: 0xe74c3c,
  warning: 0xf39c12,
  info: 0x3498db,
  signal: 0x9b59b6,
};

/** Human view of an event. Shared by the terminal log and Discord. Contains no secrets by construction. */
export function describeEvent(ev: DropEvent, timeZone = "UTC"): EventView {
  const d = ev.data;
  const at = (ms: number | undefined): string => (ms === undefined ? "n/a" : formatInstant(ms, timeZone, { withZone: true }));
  const fields: EventView["fields"] = [{ name: "Domain", value: ev.domain, inline: true }];
  const add = (name: string, value: unknown, inline = true): void => {
    if (value !== undefined && value !== null && value !== "") fields.push({ name, value: String(value), inline });
  };
  add("Provider", d.provider);

  switch (ev.type) {
    case "watch_started":
      add("Mode", `${String(d.mode).toUpperCase()}${d.dryRun ? " (DRY RUN)" : ""}`);
      add("Expected drop", d.expectedAt !== undefined ? formatInstant(Number(d.expectedAt), timeZone, { withDate: true, withZone: true }) : "not set", false);
      add("Sources", Array.isArray(d.sources) ? d.sources.join(", ") : undefined);
      return { title: "👀 Watch started", summary: `Watching ${ev.domain} (${String(d.mode)}${d.dryRun ? ", dry run" : ""})`, severity: "info", fields };

    case "drop_window_entered":
      add("Detail", d.reason, false);
      return { title: "⏱️ Drop window entered", summary: `Entering drop window: ${String(d.reason ?? "")}`, severity: "info", fields };

    case "hot_window_entered":
      add("Detail", d.reason, false);
      return { title: "🔥 Hot window", summary: `Entering hot window: ${String(d.reason ?? "")}`, severity: "info", fields };

    case "availability_detected": {
      add("Detected at", at(d.detectedAt));
      if (d.expectedAt !== undefined && d.detectedAt !== undefined) {
        add("Vs expected", `${formatDuration(Number(d.detectedAt) - Number(d.expectedAt))} after expected drop`);
      }
      add("Price", d.price ? formatMoney(d.price) : undefined);
      add("Request latency", d.latencyMs !== undefined ? `${d.latencyMs} ms` : undefined);
      add("Basis", d.reason, false);
      if (d.advisory) add("Note", "Registry data may lag; a registrar must confirm before any purchase.", false);
      return { title: "🟣 AVAILABILITY DETECTED", summary: `Availability signal detected (${String(d.reason ?? d.provider)})`, severity: "signal", fields };
    }

    case "availability_false_positive":
      add("Detail", d.reason, false);
      return { title: "↩️ False positive, still watching", summary: `Registrar did not confirm availability (${String(d.reason ?? "")}); resuming`, severity: "warning", fields };

    case "purchase_blocked":
      add("Price", d.price ? formatMoney(d.price) : undefined);
      add("Reasons", Array.isArray(d.reasons) ? d.reasons.join(", ") : undefined, false);
      add("Detail", d.reason, false);
      return { title: "⛔ PURCHASE BLOCKED", summary: `Purchase blocked: ${Array.isArray(d.reasons) ? d.reasons.join(", ") : ""}`, severity: "danger", fields };

    case "budget_exceeded":
      add("Price", d.price ? formatMoney(d.price) : undefined);
      add("Detail", d.reason, false);
      return { title: "💸 BUDGET EXCEEDED", summary: `Price over budget: ${String(d.reason ?? "")}`, severity: "danger", fields };

    case "confirmation_requested":
      add("Price", d.price ? formatMoney(d.price) : undefined);
      return { title: "✋ Waiting for your confirmation", summary: "Waiting for operator confirmation in the terminal", severity: "warning", fields };

    case "confirmation_declined":
      add("Detail", d.reason ?? "declined or timed out", false);
      return { title: "✋ Not confirmed", summary: `Registration not confirmed (${String(d.reason ?? "declined or timed out")})`, severity: "warning", fields };

    case "registration_started":
      add("Price", d.price ? formatMoney(d.price) : undefined);
      add("Attempt", d.attempt);
      return { title: "🛒 Registration submitted", summary: `Registration request submitted via ${String(d.provider)}`, severity: "info", fields };

    case "registration_succeeded":
      add("Registration", "SUCCESS");
      add("Price", d.price ? formatMoney(d.price) : undefined);
      add("Request latency", d.latencyMs !== undefined ? `${d.latencyMs} ms` : undefined);
      add("Reference", d.providerReference);
      add("Attempt", d.attempt);
      add("Note", d.reason, false);
      return { title: "🚨 DOMAIN REGISTERED", summary: `Registration SUCCESS via ${String(d.provider)}`, severity: "success", fields };

    case "registration_failed":
      add("Reason", d.errorCode ?? d.status);
      add("Attempt", d.attempt);
      add("Detail", d.reason, false);
      return { title: "⚠️ DOMAIN REGISTRATION FAILED", summary: `Registration FAILED via ${String(d.provider)}: ${String(d.errorCode ?? d.reason ?? "")}`, severity: "danger", fields };

    case "registration_pending":
      add("Reference", d.providerReference);
      add("Attempt", d.attempt);
      return { title: "⏳ REGISTRATION PENDING", summary: `Registration accepted by ${String(d.provider)}, not final yet`, severity: "warning", fields };

    case "registration_ambiguous":
      add("Detail", d.reason, false);
      add("Action", "Check the registrar account, then run: dropcatch resolve " + ev.targetId, false);
      return { title: "❓ REGISTRATION RESULT UNKNOWN", summary: `Registration result UNKNOWN via ${String(d.provider)}. No further attempts until resolved.`, severity: "danger", fields };

    case "dry_run_registration":
      add("Would pay", d.price ? formatMoney(d.price) : undefined);
      add("Verdict", d.status === "success" ? "would register" : "would fail");
      add("Detail", d.reason, false);
      return { title: "🧪 DRY RUN: registration not sent", summary: `DRY RUN via ${String(d.provider)}: ${String(d.reason ?? "")}`, severity: "info", fields };

    case "provider_error":
      add("Error", d.errorCode);
      add("Detail", d.reason, false);
      return { title: "⚠️ Provider error", summary: `${String(d.provider)} error ${String(d.errorCode ?? "")}${d.reason ? `: ${String(d.reason)}` : ""}`, severity: "warning", fields };

    case "rate_limited":
      add("Detail", d.reason, false);
      return { title: "🐢 Rate limited", summary: `${String(d.provider)} rate limited; backing off`, severity: "warning", fields };

    case "clock_jump":
      add("Detail", d.reason, false);
      return { title: "🕰️ Clock jump", summary: `Clock jump: ${String(d.reason ?? "")}`, severity: "warning", fields };

    case "watch_finished":
      add("Outcome", String(d.outcome ?? "").toUpperCase());
      return { title: "🏁 Watch finished", summary: `Watch finished: ${String(d.outcome ?? "")}`, severity: d.outcome === "succeeded" ? "success" : "info", fields };
  }
}

export interface DiscordPayloadOptions {
  username: string;
  mentionRoleId?: string;
  timeZone: string;
}

/** Discord webhook body. Mentions are restricted to the configured role only. */
export function discordPayload(ev: DropEvent, opts: DiscordPayloadOptions): Record<string, unknown> {
  const view = describeEvent(ev, opts.timeZone);
  const loud = ["registration_succeeded", "registration_failed", "registration_ambiguous", "availability_detected", "purchase_blocked", "confirmation_requested"].includes(ev.type);
  const mention = loud && opts.mentionRoleId ? `<@&${opts.mentionRoleId}>` : undefined;
  return {
    username: opts.username,
    ...(mention ? { content: mention } : {}),
    allowed_mentions: { parse: [], roles: mention && opts.mentionRoleId ? [opts.mentionRoleId] : [] },
    embeds: [
      {
        title: view.title.slice(0, 256),
        color: SEVERITY_COLOR[view.severity],
        fields: view.fields.slice(0, 25).map((f) => ({ name: f.name.slice(0, 256), value: f.value.slice(0, 1024), inline: f.inline ?? false })),
        timestamp: new Date(ev.at).toISOString(),
        footer: { text: `target ${ev.targetId}` },
      },
    ],
  };
}
