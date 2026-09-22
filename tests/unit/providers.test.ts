import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigError } from "../../src/core/errors.ts";
import type { AvailabilityResult, RegistrationRequest, RegistrationResult } from "../../src/core/types.ts";
import { cloudflarePlugin } from "../../src/providers/cloudflare/CloudflareProvider.ts";
import { namecheapPlugin, parseRegistrationPrice } from "../../src/providers/namecheap/NamecheapProvider.ts";
import { porkbunPlugin } from "../../src/providers/porkbun/PorkbunProvider.ts";
import { parseBootstrap, rdapPlugin } from "../../src/providers/rdap/RdapProvider.ts";
import type { AnyProviderPlugin, ProviderInstance } from "../../src/providers/types.ts";
import { connectionRefused, FakeTransport, providerCtx, response, timeoutAfterSend } from "../helpers/fakes.ts";

const STATUSES = new Set(["available", "unavailable", "unknown", "unsupported", "rate_limited", "error"]);

function assertAvailabilityContract(r: AvailabilityResult, provider: string, domain: string): void {
  assert.equal(r.provider, provider);
  assert.equal(r.domain, domain);
  assert.ok(STATUSES.has(r.status), r.status);
  assert.ok(Number.isFinite(Date.parse(r.startedAt)) && Number.isFinite(Date.parse(r.checkedAt)));
  assert.ok(r.latencyMs >= 0);
  if (r.status === "error") assert.ok(r.errorCode, "errors carry a stable code");
}

function assertRegistrationContract(r: RegistrationResult): void {
  assert.ok(["success", "pending", "failed", "unknown"].includes(r.status));
  assert.ok(r.startedAt && r.finishedAt);
  if (r.status === "failed" || r.status === "unknown") assert.ok(r.errorCode);
}

const req = (price = 9.73): RegistrationRequest => ({
  domain: "example.com",
  price: { amount: price, currency: "USD" },
  premium: false,
  years: 1,
  attemptId: "a1",
  timeoutMs: 1000,
});

function make(plugin: AnyProviderPlugin, transport: FakeTransport, extra: { options?: unknown; credentials?: Record<string, string>; environment?: "production" | "sandbox" } = {}): ProviderInstance {
  return plugin.create(providerCtx(plugin, { transport, accountId: "acct", ...extra }));
}

