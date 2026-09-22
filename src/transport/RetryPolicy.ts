import type { TransportError } from "./HttpTransport.ts";

export interface RetryPolicy {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** HTTP statuses that may be retried. */
  retryOnStatuses: number[];
  /**
   * "all": retry any retryable network error (safe for idempotent reads).
   * "not-sent": only retry when the request provably never reached the server.
   */
  retryOnNetwork: "all" | "not-sent" | "none";
}

export const NO_RETRY: RetryPolicy = {
  maxRetries: 0,
  baseDelayMs: 0,
  maxDelayMs: 0,
  retryOnStatuses: [],
  retryOnNetwork: "none",
};

/** Availability checks are idempotent reads. One quick retry, the poll loop does the rest. */
export const AVAILABILITY_RETRY: RetryPolicy = {
  maxRetries: 1,
  baseDelayMs: 50,
  maxDelayMs: 250,
  retryOnStatuses: [502, 503, 504],
  retryOnNetwork: "all",
};

/**
 * Registration is not idempotent: a retry after the request may have been processed could
 * buy twice. Only retry when the connection was never established. Never retry on a status.
 */
export const REGISTRATION_RETRY: RetryPolicy = {
  maxRetries: 1,
  baseDelayMs: 100,
  maxDelayMs: 100,
  retryOnStatuses: [],
  retryOnNetwork: "not-sent",
};

/** Housekeeping calls (health checks, ownership lookups, pricing): a little more patient. */
export const READ_RETRY: RetryPolicy = {
  maxRetries: 2,
  baseDelayMs: 200,
  maxDelayMs: 1500,
  retryOnStatuses: [500, 502, 503, 504],
  retryOnNetwork: "all",
};

export function shouldRetryStatus(policy: RetryPolicy, status: number, attempt: number): boolean {
  return attempt <= policy.maxRetries && policy.retryOnStatuses.includes(status);
}

export function shouldRetryError(policy: RetryPolicy, err: TransportError, attempt: number): boolean {
  if (attempt > policy.maxRetries || err.code === "ABORTED") return false;
  if (policy.retryOnNetwork === "none") return false;
  if (policy.retryOnNetwork === "not-sent") return err.sent === "no";
  return true;
}

/** Exponential backoff with full jitter, capped. `attempt` starts at 1 for the first retry. */
export function backoffDelay(policy: RetryPolicy, attempt: number, random: () => number = Math.random): number {
  const exp = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  return Math.round(policy.baseDelayMs / 2 + random() * Math.max(0, exp - policy.baseDelayMs / 2));
}
