import { randomUUID } from "node:crypto";
import type { ResolvedTarget } from "../../config/loader.ts";
import type { Logger } from "../../logging/logger.ts";
import type { Store } from "../../persistence/Store.ts";
import type { RateLimiter } from "../../providers/RateLimiter.ts";
import type { AnyProviderPlugin, ProviderInstance } from "../../providers/types.ts";
import type { Clock } from "../clock.ts";
import type { EventSink, EventType } from "../events.ts";
import type { AvailabilityResult, Money, RegistrationRequest, RegistrationResult } from "../types.ts";
import { nowIso } from "../types.ts";
import { evaluatePurchaseGate, type GateReason, type PurchaseGateResult } from "./PurchaseGate.ts";

export interface RegistrationCandidate {
  id: string;
  plugin: AnyProviderPlugin;
  instance: ProviderInstance;
  availabilityLimiter: RateLimiter;
  registrationLimiter: RateLimiter;
  credentialsValid: boolean;
}

export interface ConfirmRequest {
  domain: string;
  provider: string;
  price?: Money;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** Operator confirmation (confirm mode, `buy` without --yes). Resolves false on timeout. */
export type ConfirmFn = (request: ConfirmRequest) => Promise<boolean>;

export type RegistrationOutcome =
  | { kind: "succeeded"; result: RegistrationResult; via: "response" | "ownership-lookup" | "status-poll" }
  | { kind: "pending"; result: RegistrationResult }
  | { kind: "ambiguous"; result: RegistrationResult }
  | { kind: "failed"; results: RegistrationResult[]; attemptsExhausted: boolean }
  | { kind: "false_positive"; checks: AvailabilityResult[] }
  | { kind: "blocked"; reasons: GateReason[]; details: string[] }
  | { kind: "declined" }
  | { kind: "dry_run"; result: RegistrationResult; gate: PurchaseGateResult }
  | { kind: "lost_lock" };

export interface RegistrationServiceDeps {
  target: ResolvedTarget;
  candidates: RegistrationCandidate[];
  store: Store;
  events: EventSink;
  logger: Logger;
  clock: Clock;
  dryRun: boolean;
  confirm?: ConfirmFn;
  runId?: string;
  /** Ambiguity resolution: ownership lookups after an unknown result. */
  verifyAttempts?: number;
  verifyIntervalMs?: number;
  /** Pending registrations: how long to poll before giving up (state stays PENDING). */
  pendingPollMs?: number;
  pendingIntervalMs?: number;
}

/**
 * The purchase path. Order of operations is the safety design (docs/ARCHITECTURE.md):
 * final check -> gate -> confirm -> (dry-run stops here) -> CAS lock + write-ahead -> register
 * -> interpret -> resolve ambiguity. A second registrar is only tried after a CONFIRMED failure.
 */
export class RegistrationService {
  private readonly d: RegistrationServiceDeps;

  constructor(deps: RegistrationServiceDeps) {
    this.d = deps;
  }

  private emit(type: EventType, data: Record<string, unknown>): void {
    const t = this.d.target;
    this.d.events.emit({ type, targetId: t.id, domain: t.domain.ascii, runId: this.d.runId, data });
  }

  private transition(to: Parameters<Store["transition"]>[2], detail?: string): boolean {
    return this.d.store.transition(this.d.target.id, this.d.target.domain.ascii, to, detail);
  }

