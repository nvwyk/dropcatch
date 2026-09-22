import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RateLimiter } from "../../src/providers/RateLimiter.ts";
import { Redactor } from "../../src/security/redaction.ts";
import { classifyError, TransportError } from "../../src/transport/HttpTransport.ts";
import {
  AVAILABILITY_RETRY,
  backoffDelay,
  READ_RETRY,
  REGISTRATION_RETRY,
  shouldRetryError,
  shouldRetryStatus,
} from "../../src/transport/RetryPolicy.ts";

describe("rate limiter", () => {
  it("enforces min interval, concurrency and per-minute caps without queueing", () => {
    let now = 0;
    const l = new RateLimiter({ minIntervalMs: 1000, maxConcurrentRequests: 1, requestsPerMinute: 3 }, () => now);
    const r1 = l.tryAcquire();
    assert.ok(r1);
    assert.equal(l.tryAcquire(), null, "still in flight");
    r1!();
    assert.equal(l.tryAcquire(), null, "min interval not elapsed");
    now = 1000;
    l.tryAcquire()!();
    now = 2000;
    l.tryAcquire()!();
    now = 3000;
    assert.equal(l.tryAcquire(), null, "3 per minute reached");
    now = 60_001;
    assert.ok(l.tryAcquire());
  });

  it("honours Retry-After pauses and makes acquire() wait", async () => {
    const l = new RateLimiter({ maxConcurrentRequests: 1 });
    l.pauseUntil(Date.now() + 40);
    assert.equal(l.tryAcquire(), null);
    const started = Date.now();
    const release = await l.acquire();
    assert.ok(Date.now() - started >= 30);
    release();
  });
});

describe("retry policy", () => {
  const maybe = new TransportError("NETWORK_TIMEOUT", "maybe", "t", 1);
  const notSent = new TransportError("NETWORK_ERROR", "no", "refused", 1);

  it("never retries a registration that may have reached the server", () => {
    assert.equal(shouldRetryError(REGISTRATION_RETRY, maybe, 1), false);
    assert.equal(shouldRetryError(REGISTRATION_RETRY, notSent, 1), true);
    assert.equal(shouldRetryError(REGISTRATION_RETRY, notSent, 2), false);
    assert.equal(shouldRetryStatus(REGISTRATION_RETRY, 503, 1), false);
  });

  it("retries idempotent reads on transient failures only", () => {
    assert.equal(shouldRetryError(AVAILABILITY_RETRY, maybe, 1), true);
    assert.equal(shouldRetryStatus(AVAILABILITY_RETRY, 503, 1), true);
    assert.equal(shouldRetryStatus(AVAILABILITY_RETRY, 401, 1), false);
    assert.equal(shouldRetryStatus(AVAILABILITY_RETRY, 429, 1), false);
    assert.equal(shouldRetryError(READ_RETRY, new TransportError("ABORTED", "maybe", "a", 1), 1), false);
  });

  it("keeps backoff within bounds", () => {
    for (let attempt = 1; attempt <= 5; attempt++) {
      for (const rnd of [0, 0.5, 1]) {
        const d = backoffDelay(READ_RETRY, attempt, () => rnd);
        assert.ok(d >= 100 && d <= READ_RETRY.maxDelayMs, `${attempt}/${rnd} -> ${d}`);
      }
    }
  });

  it("classifies transport errors by whether the request could have been processed", () => {
    const err = (code: string): Error => Object.assign(new Error(code), { code });
    const c = (code: string) => classifyError(err(code), 5, { timedOut: false, externalAbort: false });
    assert.deepEqual([c("ENOTFOUND").code, c("ENOTFOUND").sent], ["DNS_ERROR", "no"]);
    assert.deepEqual([c("ECONNREFUSED").code, c("ECONNREFUSED").sent], ["NETWORK_ERROR", "no"]);
    assert.deepEqual([c("UND_ERR_CONNECT_TIMEOUT").code, c("UND_ERR_CONNECT_TIMEOUT").sent], ["NETWORK_TIMEOUT", "no"]);
    assert.deepEqual([c("ECONNRESET").code, c("ECONNRESET").sent], ["NETWORK_ERROR", "maybe"]);
    assert.deepEqual([c("UND_ERR_HEADERS_TIMEOUT").code, c("UND_ERR_HEADERS_TIMEOUT").sent], ["NETWORK_TIMEOUT", "maybe"]);
    const timedOut = classifyError(new Error("aborted"), 5, { timedOut: true, externalAbort: false });
    assert.deepEqual([timedOut.code, timedOut.sent], ["NETWORK_TIMEOUT", "maybe"]);
    assert.equal(classifyError(new Error("x"), 5, { timedOut: false, externalAbort: true }).code, "ABORTED");
  });
});

describe("redaction", () => {
  it("removes known secret values and common secret patterns", () => {
    const r = new Redactor();
    r.addSecret("pk1_supersecretvalue");
    const text = r.redact(
      'key pk1_supersecretvalue url https://discord.com/api/webhooks/123/abcDEF-xyz proxy socks5://bob:hunter2@10.0.0.1:1080 Authorization: Bearer abcdefghijklmnop {"secretapikey":"sk1_zzz"}',
    );
    assert.ok(!text.includes("supersecretvalue"));
    assert.ok(!text.includes("abcDEF-xyz"));
    assert.ok(!text.includes("hunter2"));
    assert.ok(!text.includes("abcdefghijklmnop"));
    assert.ok(!text.includes("sk1_zzz"));
    assert.ok(text.includes("https://discord.com/api/webhooks/123/[REDACTED]"));
  });

  it("redacts nested values and secret-named keys", () => {
    const r = new Redactor();
    const out = r.redactValue({ apiKey: "plain", nested: { password: "x", note: "ok" }, list: ["Bearer 123456789abcdefgh"] });
    assert.deepEqual(out, { apiKey: "[REDACTED]", nested: { password: "[REDACTED]", note: "ok" }, list: ["Bearer [REDACTED]"] });
  });
});
