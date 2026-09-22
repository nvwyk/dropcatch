# Requirements (MoSCoW)

Extracted from [`domain-drop-auto-buyer-plan.md`](../domain-drop-auto-buyer-plan.md) (Step B of the agentic workflow).
Status column reflects v0.2.0.

Legend: **Done** = implemented and covered by tests. **Partial** = implemented with a documented gap.
**Deferred** = intentionally not built yet.

## MUST HAVE

| # | Requirement | Plan section | Status |
|---|---|---|---|
| M1 | Node.js 22+, TypeScript, native ESM, CLI-first | 2, 4 | Done |
| M2 | YAML/JSON config + env vars, validated at runtime | 6, 7, 68 | Done |
| M3 | Secrets only by env var reference; reject secret-looking literals in config files | 7, 35 | Done |
| M4 | Multiple targets, each independently configured | 8 | Done |
| M5 | Domain normalization (case, scheme, path, trailing dot) and IDN to punycode | 8 | Done |
| M6 | Exact UTC drop timestamps, naive local times converted with an IANA timezone | 10, 67 | Done |
| M7 | Adaptive polling with idle, warm, hot and post phases, drift-free and aligned to the drop instant | 9, 26 | Done |
| M8 | Provider abstraction: core never calls a registrar directly | 3, 11, 48 | Done |
| M9 | Generic RDAP provider with IANA bootstrap and NASK `.pl` endpoint | 12 | Done |
| M10 | Registrar adapters: OVHcloud, Porkbun, Namecheap, Cloudflare (availability + registration) | 13 | Done (Namecheap/Cloudflare/OVH need live verification with real accounts, see PROVIDERS.md) |
| M11 | Multi-provider aggregation where timeouts, 429 and errors never count as "unavailable" | 15, 39 | Done |
| M12 | Modes: notify-only (default), confirm, auto-buy (explicit switch) | 19, 65 | Done |
| M13 | Dry-run that can never reach a provider's `register()` | 33 | Done |
| M14 | Purchase gate: domain match, budget, currency, premium, attempts, target enabled, window | 18, 36 | Done |
| M15 | Duplicate-purchase protection: persisted state machine, write-ahead attempts, CAS lock, attempt caps | 16, 17 | Done |
| M16 | Ambiguous registration results are a distinct state and block fallback to another registrar | 17, 37 | Done |
| M17 | Discord and Telegram notifications, non-blocking, never containing secrets | 20, 21, 57 | Done |
| M18 | Structured logs (pretty + JSON) with redaction of tokens, webhook URLs and proxy credentials | 35, 40 | Done |
| M19 | SQLite audit trail: targets, runs, checks, attempts, events | 29, 55 | Done |
| M20 | Transport layer with timeouts, retry policy and error taxonomy | 23, 24, 53 | Done |
| M21 | Per-provider rate limits enforced by the scheduler | 25, 50 | Done |
| M22 | CLI: init, providers, check, watch, buy, test, status | 30 to 34, 63, 64 | Done |
| M23 | Graceful shutdown that never interrupts an in-flight registration | 66 | Done |
| M24 | Mock providers for every failure scenario, tests with no network | 41, 71F | Done |

## SHOULD HAVE

| # | Requirement | Plan section | Status |
|---|---|---|---|
| S1 | HTTP / HTTPS / SOCKS5 proxies with static, round-robin, random, failover pools | 22 | Done |
| S2 | Credential profiles (several accounts per registrar) | 61 | Done |
| S3 | Profiles: development, testing, production | 43 | Done |
| S4 | Provider sandbox selection made explicit, never inferred | 42 | Done |
| S5 | TLD strategies (`generic`, `pl`) | 51, 52 | Done |
| S6 | Latency recording and per-provider stats | 27 | Done |
| S7 | Event timeline per target | 28 | Done |
| S8 | Docker image, docker-compose, systemd unit | 44 to 46 | Done |
| S9 | Interactive `init` with hidden secret input | 31 | Done |
| S10 | Clock skew hint from server `Date` headers | 10 | Done |
| S11 | Plugin loading for third-party providers without core changes | 48 | Done |
| S12 | `resolve` command to settle ambiguous or pending registrations | 17 | Done |

## COULD HAVE

| # | Requirement | Plan section | Status |
|---|---|---|---|
| C1 | Prometheus metrics endpoint | 40 | Done (`/metrics`, `/healthz`, `watch --metrics-port`) |
| C2 | Generic HTTP provider with safe templating | 49 | Deferred |
| C3 | Multi-currency budget conversion | 18 | Deferred (currency mismatch is a hard block) |
| C4 | Connection pre-warming for registration-only providers | 26 | Done |
| C5 | NTP-grade clock offset measurement | 10 | Done (SNTP, optional correction of scheduling) |
| C6 | `.pl` registration through an API registrar | 52 | Done (OVHcloud adapter) |
| C7 | Telegram notifications | 20 | Done |
| C8 | Bulk import and drop calendar (`.ics`) | 30 | Done |

## RESEARCH (answered in PROVIDERS.md and ARCHITECTURE.md)

- Real polling limits per provider.
- Whether RDAP 404 can trigger a purchase (answer: no, and for `.pl` it lags by up to 15 minutes).
- Which registrars sell the user's TLD (answer: OVHcloud sells `.pl` and `.com.pl`; Porkbun does not).
- Whether multi-registrar race registration is safe (answer: no parallel purchase; sequential fallback only after a confirmed failure).

## DEFERRED / NOT BUILDING

Public REST API for third parties, multi-user SaaS, automatic account creation, CAPTCHA or anti-bot bypass,
undocumented endpoints, browser automation, proxy rotation to evade limits, unlimited polling (plan section 73).
The single-user web dashboard (plan section 58) was built on request.
