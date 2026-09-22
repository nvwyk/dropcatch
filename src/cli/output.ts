import { styleText } from "node:util";

type Style = Parameters<typeof styleText>[0];

let colorEnabled = process.stdout.isTTY === true && !process.env.NO_COLOR;

export function setColor(enabled: boolean): void {
  colorEnabled = enabled && process.stdout.isTTY === true && !process.env.NO_COLOR;
}

export function paint(style: Style, text: string): string {
  return colorEnabled ? styleText(style, text, { validateStream: false }) : text;
}

export const bold = (t: string): string => paint("bold", t);
export const dim = (t: string): string => paint("gray", t);
export const good = (t: string): string => paint("green", t);
export const bad = (t: string): string => paint("red", t);
export const warn = (t: string): string => paint("yellow", t);

export function out(line = ""): void {
  process.stdout.write(`${line}\n`);
}

export function printJson(value: unknown): void {
  out(JSON.stringify(value, (_k, v: unknown) => (v instanceof Set ? [...v] : v), 2));
}

export function kv(label: string, value: string, indent = 2, width = 20): void {
  out(`${" ".repeat(indent)}${`${label}:`.padEnd(width)} ${value}`);
}

export function table(headers: string[], rows: string[][]): void {
  // Strip ANSI codes when measuring.
  // eslint-disable-next-line no-control-regex
  const visible = (s: string): number => s.replace(/\u001b\[[0-9;]*m/g, "").length;
  const widths = headers.map((h, i) => Math.max(visible(h), ...rows.map((r) => visible(r[i] ?? ""))));
  const line = (cells: string[]): string =>
    cells.map((cell, i) => cell + " ".repeat(Math.max(0, widths[i]! - visible(cell)))).join("  ").trimEnd();
  out(bold(line(headers)));
  for (const row of rows) out(line(row));
}

export function yesNo(value: boolean): string {
  return value ? good("yes") : dim("no");
}