describe("porkbun adapter", () => {
  const creds = { apiKey: "pk1_live", secretApiKey: "sk1_live" };

  it("parses availability with dollar-string prices and premium flags", async () => {
    const t = new FakeTransport(() => response(200, { status: "SUCCESS", response: { avail: "yes", price: "9.73", premium: "no" } }));
    const r = await make(porkbunPlugin, t, { credentials: creds }).check!({ domain: "example.com", timeoutMs: 1000 });
    assertAvailabilityContract(r, "acct", "example.com");
    assert.equal(r.status, "available");
    assert.deepEqual(r.price, { amount: 9.73, currency: "USD" });
    assert.equal(r.registrable, true);
    const body = t.requests[0]!.json as Record<string, unknown>;
    assert.equal(body.apikey, "pk1_live");
    assert.match(t.requests[0]!.url, /\/domain\/checkDomain\/example\.com$/);

    const premium = await make(porkbunPlugin, new FakeTransport(() => response(200, { status: "SUCCESS", response: { avail: "yes", price: "999.00", premium: "yes" } })), { credentials: creds })
      .check!({ domain: "example.com", timeoutMs: 1000 });
    assert.equal(premium.premium, true);
    assert.equal(premium.registrable, false);
  });

  it("maps rate limits, auth errors and transport failures", async () => {
    const limited = await make(porkbunPlugin, new FakeTransport(() => response(429, { status: "ERROR", code: "RATE_LIMIT_EXCEEDED" }, { "retry-after": "3" })), { credentials: creds })
      .check!({ domain: "example.com", timeoutMs: 1000 });
    assert.equal(limited.status, "rate_limited");
    assert.equal(limited.retryAfterMs, 3000);
    const auth = await make(porkbunPlugin, new FakeTransport(() => response(400, { status: "ERROR", code: "INVALID_API_KEYS_001", message: "invalid" })), { credentials: creds })
      .check!({ domain: "example.com", timeoutMs: 1000 });
    assert.equal(auth.errorCode, "AUTHENTICATION_FAILED");
    const down = await make(porkbunPlugin, new FakeTransport(timeoutAfterSend), { credentials: creds }).check!({ domain: "example.com", timeoutMs: 1000 });
    assert.equal(down.status, "error");
    assert.equal(down.errorCode, "NETWORK_TIMEOUT");
  });

  it("registers with the exact cost in pennies and reports the order id", async () => {
    const t = new FakeTransport(() => response(200, { status: "SUCCESS", domain: "example.com", cost: 973, orderId: 12345 }));
    const r = await make(porkbunPlugin, t, { credentials: creds }).register!(req());
    assertRegistrationContract(r);
    assert.equal(r.status, "success");
    assert.equal(r.providerReference, "12345");
    const body = t.requests[0]!.json as Record<string, unknown>;
    assert.equal(body.cost, 973);
    assert.equal(body.agreeToTerms, "yes");
    assert.equal(body.dryRun, undefined, "a real registration never sends dryRun");
  });

  it("treats an explicit rejection as a confirmed failure and anything unclear as unknown", async () => {
    const reject = await make(porkbunPlugin, new FakeTransport(() => response(400, { status: "ERROR", code: "DOMAIN_NOT_AVAILABLE", message: "not available" })), { credentials: creds }).register!(req());
    assert.deepEqual([reject.status, reject.errorCode], ["failed", "DOMAIN_UNAVAILABLE"]);
    const serverError = await make(porkbunPlugin, new FakeTransport(() => response(502, "bad gateway")), { credentials: creds }).register!(req());
    assert.equal(serverError.status, "unknown");
    const garbled = await make(porkbunPlugin, new FakeTransport(() => response(200, "<html>")), { credentials: creds }).register!(req());
    assert.equal(garbled.status, "unknown");
    const timeout = await make(porkbunPlugin, new FakeTransport(timeoutAfterSend), { credentials: creds }).register!(req());
    assert.equal(timeout.status, "unknown");
    const refused = await make(porkbunPlugin, new FakeTransport(connectionRefused), { credentials: creds }).register!(req());
    assert.equal(refused.status, "failed", "never sent = safe to fall back");
  });

  it("uses Porkbun's server-side dry run for preflight and marks it simulated", async () => {
    const t = new FakeTransport(() => response(200, { status: "SUCCESS", dryRun: true, wouldSucceed: true, cost: 973, message: "would succeed" }));
    const r = await make(porkbunPlugin, t, { credentials: creds }).preflight!(req());
    assert.equal(r.simulated, true);
    assert.equal(r.status, "success");
    assert.equal((t.requests[0]!.json as Record<string, unknown>).dryRun, true);
  });

  it("refuses a sandbox account with a production key", () => {
    assert.throws(() => make(porkbunPlugin, new FakeTransport(() => response(200)), { credentials: creds, environment: "sandbox" }), ConfigError);
    assert.doesNotThrow(() => make(porkbunPlugin, new FakeTransport(() => response(200)), { credentials: { apiKey: "pk1_sb_x", secretApiKey: "sk1_sb_x" }, environment: "sandbox" }));
  });

  it("looks up ownership via listAll", async () => {
    const t = new FakeTransport(() => response(200, { status: "SUCCESS", domains: [{ domain: "example.com" }] }));
    assert.equal(await make(porkbunPlugin, t, { credentials: creds }).lookupOwnership!("example.com", 1000), "owned");
    assert.equal(await make(porkbunPlugin, t, { credentials: creds }).lookupOwnership!("other.com", 1000), "not-owned");
  });
});