  async execute(signal?: AbortSignal): Promise<RegistrationOutcome> {
    const { target, store } = this.d;
    const domain = target.domain.ascii;
    const reg = target.registration;
    const failures: RegistrationResult[] = [];
    const blocks: { reasons: GateReason[]; details: string[] } = { reasons: [], details: [] };
    const finalChecks: AvailabilityResult[] = [];

    for (const candidate of this.d.candidates) {
      if (signal?.aborted) break;
      const total = store.countAttempts(target.id);
      const perProvider = store.countAttempts(target.id, candidate.id);
      if (total >= reg.maxTotalAttempts) {
        blocks.reasons.push("DUPLICATE_ATTEMPT");
        blocks.details.push(`total attempts ${total}/${reg.maxTotalAttempts} used`);
        break;
      }
      if (perProvider >= reg.maxAttemptsPerProvider) {
        blocks.reasons.push("DUPLICATE_ATTEMPT");
        blocks.details.push(`${candidate.id} attempts ${perProvider}/${reg.maxAttemptsPerProvider} used`);
        continue;
      }

      this.transition("VERIFYING", `final check via ${candidate.id}`);
      const check = await this.finalCheck(candidate, signal);
      finalChecks.push(check);
      store.recordCheck(this.d.runId, check, "final");
      if (check.status !== "available") {
        this.d.logger.info(`Final check via ${candidate.id}: ${check.status}`, { reason: check.reason, errorCode: check.errorCode });
        this.transition("AVAILABLE");
        continue;
      }

      const gate = evaluatePurchaseGate({
        expectedDomain: domain,
        domain,
        provider: {
          id: candidate.id,
          canRegister: candidate.plugin.capabilities.registration && typeof candidate.instance.register === "function",
          premiumRegistration: candidate.plugin.capabilities.premiumRegistration,
          credentialsValid: candidate.credentialsValid,
        },
        availability: check,
        budget: reg.budget,
        requireBudget: reg.mode === "auto-buy",
        attempts: { total, provider: perProvider, maxTotal: reg.maxTotalAttempts, maxPerProvider: reg.maxAttemptsPerProvider },
        targetEnabled: target.enabled,
        window: target.drop
          ? {
            now: this.d.clock.now(),
            start: target.drop.expectedAtMs - target.drop.preWindowMs,
            end: target.drop.expectedAtMs + target.drop.postWindowMs,
            enforce: reg.restrictToDropWindow,
          }
          : undefined,
      });

      if (!gate.allowed) {
        blocks.reasons.push(...gate.reasons);
        blocks.details.push(...gate.details);
        this.emit("purchase_blocked", { provider: candidate.id, reasons: gate.reasons, reason: gate.details.join("; "), price: check.price });
        if (gate.reasons.includes("PRICE_TOO_HIGH")) {
          this.emit("budget_exceeded", { provider: candidate.id, price: check.price, reason: gate.details.join("; ") });
        }
        this.transition("AVAILABLE");
        continue;
      }

      const request: RegistrationRequest = {
        domain,
        price: gate.price!,
        premium: check.premium === true,
        years: reg.years,
        attemptId: randomUUID(),
        timeoutMs: reg.requestTimeoutMs,
      };

      if (this.d.dryRun) return this.dryRun(candidate, request, check, gate);

      if (reg.mode === "confirm") {
        if (!this.d.confirm) {
          this.emit("confirmation_declined", { provider: candidate.id, reason: "no interactive terminal to confirm on" });
          return { kind: "declined" };
        }
        this.emit("confirmation_requested", { provider: candidate.id, price: gate.price });
        const ok = await this.d.confirm({ domain, provider: candidate.id, price: gate.price, timeoutMs: reg.confirmTimeoutMs, signal });
        if (!ok) {
          this.emit("confirmation_declined", { provider: candidate.id });
          return { kind: "declined" };
        }
        // Time passed while a human decided: re-verify before spending money.
        const recheck = await this.finalCheck(candidate, signal);
        store.recordCheck(this.d.runId, recheck, "final");
        if (recheck.status !== "available" || recheck.price?.amount !== gate.price?.amount) {
          this.d.logger.warn("Availability or price changed during confirmation; not registering", { status: recheck.status });
          this.transition("AVAILABLE");
          finalChecks.push(recheck);
          continue;
        }
      }

      const outcome = await this.purchase(candidate, request, check, gate);
      if (outcome.kind !== "failed") return outcome;
      failures.push(...outcome.results);
    }

    if (failures.length > 0) {
      return { kind: "failed", results: failures, attemptsExhausted: store.countAttempts(target.id) >= reg.maxTotalAttempts };
    }
    if (blocks.reasons.length > 0) {
      return { kind: "blocked", reasons: [...new Set(blocks.reasons)], details: blocks.details };
    }
    return { kind: "false_positive", checks: finalChecks };
  }

