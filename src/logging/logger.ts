import { styleText } from "node:util";
import { formatInstant } from "../core/time.ts";
import { Redactor } from "../security/redaction.ts";

export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "silent"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export type LogFormat = "pretty" | "json";
export type LogFields = Record<string, unknown>;

const RANK: Record<LogLevel, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, silent: 99 };

export interface Logger {
  level: LogLevel;
  trace(msg: string, fields?: LogFields): void;
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
  isEnabled(level: LogLevel): boolean;
}

export interface LoggerOptions {
  level?: LogLevel;
  format?: LogFormat;
  timeZone?: string;
  redactor?: Redactor;
  color?: boolean;
  write?: (line: string) => void;
  now?: () => number;
}

type Style = Parameters<typeof styleText>[0];
const LEVEL_STYLE: Record<Exclude<LogLevel, "silent">, Style> = {
  trace: "gray",
  debug: "cyan",
  info: "green",
  warn: "yellow",
  error: "red",
};

/**
 * Structured logger. JSON lines for machines, a compact human format for terminals.
 * Everything passes through the redactor before it is written. Logs go to stderr so
 * `--json` command output on stdout stays machine-readable.
 */
export function createLogger(options: LoggerOptions = {}, bindings: LogFields = {}): Logger {
  const state = {
    level: options.level ?? "info",
    format: options.format ?? "pretty",
    timeZone: options.timeZone ?? "UTC",
    redactor: options.redactor ?? new Redactor(),
    color: options.color ?? (process.stderr.isTTY === true && !process.env.NO_COLOR),
    write: options.write ?? ((line: string) => process.stderr.write(`${line}\n`)),
    now: options.now ?? Date.now,
  };

  const paint = (style: Style, text: string): string =>
    state.color ? styleText(style, text, { validateStream: false }) : text;

  function emit(level: Exclude<LogLevel, "silent">, msg: string, fields?: LogFields): void {
    if (RANK[level] < RANK[logger.level]) return;
    const ts = state.now();
    const merged = state.redactor.redactValue({ ...bindings, ...fields });
    const message = state.redactor.redact(msg);
    if (state.format === "json") {
      state.write(JSON.stringify({ time: new Date(ts).toISOString(), level, msg: message, ...merged }));
      return;
    }
    const time = paint("gray", `[${formatInstant(ts, state.timeZone)}]`);
    const lvl = paint(LEVEL_STYLE[level], level.toUpperCase().padEnd(5));
    const extras = Object.entries(merged)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => paint("gray", `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`))
      .join(" ");
    state.write(`${time} ${lvl} ${message}${extras ? ` ${extras}` : ""}`);
  }

  const logger: Logger = {
    level: state.level,
    trace: (m, f) => emit("trace", m, f),
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    child: (more) => {
      const child = createLogger({ ...options, ...state, level: logger.level }, { ...bindings, ...more });
      return child;
    },
    isEnabled: (level) => RANK[level] >= RANK[logger.level],
  };
  return logger;
}

export const silentLogger: Logger = createLogger({ level: "silent" });