describe("namecheap adapter", () => {
  const creds = { apiUser: "u", apiKey: "k", clientIp: "203.0.113.5" };
  const ok = (inner: string): string => `<?xml version="1.0"?><ApiResponse Status="OK" xmlns="http://api.namecheap.com/xml.response"><Errors/><CommandResponse>${inner}</CommandResponse></ApiResponse>`;
  const contact = { firstName: "Marta", lastName: "Kowalczyk", address1: "Prosta 12", city: "Warszawa", stateProvince: "MZ", postalCode: "00-850", country: "PL", phone: "+48.221234567", email: "m@example.pl" };

  it("checks availability over POST (key never in the URL) and uses cached TLD pricing", async () => {
    const t = new FakeTransport((r) => {
      const cmd = r.form!.Command;
      if (cmd === "namecheap.users.getPricing") return response(200, ok('<ProductType Name="domains"><Product Name="com"><Price Duration="1" DurationType="YEAR" YourPrice="10.28" YourAdditonalCost="0.20" Currency="USD"/></Product></ProductType>'));
      return response(200, ok('<DomainCheckResult Domain="example.com" Available="true" ErrorNo="0" IsPremiumName="false" PremiumRegistrationPrice="0" EapFee="0" IcannFee="0"/>'));
    });
    const inst = make(namecheapPlugin, t, { credentials: creds });
    await inst.prepare!("example.com");
    const r = await inst.check!({ domain: "example.com", timeoutMs: 1000 });
    assertAvailabilityContract(r, "acct", "example.com");
    assert.equal(r.status, "available");
    assert.deepEqual(r.price, { amount: 10.48, currency: "USD" });
    assert.ok(!t.requests.some((x) => x.url.includes("ApiKey")));
    assert.equal(t.requests[1]!.form!.ClientIp, "203.0.113.5");
  });

  it("maps API errors and registration results", async () => {
    const err = `<ApiResponse Status="ERROR"><Errors><Error Number="1011150">Invalid request IP: 1.2.3.4 is not whitelisted</Error></Errors></ApiResponse>`;
    const r = await make(namecheapPlugin, new FakeTransport(() => response(200, err)), { credentials: creds }).check!({ domain: "example.com", timeoutMs: 1000 });
    assert.equal(r.errorCode, "AUTHENTICATION_FAILED");

    const created = ok('<DomainCreateResult Domain="example.com" Registered="true" ChargedAmount="10.48" DomainID="9" OrderID="77" TransactionID="88" NonRealTimeDomain="false"/>');
    const t = new FakeTransport(() => response(200, created));
    const reg = await make(namecheapPlugin, t, { credentials: creds, options: { contact } }).register!(req(10.48));
    assertRegistrationContract(reg);
    assert.deepEqual([reg.status, reg.providerReference, reg.price?.amount], ["success", "order:77", 10.48]);
    assert.equal(t.requests[0]!.form!.RegistrantCountry, "PL");
    assert.equal(t.requests[0]!.form!.AuxBillingEmailAddress, "m@example.pl");

    const rejected = await make(namecheapPlugin, new FakeTransport(() => response(200, `<ApiResponse Status="ERROR"><Errors><Error Number="2033409">Domain is not available</Error></Errors></ApiResponse>`)), { credentials: creds, options: { contact } }).register!(req());
    assert.deepEqual([rejected.status, rejected.errorCode], ["failed", "DOMAIN_UNAVAILABLE"]);
    const noContact = await make(namecheapPlugin, new FakeTransport(() => response(200)), { credentials: creds }).register!(req());
    assert.equal(noContact.errorCode, "CONFIGURATION_ERROR");
  });

  it("parses users.getPricing including the misspelled attribute", () => {
    assert.deepEqual(parseRegistrationPrice('<Price Duration="1" DurationType="YEAR" YourPrice="8.00" YourAdditonalCost="0.18" Currency="USD"/>'), { amount: 8.18, currency: "USD" });
    assert.equal(parseRegistrationPrice("<nothing/>"), undefined);
  });
});