  private async finalCheck(candidate: RegistrationCandidate, signal?: AbortSignal): Promise<AvailabilityResult> {
    const domain = this.d.target.domain.ascii;
    const started = this.d.clock.now();
    if (!candidate.instance.check) {
      return {
        provider: candidate.id,
        providerType: candidate.plugin.id,
        sourceKind: candidate.plugin.sourceKind,
        domain,
        status: "unsupported",
        reason: "provider cannot verify availability before registering",
        startedAt: nowIso(started),
        checkedAt: nowIso(started),
        latencyMs: 0,
      };
    }
    const release = await candidate.availabilityLimiter.acquire(signal).catch(() => undefined);
    if (!release) {
      return {
        provider: candidate.id,
        providerType: candidate.plugin.id,
        sourceKind: candidate.plugin.sourceKind,
        domain,
        status: "unknown",
        errorCode: "ABORTED",
        startedAt: nowIso(started),
        checkedAt: nowIso(this.d.clock.now()),
        latencyMs: this.d.clock.now() - started,
      };
    }
    try {
      return await candidate.instance.check({ domain, timeoutMs: this.d.target.requestTimeoutMs, signal });
    } finally {
      release();
    }
  }

  private async dryRun(
    candidate: RegistrationCandidate,
    request: RegistrationRequest,
    check: AvailabilityResult,
    gate: PurchaseGateResult,
  ): Promise<RegistrationOutcome> {
    const started = this.d.clock.now();
    let result: RegistrationResult;
    if (candidate.instance.preflight) {
      result = await candidate.instance.preflight(request);
      result = { ...result, simulated: true };
    } else {
      const finished = this.d.clock.now();
      result = {
        provider: candidate.id,
        providerType: candidate.plugin.id,
        domain: request.domain,
        status: "success",
        price: request.price,
        simulated: true,
        reason: "dry run: gate passed, registration request NOT sent",
        startedAt: nowIso(started),
        finishedAt: nowIso(finished),
        latencyMs: finished - started,
      };
    }
    this.d.store.recordSimulatedAttempt({
      attemptId: request.attemptId,
      runId: this.d.runId,
      targetId: this.d.target.id,
      domain: request.domain,
      provider: candidate.id,
      price: request.price,
      availability: check,
      gate,
      result,
    });
    this.emit("dry_run_registration", {
      provider: candidate.id,
      price: request.price,
      status: result.status,
      reason: result.reason,
      latencyMs: result.latencyMs,
      dryRun: true,
    });
    return { kind: "dry_run", result, gate };
  }

  private async purchase(
    candidate: RegistrationCandidate,
    request: RegistrationRequest,
    check: AvailabilityResult,
    gate: PurchaseGateResult,
  ): Promise<RegistrationOutcome> {
    const { store, target } = this.d;
    const claimed = store.claimRegistration({
      attemptId: request.attemptId,
      runId: this.d.runId,
      targetId: target.id,
      domain: request.domain,
      provider: candidate.id,
      price: request.price,
      availability: check,
      gate,
    });
    if (!claimed) {
      this.d.logger.error("Could not take the registration lock (another process or run owns this target). Not registering.");
      return { kind: "lost_lock" };
    }
    const attempt = store.countAttempts(target.id);
    this.emit("registration_started", { provider: candidate.id, price: request.price, attempt, attemptId: request.attemptId });

    // Never cancelled by shutdown: an aborted purchase request is the worst kind of ambiguity.
    const release = await candidate.registrationLimiter.acquire();
    let result: RegistrationResult;
    try {
      result = await this.guardedRegister(candidate, request);
    } finally {
      release();
    }
    store.finishAttempt(request.attemptId, result);

    switch (result.status) {
      case "success":
        this.transition("SUCCEEDED", `registered via ${candidate.id}${result.providerReference ? ` (${result.providerReference})` : ""}`);
        this.emit("registration_succeeded", this.resultData(result, attempt));
        return { kind: "succeeded", result, via: "response" };

      case "pending":
        return this.followPending(candidate, result, attempt);

      case "unknown":
        return this.resolveAmbiguity(candidate, result, attempt);

      case "failed":
        this.transition("AVAILABLE", `confirmed failure via ${candidate.id}: ${result.errorCode ?? "rejected"}`);
        this.emit("registration_failed", this.resultData(result, attempt));
        return { kind: "failed", results: [result], attemptsExhausted: false };
    }
  }

