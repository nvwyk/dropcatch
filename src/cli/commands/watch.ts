import type { ResolvedTarget } from "../../config/loader.ts";
import { ConfigError } from "../../core/errors.ts";
import type { WatchOutcome } from "../../core/orchestration/DropOrchestrator.ts";
import { formatDuration, formatInstant } from "../../core/time.ts";
import { displayDomain } from "../../domain/normalize.ts";
import { EventPublisher } from "../../notifications/Notifier.ts";
import { VERSION } from "../../version.ts";
import { bad, bold, dim, good, kv, out, printJson, warn } from "../output.ts";
import { isInteractive, terminalConfirm } from "../prompt.ts";
import type { Runtime } from "../runtime.ts";
import { exitCodeFor, prepareWatch } from "../watchSupport.ts";

export function selectTargets(rt: Runtime, ids?: string[]): ResolvedTarget[] {
  if (!ids?.length) {
    const enabled = rt.config.targets.filter((t) => t.enabled);
    if (enabled.length === 0) throw new ConfigError("No enabled targets in the config");
    return enabled;
  }
  return ids.map((id) => {
    const t = rt.config.targets.find((x) => x.id === id);
    if (!t) throw new ConfigError(`Unknown target "${id}" (known: ${rt.config.targets.map((x) => x.id).join(", ")})`);
    return t;
  });
}

function modeLabel(t: ResolvedTarget): string {
  switch (t.registration.mode) {
    case "auto-buy":
      return bad(bold("AUTO-BUY"));
    case "confirm":
      return warn(bold("CONFIRM"));
    default:
      return good("NOTIFY ONLY");
  }
}

function printBanner(rt: Runtime, targets: ResolvedTarget[], dryRun: boolean): void {
  const tz = rt.config.app.timezone;
  out(bold(`dropcatch v${VERSION}`));
  for (const t of targets) {
    out();
    out(`${bold("Target:")}         ${displayDomain(t.domain)} ${dim(`(${t.id})`)}`);
    if (t.drop) {
      const inMs = t.drop.expectedAtMs - Date.now();
      kv("Expected drop", `${formatInstant(t.drop.expectedAtMs, "UTC", { withDate: true, withZone: true })}${tz !== "UTC" ? dim(` / ${formatInstant(t.drop.expectedAtMs, tz, { withDate: true, withZone: true })}`) : ""} ${dim(inMs > 0 ? `in ${formatDuration(inMs)}` : `${formatDuration(-inMs)} ago`)}`, 0, 16);
    } else {
      kv("Expected drop", dim("not set, polling continuously"), 0, 16);
    }
    kv("Mode", modeLabel(t), 0, 16);
    kv("Sources", t.availability.sources.join(", ") + dim(` (quorum: ${t.availability.quorum})`), 0, 16);
    if (t.registration.active) {
      kv("Registrar", t.registration.providers.join(" -> "), 0, 16);
      const b = t.registration.budget;
      kv("Budget", b.maxRegistrationPrice !== undefined ? `${b.maxRegistrationPrice.toFixed(2)} ${b.currency}` : warn("none"), 0, 16);
    }
    kv("Discord", t.notifications.discord.enabled && process.env[t.notifications.discord.webhookEnv] ? good("ENABLED") : warn("DISABLED"), 0, 16);
    kv("Safety", `DRY RUN = ${dryRun ? good("ON") : bad(bold("OFF"))}   PREMIUM = ${t.registration.budget.allowPremium ? warn("ALLOWED") : good("BLOCKED")}`, 0, 16);
  }
  out();
}

export async function watchCommand(rt: Runtime, opts: { target?: string[]; dryRun?: boolean; json?: boolean }): Promise<number> {
  const targets = selectTargets(rt, opts.target);
  const dryRun = rt.config.app.dryRun || opts.dryRun === true;
  const store = rt.openStore();
  const notifier = rt.buildNotifier(targets);
  const events = new EventPublisher({ store, logger: rt.logger, notifier, timeZone: rt.config.app.timezone });
  const confirm = isInteractive() ? terminalConfirm() : undefined;

  const orchestrators = [];
  for (const target of targets) {
    orchestrators.push({ target, orchestrator: await prepareWatch(rt, target, { store, events, dryRun, confirm }) });
  }
  if (!opts.json) printBanner(rt, targets, dryRun);

  const controller = new AbortController();
  let interrupts = 0;
  const onSignal = (sig: NodeJS.Signals): void => {
    interrupts++;
    if (interrupts === 1) {
      rt.logger.warn(`${sig} received: stopping watches. A registration already in flight is allowed to finish. Press Ctrl+C again to force quit.`);
      controller.abort();
    } else {
      rt.logger.error("Forced exit. Any in-flight registration will show as AMBIGUOUS on the next start.");
      process.exit(130);
    }
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  let outcomes: WatchOutcome[];
  try {
    outcomes = await Promise.all(orchestrators.map(({ orchestrator }) => orchestrator.run(controller.signal)));
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await notifier.drain(5000);
  }

  if (opts.json) {
    printJson(targets.map((t, i) => ({ target: t.id, domain: t.domain.ascii, outcome: outcomes[i] })));
  } else {
    out();
    out(bold("Summary"));
    targets.forEach((t, i) => kv(t.id, String(outcomes[i]).toUpperCase()));
  }
  return exitCodeFor(outcomes);
}
