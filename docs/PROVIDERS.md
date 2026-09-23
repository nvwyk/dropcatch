# Provider research

Step C of the plan: every adapter was checked against the provider's official documentation on 2026-09-22.
APIs change. Re-verify before relying on a provider for a real drop, and always run `dropcatch check <domain>`
and a dry run against the exact TLD you care about.

## Capability matrix

Generated from adapter metadata by `dropcatch providers` (this table mirrors it).

| Capability | OVHcloud | Porkbun | Namecheap | Cloudflare | RDAP |
|---|:-:|:-:|:-:|:-:|:-:|
| Sells `.pl` | **Yes** (PL catalog) | No | Unverified | No | n/a |
| Availability check | Yes (cart offers) | Yes | Yes | Yes | Yes (registry data, advisory) |
| Pricing in check | Yes (net of VAT) | Yes | Premium only, standard via `users.getPricing` | Yes | No |
| Registration | Yes | Yes | Yes | Yes (API beta, subset of TLDs) | No |
| Server-side dry run | Yes (`GET .../checkout`) | Yes (`dryRun: true`) | No | No | n/a |
| Ownership lookup (ambiguity resolution) | Yes (`GET /domain/{d}`) | Yes (`listAll`) | Yes (`domains.getList`) | Yes (`GET registrations/{domain}`) | n/a |
| Async registration status | Yes (`/me/order/{id}/status`) | n/a | n/a | Yes (`registration-status`) | n/a |
| Sandbox | No | Yes (`pk1_sb_` keys, same base URL) | Yes (`api.sandbox.namecheap.com`) | Yes (`registrar-sandbox`, com/net only) | n/a |
| Premium registration via API | No (not enabled) | No | Yes (not enabled in v0.1) | Needs acknowledgements (not enabled in v0.1) | n/a |
| Default limits used by dropcatch | 1 check/s | 1 check/s, 1 create/s | 1 check/2s, 25/min | 1 check/s | 1 req/2s, 20/min |

## OVHcloud

