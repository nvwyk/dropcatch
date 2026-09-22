import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import type { RegistrationRequest } from "../../src/core/types.ts";
import { ovhOrderStatus, ovhPlugin, ovhSignature, parseOffers } from "../../src/providers/ovh/OvhProvider.ts";
import type { HttpRequest } from "../../src/transport/HttpTransport.ts";
import { FakeTransport, providerCtx, response, timeoutAfterSend } from "../helpers/fakes.ts";

const BASE = "https://eu.api.ovh.com/1.0";
const creds = { applicationKey: "ak", applicationSecret: "as", consumerKey: "ck" };
const req = (amount = 16.69): RegistrationRequest => ({ domain: "sklep.pl", price: { amount, currency: "PLN" }, premium: false, years: 1, attemptId: "a", timeoutMs: 2000 });

const offers = (orderable: boolean, mode = "create-default") => [
  { action: "create", offer: "gold", orderable, pricingMode: mode, duration: ["P1Y"], prices: [{ label: "PRICE", price: { value: 16.69, currencyCode: "PLN" } }, { label: "TOTAL", price: { value: 16.69, currencyCode: "PLN" } }] },
];

interface Script {
  preview?: unknown;
  previewStatus?: number;
  required?: Array<{ label: string; required: boolean }>;
  checkout?: (r: HttpRequest) => ReturnType<typeof response>;
}

/** Routes OVH API calls by method and path. */
function ovhServer(script: Script = {}): FakeTransport {
  return new FakeTransport((r) => {
    const path = r.url.replace(BASE, "").split("?")[0]!;
    const key = `${r.method} ${path}`;
    if (key === "GET /auth/time") return response(200, String(Math.floor(Date.now() / 1000)));
    if (key === "POST /order/cart") return response(200, { cartId: "cart-1", expire: new Date(Date.now() + 86_400_000).toISOString() });
    if (key === "POST /order/cart/cart-1/assign") return response(200, null);
    if (key === "GET /me") return response(200, { nichandle: "ab12345-ovh" });
    if (key === "GET /order/cart/cart-1/domain") return response(200, offers(r.url.includes("free")));
    if (key === "POST /order/cart/cart-1/domain") return response(200, { itemId: 42 });
    if (key === "GET /order/cart/cart-1/item/42/requiredConfiguration") return response(200, script.required ?? [{ label: "OWNER_CONTACT", required: true }, { label: "ADMIN_ACCOUNT", required: true }, { label: "TECH_ACCOUNT", required: true }]);
    if (key === "POST /order/cart/cart-1/item/42/configuration") return response(200, { id: 1 });
    if (key === "DELETE /order/cart/cart-1/item/42") return response(200, null);
    if (key === "GET /order/cart/cart-1/checkout") {
      return response(script.previewStatus ?? 200, script.preview ?? { prices: { withoutTax: { value: 16.69, currencyCode: "PLN" }, withTax: { value: 20.53, currencyCode: "PLN", text: "20.53 PLN" } }, details: [{ domain: "sklep.pl" }] });
    }
    if (key === "POST /order/cart/cart-1/checkout") return script.checkout ? script.checkout(r) : response(200, { orderId: 777, url: "https://ovh/pay/777" });
    if (key === "GET /me/order/777/status") return response(200, JSON.stringify("delivered"));
    if (key === "GET /domain/sklep.pl") return response(200, { domain: "sklep.pl" });
    return response(404, { message: `unexpected ${key}` });
  });
}

const make = (t: FakeTransport, options: Record<string, unknown> = { ownerContact: 12345 }) =>
  ovhPlugin.create(providerCtx(ovhPlugin, { transport: t, credentials: creds, options, accountId: "ovh-main" }));

const paths = (t: FakeTransport): string[] => t.requests.map((r) => `${r.method} ${r.url.replace(BASE, "").split("?")[0]}`);

