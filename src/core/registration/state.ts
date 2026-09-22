/**
 * Persisted per-target registration state machine (plan sections 16 and 17).
 *
 * IDLE -> ARMED -> CHECKING -> AVAILABLE -> VERIFYING -> REGISTERING -> SUCCEEDED
 *                                                              |-> REGISTRATION_PENDING
 *                                                              |-> AMBIGUOUS
 *                                                              '-> FAILED | AVAILABLE (confirmed failure, try next)
 */
export const REGISTRATION_STATES = [
  "IDLE",
  "ARMED",
  "CHECKING",
  "AVAILABLE",
  "VERIFYING",
  "REGISTERING",
  "REGISTRATION_PENDING",
  "SUCCEEDED",
  "FAILED",
  "ABORTED",
  "AMBIGUOUS",
] as const;

export type RegistrationState = (typeof REGISTRATION_STATES)[number];

/** States in which no new purchase may start until a human resolves the situation. */
export const BLOCKING_STATES: readonly RegistrationState[] = ["REGISTERING", "REGISTRATION_PENDING", "SUCCEEDED", "AMBIGUOUS"];

/** States from which a target may be (re)armed. */
export const ARMABLE_STATES: readonly RegistrationState[] = ["IDLE", "ARMED", "CHECKING", "AVAILABLE", "VERIFYING", "FAILED", "ABORTED"];

const TRANSITIONS: Record<RegistrationState, readonly RegistrationState[]> = {
  IDLE: ["ARMED"],
  ARMED: ["CHECKING", "IDLE", "ABORTED"],
  CHECKING: ["AVAILABLE", "IDLE", "ABORTED", "FAILED"],
  AVAILABLE: ["VERIFYING", "CHECKING", "IDLE", "ABORTED", "FAILED"],
  VERIFYING: ["REGISTERING", "AVAILABLE", "CHECKING", "IDLE", "ABORTED", "FAILED"],
  // A CONFIRMED failure returns to AVAILABLE so the next registrar can be tried.
  REGISTERING: ["SUCCEEDED", "REGISTRATION_PENDING", "AMBIGUOUS", "FAILED", "AVAILABLE"],
  REGISTRATION_PENDING: ["SUCCEEDED", "FAILED", "AMBIGUOUS"],
  SUCCEEDED: [],
  FAILED: ["ARMED", "IDLE"],
  ABORTED: ["ARMED", "IDLE"],
  AMBIGUOUS: ["SUCCEEDED", "FAILED"],
};

export function canTransition(from: RegistrationState, to: RegistrationState): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

/** States that may move to `to`. Used to build compare-and-set updates. */
export function predecessorsOf(to: RegistrationState): RegistrationState[] {
  return REGISTRATION_STATES.filter((from) => from === to || TRANSITIONS[from].includes(to));
}

export function isBlocking(state: RegistrationState | undefined): boolean {
  return state !== undefined && BLOCKING_STATES.includes(state);
}

export function describeBlockingState(state: RegistrationState): string {
  switch (state) {
    case "SUCCEEDED":
      return "this target was already registered by dropcatch";
    case "REGISTERING":
      return "a registration was in flight when the process stopped; its outcome is unknown";
    case "REGISTRATION_PENDING":
      return "a registration was accepted and is still pending at the registrar";
    case "AMBIGUOUS":
      return "the last registration result was ambiguous (the purchase may have happened)";
    default:
      return state;
  }
}
