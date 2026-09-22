import type { AvailabilityResult, Money } from "../types.ts";

/** Why a purchase was refused (plan section 36). */
export type GateReason =
  | "DOMAIN_MISMATCH"
  | "NOT_AVAILABLE"
  | "NOT_REGISTRABLE"
  | "UNVERIFIED_PROVIDER"
  | "PRICE_UNKNOWN"
  | "PRICE_TOO_HIGH"
  | "CURRENCY_MISMATCH"
  | "PRICE_MISMATCH"
  | "NO_BUDGET"
  | "PREMIUM_DOMAIN"
  | "PROVIDER_UNSUPPORTED"
  | "DUPLICATE_ATTEMPT"
  | "TARGET_DISABLED"
  | "CREDENTIALS_INVALID"
  | "OUTSIDE_DROP_WINDOW";

export interface GateBudget {
  maxRegistrationPrice?: number;
  currency: string;
  allowPremium: boolean;
  expectedPrice?: number;
  requireExactPrice: boolean;
}

export interface PurchaseGateInput {
  /** Normalized domain of the configured target. */
  expectedDomain: string;
  /** Domain about to be registered. */
  domain: string;
  provider: {
    id: string;
    canRegister: boolean;
    premiumRegistration: boolean;
    credentialsValid: boolean;
  };
  /** Final check from the SAME provider that will register. */
  availability: AvailabilityResult;
  budget: GateBudget;
  /** auto-buy requires an explicit budget. */
  requireBudget: boolean;
  attempts: { total: number; provider: number; maxTotal: number; maxPerProvider: number };
  targetEnabled: boolean;
  window?: { now: number; start: number; end: number; enforce: boolean };
}

export interface PurchaseGateResult {
  allowed: boolean;
  reasons: GateReason[];
  details: string[];
  price?: Money;
}

const CENT = 0.005;

/** Pure final purchase gate. Only `allowed: true` may lead to a registration request. */
export function evaluatePurchaseGate(input: PurchaseGateInput): PurchaseGateResult {
  const reasons: GateReason[] = [];
  const details: string[] = [];
  const reject = (reason: GateReason, detail: string): void => {
    if (!reasons.includes(reason)) reasons.push(reason);
    details.push(detail);
  };
  const a = input.availability;
  const b = input.budget;

  if (input.domain !== input.expectedDomain || a.domain !== input.expectedDomain) {
    reject("DOMAIN_MISMATCH", `expected ${input.expectedDomain}, got ${input.domain} / checked ${a.domain}`);
  }
  if (!input.targetEnabled) reject("TARGET_DISABLED", "target is disabled");
  if (!input.provider.canRegister) reject("PROVIDER_UNSUPPORTED", `${input.provider.id} cannot register domains`);
  if (!input.provider.credentialsValid) reject("CREDENTIALS_INVALID", `${input.provider.id} credentials failed validation`);
  if (a.provider !== input.provider.id) {
    reject("UNVERIFIED_PROVIDER", `final check came from ${a.provider}, not the registering provider ${input.provider.id}`);
  }
  if (a.status !== "available") reject("NOT_AVAILABLE", `final check status is ${a.status}`);

  if (a.premium) {
    if (!b.allowPremium) reject("PREMIUM_DOMAIN", "premium name and budget.allowPremium is false");
    else if (!input.provider.premiumRegistration) reject("PROVIDER_UNSUPPORTED", `${input.provider.id} cannot register premium names via API`);
  } else if (a.registrable === false) {
    reject("NOT_REGISTRABLE", a.reason ?? "provider reports the name is not registrable");
  }

  const hasBudget = b.maxRegistrationPrice !== undefined;
  if (input.requireBudget && !hasBudget) reject("NO_BUDGET", "auto-buy requires budget.maxRegistrationPrice");
  const price = a.price;
  if (!price) {
    if (hasBudget || input.requireBudget || b.requireExactPrice) reject("PRICE_UNKNOWN", "provider returned no price; budget cannot be verified");
  } else {
    if ((hasBudget || b.requireExactPrice) && price.currency !== b.currency) {
      reject("CURRENCY_MISMATCH", `price is in ${price.currency}, budget is in ${b.currency}`);
    } else {
      if (hasBudget && price.amount > b.maxRegistrationPrice! + 1e-9) {
        reject("PRICE_TOO_HIGH", `${price.amount.toFixed(2)} ${price.currency} exceeds ${b.maxRegistrationPrice!.toFixed(2)} ${b.currency}`);
      }
      if (b.requireExactPrice && b.expectedPrice !== undefined && Math.abs(price.amount - b.expectedPrice) > CENT) {
        reject("PRICE_MISMATCH", `${price.amount.toFixed(2)} differs from expected ${b.expectedPrice.toFixed(2)}`);
      }
    }
    if (!(price.amount > 0) || !Number.isFinite(price.amount)) reject("PRICE_UNKNOWN", `invalid price ${price.amount}`);
  }

  const t = input.attempts;
  if (t.total >= t.maxTotal) reject("DUPLICATE_ATTEMPT", `total attempts ${t.total}/${t.maxTotal} used`);
  if (t.provider >= t.maxPerProvider) reject("DUPLICATE_ATTEMPT", `${input.provider.id} attempts ${t.provider}/${t.maxPerProvider} used`);

  const w = input.window;
  if (w?.enforce && (w.now < w.start || w.now > w.end)) {
    reject("OUTSIDE_DROP_WINDOW", "restrictToDropWindow is set and now is outside the drop window");
  }

  return { allowed: reasons.length === 0, reasons, details, price };
}
