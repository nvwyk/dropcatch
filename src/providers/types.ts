import type { z } from "zod";
import type {
  AvailabilityRequest,
  AvailabilityResult,
  HealthResult,
  OwnershipStatus,
  RegistrationRequest,
  RegistrationResult,
  SourceKind,
} from "../core/types.ts";
import type { Logger } from "../logging/logger.ts";
import type { HttpRequest, HttpResponse } from "../transport/HttpTransport.ts";
import type { ProviderLimits } from "./RateLimiter.ts";

export type ProviderEnvironment = "production" | "sandbox" | "mock";

export interface ProviderCapabilities {
  availability: boolean;
  registration: boolean;
  /** Availability results carry a price usable by the budget gate. */
  pricing: boolean;
  /** Server-side dry run of a registration (validates funds, price, eligibility without charging). */
  preflight: boolean;
  /** Can tell whether this account owns a domain (used to resolve ambiguous registrations). */
  ownershipLookup: boolean;
  /** Can poll an accepted-but-not-final registration. */
  registrationStatus: boolean;
  sandbox: boolean;
  /** Premium names can be bought through this API. */
  premiumRegistration: boolean;
}

export interface CredentialField {
  /** Key used in `accounts.<id>.credentials`. */
  name: string;
  /** Default environment variable name. */
  defaultEnv: string;
  required: boolean;
  /** false for identifiers such as a Cloudflare account id. Still never logged. */
  secret: boolean;
  description: string;
}

/** HTTP bound to the account's proxy route. Adapters never choose proxies or retry logic. */
export type BoundHttp = (req: Omit<HttpRequest, "proxy">) => Promise<HttpResponse>;

export interface ProviderContext<TOptions = Record<string, unknown>> {
  accountId: string;
  environment: ProviderEnvironment;
  credentials: Record<string, string>;
  options: TOptions;
  http: BoundHttp;
  logger: Logger;
  now: () => number;
}

export interface ProviderInstance {
  check?(req: AvailabilityRequest): Promise<AvailabilityResult>;
  /** Performs a REAL, billable registration. Never reachable in dry-run mode. */
  register?(req: RegistrationRequest): Promise<RegistrationResult>;
  /** Server-side dry run. Must never charge. */
  preflight?(req: RegistrationRequest): Promise<RegistrationResult>;
  lookupOwnership?(domain: string, timeoutMs: number): Promise<OwnershipStatus>;
  getRegistrationStatus?(domain: string, reference: string | undefined, timeoutMs: number): Promise<RegistrationResult>;
  /** Warm caches (pricing, bootstrap) before the hot window. */
  prepare?(domain: string): Promise<void>;
  healthCheck?(timeoutMs: number): Promise<HealthResult>;
}

export interface ProviderPlugin<TOptions = Record<string, unknown>> {
  id: string;
  displayName: string;
  description?: string;
  sourceKind: SourceKind;
  capabilities: ProviderCapabilities;
  credentials: CredentialField[];
  defaultLimits: { availability: ProviderLimits; registration: ProviderLimits };
  /** Validates `accounts.<id>.options`. */
  optionsSchema?: z.ZodType<TOptions>;
  /** Documentation links shown by `dropcatch providers`. */
  docs?: string[];
  /** Extra config checks once usage is known. Returns problems (empty = fine). */
  validateAccount?(options: TOptions, usage: { registration: boolean }): string[];
  create(ctx: ProviderContext<TOptions>): ProviderInstance;
}

/** Plugins are heterogeneous by design; the registry stores them type-erased. */
export type AnyProviderPlugin = ProviderPlugin<any>;

export function definePlugin<TOptions>(plugin: ProviderPlugin<TOptions>): ProviderPlugin<TOptions> {
  return plugin;
}
