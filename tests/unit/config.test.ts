import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseConfigText, resolveConfig } from "../../src/config/loader.ts";
import { ConfigError } from "../../src/core/errors.ts";
import { builtinRegistry } from "../../src/providers/ProviderRegistry.ts";

const load = (yaml: string, env: NodeJS.ProcessEnv = {}) =>
  resolveConfig(parseConfigText(yaml), { registry: builtinRegistry(), baseDir: "/tmp", env, now: Date.UTC(2026, 8, 1) });

function issues(yaml: string): string[] {
  try {
    load(yaml);
  } catch (err) {
    assert.ok(err instanceof ConfigError);
    return err.issues.length ? err.issues : [err.message];
  }
  assert.fail("expected a ConfigError");
}

const base = `
accounts:
  pb:
    provider: porkbun
targets:
  - id: t1
    domain: example.com
    availability:
      providers: [rdap, pb]
`;

describe("config validation", () => {
  it("applies safe defaults: dry run on, notify-only, conservative attempts", () => {
    const c = load(base);
    assert.equal(c.app.dryRun, true);
    const t = c.targets[0]!;
    assert.equal(t.registration.mode, "notify-only");
    assert.equal(t.registration.active, false);
    assert.equal(t.registration.maxTotalAttempts, 1);
    assert.equal(t.registration.budget.allowPremium, false);
    assert.equal(c.accounts.pb!.credentialEnv.apiKey, "PORKBUN_API_KEY");
    assert.equal(c.accounts.pb!.limits.availability.minIntervalMs, 1000);
  });

  it("rejects an empty domain, a negative budget and an invalid date (plan section 68)", () => {
    assert.ok(issues(`targets:\n  - id: t\n    domain: ""\n`).some((i) => i.includes("domain")));
    assert.ok(issues(`targets:\n  - id: t\n    domain: a.com\n    registration:\n      enabled: true\n      budget:\n        maxRegistrationPrice: -1\n`).some((i) => i.includes("maxRegistrationPrice")));
    assert.ok(issues(`targets:\n  - id: t\n    domain: a.com\n    drop:\n      expectedAt: not-a-date\n`).some((i) => i.includes("expectedAt")));
  });

  it("refuses secrets embedded in the config file", () => {
    const webhook = "notifications:\n  discord:\n    webhookEnv: X\n# https://discord.com/api/webhooks/123456789/abcdefghijklmnopqrstuvwxyz0123\n";
    assert.throws(() => parseConfigText(webhook), (e: unknown) => e instanceof ConfigError && e.issues[0]!.includes("Discord webhook"));
    assert.throws(() => parseConfigText(`proxies:\n  pools:\n    p:\n      proxies: ["http://user:secret@proxy:8080"]\n`), /secret-looking/);
    assert.ok(issues(`accounts:\n  pb:\n    provider: porkbun\n    credentials:\n      apiKey: my-actual-key-123\n`).some((i) => i.includes("environment variable NAME")));
  });

  it("requires a budget and registrars for auto-buy, and warns about Discord", () => {
    const yaml = `${base}    registration:\n      enabled: true\n      mode: auto-buy\n      providers: [pb]\n`;
    assert.ok(issues(yaml).some((i) => i.includes("maxRegistrationPrice is required for auto-buy")));
    const ok = load(`${yaml}      budget:\n        maxRegistrationPrice: 15\n`);
    assert.equal(ok.targets[0]!.registration.active, true);
    assert.ok(ok.warnings.some((w) => w.includes("DISCORD_WEBHOOK_URL is not set")));
  });

  it("rejects unknown accounts, wrong capabilities, duplicates and bad quorum setups", () => {
    assert.ok(issues(`targets:\n  - id: t\n    domain: a.com\n    availability:\n      providers: [nope]\n`).some((i) => i.includes('unknown account "nope"')));
    assert.ok(issues(`targets:\n  - id: t\n    domain: a.com\n    registration:\n      enabled: true\n      mode: confirm\n      providers: [rdap]\n`).some((i) => i.includes("cannot register")));
    assert.ok(issues(`targets:\n  - id: a\n    domain: x.com\n  - id: b\n    domain: X.COM.\n`).some((i) => i.includes("could buy it twice")));
    assert.ok(issues(`targets:\n  - id: t\n    domain: a.com\n    availability:\n      quorum:\n        mode: registry-confirmed\n`).some((i) => i.includes("registry-confirmed")));
  });

  it("normalizes quorum aliases", () => {
    const c = load(base.replace("providers: [rdap, pb]", "providers: [rdap, pb]\n      quorum:\n        mode: first-positive"));
    assert.equal(c.targets[0]!.availability.quorum, "any");
  });

  it("enforces profiles: production refuses mocks, development forces dry run", () => {
    const mock = `accounts:\n  m:\n    provider: mock\ntargets: []\n`;
    assert.ok(issues(mock).some((i) => i.includes("not allowed in profile")));
    const dev = load(`profile: development\napp:\n  dryRun: false\n${mock}`);
    assert.equal(dev.app.dryRun, true);
    assert.ok(issues(`profile: testing\n${base}`).some((i) => i.includes("sandbox or mock")));
  });

  it("refuses live auto-buy without a persistent database", () => {
    const yaml = `app:\n  dryRun: false\n  database: ":memory:"\n${base}    registration:\n      enabled: true\n      mode: auto-buy\n      providers: [pb]\n      budget:\n        maxRegistrationPrice: 10\n`;
    assert.ok(issues(yaml).some((i) => i.includes("persistent app.database")));
  });

  it("converts naive drop times with the target timezone and warns about DST ambiguity", () => {
    const c = load(`targets:\n  - id: t\n    domain: a.pl\n    drop:\n      expectedAt: "2026-10-25 02:30"\n      timezone: Europe/Warsaw\n`);
    assert.equal(c.targets[0]!.drop!.expectedAtMs, Date.UTC(2026, 9, 25, 0, 30));
    assert.ok(c.warnings.some((w) => w.includes("occurs twice")));
    assert.ok(issues(`app:\n  timezone: Mars/Base\n`).some((i) => i.includes("unknown IANA timezone")));
  });

  it("adds .pl specific warnings", () => {
    const c = load(`targets:\n  - id: t\n    domain: sklep.pl\n    drop:\n      expectedAt: "2026-10-01T12:00:00Z"\n      postWindowSeconds: 60\n`);
    assert.ok(c.warnings.some((w) => w.includes("NASK RDAP lags")));
    assert.ok(c.warnings.some((w) => w.includes("postWindowSeconds")));
  });

  it("requires a Namecheap contact only when the account registers", () => {
    const yaml = `accounts:\n  nc:\n    provider: namecheap\ntargets:\n  - id: t\n    domain: a.com\n    availability:\n      providers: [nc]\n`;
    assert.equal(load(yaml).targets.length, 1);
    const reg = `${yaml}    registration:\n      enabled: true\n      mode: confirm\n      providers: [nc]\n      budget:\n        maxRegistrationPrice: 10\n`;
    assert.ok(issues(reg).some((i) => i.includes("options.contact is required")));
  });
});
