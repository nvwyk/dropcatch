import { Command, Option } from "commander";
import { AppError, ConfigError } from "../core/errors.ts";
import { LOG_LEVELS } from "../logging/logger.ts";
import { VERSION } from "../version.ts";
import { buyCommand } from "./commands/buy.ts";
import { checkCommand } from "./commands/check.ts";
import { calendarCommand, importCommand } from "./commands/importCalendar.ts";
import { initCommand } from "./commands/init.ts";
import { providersCommand } from "./commands/providers.ts";
import { resolveCommand } from "./commands/resolve.ts";
import { statusCommand } from "./commands/status.ts";
import { testDiscord, testProvider, testTelegram } from "./commands/test.ts";
import { validateCommand } from "./commands/validate.ts";
import { watchCommand } from "./commands/watch.ts";
import { bad, bold, out } from "./output.ts";
import { Runtime, type GlobalOptions } from "./runtime.ts";

const collect = (value: string, previous: string[] = []): string[] => [...previous, ...value.split(",").map((s) => s.trim()).filter(Boolean)];

function globals(cmd: Command): GlobalOptions {
  return cmd.optsWithGlobals<GlobalOptions>();
}

/** Run a command body with a runtime, closing it afterwards and turning errors into exit codes. */
async function withRuntime(
  cmd: Command,
  requireConfig: boolean,
  body: (rt: Runtime, opts: GlobalOptions) => Promise<number>,
): Promise<void> {
  const opts = globals(cmd);
  const rt = await Runtime.load(opts, { requireConfig });
  try {
    process.exitCode = await body(rt, opts);
  } finally {
    await rt.close();
  }
}

