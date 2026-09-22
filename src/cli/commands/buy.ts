import type { ResolvedTarget } from "../../config/loader.ts";
import { systemClock, withTimeout } from "../../core/clock.ts";
import { ConfigError } from "../../core/errors.ts";
import { RegistrationService, type RegistrationOutcome } from "../../core/registration/RegistrationService.ts";
import { describeBlockingState } from "../../core/registration/state.ts";
import { formatMoney } from "../../core/types.ts";
import { normalizeDomain } from "../../domain/normalize.ts";
import { EventPublisher } from "../../notifications/Notifier.ts";
import { strategyFor } from "../../tld/strategies.ts";
import { bad, bold, good, kv, out, printJson, warn } from "../output.ts";
import { isInteractive, terminalConfirm } from "../prompt.ts";
import type { Runtime } from "../runtime.ts";

export interface BuyOptions {
  provider?: string[];
  maxPrice?: string;
  currency?: string;
  allowPremium?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  json?: boolean;
}

export async function buyCommand(rt: Runtime, input: string, opts: BuyOptions): Promise<number> {
  const domain = normalizeDomain(input);
  const base = rt.config.targets.find((t) => t.domain.ascii === domain.ascii);
  const providers = opts.provider?.length ? opts.provider : base?.registration.providers ?? [];
  if (providers.length === 0) throw new ConfigError("Name the registrar account to use with --provider <account>");

  const budget = { ...(base?.registration.budget ?? { currency: "USD", allowPremium: false, requireExactPrice: false }) };
  if (opts.maxPrice !== undefined) {
    const max = Number(opts.maxPrice);
    if (!Number.isFinite(max) || max <= 0) throw new ConfigError("--max-price must be a positive number");
    budget.maxRegistrationPrice = max;
  }
  if (opts.currency) budget.currency = opts.currency.toUpperCase();
  if (opts.allowPremium) budget.allowPremium = true;
  if (budget.maxRegistrationPrice === undefined) {
    throw new ConfigError("A budget is required: pass --max-price <amount> or configure the target's registration.budget");
  }

  const dryRun = rt.config.app.dryRun || opts.dryRun === true;
  const interactive = isInteractive();
  if (!dryRun && !opts.yes && !interactive) throw new ConfigError("Refusing a real purchase in a non-interactive shell without --yes");
  const mode = !dryRun && !opts.yes ? "confirm" : "auto-buy";

  const target: ResolvedTarget = {
    id: base?.id ?? `buy-${domain.ascii}`,
    domain,
    enabled: true,
    tld: strategyFor(domain),
    drop: base?.drop,
    schedule: base?.schedule ?? {
      strategy: "fixed",
      preWindowMs: 0,
      hotWindowMs: 0,
      postWindowMs: 0,
      initialIntervalMs: 5000,
      warmupIntervalMs: 1000,
      hotIntervalMs: 250,
      fixedIntervalMs: 5000,
      alignToDrop: false,
      stopAfterWindow: false,
    },
    requestTimeoutMs: base?.requestTimeoutMs ?? 5000,
    availability: base?.availability ?? { sources: [], quorum: "any", minimumConfirmations: 1 },
    registration: {
      maxAttemptsPerProvider: 1,
      maxTotalAttempts: 1,
      years: 1,
      requestTimeoutMs: 30_000,
      restrictToDropWindow: false,
      confirmTimeoutMs: 120_000,
      onFailure: "stop",
      ...base?.registration,
      active: true,
      mode,
      providers,
      budget,
    },
    notifications: base?.notifications ?? { discord: { enabled: true, webhookEnv: rt.config.notifications.discord.webhookEnv } },
  };

  const store = rt.openStore();
  if (!dryRun && !store.persistent) throw new ConfigError("A real purchase needs a persistent database (app.database must not be :memory:)");
  const candidates = rt.candidatesFor(target, providers);
  if (!dryRun) {
    for (const c of candidates) {
      if (!c.instance.healthCheck) continue;
      const health = await withTimeout(c.instance.healthCheck(8000), 10_000).catch((err: Error) => ({ ok: false, detail: err.message }));
      if (!health.ok) throw new ConfigError(`Account "${c.id}" failed its health check (${health.detail ?? "no detail"}); not buying`);
    }
  }

  const notifier = rt.buildNotifier([target]);
  const events = new EventPublisher({ store, logger: rt.logger, notifier, timeZone: rt.config.app.timezone });
  store.upsertTarget({ id: target.id, domain: domain.ascii, enabled: true, expectedDropAt: target.drop?.expectedAtMs });
  const armed = store.arm(target.id, domain.ascii);
  if (!armed.ok) {
    throw new ConfigError(`Target ${target.id} is locked: ${describeBlockingState(armed.state)}. Run "dropcatch resolve ${target.id}".`);
  }
  store.transition(target.id, domain.ascii, "CHECKING");
  store.transition(target.id, domain.ascii, "AVAILABLE", "manual buy command");

  if (!opts.json) {
    out(`${bold("Buy")} ${domain.ascii} via ${providers.join(" -> ")}  budget ${budget.maxRegistrationPrice.toFixed(2)} ${budget.currency}`);
    out(dryRun ? good("DRY RUN: no registration request will be sent.") : bad(bold("LIVE: this can create a real, non-refundable charge.")));
  }

  const service = new RegistrationService({
    target,
    candidates,
    store,
    events,
    logger: rt.logger,
    clock: systemClock,
    dryRun,
    confirm: interactive ? terminalConfirm() : undefined,
  });
  let outcome: RegistrationOutcome;
  try {
    outcome = await service.execute();
  } finally {
    await notifier.drain(5000);
  }

  switch (outcome.kind) {
    case "dry_run":
    case "false_positive":
      store.transition(target.id, domain.ascii, "IDLE", `buy: ${outcome.kind}`);
      break;
    case "blocked":
    case "declined":
      store.transition(target.id, domain.ascii, "ABORTED", `buy: ${outcome.kind}`);
      break;
    case "failed":
      store.transition(target.id, domain.ascii, "FAILED", "buy: confirmed failure");
      break;
    default:
      break;
  }

  if (opts.json) {
    printJson(outcome);
  } else {
    out();
    kv("Outcome", bold(outcome.kind.toUpperCase()), 0, 12);
    if (outcome.kind === "dry_run") {
      kv("Verdict", outcome.result.status === "success" ? good("would register") : bad("would fail"), 0, 12);
      kv("Price", formatMoney(outcome.gate.price), 0, 12);
      if (outcome.result.reason) kv("Detail", outcome.result.reason, 0, 12);
    } else if (outcome.kind === "blocked") {
      kv("Reasons", outcome.reasons.join(", "), 0, 12);
      for (const d of outcome.details) out(`  ${warn(d)}`);
    } else if (outcome.kind === "failed") {
      for (const r of outcome.results) kv(r.provider, `${r.errorCode ?? r.status}${r.reason ? `: ${r.reason}` : ""}`, 0, 12);
    } else if (outcome.kind === "succeeded" || outcome.kind === "pending" || outcome.kind === "ambiguous") {
      kv("Provider", outcome.result.provider, 0, 12);
      kv("Price", formatMoney(outcome.result.price), 0, 12);
      if (outcome.result.providerReference) kv("Reference", outcome.result.providerReference, 0, 12);
    } else if (outcome.kind === "false_positive") {
      for (const c of outcome.checks) kv(c.provider, `${c.status}${c.reason ? `: ${c.reason}` : ""}`, 0, 12);
    }
  }

  switch (outcome.kind) {
    case "succeeded":
      return 0;
    case "dry_run":
      return outcome.result.status === "success" ? 0 : 4;
    case "pending":
    case "ambiguous":
      return 3;
    default:
      return 4;
  }
}
