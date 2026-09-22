import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";

const PARAMS = { N: 16_384, r: 8, p: 1, keylen: 32 } as const;
export const MIN_PASSWORD_LENGTH = 10;

function scrypt(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** "scrypt$N$r$p$salt$hash" (base64url). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize("NFKC"), salt, PARAMS.keylen, { N: PARAMS.N, r: PARAMS.r, p: PARAMS.p });
  return ["scrypt", PARAMS.N, PARAMS.r, PARAMS.p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, saltText, hashText] = stored.split("$");
  if (scheme !== "scrypt" || !saltText || !hashText) return false;
  const expected = Buffer.from(hashText, "base64url");
  const key = await scrypt(password.normalize("NFKC"), Buffer.from(saltText, "base64url"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

export function passwordProblem(password: unknown): string | undefined {
  if (typeof password !== "string") return "Password is required.";
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password.length > 256) return "Use at most 256 characters.";
  if (new Set(password).size < 4) return "Use a less repetitive password.";
  return undefined;
}

export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Sessions are stored by hash, so a leaked database cannot be replayed as a cookie. */
export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Brute-force protection: 5 failures per IP in 15 minutes locks that IP for 15 minutes,
 * and more than 30 failures per minute across all IPs slows everyone down.
 */
export class LoginThrottle {
  private readonly failures = new Map<string, number[]>();
  private global: number[] = [];
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Milliseconds until this IP may try again (0 = allowed). */
  retryAfter(ip: string): number {
    const t = this.now();
    const list = (this.failures.get(ip) ?? []).filter((x) => t - x < 15 * 60_000);
    this.failures.set(ip, list);
    this.global = this.global.filter((x) => t - x < 60_000);
    if (list.length >= 5) return list[0]! + 15 * 60_000 - t;
    if (this.global.length >= 30) return this.global[0]! + 60_000 - t;
    return 0;
  }

  fail(ip: string): void {
    const t = this.now();
    this.failures.set(ip, [...(this.failures.get(ip) ?? []), t]);
    this.global.push(t);
  }

  succeed(ip: string): void {
    this.failures.delete(ip);
  }
}
