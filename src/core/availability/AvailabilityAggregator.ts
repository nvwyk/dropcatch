import type { QuorumMode } from "../../config/schema.ts";
import type { AvailabilityResult } from "../types.ts";

export type Decision = "positive" | "negative" | "inconclusive";

export interface AggregateResult {
  decision: Decision;
  basis: string;
  available: AvailabilityResult[];
  unavailable: AvailabilityResult[];
  /** unknown, error, rate_limited, unsupported: never counted as "unavailable". */
  indeterminate: AvailabilityResult[];
}

/**
 * Combine the latest result of each source into one decision (plan sections 15 and 39).
 * `complete` = every source asked in this round has answered.
 */
export function aggregate(
  results: readonly AvailabilityResult[],
  mode: QuorumMode,
  minimumConfirmations: number,
  complete: boolean,
): AggregateResult {
  const available = results
    .filter((r) => r.status === "available")
    .sort((a, b) => a.checkedAt.localeCompare(b.checkedAt));
  const unavailable = results.filter((r) => r.status === "unavailable");
  const indeterminate = results.filter((r) => r.status !== "available" && r.status !== "unavailable");
  const base = { available, unavailable, indeterminate };
  const names = (rs: AvailabilityResult[]): string => rs.map((r) => r.provider).join(", ");

  const settle = (): AggregateResult => {
    if (!complete) return { ...base, decision: "inconclusive", basis: "waiting for sources" };
    if (unavailable.length > 0) return { ...base, decision: "negative", basis: `unavailable per ${names(unavailable)}` };
    return { ...base, decision: "inconclusive", basis: indeterminate.length ? "no definitive answer" : "no results" };
  };

  switch (mode) {
    case "any":
      if (available.length >= minimumConfirmations) {
        return { ...base, decision: "positive", basis: `available per ${names(available)}` };
      }
      return settle();

    case "majority": {
      if (!complete) return { ...base, decision: "inconclusive", basis: "waiting for all sources" };
      const definitive = available.length + unavailable.length;
      if (available.length >= minimumConfirmations && available.length * 2 > definitive) {
        return { ...base, decision: "positive", basis: `majority ${available.length}/${definitive} available` };
      }
      return settle();
    }

    case "registry-confirmed": {
      const registry = available.filter((r) => r.sourceKind === "registry");
      const registrar = available.filter((r) => r.sourceKind === "registrar");
      if (registry.length > 0 && registrar.length > 0 && available.length >= minimumConfirmations) {
        return { ...base, decision: "positive", basis: `registry (${names(registry)}) and registrar (${names(registrar)}) agree` };
      }
      return settle();
    }
  }
}