  /** Defense in depth: even if orchestration had a bug, dry-run can never reach register(). */
  private async guardedRegister(candidate: RegistrationCandidate, request: RegistrationRequest): Promise<RegistrationResult> {
    if (this.d.dryRun) throw new Error("BUG: register() reached while dry-run is on; refusing");
    if (!candidate.instance.register) throw new Error(`${candidate.id} cannot register`);
    try {
      return await candidate.instance.register(request);
    } catch (err) {
      // An adapter that throws after sending gives no guarantee: treat as unknown.
      const now = this.d.clock.now();
      return {
        provider: candidate.id,
        providerType: candidate.plugin.id,
        domain: request.domain,
        status: "unknown",
        errorCode: "REGISTRATION_UNKNOWN",
        reason: err instanceof Error ? err.message : String(err),
        startedAt: nowIso(now),
        finishedAt: nowIso(now),
        latencyMs: 0,
      };
    }
  }

  private async followPending(candidate: RegistrationCandidate, first: RegistrationResult, attempt: number): Promise<RegistrationOutcome> {
    const pollFor = this.d.pendingPollMs ?? 60_000;
    const every = this.d.pendingIntervalMs ?? 3000;
    let latest = first;
    if (candidate.instance.getRegistrationStatus) {
      const deadline = this.d.clock.now() + pollFor;
      while (this.d.clock.now() < deadline) {
        await this.d.clock.sleep(every);
        latest = await candidate.instance.getRegistrationStatus(first.domain, first.providerReference, 10_000);
        if (latest.status === "success") {
          this.transition("REGISTRATION_PENDING");
          this.transition("SUCCEEDED", `registered via ${candidate.id} (confirmed by status poll)`);
          this.emit("registration_succeeded", this.resultData({ ...latest, price: latest.price ?? first.price }, attempt));
          return { kind: "succeeded", result: latest, via: "status-poll" };
        }
        if (latest.status === "failed") break;
      }
    }
    if (latest.status === "failed") {
      this.transition("REGISTRATION_PENDING");
      this.transition("FAILED", `pending registration failed at ${candidate.id}`);
      this.emit("registration_failed", this.resultData(latest, attempt));
      // Stop here: a registrar that accepted and then failed is still worth a human look.
      return { kind: "failed", results: [latest], attemptsExhausted: true };
    }
    this.transition("REGISTRATION_PENDING", `accepted by ${candidate.id}, not final yet`);
    this.emit("registration_pending", this.resultData(first, attempt));
    return { kind: "pending", result: first };
  }

  private async resolveAmbiguity(candidate: RegistrationCandidate, result: RegistrationResult, attempt: number): Promise<RegistrationOutcome> {
    const tries = this.d.verifyAttempts ?? 4;
    const every = this.d.verifyIntervalMs ?? 3000;
    if (candidate.instance.lookupOwnership) {
      for (let i = 0; i < tries; i++) {
        if (i > 0) await this.d.clock.sleep(every);
        const owned = await candidate.instance.lookupOwnership(result.domain, 10_000).catch(() => "unknown" as const);
        this.d.logger.info(`Ownership lookup ${i + 1}/${tries} via ${candidate.id}: ${owned}`);
        if (owned === "owned") {
          this.transition("SUCCEEDED", `registered via ${candidate.id} (confirmed by ownership lookup after an unclear response)`);
          const confirmed = { ...result, status: "success" as const };
          this.emit("registration_succeeded", { ...this.resultData(confirmed, attempt), reason: "confirmed by ownership lookup" });
          return { kind: "succeeded", result: confirmed, via: "ownership-lookup" };
        }
      }
    }
    this.transition("AMBIGUOUS", `unclear result from ${candidate.id}: ${result.reason ?? result.errorCode ?? "unknown"}`);
    this.emit("registration_ambiguous", this.resultData(result, attempt));
    return { kind: "ambiguous", result };
  }

  private resultData(result: RegistrationResult, attempt: number): Record<string, unknown> {
    return {
      provider: result.provider,
      status: result.status,
      price: result.price,
      latencyMs: result.latencyMs,
      errorCode: result.errorCode,
      reason: result.reason,
      providerReference: result.providerReference,
      attempt,
    };
  }
}
