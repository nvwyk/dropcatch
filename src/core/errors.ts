/** Stable internal error taxonomy (plan section 53). Provider-specific codes are mapped onto these. */
export const ERROR_CODES = [
  "NETWORK_TIMEOUT",
  "NETWORK_ERROR",
  "DNS_ERROR",
  "ABORTED",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_ERROR",
  "INVALID_RESPONSE",
  "RATE_LIMITED",
  "INVALID_DOMAIN",
  "DOMAIN_UNAVAILABLE",
  "DOMAIN_RESERVED",
  "DOMAIN_PREMIUM",
  "DOMAIN_UNSUPPORTED",
  "REGISTRATION_REJECTED",
  "REGISTRATION_PENDING",
  "REGISTRATION_UNKNOWN",
  "AUTHENTICATION_FAILED",
  "CREDENTIALS_MISSING",
  "INSUFFICIENT_FUNDS",
  "PRICE_CHANGED",
  "BUDGET_EXCEEDED",
  "CONFIGURATION_ERROR",
] as const;

export type KnownErrorCode = (typeof ERROR_CODES)[number];
export type ErrorCode = KnownErrorCode | `HTTP_${number}`;

export function httpErrorCode(status: number): ErrorCode {
  return `HTTP_${status}`;
}

export class AppError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AppError";
    this.code = code;
  }
}

export class ConfigError extends Error {
  readonly issues: string[];
  /** The headline without the issue list. */
  readonly summary: string;

  constructor(message: string, issues: string[] = []) {
    super(issues.length ? `${message}\n  - ${issues.join("\n  - ")}` : message);
    this.name = "ConfigError";
    this.issues = issues;
    this.summary = message;
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
