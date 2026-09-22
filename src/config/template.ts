import { stringify } from "yaml";

export type RegistrarChoice = "porkbun" | "namecheap" | "cloudflare" | "ovh";

export interface TemplateAnswers {
  timezone: string;
  target: {
    id: string;
    domain: string;
    expectedAt?: string;
    strategy: "adaptive" | "fixed";
  };
  registrars: RegistrarChoice[];
  mode: "notify-only" | "confirm" | "auto-buy";
  budget?: { max: number; currency: string };
  namecheapContact?: Record<string, string>;
  ovhOwnerContact?: string;
  discord: boolean;
}

const ACCOUNT_BLOCKS: Record<RegistrarChoice, Record<string, unknown>> = {
  porkbun: {
    provider: "porkbun",
    environment: "production",
    credentials: { apiKey: "PORKBUN_API_KEY", secretApiKey: "PORKBUN_SECRET_API_KEY" },
  },
  namecheap: {
    provider: "namecheap",
    environment: "production",
    credentials: {
      apiUser: "NAMECHEAP_API_USER",
      apiKey: "NAMECHEAP_API_KEY",
      userName: "NAMECHEAP_USERNAME",
      clientIp: "NAMECHEAP_CLIENT_IP",
    },
  },
  cloudflare: {
    provider: "cloudflare",
    environment: "production",
    credentials: { apiToken: "CLOUDFLARE_API_TOKEN", accountId: "CLOUDFLARE_ACCOUNT_ID" },
  },
  ovh: {
    provider: "ovh",
    environment: "production",
    credentials: { applicationKey: "OVH_APPLICATION_KEY", applicationSecret: "OVH_APPLICATION_SECRET", consumerKey: "OVH_CONSUMER_KEY" },
    options: { endpoint: "ovh-eu", ovhSubsidiary: "PL" },
  },
};

export function accountId(registrar: RegistrarChoice): string {
  return `${registrar}-main`;
}

/** Render a fresh, valid, commented config. Always dry-run. */
export function renderConfig(a: TemplateAnswers): string {
  const accounts: Record<string, unknown> = {};
  for (const r of a.registrars) {
    const block: Record<string, unknown> = { ...ACCOUNT_BLOCKS[r] };
    if (r === "namecheap" && a.namecheapContact) block.options = { contact: a.namecheapContact };
    if (r === "ovh" && a.ovhOwnerContact) block.options = { ...(block.options as object), ownerContact: a.ovhOwnerContact };
    accounts[accountId(r)] = block;
  }
  const registrationActive = a.mode !== "notify-only" && a.registrars.length > 0;
  const target: Record<string, unknown> = {
    id: a.target.id,
    domain: a.target.domain,
  };
  if (a.target.expectedAt) {
    target.drop = { expectedAt: a.target.expectedAt, preWindowSeconds: 600, postWindowSeconds: 900 };
  }
  target.monitoring = { strategy: a.target.strategy, requestTimeoutMs: 2500 };
  target.availability = { providers: ["rdap", ...a.registrars.map(accountId)], quorum: { mode: "any", minimumConfirmations: 1 } };
  target.registration = {
    enabled: registrationActive,
    mode: registrationActive ? a.mode : "notify-only",
    providers: a.registrars.map(accountId),
    maxAttemptsPerProvider: 1,
    maxTotalAttempts: 1,
    budget: {
      ...(a.budget ? { maxRegistrationPrice: a.budget.max } : {}),
      currency: a.budget?.currency ?? (a.registrars.includes("ovh") ? "PLN" : "USD"),
      allowPremium: false,
    },
  };
  target.notifications = { discord: { enabled: a.discord } };

  const doc = {
    profile: "production",
    app: {
      timezone: a.timezone,
      database: "./data/dropcatch.sqlite",
      logLevel: "info",
      dryRun: true,
    },
    accounts,
    notifications: { discord: { enabled: a.discord, webhookEnv: "DISCORD_WEBHOOK_URL", username: "dropcatch" } },
    targets: [target],
  };

  const header = [
    "# dropcatch configuration",
    "# Secrets never go in this file: it only names the environment variables that hold them (see .env).",
    "# app.dryRun is true: nothing can be purchased until you set it to false after a successful rehearsal.",
    "# Reference: config/example.yaml and README.md",
    "",
  ].join("\n");
  return header + stringify(doc, { lineWidth: 0 });
}
