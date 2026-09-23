import type { ErrorCode } from "./errors.ts";

export interface Money {
  amount: number;
  currency: string;
}

export type AvailabilityStatus =
  | "available"
  | "unavailable"
  | "unknown"
  | "unsupported"
  | "rate_limited"
  | "error";

/** Statuses in words, matching the dashboard. "unavailable" reads like an outage, but it means taken. */
export const STATUS_TEXT: Record<AvailabilityStatus, string> = {
  available: "available",
  unavailable: "taken",
  unknown: "unknown",
  unsupported: "unsupported",
  rate_limited: "rate limited",
  error: "error",
};

/** registry = registry data (RDAP). registrar = a registrar's own availability check. */
export type SourceKind = "registry" | "registrar";

export interface AvailabilityRequest {
  /** Normalized ASCII (punycode) domain. */
  domain: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface AvailabilityResult {
  /** Account id (or "rdap"). */
  provider: string;
  /** Plugin id, e.g. "porkbun". */
  providerType: string;
  sourceKind: SourceKind;
  domain: string;
  status: AvailabilityStatus;
  /** false when the name is free but cannot be registered through this channel (e.g. premium via API). */
  registrable?: boolean;
  premium?: boolean;
  price?: Money;
  reason?: string;
  errorCode?: ErrorCode;
  /** The signal is not authoritative for timing, e.g. RDAP data that lags the registry. */
  advisory?: boolean;
  retryAfterMs?: number;
  startedAt: string;
  checkedAt: string;
  latencyMs: number;
  /** Server clock (from the HTTP Date header) minus local clock, when measurable. */
  clockSkewMs?: number;
}

export type RegistrationStatus = "success" | "pending" | "failed" | "unknown";

export interface RegistrationRequest {
  domain: string;
  /** Price validated by the purchase gate. Adapters that require an exact cost must send exactly this. */
  price: Money;
  premium: boolean;
  years: number;
  attemptId: string;
  timeoutMs: number;
}

export interface RegistrationResult {
  provider: string;
  providerType: string;
  domain: string;
  /**
   * success: registered. pending: accepted, not final yet.
   * failed: CONFIRMED failure (provider rejected it, or the request provably never left this machine).
   * unknown: anything else. The purchase may or may not have happened.
   */
  status: RegistrationStatus;
  price?: Money;
  providerReference?: string;
  errorCode?: ErrorCode;
  reason?: string;
  /** True for dry-run results (simulated or provider preflight). */
  simulated?: boolean;
  startedAt: string;
  finishedAt: string;
  latencyMs: number;
}

export type OwnershipStatus = "owned" | "not-owned" | "unknown";

export interface HealthResult {
  ok: boolean;
  latencyMs?: number;
  detail?: string;
}

export function nowIso(ms: number = Date.now()): string {
  return new Date(ms).toISOString();
}

export function formatMoney(money: Money | undefined): string {
  if (!money) return "unknown";
  return `${money.amount.toFixed(2)} ${money.currency}`;
}