export function buildProgram(): Command {
  const program = new Command()
    .name("dropcatch")
    .description("Domain drop watcher and safe auto-buyer")
    .version(VERSION)
    .option("-c, --config <path>", "config file (default: ./config.yaml or $DROPCATCH_CONFIG)")
    .option("--env-file <path>", "load environment variables from this file (default: ./.env)")
    .addOption(new Option("--log-level <level>", "log verbosity").choices([...LOG_LEVELS]))
    .option("--json", "machine-readable output (JSON logs on stderr, JSON results on stdout)")
    .option("--no-color", "disable colors")
    .showHelpAfterError();

  program
    .command("init")
    .description("interactive first-time setup: writes config.yaml and a private .env")
    .option("--force", "overwrite an existing config without asking")
    .action(async (opts: { force?: boolean }, cmd: Command) => {
      process.exitCode = await initCommand({ config: globals(cmd).config, force: opts.force });
    });

  program
    .command("validate")
    .description("validate the config file and print warnings")
    .action(async (_opts: unknown, cmd: Command) => withRuntime(cmd, true, (rt, g) => validateCommand(rt, { json: g.json })));

  program
    .command("providers")
    .description("capability matrix, account credentials and API connectivity")
    .option("--offline", "skip connectivity checks")
    .action(async (opts: { offline?: boolean }, cmd: Command) =>
      withRuntime(cmd, false, (rt, g) => providersCommand(rt, { json: g.json, offline: opts.offline })));

  program
    .command("check")
    .argument("<domain>", "domain to check, e.g. example.pl")
    .description("check availability once across all sources (works without a config: RDAP only)")
    .option("-p, --provider <account>", "only these accounts (repeatable or comma separated)", collect)
    .action(async (domain: string, opts: { provider?: string[] }, cmd: Command) =>
      withRuntime(cmd, false, (rt, g) => checkCommand(rt, domain, { provider: opts.provider, json: g.json })));

  program
    .command("watch")
    .description("watch targets on the adaptive schedule and act when they free up")
    .option("-t, --target <id>", "only these targets (repeatable or comma separated)", collect)
    .option("--dry-run", "force dry-run (it can only be turned OFF in the config)")
    .option("--metrics-port <port>", "serve Prometheus /metrics and /healthz on this port")
    .option("--metrics-host <host>", "bind address for the metrics server (default 127.0.0.1)")
    .action(async (opts: { target?: string[]; dryRun?: boolean; metricsPort?: string; metricsHost?: string }, cmd: Command) =>
      withRuntime(cmd, true, (rt, g) => watchCommand(rt, { ...opts, json: g.json })));

  program
    .command("import")
    .argument("<file>", "CSV with a domain column, or one 'domain [drop time]' per line; - for stdin")
    .description("bulk-add targets to config.yaml (validated as a whole; nothing is written on errors)")
    .option("--dry-run", "show what would be imported")
    .option("--update", "overwrite targets whose id already exists")
    .addOption(new Option("--mode <mode>", "default mode for rows without one").choices(["notify-only", "confirm", "auto-buy"]))
    .option("--max-price <amount>", "default budget for rows without one")
    .option("--currency <code>", "default budget currency")
    .option("-r, --registrar <account>", "registration accounts (repeatable)", collect)
    .option("-s, --source <account>", "availability sources (repeatable)", collect)
    .option("--timezone <tz>", "timezone for drop times without an offset")
    .action(async (file: string, opts: Record<string, unknown>, cmd: Command) =>
      withRuntime(cmd, true, (rt, g) => importCommand(rt, file, { ...opts, json: g.json })));

  program
    .command("calendar")
    .description("upcoming drop windows, optionally exported as an .ics calendar")
    .option("--ics <file>", "write an iCalendar file with every drop window")
    .option("--days <n>", "how far ahead to list", "30")
    .action(async (opts: { ics?: string; days?: string }, cmd: Command) =>
      withRuntime(cmd, true, (rt, g) => calendarCommand(rt, { ...opts, json: g.json })));

  program
    .command("buy")
    .argument("<domain>", "domain to register now")
    .description("one-shot registration through the same gate, lock and audit trail as watch")
    .option("-p, --provider <account>", "registrar account(s), tried in order", collect)
    .option("--max-price <amount>", "refuse above this price")
    .option("--currency <code>", "budget currency (default USD)")
    .option("--allow-premium", "allow premium names (if the provider supports it)")
    .option("--dry-run", "validate and preflight without registering")
    .option("-y, --yes", "skip the typed confirmation (required in non-interactive shells)")
    .action(async (domain: string, opts: Record<string, unknown>, cmd: Command) =>
      withRuntime(cmd, true, (rt, g) => buyCommand(rt, domain, { ...opts, json: g.json })));

  const test = program.command("test").description("test notifications and provider credentials without buying anything");
  test
    .command("discord")
    .description("send a test message to the Discord webhook")
    .option("-t, --target <id>", "use this target's webhook override")
    .action(async (opts: { target?: string }, cmd: Command) =>
      withRuntime(cmd, false, (rt, g) => testDiscord(rt, { json: g.json, target: opts.target })));
  test
    .command("telegram")
    .description("send a test message to the Telegram chat")
    .option("--chats", "list chats that recently messaged the bot (to find your chat id)")
    .action(async (opts: { chats?: boolean }, cmd: Command) =>
      withRuntime(cmd, false, (rt, g) => testTelegram(rt, { json: g.json, chats: opts.chats })));
  test
    .command("provider")
    .argument("<account>", "account id from the config")
    .description("validate credentials and API connectivity")
    .option("-d, --domain <domain>", "also run one availability check for this domain")
    .action(async (account: string, opts: { domain?: string }, cmd: Command) =>
      withRuntime(cmd, true, (rt, g) => testProvider(rt, account, { json: g.json, domain: opts.domain })));

  program
    .command("status")
    .description("persisted target states, attempts, runs, timeline and provider latency")
    .option("-t, --target <id>", "details and event timeline for one target")
    .option("-n, --events <count>", "timeline length", "25")
    .action(async (opts: { target?: string; events?: string }, cmd: Command) =>
      withRuntime(cmd, false, (rt, g) => statusCommand(rt, { ...opts, json: g.json })));

  program
    .command("resolve")
    .argument("<target>", "target id")
    .description("settle an AMBIGUOUS / PENDING / locked target")
    .addOption(new Option("--as <outcome>", "set the outcome manually").choices(["succeeded", "failed", "reset", "auto"]).default("auto"))
    .action(async (target: string, opts: { as?: string }, cmd: Command) =>
      withRuntime(cmd, true, (rt, g) => resolveCommand(rt, target, { as: opts.as, json: g.json })));

  program
    .command("dashboard")
    .alias("serve")
    .description("all-in-one web dashboard: setup, insights, config and watch control")
    .option("--host <host>", "bind address (default 127.0.0.1)")
    .option("--port <port>", "port (default 4747)")
    .option("--public", "bind 0.0.0.0 so other machines can reach it (put HTTPS in front)")
    .option("--watch", "start watching all enabled targets on launch")
    .action(async (opts: { host?: string; port?: string; public?: boolean; watch?: boolean }, cmd: Command) => {
      const { dashboardCommand } = await import("../dashboard/command.ts");
      process.exitCode = await dashboardCommand(globals(cmd), opts);
    });

  return program;
}

export async function main(argv: string[]): Promise<void> {
  try {
    await buildProgram().parseAsync(argv);
  } catch (err) {
    if (err instanceof ConfigError) {
      out(bad(bold("Configuration error")));
      out(err.message);
      process.exitCode = 2;
    } else if (err instanceof AppError) {
      out(bad(`${err.code}: ${err.message}`));
      process.exitCode = 1;
    } else {
      out(bad(`Error: ${err instanceof Error ? err.message : String(err)}`));
      if (process.env.DROPCATCH_DEBUG && err instanceof Error) out(err.stack ?? "");
      process.exitCode = 1;
    }
  }
}
