import { createInterface, type Interface } from "node:readline/promises";
import { Writable } from "node:stream";
import type { ConfirmFn } from "../core/registration/RegistrationService.ts";
import { formatMoney } from "../core/types.ts";
import { bold, bad } from "./output.ts";

export function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

/** stdout wrapper that can swallow readline's echo while a secret is typed. */
class MutableStdout extends Writable {
  muted = false;

  override _write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (!this.muted) process.stdout.write(chunk, encoding);
    callback();
  }
}

export class Prompter {
  private readonly output = new MutableStdout();
  private readonly rl: Interface;

  constructor() {
    this.rl = createInterface({ input: process.stdin, output: this.output, terminal: true });
  }

  async ask(question: string, defaultValue?: string): Promise<string> {
    const suffix = defaultValue ? ` [${defaultValue}]` : "";
    const answer = (await this.rl.question(`${question}${suffix}: `)).trim();
    return answer || defaultValue || "";
  }

  /** Input is not echoed. Never print the returned value. */
  async askSecret(question: string): Promise<string> {
    process.stdout.write(`${question} (hidden, Enter to skip): `);
    this.output.muted = true;
    try {
      return (await this.rl.question("")).trim();
    } finally {
      this.output.muted = false;
      process.stdout.write("\n");
    }
  }

  async choose<T extends string>(question: string, options: readonly T[], defaultValue: T): Promise<T> {
    for (;;) {
      const answer = await this.ask(`${question} (${options.join("/")})`, defaultValue);
      const match = options.find((o) => o.toLowerCase() === answer.toLowerCase());
      if (match) return match;
      process.stdout.write(`Please answer one of: ${options.join(", ")}\n`);
    }
  }

  async confirm(question: string, defaultYes = false): Promise<boolean> {
    const answer = (await this.ask(`${question} (y/n)`, defaultYes ? "y" : "n")).toLowerCase();
    return answer === "y" || answer === "yes";
  }

  close(): void {
    this.rl.close();
  }
}

/**
 * Typed-domain confirmation used by confirm mode and `buy` without --yes.
 * Prompts are serialized so concurrent targets never interleave.
 */
export function terminalConfirm(): ConfirmFn {
  let chain: Promise<unknown> = Promise.resolve();
  return (request) => {
    const run = async (): Promise<boolean> => {
      const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
      const signals = [AbortSignal.timeout(request.timeoutMs)];
      if (request.signal) signals.push(request.signal);
      try {
        process.stdout.write(
          `\n${bad(bold("CONFIRM PURCHASE"))}: ${bold(request.domain)} via ${request.provider} for ${bold(formatMoney(request.price))}\n`,
        );
        const answer = await rl.question(
          `Type the domain name to register it (${Math.round(request.timeoutMs / 1000)}s): `,
          { signal: AbortSignal.any(signals) },
        );
        return answer.trim().toLowerCase().replace(/\.$/, "") === request.domain;
      } catch {
        process.stdout.write("\nNo confirmation received.\n");
        return false;
      } finally {
        rl.close();
      }
    };
    const result = chain.then(run, run);
    chain = result.catch(() => undefined);
    return result;
  };
}
