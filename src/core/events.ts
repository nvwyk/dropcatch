import type { Money } from "./types.ts";

export const EVENT_TYPES = [
  "watch_started",
  "drop_window_entered",
  "hot_window_entered",
  "availability_detected",
  "availability_false_positive",
  "purchase_blocked",
  "budget_exceeded",
  "confirmation_requested",
  "confirmation_declined",
  "registration_started",
  "registration_succeeded",
  "registration_failed",
  "registration_pending",
  "registration_ambiguous",
  "dry_run_registration",
  "provider_error",
  "rate_limited",
  "clock_jump",
  "watch_finished",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/** Events sent to Discord unless `notifications.discord.events` narrows the list. */
export const DEFAULT_NOTIFY_EVENTS: readonly EventType[] = [
  "watch_started",
  "drop_window_entered",
  "availability_detected",
  "purchase_blocked",
  "budget_exceeded",
  "confirmation_requested",
  "registration_started",
  "registration_succeeded",
  "registration_failed",
  "registration_pending",
  "registration_ambiguous",
  "dry_run_registration",
  "provider_error",
  "rate_limited",
  "watch_finished",
];

export interface EventData {
  provider?: string;
  status?: string;
  price?: Money;
  latencyMs?: number;
  errorCode?: string;
  reason?: string;
  reasons?: string[];
  attempt?: number;
  attemptId?: string;
  phase?: string;
  mode?: string;
  dryRun?: boolean;
  expectedAt?: number;
  detectedAt?: number;
  outcome?: string;
  providerReference?: string;
  [key: string]: unknown;
}

export interface DropEvent {
  type: EventType;
  targetId: string;
  domain: string;
  runId?: string;
  /** Epoch ms (UTC). */
  at: number;
  data: EventData;
}

export interface EventSink {
  emit(event: Omit<DropEvent, "at"> & { at?: number }): void;
}

/** Collects events in memory (tests, `check`). */
export class MemorySink implements EventSink {
  readonly events: DropEvent[] = [];

  emit(event: Omit<DropEvent, "at"> & { at?: number }): void {
    this.events.push({ ...event, at: event.at ?? Date.now() });
  }

  types(): EventType[] {
    return this.events.map((e) => e.type);
  }
}
