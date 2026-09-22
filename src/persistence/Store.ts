import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { DropEvent } from "../core/events.ts";
import type { AvailabilityResult, Money, RegistrationResult } from "../core/types.ts";
import { nowIso } from "../core/types.ts";
import {
  ARMABLE_STATES,
  BLOCKING_STATES,
  predecessorsOf,
  type RegistrationState,
} from "../core/registration/state.ts";
import type { Redactor } from "../security/redaction.ts";
import { MIGRATIONS } from "./migrations.ts";

type Row = Record<string, SQLInputValue>;

const v = (value: unknown): SQLInputValue => {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number" || typeof value === "string" || typeof value === "bigint") return value;
  return JSON.stringify(value);
};

export interface TargetStateRow {
  targetId: string;
  domain: string;
  state: RegistrationState;
  detail: string | null;
  updatedAt: string;
  resetAt: string | null;
}

export interface AttemptRow {
  id: string;
  runId: string | null;
  targetId: string;
  provider: string;
  domain: string;
  status: string;
  dryRun: boolean;
  priceAmount: number | null;
  priceCurrency: string | null;
  startedAt: string;
  finishedAt: string | null;
  providerReference: string | null;
  errorCode: string | null;
  reason: string | null;
}

export interface RunRow {
  id: string;
  targetId: string;
  startedAt: string;
  endedAt: string | null;
  status: string;
  mode: string;
  dryRun: boolean;
  detectedAt: string | null;
}

export interface EventRow {
  id: number;
  targetId: string | null;
  runId: string | null;
  type: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface LatencyStat {
  provider: string;
  checks: number;
  errors: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
}

export type ArmResult =
  | { ok: true; previous?: RegistrationState }
  | { ok: false; state: RegistrationState; detail: string | null; convertedFromRegistering: boolean };

/**
 * SQLite persistence (node:sqlite). Holds the audit trail and, critically, the per-target
 * registration lock. Never stores secrets or raw provider payloads.
 */
export class Store {
  readonly path: string;
  private readonly db: DatabaseSync;
  private readonly redactor?: Redactor;
  private closed = false;

  constructor(path: string, redactor?: Redactor) {
    this.path = path;
    this.redactor = redactor;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    this.migrate();
  }

  get persistent(): boolean {
    return this.path !== ":memory:";
  }