Sources: <https://docs.ovhcloud.com/en/guides/web-cloud/domains/api-domain-order>, the official
[python-ovh](https://github.com/ovh/python-ovh) client (signing), and live probes on 2026-09-23.

- **`.pl` is sold.** `GET /order/catalog/public/domain?ovhSubsidiary=PL` (public) lists plan codes `pl` and
  `com.pl`; `.pl` first year was 16.69 PLN net (catalog value `1669000000` = 16.69 x 10^8), VAT 23% on top.
- Endpoints: `https://eu.api.ovh.com/1.0` (also `ca.api.ovh.com`, `api.us.ovhcloud.com`).
- Signing: headers `X-Ovh-Application`, `X-Ovh-Consumer`, `X-Ovh-Timestamp`, and
  `X-Ovh-Signature = "$1$" + sha1(AS+"+"+CK+"+"+METHOD+"+"+fullUrl+"+"+body+"+"+timestamp)`, with the
  timestamp taken from `GET /auth/time` (unauthenticated) plus the measured delta.
- Availability: `GET /order/cart/{cartId}/domain?domain=...` returns offers; the `action: "create"` offer
  with `orderable: true` means registrable. `pricingMode` containing `premium` marks premium names.
  Requires an authenticated, assigned cart (verified: anonymous carts get `401 You must login first`).
  dropcatch keeps a dedicated lookup cart that never holds items.
- Order: `POST /order/cart/{id}/domain` -> `GET .../item/{itemId}/requiredConfiguration` ->
  `POST .../configuration` for each (`OWNER_CONTACT` = `/me/contact/{id}`, `ADMIN_ACCOUNT`/`TECH_ACCOUNT`
  = NIC handle, `OWNER_LEGAL_AGE`, and TLD-specific labels) -> `GET /order/cart/{id}/checkout`
  (validation, no order) -> `POST /order/cart/{id}/checkout` with
  `{ autoPayWithPreferredPaymentMethod, waiveRetractationPeriod }` which creates the order.
- Delivery: `GET /me/order/{orderId}/status` (`delivered`, `delivering`, `notPaid`, `cancelled`, ...).
- Safety in dropcatch: a separate buy cart; before the paid checkout it verifies that every line of the
  validated order is this domain and that the net total is not above the price the gate approved.
- No published API rate limits and no sandbox. Rehearse with `dryRun: true` (checkout preview only).
- Required token rights: `GET/POST/DELETE /order/cart*`, `GET /me*`, `GET /domain/*`.

## Porkbun

Source: <https://porkbun.com/api/json/v3/documentation> and the machine-readable reference <https://porkbun.com/llms-full.txt>.

- Base URL `https://api.porkbun.com/api/json/v3`. Auth via `apikey` / `secretapikey` in the JSON body (or `X-API-Key` / `X-Secret-API-Key` headers).
- Check: `POST /domain/checkDomain/{domain}`. `response.avail` is `"yes"`/`"no"`, `response.price` is a **string in USD dollars** (`"9.73"`), `premium` may be `"yes"`/`"no"` or boolean. Verified against the credential-free mock server (`/api/json/v3/mock/...`).
- Rate limit: **10 checks per 10 seconds per account** (single check). HTTP 429 carries `Retry-After`. dropcatch defaults to 1 check per second, the documented average.
- Create: `POST /domain/create/{domain}` with `cost` as **integer pennies** that must exactly equal the current price, and `agreeToTerms: "yes"`. A price change between check and create is rejected by Porkbun, which acts as a second budget guard.
- Create limits: 1 attempt per second, 1000 successes per day. Registration is always the registry-minimum term. **Premium domains cannot be registered via API.** The account must have a prior registration, verified email and phone, and enough credit.
- `dryRun: true` on create runs every pre-flight check (availability, cost match, funds, spend limit) without charging. dropcatch uses it for dry runs through a separate `preflight()` method, so `register()` is never reached.
- Sandbox: keys prefixed `pk1_sb_` / `sk1_sb_` against the same base URL. dropcatch refuses a sandbox account with a production key and warns on the opposite.
- Ownership: `POST /domain/listAll` with a `domain` filter.
- **Does not sell `.pl`**: `pricing/get` returns `0.00` for `pl` and `com.pl` (checked live on 2026-09-22).

## Namecheap

Sources: <https://www.namecheap.com/support/api/intro/>, <https://www.namecheap.com/support/api/methods/domains/check/>,
<https://www.namecheap.com/support/api/methods/domains/create/>. The official pages block automated fetches, so parts of the
adapter follow the long-stable published XML schema and **must be verified against the sandbox before a real purchase**.

- Endpoints: `https://api.namecheap.com/xml.response` and `https://api.sandbox.namecheap.com/xml.response`.
- Global params: `ApiUser`, `ApiKey`, `UserName`, `ClientIp`, `Command`. The API key only works from **whitelisted IPs**. With a proxy, the whitelisted IP must be the proxy's egress IP.
- `namecheap.domains.check` returns `DomainCheckResult` with `Available`, `IsPremiumName`, `PremiumRegistrationPrice`, `EapFee`, `IcannFee`. Standard prices are not included, so the adapter caches `namecheap.users.getPricing` per TLD during arming.
- `namecheap.domains.create` needs Registrant, Tech, Admin and AuxBilling contacts (dropcatch applies one configured contact to all four). The response `DomainCreateResult` has `Registered`, `ChargedAmount`, `OrderID`, `TransactionID`, `NonRealTimeDomain`.
- Rate limits: **50/min, 700/hour, 8000/day** per key. dropcatch defaults to 1 check per 2 seconds and 25 checks per minute.
- Errors come back as HTTP 200 with `Status="ERROR"`. These are treated as confirmed failures because the server processed and rejected the command.

## Cloudflare Registrar

Sources: <https://developers.cloudflare.com/registrar/registrar-api/>, <https://developers.cloudflare.com/api/resources/registrar/>,
<https://developers.cloudflare.com/api/resources/registrar_sandbox/>.

- Base `https://api.cloudflare.com/client/v4/accounts/{account_id}/registrar` (sandbox: `.../registrar-sandbox`). Auth: API token with Registrar write permission.
- Check: `POST /domain-check` with `{"domains": [...]}` (max 20). Result per domain: `registrable`, `tier` (`standard`/`premium`), `pricing.registration_cost` (string), `pricing.currency`, and `reason` when not registrable (`domain_unavailable`, `domain_premium`, `extension_not_supported_via_api`, `extension_not_supported`, `extension_disallows_registration`).
- Create: `POST /registrations` with `domain_name` (plus optional `years`, `auto_renew`, `privacy_mode`, `contacts`). `201` means done, `202` means poll `registration-status`. The domain name is documented as the natural idempotency key. **All registrations are non-refundable.**
- The request carries no price field, so the check price validated by the gate is the last guard. That leaves a window of milliseconds in which the price could change.
- API is a beta limited to a subset of TLDs. Sandbox supports only `com` and `net` and requires full contact data.
- No rate limits are published for the registrar endpoints. dropcatch defaults to 1 check per second.

## RDAP

- IANA bootstrap: <https://data.iana.org/rdap/dns.json> (fetched lazily, cached in memory).
- NASK `.pl`: <https://www.dns.pl/en/RDAP_in_NASK>. Endpoint `https://rdap.dns.pl/domain/{domain}`. `200` = object exists, `404` = valid query for a non-existing object, `400` = invalid query.
- **Observed 2026-09-23:** after several minutes of polling `rdap.dns.pl` at about 1 request per second, NASK answered `429` with no `Retry-After` header and kept blocking the IP. dropcatch now defaults RDAP to 1 request per 2 s and at most 20 per minute, and backs off exponentially (5 s up to 5 min) on repeated 429s.
- **Observed 2026-09-23, continued:** once blocked, NASK let a single request through roughly every 15 minutes and answered `429` again to a request 5 s later. Back-off therefore steps down one level per successful answer (5 min, 2 min 40 s, 1 min 20 s ...) instead of resetting. Watching a `.pl` name around the clock without a drop time polls every `fixedIntervalMs` (5 s by default), which is enough to get blocked; set `drop.expectedAt` or raise `fixedIntervalMs`.
- **NASK states that RDAP data lags the registry by up to 15 minutes.** An RDAP 404 on `.pl` is therefore an early hint, never proof of registrability, and it can arrive long after a registrar already sees the domain as free.
- RDAP is registry data access, not a purchase API. dropcatch never buys on an RDAP signal alone: every registration is preceded by a final check at the registrar that will perform it.

## `.pl` lifecycle notes

Sources: <https://www.dns.pl/en/domain_name_life_cycle>, <https://www.dns.pl/en/news/item/596>.

- An unrenewed `.pl` domain enters a 30-day BLOCKED period, then returns to the pool of available names.
- A domain deleted by its holder sits in DELETE_BLOCKED for 5 days.
- NASK does not publish an exact release second, so a configured `expectedAt` is a scheduling hint. Keep a generous `postWindowSeconds`.
- You need a registrar that sells `.pl` and has an API: OVHcloud (subsidiary PL) does, verified via its public catalog.