describe("ovh adapter", () => {
  it("signs requests exactly like the official client", async () => {
    const expected = `$1$${createHash("sha1").update("as+ck+GET+https://x/1.0/me++1700000000").digest("hex")}`;
    assert.equal(ovhSignature("as", "ck", "get", "https://x/1.0/me", "", 1700000000), expected);
    const t = ovhServer();
    await make(t).check!({ domain: "free.pl", timeoutMs: 1000 });
    const signed = t.requests.find((r) => r.url.includes("/order/cart/cart-1/domain"))!;
    assert.equal(signed.headers!["x-ovh-application"], "ak");
    assert.equal(signed.headers!["x-ovh-consumer"], "ck");
    const ts = Number(signed.headers!["x-ovh-timestamp"]);
    assert.equal(signed.headers!["x-ovh-signature"], ovhSignature("as", "ck", "GET", signed.url, "", ts));
  });

  it("reads orderable create offers with PLN prices (net of VAT)", async () => {
    const inst = make(ovhServer());
    const free = await inst.check!({ domain: "free.pl", timeoutMs: 1000 });
    assert.deepEqual([free.status, free.price, free.registrable], ["available", { amount: 16.69, currency: "PLN" }, true]);
    const taken = await inst.check!({ domain: "taken.pl", timeoutMs: 1000 });
    assert.equal(taken.status, "unavailable");
    assert.equal(parseOffers([{ action: "transfer" }]).transferOnly, true);
    assert.equal(parseOffers(offers(true, "create-premium")).premium, true);
  });

  it("buys through the cart: configure, validate, then a single paid checkout", async () => {
    const t = ovhServer();
    const r = await make(t).register!(req());
    assert.equal(r.status, "pending");
    assert.equal(r.providerReference, "order:777");
    const flow = paths(t);
    assert.equal(flow.filter((p) => p === "POST /order/cart/cart-1/checkout").length, 1);
    assert.ok(flow.indexOf("GET /order/cart/cart-1/checkout") < flow.indexOf("POST /order/cart/cart-1/checkout"));
    const configs = t.requests.filter((x) => x.url.endsWith("/configuration")).map((x) => JSON.parse(x.body!));
    assert.deepEqual(configs.map((c) => c.label).sort(), ["ADMIN_ACCOUNT", "OWNER_CONTACT", "TECH_ACCOUNT"]);
    assert.equal(configs.find((c) => c.label === "OWNER_CONTACT").value, "/me/contact/12345");
    assert.equal(configs.find((c) => c.label === "ADMIN_ACCOUNT").value, "ab12345-ovh");
    const checkoutBody = JSON.parse(t.requests.find((x) => x.method === "POST" && x.url.endsWith("/checkout"))!.body!);
    assert.deepEqual(checkoutBody, { autoPayWithPreferredPaymentMethod: true, waiveRetractationPeriod: true });
  });

  it("never checks out when the order total is above the verified price", async () => {
    const t = ovhServer({ preview: { prices: { withoutTax: { value: 99, currencyCode: "PLN" } }, details: [{ domain: "sklep.pl" }] } });
    const r = await make(t).register!(req());
    assert.deepEqual([r.status, r.errorCode], ["failed", "PRICE_CHANGED"]);
    assert.ok(!paths(t).includes("POST /order/cart/cart-1/checkout"));
    assert.ok(paths(t).includes("DELETE /order/cart/cart-1/item/42"), "the item is removed again");
  });

  it("refuses to check out a cart that contains other items", async () => {
    const t = ovhServer({ preview: { prices: { withoutTax: { value: 16.69, currencyCode: "PLN" } }, details: [{ domain: "sklep.pl" }, { domain: "other.pl" }] } });
    const r = await make(t).register!(req());
    assert.equal(r.status, "failed");
    assert.match(r.reason!, /other items/);
    assert.ok(!paths(t).includes("POST /order/cart/cart-1/checkout"));
  });

  it("stops with a clear error when a TLD needs configuration it does not have", async () => {
    const t = ovhServer({ required: [{ label: "OWNER_CONTACT", required: true }, { label: "ACCEPT_CONDITIONS", required: true }] });
    const r = await make(t).register!(req());
    assert.deepEqual([r.status, r.errorCode], ["failed", "CONFIGURATION_ERROR"]);
    assert.match(r.reason!, /ACCEPT_CONDITIONS/);
    const ok = await make(ovhServer({ required: [{ label: "ACCEPT_CONDITIONS", required: true }] }), { ownerContact: 1, acceptConditions: true }).register!(req());
    assert.equal(ok.status, "pending");
  });

  it("dry run validates the whole order but never sends the paid checkout", async () => {
    const t = ovhServer();
    const r = await make(t).preflight!(req());
    assert.deepEqual([r.status, r.simulated], ["success", true]);
    assert.match(r.reason!, /No order was created/);
    assert.ok(paths(t).includes("GET /order/cart/cart-1/checkout"));
    assert.ok(!paths(t).includes("POST /order/cart/cart-1/checkout"));
  });

  it("treats a timeout on the paid checkout as unknown, but earlier failures as confirmed", async () => {
    const lost = await make(ovhServer({ checkout: timeoutAfterSend })).register!(req());
    assert.equal(lost.status, "unknown");
    const early = await make(ovhServer({ previewStatus: 400, preview: { message: "Domain is not available" } })).register!(req());
    assert.deepEqual([early.status, early.errorCode], ["failed", "DOMAIN_UNAVAILABLE"]);
  });

  it("follows orders to delivery and looks up ownership", async () => {
    const inst = make(ovhServer());
    const s = await inst.getRegistrationStatus!("sklep.pl", "order:777", 1000);
    assert.equal(s.status, "success");
    assert.equal(await inst.lookupOwnership!("sklep.pl", 1000), "owned");
    assert.equal(ovhOrderStatus("notPaid"), "pending");
    assert.equal(ovhOrderStatus("cancelled"), "failed");
  });

  it("requires an owner contact only for registering accounts", () => {
    assert.deepEqual(ovhPlugin.validateAccount!(ovhPlugin.optionsSchema!.parse({}), { registration: false }), []);
    assert.equal(ovhPlugin.validateAccount!(ovhPlugin.optionsSchema!.parse({}), { registration: true }).length, 1);
  });
});
