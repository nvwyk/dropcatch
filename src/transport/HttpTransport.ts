import { randomUUID } from "node:crypto";
import { request as undiciRequest, type Dispatcher } from "undici";
import { sleep } from "../core/clock.ts";
import type { ErrorCode } from "../core/errors.ts";
import type { Logger } from "../logging/logger.ts";
import { silentLogger } from "../logging/logger.ts";
import { ProxyRouter } from "./ProxyRouter.ts";
import {
  backoffDelay,
  NO_RETRY,
  shouldRetryError,
  shouldRetryStatus,
  type RetryPolicy,
} from "./RetryPolicy.ts";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";

export interface HttpRequest {
  method: HttpMethod;
  url: string;
  headers?: Record<string, string>;
  /** Serialized as JSON with the matching content-type. */
  json?: unknown;
  /** Serialized as application/x-www-form-urlencoded. */
  form?: Record<string, string>;
  body?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  retry?: RetryPolicy;
  /** Proxy pool name, "direct" or undefined (direct). */
  proxy?: string;
  /** Short label for logs, e.g. "porkbun.check". Never log the URL itself (it may carry keys). */
  label?: string;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
  startedAt: number;
  finishedAt: number;
  latencyMs: number;
  /** Parsed `Date` header (second precision). */
  serverDate?: number;
  attempts: number;
  requestId: string;
}

/**
 * Transport failure. `sent` answers the question that matters for purchases:
 * "no"    = the request provably never reached the server (DNS, refused, connect timeout).
 * "maybe" = it may have been received and processed (reset, header/body timeout, abort).
 */
export class TransportError extends Error {
  readonly code: ErrorCode;
  readonly sent: "no" | "maybe";
  readonly latencyMs: number;

  constructor(code: ErrorCode, sent: "no" | "maybe", message: string, latencyMs: number, cause?: unknown) {
    super(message, { cause });
    this.name = "TransportError";
    this.code = code;
    this.sent = sent;
    this.latencyMs = latencyMs;
  }
}

export interface HttpTransport {
  request(req: HttpRequest): Promise<HttpResponse>;
}

export function parseJson<T = unknown>(res: HttpResponse): T | undefined {
  if (!res.text) return undefined;
  try {
    return JSON.parse(res.text) as T;
  } catch {
    return undefined;
  }
}

/** Retry-After (seconds or HTTP date) in ms. */
export function retryAfterMs(res: HttpResponse, now = Date.now()): number | undefined {
  const value = res.headers["retry-after"];
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

const NOT_SENT_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
]);

function errorCodeOf(err: unknown): string | undefined {
  let current: unknown = err;
  for (let i = 0; i < 4 && current; i++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export function classifyError(
  err: unknown,
  latencyMs: number,
  ctx: { timedOut: boolean; externalAbort: boolean },
): TransportError {
  if (err instanceof TransportError) return err;
  const code = errorCodeOf(err);
  const message = err instanceof Error ? err.message : String(err);
  if (ctx.externalAbort) return new TransportError("ABORTED", "maybe", "request aborted", latencyMs, err);
  if (ctx.timedOut || code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT") {
    return new TransportError("NETWORK_TIMEOUT", "maybe", "request timed out after connecting", latencyMs, err);
  }
  if (code === "UND_ERR_CONNECT_TIMEOUT") {
    return new TransportError("NETWORK_TIMEOUT", "no", "connect timeout", latencyMs, err);
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return new TransportError("DNS_ERROR", "no", `DNS lookup failed (${code})`, latencyMs, err);
  }
  if (code && NOT_SENT_CODES.has(code)) {
    return new TransportError("NETWORK_ERROR", "no", `connection failed (${code})`, latencyMs, err);
  }
  return new TransportError("NETWORK_ERROR", "maybe", `network error${code ? ` (${code})` : ""}: ${message}`, latencyMs, err);
}

export interface UndiciTransportOptions {
  router?: ProxyRouter;
  logger?: Logger;
  userAgent?: string;
}

export class UndiciTransport implements HttpTransport {
  private readonly router: ProxyRouter;
  private readonly logger: Logger;
  private readonly userAgent: string;

  constructor(options: UndiciTransportOptions = {}) {
    this.router = options.router ?? new ProxyRouter();
    this.logger = options.logger ?? silentLogger;
    this.userAgent = options.userAgent ?? "dropcatch";
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    const policy = req.retry ?? NO_RETRY;
    const requestId = randomUUID();
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await this.once(req, requestId, attempt);
        if (shouldRetryStatus(policy, res.status, attempt)) {
          const delay = backoffDelay(policy, attempt);
          this.logger.debug("retrying after HTTP status", { label: req.label, status: res.status, attempt, delay });
          await sleep(delay, req.signal);
          continue;
        }
        return res;
      } catch (err) {
        const terr = err as TransportError;
        if (!shouldRetryError(policy, terr, attempt) || req.signal?.aborted) throw terr;
        const delay = backoffDelay(policy, attempt);
        this.logger.debug("retrying after network error", { label: req.label, code: terr.code, attempt, delay });
        await sleep(delay, req.signal);
      }
    }
  }

  private async once(req: HttpRequest, requestId: string, attempt: number): Promise<HttpResponse> {
    const route = this.router.route(req.proxy);
    const headers: Record<string, string> = {
      "user-agent": this.userAgent,
      accept: "application/json",
      "x-request-id": requestId,
      ...req.headers,
    };
    let body = req.body;
    if (req.json !== undefined) {
      body = JSON.stringify(req.json);
      headers["content-type"] = "application/json";
    } else if (req.form) {
      body = new URLSearchParams(req.form).toString();
      headers["content-type"] = "application/x-www-form-urlencoded";
    }

    const timeout = AbortSignal.timeout(req.timeoutMs);
    const signal = req.signal ? AbortSignal.any([timeout, req.signal]) : timeout;
    const startedAt = Date.now();
    try {
      const res = await undiciRequest(req.url, {
        method: req.method,
        headers,
        body,
        signal,
        dispatcher: route.dispatcher as Dispatcher,
        headersTimeout: req.timeoutMs,
        bodyTimeout: req.timeoutMs,
      });
      const text = await res.body.text();
      const finishedAt = Date.now();
      const flat: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) {
        if (v !== undefined) flat[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
      }
      const serverDate = flat.date ? Date.parse(flat.date) : Number.NaN;
      this.logger.trace("http", {
        label: req.label,
        status: res.statusCode,
        latencyMs: finishedAt - startedAt,
        route: route.label,
        attempt,
      });
      return {
        status: res.statusCode,
        headers: flat,
        text,
        startedAt,
        finishedAt,
        latencyMs: finishedAt - startedAt,
        serverDate: Number.isFinite(serverDate) ? serverDate : undefined,
        attempts: attempt,
        requestId,
      };
    } catch (err) {
      const latency = Date.now() - startedAt;
      const terr = classifyError(err, latency, {
        timedOut: timeout.aborted,
        externalAbort: req.signal?.aborted === true && !timeout.aborted,
      });
      if (terr.code !== "ABORTED") route.reportFailure();
      this.logger.debug("http error", { label: req.label, code: terr.code, sent: terr.sent, latencyMs: latency, route: route.label });
      throw terr;
    }
  }
}
