const MASK = "[REDACTED]";

const PATTERNS: Array<[RegExp, string]> = [
  // Discord webhook URLs (token part).
  [/(https?:\/\/(?:[a-z]+\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/)[\w-]+/gi, `$1${MASK}`],
  // Telegram bot tokens, alone or inside API URLs.
  [/(api\.telegram\.org\/bot)[^/\s]+/gi, `$1${MASK}`],
  [/\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, MASK],
  // URL userinfo, e.g. proxy credentials: scheme://user:pass@host
  [/([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, `$1${MASK}@`],
  // Authorization headers / bearer tokens.
  [/(authorization["']?\s*[:=]\s*["']?)(?:bearer\s+|basic\s+)?[^\s"',}]+/gi, `$1${MASK}`],
  [/\bbearer\s+[a-z0-9._~+/-]{8,}=*/gi, `Bearer ${MASK}`],
  // Porkbun-style keys.
  [/\b(pk1|sk1)_[a-z0-9_]{8,}/gi, `$1_${MASK}`],
  // JSON / query / form fields that carry secrets.
  [
    /(["']?(?:apikey|secretapikey|api_key|apiKey|ApiKey|secret|password|token|x-api-key|x-secret-api-key)["']?\s*[:=]\s*["']?)[^"'&\s,}]+/gi,
    `$1${MASK}`,
  ],
];

/**
 * Removes secrets from strings and structured values. Known secret values (resolved
 * credentials) are replaced verbatim. Patterns catch anything that slipped through.
 */
export class Redactor {
  private readonly secrets = new Set<string>();

  addSecret(value: string | undefined): void {
    if (!value) return;
    const trimmed = value.trim();
    if (trimmed.length >= 4) this.secrets.add(trimmed);
  }

  redact(text: string): string {
    let out = text;
    // Longest first, so a secret that contains another secret is fully masked.
    for (const secret of [...this.secrets].sort((a, b) => b.length - a.length)) {
      if (out.includes(secret)) out = out.split(secret).join(MASK);
    }
    for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
    return out;
  }

  redactValue<T>(value: T): T {
    return this.walk(value, new WeakSet()) as T;
  }

  private walk(value: unknown, seen: WeakSet<object>): unknown {
    if (typeof value === "string") return this.redact(value);
    if (value === null || typeof value !== "object") return value;
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    if (value instanceof Error) {
      return { name: value.name, message: this.redact(value.message), code: (value as { code?: unknown }).code };
    }
    if (Array.isArray(value)) return value.map((v) => this.walk(v, seen));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = /^(apikey|secretapikey|api_?key|secret|password|token|authorization|webhook(url)?)$/i.test(k) && v
        ? MASK
        : this.walk(v, seen);
    }
    return out;
  }
}

/** Show only the host of a URL, e.g. for printing a configured webhook or proxy. */
export function describeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "[invalid url]";
  }
}