  private migrate(): void {
    const current = Number((this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
    for (let version = current; version < MIGRATIONS.length; version++) {
      this.tx(() => {
        this.db.exec(MIGRATIONS[version]!);
        this.db.exec(`PRAGMA user_version = ${version + 1}`);
      });
    }
  }

  private tx<T>(fn: () => T, mode: "DEFERRED" | "IMMEDIATE" = "IMMEDIATE"): T {
    this.db.exec(`BEGIN ${mode}`);
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Commit with fsync (synchronous=FULL). Used for the write-ahead purchase record. */
  private durableTx<T>(fn: () => T): T {
    if (!this.persistent) return this.tx(fn);
    this.db.exec("PRAGMA synchronous = FULL");
    try {
      return this.tx(fn);
    } finally {
      this.db.exec("PRAGMA synchronous = NORMAL");
    }
  }

  private run(sql: string, ...params: SQLInputValue[]): { changes: number } {
    const res = this.db.prepare(sql).run(...params);
    return { changes: Number(res.changes) };
  }

  private get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  private all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  private json(value: unknown): string {
    return JSON.stringify(this.redactor ? this.redactor.redactValue(value) : value);
  }

  // ---- targets & state ---------------------------------------------------------

  upsertTarget(t: { id: string; domain: string; enabled: boolean; expectedDropAt?: number }): void {
    const now = nowIso();
    this.run(
      `INSERT INTO targets (id, domain, enabled, expected_drop_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET domain = excluded.domain, enabled = excluded.enabled,
         expected_drop_at = excluded.expected_drop_at, updated_at = excluded.updated_at`,
      t.id, t.domain, v(t.enabled), v(t.expectedDropAt !== undefined ? nowIso(t.expectedDropAt) : null), now, now,
    );
  }

  getState(targetId: string): TargetStateRow | undefined {
    const row = this.get<Row>("SELECT * FROM target_state WHERE target_id = ?", targetId);
    return row ? mapState(row) : undefined;
  }

  listStates(): TargetStateRow[] {
    return this.all<Row>("SELECT * FROM target_state ORDER BY target_id").map(mapState);
  }

  /**
   * Compare-and-set state change. Succeeds only if the current state may legally move to `to`
   * (or matches `from` when given). Returns false when another writer got there first.
   */
  transition(targetId: string, domain: string, to: RegistrationState, detail?: string, from?: readonly RegistrationState[]): boolean {
    const allowed = from ?? predecessorsOf(to);
    const placeholders = allowed.map(() => "?").join(", ");
    return this.tx(() => {
      const existing = this.get<Row>("SELECT state FROM target_state WHERE target_id = ?", targetId);
      if (!existing) {
        if (!allowed.includes("IDLE") && to !== "IDLE") return false;
        this.run(
          "INSERT INTO target_state (target_id, domain, state, detail, updated_at) VALUES (?, ?, ?, ?, ?)",
          targetId, domain, to, v(detail), nowIso(),
        );
        return true;
      }
      const res = this.run(
        `UPDATE target_state SET state = ?, detail = ?, domain = ?, updated_at = ?
         WHERE target_id = ? AND state IN (${placeholders})`,
        to, v(detail), domain, nowIso(), targetId, ...allowed,
      );
      return res.changes === 1;
    });
  }

  /**
   * Arm a target for a new watch run. Refuses blocking states. A leftover REGISTERING
   * (process died mid-request) becomes AMBIGUOUS, and its in-flight attempts become "unknown".
   */
  arm(targetId: string, domain: string): ArmResult {
    return this.durableTx(() => {
      const row = this.get<Row>("SELECT * FROM target_state WHERE target_id = ?", targetId);
      if (!row) {
        this.run(
          "INSERT INTO target_state (target_id, domain, state, detail, updated_at) VALUES (?, ?, 'ARMED', NULL, ?)",
          targetId, domain, nowIso(),
        );
        return { ok: true };
      }
      const state = String(row.state) as RegistrationState;
      if (state === "REGISTERING") {
        const detail = "process stopped while a registration request was in flight";
        this.run("UPDATE target_state SET state = 'AMBIGUOUS', detail = ?, updated_at = ? WHERE target_id = ?", detail, nowIso(), targetId);
        this.run(
          "UPDATE registration_attempts SET status = 'unknown', error_code = 'REGISTRATION_UNKNOWN', reason = ?, finished_at = ? WHERE target_id = ? AND status = 'in_flight'",
          detail, nowIso(), targetId,
        );
        return { ok: false, state: "AMBIGUOUS", detail, convertedFromRegistering: true };
      }
      if (BLOCKING_STATES.includes(state)) {
        return { ok: false, state, detail: row.detail === null ? null : String(row.detail), convertedFromRegistering: false };
      }
      if (!ARMABLE_STATES.includes(state)) {
        return { ok: false, state, detail: row.detail === null ? null : String(row.detail), convertedFromRegistering: false };
      }
      this.run("UPDATE target_state SET state = 'ARMED', detail = NULL, domain = ?, updated_at = ? WHERE target_id = ?", domain, nowIso(), targetId);
      return { ok: true, previous: state };
    });
  }

  /**
   * Atomically claim the purchase: VERIFYING -> REGISTERING and write the in-flight attempt,
   * durably, BEFORE any request is sent. Returns false if the state was not VERIFYING.
   */
  claimRegistration(input: {
    attemptId: string;
    runId?: string;
    targetId: string;
    domain: string;
    provider: string;
    price?: Money;
    availability?: AvailabilityResult;
    gate?: unknown;
  }): boolean {
    return this.durableTx(() => {
      const res = this.run(
        "UPDATE target_state SET state = 'REGISTERING', detail = ?, updated_at = ? WHERE target_id = ? AND state = 'VERIFYING'",
        `attempt ${input.attemptId} via ${input.provider}`, nowIso(), input.targetId,
      );
      if (res.changes !== 1) return false;
      this.insertAttempt({ ...input, status: "in_flight", dryRun: false });
      return true;
    });
  }

  recordSimulatedAttempt(input: {
    attemptId: string;
    runId?: string;
    targetId: string;
    domain: string;
    provider: string;
    price?: Money;
    availability?: AvailabilityResult;
    gate?: unknown;
    result: RegistrationResult;
  }): void {
    this.tx(() => {
      this.insertAttempt({ ...input, status: "simulated", dryRun: true });
      this.finishAttempt(input.attemptId, input.result, "simulated");
    });
  }

  private insertAttempt(input: {
    attemptId: string;
    runId?: string;
    targetId: string;
    domain: string;
    provider: string;
    status: string;
    dryRun: boolean;
    price?: Money;
    availability?: AvailabilityResult;
    gate?: unknown;
  }): void {
    this.run(
      `INSERT INTO registration_attempts
         (id, watch_run_id, target_id, provider, domain, status, dry_run, price_amount, price_currency, started_at, availability_json, gate_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.attemptId, v(input.runId), input.targetId, input.provider, input.domain, input.status, v(input.dryRun),
      v(input.price?.amount), v(input.price?.currency), nowIso(),
      v(input.availability ? this.json(input.availability) : null), v(input.gate ? this.json(input.gate) : null),
    );
  }

  finishAttempt(attemptId: string, result: RegistrationResult, statusOverride?: string): void {
    this.run(
      `UPDATE registration_attempts SET status = ?, finished_at = ?, provider_reference = ?, error_code = ?, reason = ?,
         price_amount = COALESCE(?, price_amount), price_currency = COALESCE(?, price_currency)
       WHERE id = ?`,
      statusOverride ?? result.status, result.finishedAt, v(result.providerReference), v(result.errorCode),
      v(result.reason ? this.redactor?.redact(result.reason) ?? result.reason : null),
      v(result.price?.amount), v(result.price?.currency), attemptId,
    );
  }

  /** Real (non-simulated) attempts since the last manual reset. */
  countAttempts(targetId: string, provider?: string): number {
    const state = this.getState(targetId);
    const since = state?.resetAt ?? "";
    const row = provider
      ? this.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM registration_attempts WHERE target_id = ? AND provider = ? AND dry_run = 0 AND started_at > ?",
        targetId, provider, since,
      )
      : this.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM registration_attempts WHERE target_id = ? AND dry_run = 0 AND started_at > ?",
        targetId, since,
      );
    return Number(row?.n ?? 0);
  }

  attempts(targetId?: string, limit = 20): AttemptRow[] {
    const rows = targetId
      ? this.all<Row>("SELECT * FROM registration_attempts WHERE target_id = ? ORDER BY started_at DESC LIMIT ?", targetId, limit)
      : this.all<Row>("SELECT * FROM registration_attempts ORDER BY started_at DESC LIMIT ?", limit);
    return rows.map(mapAttempt);
  }

  /** Manual resolution (dropcatch resolve). Keeps history; `reset` restarts attempt counting. */
  resolve(targetId: string, domain: string, to: "SUCCEEDED" | "FAILED" | "IDLE", detail: string, reset: boolean): void {
    this.durableTx(() => {
      const now = nowIso();
      const existing = this.get<Row>("SELECT state FROM target_state WHERE target_id = ?", targetId);
      if (!existing) {
        this.run(
          "INSERT INTO target_state (target_id, domain, state, detail, updated_at, reset_at) VALUES (?, ?, ?, ?, ?, ?)",
          targetId, domain, to, detail, now, v(reset ? now : null),
        );
      } else {
        this.run(
          `UPDATE target_state SET state = ?, detail = ?, updated_at = ?, reset_at = CASE WHEN ? THEN ? ELSE reset_at END WHERE target_id = ?`,
          to, detail, now, v(reset), now, targetId,
        );
      }
      this.run(
        "UPDATE registration_attempts SET status = 'unknown', finished_at = ? WHERE target_id = ? AND status = 'in_flight'",
        now, targetId,
      );
    });
  }

  // ---- runs, checks, events --------------------------------------------------------

  startRun(input: { targetId: string; mode: string; dryRun: boolean }): string {
    const id = randomUUID();
    this.run(
      "INSERT INTO watch_runs (id, target_id, started_at, status, mode, dry_run) VALUES (?, ?, ?, 'running', ?, ?)",
      id, input.targetId, nowIso(), input.mode, v(input.dryRun),
    );
    return id;
  }

  markDetected(runId: string, at: number): void {
    this.run("UPDATE watch_runs SET detected_at = COALESCE(detected_at, ?) WHERE id = ?", nowIso(at), runId);
  }

  finishRun(runId: string, status: string): void {
    this.run("UPDATE watch_runs SET ended_at = ?, status = ? WHERE id = ?", nowIso(), status, runId);
  }

  runs(targetId?: string, limit = 10): RunRow[] {
    const rows = targetId
      ? this.all<Row>("SELECT * FROM watch_runs WHERE target_id = ? ORDER BY started_at DESC LIMIT ?", targetId, limit)
      : this.all<Row>("SELECT * FROM watch_runs ORDER BY started_at DESC LIMIT ?", limit);
    return rows.map((r) => ({
      id: String(r.id),
      targetId: String(r.target_id),
      startedAt: String(r.started_at),
      endedAt: r.ended_at === null ? null : String(r.ended_at),
      status: String(r.status),
      mode: String(r.mode),
      dryRun: Number(r.dry_run) === 1,
      detectedAt: r.detected_at === null ? null : String(r.detected_at),
    }));
  }

  recordCheck(runId: string | undefined, r: AvailabilityResult, phase?: string): void {
    this.run(
      `INSERT INTO availability_checks
         (watch_run_id, provider, domain, status, registrable, premium, price_amount, price_currency, latency_ms, started_at, checked_at, error_code, reason, phase)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      v(runId), r.provider, r.domain, r.status, v(r.registrable), v(r.premium), v(r.price?.amount), v(r.price?.currency),
      Math.round(r.latencyMs), r.startedAt, r.checkedAt, v(r.errorCode),
      v(r.reason ? this.redactor?.redact(r.reason) ?? r.reason : null), v(phase),
    );
  }

  recordEvent(event: DropEvent): void {
    this.run(
      "INSERT INTO events (target_id, watch_run_id, type, timestamp, payload_json) VALUES (?, ?, ?, ?, ?)",
      event.targetId, v(event.runId), event.type, nowIso(event.at), this.json(event.data),
    );
  }

  events(targetId?: string, limit = 50): EventRow[] {
    const rows = targetId
      ? this.all<Row>("SELECT * FROM events WHERE target_id = ? ORDER BY id DESC LIMIT ?", targetId, limit)
      : this.all<Row>("SELECT * FROM events ORDER BY id DESC LIMIT ?", limit);
    return rows
      .map((r) => ({
        id: Number(r.id),
        targetId: r.target_id === null ? null : String(r.target_id),
        runId: r.watch_run_id === null ? null : String(r.watch_run_id),
        type: String(r.type),
        timestamp: String(r.timestamp),
        payload: safeParse(String(r.payload_json ?? "{}")),
      }))
      .reverse();
  }

  latencyStats(sinceIso?: string): LatencyStat[] {
    const rows = this.all<{ provider: string; latency_ms: number; status: string }>(
      "SELECT provider, latency_ms, status FROM availability_checks WHERE checked_at >= ? ORDER BY provider",
      sinceIso ?? "",
    );
    const byProvider = new Map<string, { latencies: number[]; errors: number }>();
    for (const row of rows) {
      const entry = byProvider.get(row.provider) ?? { latencies: [], errors: 0 };
      if (row.status === "available" || row.status === "unavailable") entry.latencies.push(Number(row.latency_ms));
      else entry.errors++;
      byProvider.set(row.provider, entry);
    }
    return [...byProvider.entries()].map(([provider, { latencies, errors }]) => {
      const sorted = latencies.sort((a, b) => a - b);
      const pick = (q: number): number => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! : 0);
      return {
        provider,
        checks: sorted.length + errors,
        errors,
        avgMs: sorted.length ? Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length) : 0,
        p50Ms: pick(0.5),
        p95Ms: pick(0.95),
      };
    });
  }

  /** Latest check per provider for a domain (dashboard). */
  latestChecks(domain: string, limit = 200): Array<Record<string, unknown>> {
    const rows = this.all<Row>(
      "SELECT provider, status, price_amount, price_currency, latency_ms, checked_at, error_code, reason, phase FROM availability_checks WHERE domain = ? ORDER BY id DESC LIMIT ?",
      domain, limit,
    );
    const seen = new Map<string, Record<string, unknown>>();
    for (const r of rows) {
      const provider = String(r.provider);
      if (!seen.has(provider)) {
        seen.set(provider, {
          provider,
          status: String(r.status),
          price: r.price_amount === null ? null : { amount: Number(r.price_amount), currency: String(r.price_currency ?? "USD") },
          latencyMs: Number(r.latency_ms),
          checkedAt: String(r.checked_at),
          errorCode: r.error_code === null ? null : String(r.error_code),
          reason: r.reason === null ? null : String(r.reason),
          phase: r.phase === null ? null : String(r.phase),
        });
      }
    }
    return [...seen.values()];
  }

  /** Recent checks for a domain, oldest first, for latency charts. */
  latencySeries(domain: string, limit = 600): Array<{ provider: string; t: number; ms: number; status: string }> {
    const rows = this.all<Row>(
      "SELECT provider, latency_ms, status, checked_at FROM availability_checks WHERE domain = ? AND (phase IS NULL OR phase != 'final') ORDER BY id DESC LIMIT ?",
      domain, limit,
    );
    return rows.reverse().map((r) => ({ provider: String(r.provider), t: Date.parse(String(r.checked_at)), ms: Number(r.latency_ms), status: String(r.status) }));
  }

  checkCount(sinceIso = ""): number {
    return Number(this.get<{ n: number }>("SELECT COUNT(*) AS n FROM availability_checks WHERE checked_at >= ?", sinceIso)?.n ?? 0);
  }

  // ---- dashboard auth ------------------------------------------------------------

  getAdminPasswordHash(): string | undefined {
    const row = this.get<{ password_hash: string }>("SELECT password_hash FROM dashboard_auth WHERE id = 1");
    return row?.password_hash;
  }

  /** Create the admin credential. Returns false if one already exists (first setup only). */
  createAdmin(hash: string): boolean {
    const now = nowIso();
    const res = this.run("INSERT OR IGNORE INTO dashboard_auth (id, password_hash, created_at, updated_at) VALUES (1, ?, ?, ?)", hash, now, now);
    return res.changes === 1;
  }

  updateAdminPassword(hash: string): void {
    this.run("UPDATE dashboard_auth SET password_hash = ?, updated_at = ? WHERE id = 1", hash, nowIso());
  }

  createSession(tokenHash: string, expiresAtMs: number, ip: string | undefined, userAgent: string | undefined): void {
    const now = nowIso();
    this.run(
      "INSERT INTO dashboard_sessions (token_hash, created_at, expires_at, last_seen_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)",
      tokenHash, now, nowIso(expiresAtMs), now, v(ip), v(userAgent?.slice(0, 200)),
    );
  }

  /** Valid session lookup; extends the expiry (sliding window). */
  touchSession(tokenHash: string, extendToMs: number): boolean {
    const now = nowIso();
    const res = this.run(
      "UPDATE dashboard_sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ? AND expires_at > ?",
      now, nowIso(extendToMs), tokenHash, now,
    );
    return res.changes === 1;
  }

  deleteSession(tokenHash: string): void {
    this.run("DELETE FROM dashboard_sessions WHERE token_hash = ?", tokenHash);
  }

  deleteOtherSessions(keepTokenHash: string): number {
    return this.run("DELETE FROM dashboard_sessions WHERE token_hash != ?", keepTokenHash).changes;
  }

  pruneSessions(): void {
    this.run("DELETE FROM dashboard_sessions WHERE expires_at <= ?", nowIso());
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

function safeParse(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function mapState(row: Row): TargetStateRow {
  return {
    targetId: String(row.target_id),
    domain: String(row.domain),
    state: String(row.state) as RegistrationState,
    detail: row.detail === null ? null : String(row.detail),
    updatedAt: String(row.updated_at),
    resetAt: row.reset_at === null || row.reset_at === undefined ? null : String(row.reset_at),
  };
}

function mapAttempt(row: Row): AttemptRow {
  const s = (value: SQLInputValue | undefined): string | null => (value === null || value === undefined ? null : String(value));
  return {
    id: String(row.id),
    runId: s(row.watch_run_id),
    targetId: String(row.target_id),
    provider: String(row.provider),
    domain: String(row.domain),
    status: String(row.status),
    dryRun: Number(row.dry_run) === 1,
    priceAmount: row.price_amount === null ? null : Number(row.price_amount),
    priceCurrency: s(row.price_currency),
    startedAt: String(row.started_at),
    finishedAt: s(row.finished_at),
    providerReference: s(row.provider_reference),
    errorCode: s(row.error_code),
    reason: s(row.reason),
  };
}
