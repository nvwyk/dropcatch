import type { ErrorCode } from "../core/errors.ts";
import { httpErrorCode } from "../core/errors.ts";
import type {
  AvailabilityResult,
  AvailabilityStatus,
  RegistrationResult,
  RegistrationStatus,
  SourceKind,
} from "../core/types.ts";
import { nowIso } from "../core/types.ts";
import { TransportError, type HttpResponse } from "../transport/HttpTransport.ts";

export interface CallMeta {
  provider: string;
  providerType: string;
  domain: string;
  startedMs: number;
}

export function startCall(provider: string, providerType: string, domain: string, now = Date.now()): CallMeta {
  return { provider, providerType, domain, startedMs: now };
}

/** Server clock minus local clock, estimated at the request midpoint. */
export function clockSkew(res: HttpResponse): number | undefined {
  if (res.serverDate === undefined) return undefined;
  const midpoint = res.startedAt + res.latencyMs / 2;
  // Date headers have 1s resolution: compare against the local second the server most likely saw.
  return res.serverDate - Math.floor(midpoint / 1000) * 1000;
}

export function availability(
  meta: CallMeta,
  sourceKind: SourceKind,
  status: AvailabilityStatus,
  extra: Partial<AvailabilityResult> = {},
  finishedMs = Date.now(),
): AvailabilityResult {
  return {
    provider: meta.provider,
    providerType: meta.providerType,
    sourceKind,
    domain: meta.domain,
    status,
    startedAt: nowIso(meta.startedMs),
    checkedAt: nowIso(finishedMs),
    latencyMs: Math.max(0, finishedMs - meta.startedMs),
    ...extra,
  };
}

export function availabilityFromError(meta: CallMeta, sourceKind: SourceKind, err: unknown): AvailabilityResult {
  if (err instanceof TransportError) {
    return availability(meta, sourceKind, "error", { errorCode: err.code, reason: err.message });
  }
  return availability(meta, sourceKind, "error", {
    errorCode: "PROVIDER_ERROR",
    reason: err instanceof Error ? err.message : String(err),
  });
}

/** Common HTTP status handling for availability checks. Returns undefined for 2xx. */
export function availabilityFromHttpStatus(
  meta: CallMeta,
  sourceKind: SourceKind,
  res: HttpResponse,
  retryAfter?: number,
): AvailabilityResult | undefined {
  if (res.status >= 200 && res.status < 300) return undefined;
  if (res.status === 429) {
    return availability(meta, sourceKind, "rate_limited", {
      errorCode: "RATE_LIMITED",
      reason: "provider rate limit",
      retryAfterMs: retryAfter,
    }, res.finishedAt);
  }
  if (res.status === 401 || res.status === 403) {
    return availability(meta, sourceKind, "error", {
      errorCode: "AUTHENTICATION_FAILED",
      reason: `HTTP ${res.status}`,
    }, res.finishedAt);
  }
  return availability(meta, sourceKind, "error", {
    errorCode: res.status >= 500 ? "PROVIDER_UNAVAILABLE" : httpErrorCode(res.status),
    reason: `HTTP ${res.status}`,
  }, res.finishedAt);
}

export function registration(
  meta: CallMeta,
  status: RegistrationStatus,
  extra: Partial<RegistrationResult> = {},
  finishedMs = Date.now(),
): RegistrationResult {
  return {
    provider: meta.provider,
    providerType: meta.providerType,
    domain: meta.domain,
    status,
    startedAt: nowIso(meta.startedMs),
    finishedAt: nowIso(finishedMs),
    latencyMs: Math.max(0, finishedMs - meta.startedMs),
    ...extra,
  };
}

/**
 * A transport failure during a registration is only a CONFIRMED failure when the request
 * provably never left this machine. Everything else is "unknown": the purchase may exist.
 */
export function registrationFromError(meta: CallMeta, err: unknown): RegistrationResult {
  if (err instanceof TransportError) {
    return registration(meta, err.sent === "no" ? "failed" : "unknown", {
      errorCode: err.sent === "no" ? err.code : "REGISTRATION_UNKNOWN",
      reason: err.message,
    });
  }
  return registration(meta, "unknown", {
    errorCode: "REGISTRATION_UNKNOWN",
    reason: err instanceof Error ? err.message : String(err),
  });
}

/**
 * HTTP status for a registration request without a decisive body.
 * 5xx, 408 and 409 may hide a completed purchase, so they are "unknown".
 */
export function registrationStatusForHttp(status: number): { status: RegistrationStatus; code: ErrorCode } {
  if (status >= 500 || status === 408 || status === 409) {
    return { status: "unknown", code: "REGISTRATION_UNKNOWN" };
  }
  if (status === 429) return { status: "failed", code: "RATE_LIMITED" };
  if (status === 401 || status === 403) return { status: "failed", code: "AUTHENTICATION_FAILED" };
  return { status: "failed", code: httpErrorCode(status) };
}

/** Parse "9.73", 9.73, "$9.73" into a finite positive number. */
export function parseDecimal(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return undefined;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}

/** Truthy provider flags: true, "yes", "1", "true". */
export function flag(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return ["yes", "true", "1", "y"].includes(value.trim().toLowerCase());
  return false;
}
