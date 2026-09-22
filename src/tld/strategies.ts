import type { NormalizedDomain } from "../domain/normalize.ts";

/** What we know about how a TLD releases names. Plan sections 51 and 52. */
export interface DropSemantics {
  /** Maximum lag of public registry data (RDAP) behind the registry itself. 0 = unknown/none. */
  registryDataDelayMs: number;
  /** The configured expectedAt is a scheduling hint, not a guaranteed release instant. */
  expectedAtIsHint: boolean;
  notes: string[];
}

export interface TldTargetView {
  domain: NormalizedDomain;
  availabilitySourceTypes: string[];
  registrationProviderTypes: string[];
  registrationActive: boolean;
  quorumMode: string;
  postWindowSeconds?: number;
}

export interface TldStrategy {
  id: string;
  appliesTo(domain: NormalizedDomain): boolean;
  /** Registry RDAP base URL (with trailing slash) if known without bootstrap. */
  rdapBaseUrl?: string;
  semantics: DropSemantics;
  /** Configuration warnings specific to this TLD. */
  review(target: TldTargetView): string[];
}

const genericStrategy: TldStrategy = {
  id: "generic",
  appliesTo: () => true,
  semantics: {
    registryDataDelayMs: 0,
    expectedAtIsHint: true,
    notes: ["Release timing varies by registry. Treat expectedAt as a hint and keep a post window."],
  },
  review: () => [],
};

/** Registrars verified (2026-09-22) NOT to sell .pl through their API. */
const KNOWN_NO_PL = new Set(["porkbun"]);

const plStrategy: TldStrategy = {
  id: "pl",
  appliesTo: (d) => d.tld === "pl",
  rdapBaseUrl: "https://rdap.dns.pl/",
  semantics: {
    registryDataDelayMs: 15 * 60_000,
    expectedAtIsHint: true,
    notes: [
      "NASK RDAP data lags the .pl registry by up to 15 minutes: an RDAP 404 is advisory only.",
      "Expired .pl names spend 30 days BLOCKED, then return to the pool; NASK publishes no exact release second.",
    ],
  },
  review(t) {
    const warnings: string[] = [];
    const registrars = t.availabilitySourceTypes.filter((s) => s !== "rdap" && s !== "mock");
    if (registrars.length === 0) {
      warnings.push(
        `${t.domain.ascii}: only RDAP is watching this .pl name. NASK RDAP lags up to 15 minutes, so detection can be very late. Add a registrar availability source that sells .pl.`,
      );
    }
    if (t.quorumMode === "registry-confirmed") {
      warnings.push(
        `${t.domain.ascii}: "registry-confirmed" waits for NASK RDAP, which lags up to 15 minutes. Prefer "any" with a registrar source.`,
      );
    }
    for (const provider of t.registrationProviderTypes) {
      if (KNOWN_NO_PL.has(provider)) {
        warnings.push(`${t.domain.ascii}: ${provider} does not sell .pl (verified 2026-09-22). Registration through it will fail.`);
      }
    }
    if (t.postWindowSeconds !== undefined && t.postWindowSeconds < 900) {
      warnings.push(
        `${t.domain.ascii}: postWindowSeconds is ${t.postWindowSeconds}. .pl releases are not second-exact; consider at least 900.`,
      );
    }
    return warnings;
  },
};

const STRATEGIES: TldStrategy[] = [plStrategy];

export function strategyFor(domain: NormalizedDomain): TldStrategy {
  return STRATEGIES.find((s) => s.appliesTo(domain)) ?? genericStrategy;
}

export function allStrategies(): TldStrategy[] {
  return [...STRATEGIES, genericStrategy];
}
