import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { ConfigError } from "../core/errors.ts";

const KEY = /^[A-Z_][A-Z0-9_]*$/;

function quote(value: string): string {
  if (/[\r\n]/.test(value)) throw new ConfigError("Secret values cannot contain line breaks");
  if (!value.includes('"')) return `"${value}"`;
  if (!value.includes("'")) return `'${value}'`;
  throw new ConfigError("Secret values cannot contain both single and double quotes");
}

/** Names defined in a .env file (values are never returned). */
export function envFileKeys(path: string): Set<string> {
  if (!existsSync(path)) return new Set();
  const keys = new Set<string>();
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=/.exec(line);
    if (m) keys.add(m[1]!);
  }
  return keys;
}

/**
 * Create or update entries in a .env file, keeping comments and unrelated lines.
 * `undefined` removes a key. The file is written with mode 600.
 */
export function upsertEnvFile(path: string, entries: Record<string, string | undefined>): void {
  for (const key of Object.keys(entries)) {
    if (!KEY.test(key)) throw new ConfigError(`Invalid environment variable name "${key}"`);
  }
  const lines = existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/) : ["# dropcatch secrets. Keep this file private (chmod 600) and out of git."];
  const pending = new Map(Object.entries(entries));
  const next: string[] = [];
  for (const line of lines) {
    const m = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=/.exec(line);
    if (m && pending.has(m[1]!)) {
      const value = pending.get(m[1]!);
      pending.delete(m[1]!);
      if (value !== undefined) next.push(`${m[1]}=${quote(value)}`);
      continue;
    }
    next.push(line);
  }
  while (next.length && next[next.length - 1] === "") next.pop();
  for (const [key, value] of pending) if (value !== undefined) next.push(`${key}=${quote(value)}`);
  writeFileSync(path, `${next.join("\n")}\n`, { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(path, 0o600);
}