describe("cloudflare adapter", () => {
  const creds = { apiToken: "tok", accountId: "acc123" };
  const env = (result: unknown, success = true) => ({ success, errors: [], messages: [], result });

  it("checks availability with pricing, premium tier and unsupported extensions", async () => {
    const t = new FakeTransport(() => response(200, env({ domains: [{ name: "example.com", registrable: true, tier: "standard", pricing: { currency: "USD", registration_cost: "8.57" } }] })));
    const r = await make(cloudflarePlugin, t, { credentials: creds }).check!({ domain: "example.com", timeoutMs: 1000 });
    assertAvailabilityContract(r, "acct", "example.com");
    assert.deepEqual([r.status, r.price?.amount], ["available", 8.57]);
    assert.equal(t.requests[0]!.headers!.authorization, "Bearer tok");
    assert.match(t.requests[0]!.url, /accounts\/acc123\/registrar\/domain-check$/);

    const unsupported = await make(cloudflarePlugin, new FakeTransport(() => response(200, env({ domains: [{ name: "example.com", registrable: false, reason: "extension_not_supported_via_api" }] }))), { credentials: creds })
      .check!({ domain: "example.com", timeoutMs: 1000 });
    assert.equal(unsupported.status, "unsupported");
    const premium = await make(cloudflarePlugin, new FakeTransport(() => response(200, env({ domains: [{ name: "example.com", registrable: false, tier: "premium", reason: "domain_premium" }] }))), { credentials: creds })
      .check!({ domain: "example.com", timeoutMs: 1000 });
    assert.deepEqual([premium.status, premium.premium, premium.registrable], ["available", true, false]);
  });

  it("maps 201, 202 and failures of the registration workflow; uses the sandbox path when asked", async () => {
    const done = await make(cloudflarePlugin, new FakeTransport(() => response(201, env({ state: "succeeded", completed: true }))), { credentials: creds }).register!(req());
    assert.equal(done.status, "success");
    const pending = await make(cloudflarePlugin, new FakeTransport(() => response(202, env({ state: "in_progress", links: { self: "https://x/status" } }))), { credentials: creds }).register!(req());
    assert.deepEqual([pending.status, pending.providerReference], ["pending", "https://x/status"]);
    const rejected = await make(cloudflarePlugin, new FakeTransport(() => response(400, { success: false, errors: [{ code: 1, message: "Domain is not available" }] })), { credentials: creds }).register!(req());
    assert.deepEqual([rejected.status, rejected.errorCode], ["failed", "DOMAIN_UNAVAILABLE"]);
    const unclear = await make(cloudflarePlugin, new FakeTransport(() => response(500, "oops")), { credentials: creds }).register!(req());
    assert.equal(unclear.status, "unknown");
    const t = new FakeTransport(() => response(201, env({ state: "succeeded" })));
    await make(cloudflarePlugin, t, { credentials: creds, environment: "sandbox" }).register!(req());
    assert.match(t.requests[0]!.url, /registrar-sandbox\/registrations$/);
  });

  it("looks up ownership", async () => {
    assert.equal(await make(cloudflarePlugin, new FakeTransport(() => response(404, { success: false })), { credentials: creds }).lookupOwnership!("example.com", 1000), "not-owned");
    assert.equal(await make(cloudflarePlugin, new FakeTransport(() => response(200, env({}))), { credentials: creds }).lookupOwnership!("example.com", 1000), "owned");
  });
});

describe("rdap adapter", () => {
  it("uses NASK for .pl, marks 404 as advisory, and 200 as registered", async () => {
    const t = new FakeTransport((r) => (r.url.endsWith("/free.pl") ? response(404, "") : response(200, { objectClassName: "domain", ldhName: "taken.pl", status: ["active"] })));
    const inst = make(rdapPlugin, t);
    const free = await inst.check!({ domain: "free.pl", timeoutMs: 1000 });
    assertAvailabilityContract(free, "acct", "free.pl");
    assert.deepEqual([free.status, free.advisory, free.sourceKind], ["available", true, "registry"]);
    assert.equal(t.requests[0]!.url, "https://rdap.dns.pl/domain/free.pl");
    const taken = await inst.check!({ domain: "taken.pl", timeoutMs: 1000 });
    assert.equal(taken.status, "unavailable");
    assert.match(taken.reason!, /active/);
  });

  it("resolves other TLDs through the IANA bootstrap and reports unsupported TLDs", async () => {
    const t = new FakeTransport((r) => {
      if (r.url.includes("dns.json")) return response(200, { services: [[["com", "net"], ["http://x/", "https://rdap.verisign.test/com/v1/"]]] });
      return response(404, "");
    });
    const inst = make(rdapPlugin, t);
    const r = await inst.check!({ domain: "example.com", timeoutMs: 1000 });
    assert.equal(r.status, "available");
    assert.equal(r.advisory, false);
    assert.equal(t.requests[1]!.url, "https://rdap.verisign.test/com/v1/domain/example.com");
    const none = await inst.check!({ domain: "example.zz", timeoutMs: 1000 });
    assert.equal(none.status, "unsupported");
    assert.equal(parseBootstrap({ services: [[["A"], ["https://a/x"]]] }).get("a"), "https://a/x/");
  });
});
