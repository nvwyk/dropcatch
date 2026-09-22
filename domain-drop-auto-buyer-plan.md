# Domain Drop Watcher & Auto-Buyer — Professional Node.js Implementation Plan

## 1. Project Overview

Build a production-oriented, reusable **Node.js domain drop watcher and auto-buyer**.

The application should allow different users to configure one or more domains that are expected to become available at a known date/time and then:

1. monitor the target domain as the release window approaches,
2. determine whether the domain has actually become registrable,
3. optionally verify availability through one or more registrar/provider APIs,
4. immediately attempt registration when configured to do so,
5. send near-real-time Discord webhook notifications,
6. keep a complete local audit trail of checks, errors, attempts, and registration results,
7. support multiple providers, credentials, proxies, and monitoring strategies without rewriting the core application.

The project should be designed as a **general-purpose tool**, not a one-off script for a single domain.

The architecture should make it possible to add new registrars, registries, notification channels, and detection strategies as independent adapters/plugins.

---

## 2. Primary Goals

### Functional goals

- Node.js + TypeScript.
- CLI-first application.
- Easy configuration through YAML/JSON and/or environment variables.
- Support multiple target domains.
- Support exact release timestamps.
- Support configurable pre-drop and post-drop monitoring windows.
- Support adaptive polling frequency.
- Support multiple availability providers.
- Support direct registry/RDAP checks where appropriate.
- Support registrar-side real-time availability checks.
- Support automatic registration through supported registrar APIs.
- Support notification-only mode.
- Support auto-buy mode.
- Support dry-run / simulation mode.
- Support Discord webhooks.
- Support structured logs.
- Persist run history locally.
- Allow multiple independent registrar accounts.
- Allow provider fallback and race strategies where technically and contractually appropriate.
- Allow optional HTTP/SOCKS proxy configuration.
- Keep API credentials outside normal configuration files where possible.
- Provide clear failure reasons.

### Non-functional goals

- Low latency around the expected drop.
- Predictable request scheduling.
- Resilient network handling.
- No uncontrolled request loops.
- No accidental repeated purchases.
- Strong credential isolation.
- Easy installation for non-developers.
- Easy Docker deployment.
- Easy VPS deployment.
- Good observability.
- Testability with mocked providers.
- Extensible provider architecture.

---

## 3. Important Design Principle

Do **not** build the application around one registrar's API.

Instead, create a provider abstraction:

```text
Core engine
    |
    +-- Availability Provider Interface
    |       +-- Cloudflare
    |       +-- Namecheap
    |       +-- Porkbun
    |       +-- Generic RDAP
    |       +-- Future providers
    |
    +-- Registration Provider Interface
    |       +-- Cloudflare
    |       +-- Namecheap
    |       +-- Porkbun
    |       +-- Future providers
    |
    +-- Notification Interface
    |       +-- Discord
    |       +-- Future Telegram/Slack/etc.
    |
    +-- Transport Interface
            +-- Direct HTTP
            +-- HTTP proxy
            +-- SOCKS proxy
```

The core engine should never contain registrar-specific API calls.

---

# 4. Suggested Technology Stack

## Runtime

- Node.js 22+ LTS if compatible with the project's final dependency set.
- TypeScript.
- Native ESM unless a dependency requires otherwise.

## HTTP

Prefer a modern Node.js HTTP client with:

- timeout support,
- AbortController,
- connection reuse,
- retry hooks,
- proxy support,
- predictable error handling.

Potential options for agent evaluation:

- native `fetch` / Undici,
- `got`,
- `axios`.

The implementation should avoid unnecessary dependencies if native Node.js functionality is sufficient.

## Validation

Use a runtime schema validator.

Preferred candidates:

- Zod,
- Valibot,
- ArkType.

The agent should compare bundle size, DX, TypeScript inference, and ecosystem stability before deciding.

## CLI

Potential candidates:

- Commander,
- yargs,
- citty,
- oclif.

Recommended initial direction:

- Commander or yargs for a small, focused CLI.

## Logging

Potential candidates:

- Pino,
- Winston.

Prefer structured JSON logging internally, with human-readable CLI output as a presentation layer.

## Scheduling / concurrency

Potential candidates:

- native timers,
- `p-queue`,
- `Bottleneck`.

Do not introduce a heavy job scheduler unless the feature set genuinely requires it.

## Persistence

Phase 1:

- SQLite.

Potential libraries:

- better-sqlite3,
- Node SQLite APIs where suitable,
- Drizzle ORM only if its added abstraction is useful.

Do not make a database mandatory for the first execution path if a stateless mode can reasonably exist.

---

# 5. Proposed Repository Structure

```text
domain-drop-buyer/
├─ src/
│  ├─ cli/
│  │  ├─ commands/
│  │  │  ├─ init.ts
│  │  │  ├─ watch.ts
│  │  │  ├─ test.ts
│  │  │  ├─ check.ts
│  │  │  ├─ buy.ts
│  │  │  ├─ providers.ts
│  │  │  └─ status.ts
│  │  └─ cli.ts
│  │
│  ├─ core/
│  │  ├─ watcher/
│  │  │  ├─ WatchEngine.ts
│  │  │  ├─ PollScheduler.ts
│  │  │  ├─ DropWindow.ts
│  │  │  └─ DetectionStrategy.ts
│  │  │
│  │  ├─ availability/
│  │  │  ├─ AvailabilityService.ts
│  │  │  ├─ AvailabilityAggregator.ts
│  │  │  └─ AvailabilityDecision.ts
│  │  │
│  │  ├─ registration/
│  │  │  ├─ RegistrationService.ts
│  │  │  ├─ RegistrationPolicy.ts
│  │  │  └─ RegistrationAttempt.ts
│  │  │
│  │  └─ orchestration/
│  │     └─ DropOrchestrator.ts
│  │
│  ├─ providers/
│  │  ├─ types.ts
│  │  ├─ registry/
│  │  │  ├─ rdap/
│  │  │  └─ ...
│  │  ├─ registrars/
│  │  │  ├─ cloudflare/
│  │  │  ├─ namecheap/
│  │  │  ├─ porkbun/
│  │  │  └─ ...
│  │  └─ ProviderRegistry.ts
│  │
│  ├─ notifications/
│  │  ├─ NotificationProvider.ts
│  │  ├─ discord/
│  │  │  └─ DiscordWebhookProvider.ts
│  │  └─ ...
│  │
│  ├─ transport/
│  │  ├─ HttpTransport.ts
│  │  ├─ ProxyAgentFactory.ts
│  │  └─ RetryPolicy.ts
│  │
│  ├─ config/
│  │  ├─ schema.ts
│  │  ├─ loader.ts
│  │  ├─ env.ts
│  │  └─ secrets.ts
│  │
│  ├─ persistence/
│  │  ├─ database.ts
│  │  ├─ repositories/
│  │  └─ migrations/
│  │
│  ├─ security/
│  │  ├─ credentialStore.ts
│  │  ├─ redaction.ts
│  │  └─ secretValidation.ts
│  │
│  ├─ domain/
│  │  ├─ normalize.ts
│  │  ├─ validation.ts
│  │  └─ punycode.ts
│  │
│  └─ index.ts
│
├─ config/
│  ├─ example.yaml
│  └─ providers.example.yaml
│
├─ data/
│  └─ .gitkeep
│
├─ tests/
│  ├─ unit/
│  ├─ integration/
│  ├─ fixtures/
│  └─ mocks/
│
├─ scripts/
├─ Dockerfile
├─ docker-compose.yml
├─ .env.example
├─ .gitignore
├─ package.json
├─ tsconfig.json
├─ README.md
└─ LICENSE
```

The exact directory structure may be adjusted during implementation, but provider/core separation should remain.

---

# 6. Configuration Design

The application should be configurable without editing source code.

Example:

```yaml
app:
  mode: "watch"
  timezone: "Europe/Warsaw"
  database: "./data/domain-drop.sqlite"
  logLevel: "info"

targets:
  - id: "main-target"
    domain: "example.pl"

    drop:
      expectedAt: "2026-10-01T12:00:00.000Z"
      preWindowSeconds: 600
      postWindowSeconds: 300

    monitoring:
      strategy: "adaptive"
      initialIntervalMs: 5000
      warmupIntervalMs: 1000
      hotIntervalMs: 250
      hotWindowSeconds: 10
      requestTimeoutMs: 2500

    availability:
      providers:
        - "rdap"
        - "porkbun"
        - "namecheap"

      quorum:
        mode: "any-confirmed"
        minimumConfirmations: 1

    registration:
      enabled: true
      mode: "first-success"

      providers:
        - "porkbun"
        - "namecheap"

      maxAttemptsPerProvider: 1
      maxTotalAttempts: 3

      budget:
        maxRegistrationPrice: 100

    notifications:
      discord:
        enabled: true
        webhookEnv: "DISCORD_WEBHOOK_URL"

proxies:
  enabled: false
  strategy: "static"
  pool:
    - "http://user:password@host:port"
    - "socks5://user:password@host:port"
```

---

# 7. Environment Variables

Secrets should preferably be stored in environment variables or an external secret store.

Example:

```env
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
CLOUDFLARE_API_TOKEN=...
CLOUDFLARE_ACCOUNT_ID=...
NAMECHEAP_API_USER=...
NAMECHEAP_API_KEY=...
NAMECHEAP_USERNAME=...
PORKBUN_API_KEY=...
PORKBUN_SECRET_API_KEY=...
```

Potential future variables:

```env
DATABASE_URL=
PROXY_USERNAME=
PROXY_PASSWORD=
LOG_LEVEL=
NODE_ENV=
```

Never commit production credentials.

The configuration validator should explicitly reject suspicious configurations such as a webhook/token accidentally embedded in source-controlled example configuration.

---

# 8. Target Domain Model

Each target should be independently configurable.

Example internal representation:

```ts
interface DomainTarget {
  id: string;
  domain: string;

  drop?: {
    expectedAt?: string;
    timezone?: string;
    preWindowMs?: number;
    postWindowMs?: number;
  };

  monitoring: MonitoringConfig;
  availability: AvailabilityConfig;
  registration?: RegistrationConfig;
  notifications?: NotificationConfig;
}
```

A domain should be normalized before processing:

```text
Input:
EXAMPLE.PL
https://example.pl/
example.pl.

Normalized:
example.pl
```

Support IDNs correctly by normalizing to ASCII/punycode for provider requests where required.

---

# 9. Monitoring Engine

The monitoring engine is the heart of the project.

It should not simply use:

```ts
setInterval(check, 1000);
```

Instead, implement an adaptive schedule.

Example:

```text
> 30 minutes before drop
    every 30–60 seconds

10–30 minutes before
    every 5 seconds

1–10 minutes before
    every 1 second

last 10 seconds
    high-frequency mode according to provider limits

after detection
    stop availability polling immediately
    start registration workflow

after successful registration
    stop target

after failed registration
    execute configured fallback policy
```

Exact intervals must remain configurable and provider-aware.

---

# 10. Time Synchronization

Accurate timing matters.

The application should record:

- local system time,
- UTC time,
- configured expected drop time,
- provider response timestamp when available,
- request start time,
- request completion time,
- measured latency.

Consider adding an optional lightweight clock-offset check against trusted time sources.

However, do not over-engineer time synchronization in the initial release.

The application should use UTC internally.

Convert to a user's configured timezone only for:

- CLI display,
- logs,
- configuration helpers,
- Discord messages.

---

# 11. Availability Provider Interface

Define a generic interface such as:

```ts
interface AvailabilityProvider {
  id: string;

  supports(domain: string): Promise<boolean>;

  check(
    request: AvailabilityRequest
  ): Promise<AvailabilityResult>;
}
```

Example result:

```ts
interface AvailabilityResult {
  provider: string;
  domain: string;

  status:
    | "available"
    | "unavailable"
    | "unknown"
    | "unsupported"
    | "rate_limited"
    | "error";

  registrable?: boolean;

  price?: {
    amount: number;
    currency: string;
  };

  reason?: string;

  checkedAt: string;

  latencyMs: number;

  raw?: unknown;
}
```

The core must never depend on provider-specific response formats.

---

# 12. Registry-Level RDAP Provider

Implement generic RDAP support.

For `.pl`, NASK provides an RDAP REST endpoint:

```text
https://rdap.dns.pl/domain/{domain}
```

NASK documents:

- `200` for an existing registry object,
- `404` for a valid query for a non-existent object,
- JSON responses,
- a REST API model.

Important:

**RDAP should not automatically be treated as proof that a domain can immediately be registered.**

A missing RDAP object can indicate that the domain is not currently present in the registry, but the final registration attempt still needs to be made through a registrar/registration channel.

The agent should investigate TLD-specific semantics before using "RDAP 404" as an auto-buy trigger.

For maximum portability, implement:

```text
RdapResolverRegistry
    .register("pl", NaskRdapProvider)
    .register("com", GenericRdapProvider)
    ...
```

Do not assume that every TLD behaves identically.

---

# 13. Registrar Adapters

Implement registrar support through adapters.

## Candidate provider: Cloudflare Registrar

Cloudflare currently documents a Registrar API capable of:

- domain search,
- real-time availability checks,
- registration of supported extensions.

The documented availability check queries registry state and is intended to be performed immediately before registration.

The API currently has extension limitations and should therefore be treated as one provider among several rather than the universal backend.

The implementation should support:

```text
CloudflareAvailabilityProvider
CloudflareRegistrationProvider
```

Credentials:

```text
Account ID
API Token
```

Use least-privileged API tokens.

Source:
https://developers.cloudflare.com/registrar/registrar-api/

## Candidate provider: Namecheap

Namecheap currently exposes API methods including:

```text
namecheap.domains.check
namecheap.domains.create
```

The API is XML-based.

The `domains.check` endpoint returns availability and premium-domain information.

The `domains.create` endpoint registers a domain and returns registration/order/transaction information.

Namecheap API requests use a required client IP parameter and the API documentation describes IP whitelisting.

Adapter should therefore model:

```text
NamecheapAvailabilityProvider
NamecheapRegistrationProvider
```

Source:
https://www.namecheap.com/support/api/methods/domains/check/

Source:
https://www.namecheap.com/support/api/methods/domains/create/

## Candidate provider: Porkbun

Porkbun currently documents a REST/JSON API that supports:

- domain availability checks,
- pricing,
- registration,
- domain management,
- DNS,
- additional APIs.

The API documentation currently advertises support for up to 25 domains per availability call.

Porkbun should be implemented as another provider adapter rather than hard-coded into the engine.

Source:
https://porkbun.com/api/json/v3/documentation

---

# 14. Provider Capability Matrix

The final project should expose provider capabilities dynamically.

Example:

| Capability | Cloudflare | Namecheap | Porkbun | RDAP |
|---|---:|---:|---:|---:|
| Availability check | Yes | Yes | Yes | Yes* |
| Pricing | Yes | Yes | Yes | Usually no |
| Registration | Yes** | Yes | Yes | No |
| Registration confirmation | Yes | Yes | Yes | No |
| Proxy support | Transport dependent | Transport/API dependent | Transport dependent | Yes |
| TLD coverage | Provider-specific | Provider-specific | Provider-specific | Registry-specific |

`*` RDAP is registry data access, not a registrar purchase API.

`**` Cloudflare programmatic registration is subject to current API/TLD limitations.

The table should be generated or documented from the provider adapters rather than becoming an undocumented assumption.

---

# 15. Multi-Provider Availability Strategy

This is a core feature.

Possible modes:

### `first-positive`

Stop when the first trusted provider reports availability.

Advantages:

- lowest latency,
- fewest API requests.

Risk:

- provider false positives or stale/non-authoritative data.

### `majority`

Require multiple providers to agree.

Advantages:

- stronger confirmation.

Risk:

- slower,
- some providers may update at different times.

### `registry-confirmed`

Prefer a registry-aware signal and then immediately verify using a registrar.

### `race`

Run multiple availability checks concurrently and use the fastest usable signal.

The agent should choose the initial default based on measured reliability and provider semantics.

---

# 16. Registration Strategy

Once availability is detected:

```text
DETECTED
   |
   v
Final availability check
   |
   v
Validate price / budget
   |
   v
Registration attempt
   |
   +---- success ----> SUCCESS
   |
   +---- failure ----> fallback
```

Never blindly call multiple registration APIs after one provider succeeds.

The registration state machine must prevent accidental duplicate purchases.

Example states:

```text
IDLE
ARMED
CHECKING
AVAILABLE
VERIFYING
REGISTERING
REGISTRATION_PENDING
SUCCEEDED
FAILED
ABORTED
```

Persist the state.

---

# 17. Idempotency and Duplicate Purchase Protection

This is mandatory.

Potential protections:

- per-target distributed/local lock,
- registration attempt UUID,
- persistent target state,
- provider-specific idempotency mechanisms when offered,
- "already owned" pre-check,
- max-attempt counter,
- global budget limit.

For example:

```text
Target: example.com

attempt 1 -> provider A -> timeout
attempt 2 -> provider A -> ambiguous response

DO NOT immediately call provider B unless the system can determine
whether provider A may have actually completed the purchase.
```

An ambiguous registration response must be treated as a special state.

This is one of the most important safety mechanisms in the entire application because a successful domain registration may create a real charge.

---

# 18. Price Protection

Auto-buy should never blindly buy any returned price.

Configuration:

```yaml
budget:
  maxRegistrationPrice: 50
  currency: "USD"
  allowPremium: false
```

Before registration:

```text
returned price
     |
     +-- <= configured limit --> continue
     |
     +-- > configured limit ---> abort + notify
```

Also support:

```yaml
allowPremium: false
```

and optionally:

```yaml
requireExactPrice: true
expectedPrice: 10.99
```

For future multi-currency support, use a reliable conversion service only when the user explicitly enables it.

---

# 19. Auto-Buy Modes

Implement three modes.

## Notify Only

```text
availability detected
       |
       v
Discord notification
       |
       v
stop
```

## Confirmed Buy

```text
availability detected
       |
       v
notification
       |
       v
explicit local confirmation
       |
       v
register
```

## Full Auto-Buy

```text
availability detected
       |
       v
budget check
       |
       v
automatic registration
       |
       v
Discord success/failure
```

Default should be **Notify Only**.

Full Auto-Buy must require an explicit configuration switch.

---

# 20. Discord Notifications

Discord webhook support should be a first-class notification provider.

Useful event types:

```text
watch_started
drop_window_entered
availability_detected
registration_started
registration_succeeded
registration_failed
budget_exceeded
provider_error
rate_limited
watch_finished
```

Example success notification:

```text
🚨 DOMAIN REGISTERED

Domain: example.pl
Provider: Porkbun
Registration: SUCCESS
Price: 12.00 USD
Detected at: 12:00:01.231 UTC
Request latency: 182 ms
```

For failures:

```text
⚠️ DOMAIN REGISTRATION FAILED

Domain: example.pl
Provider: Porkbun
Reason: DOMAIN_UNAVAILABLE
Attempts: 2
```

Do not put secrets into the webhook payload.

---

# 21. Discord Notification Reliability

Notifications should not block registration.

Bad:

```text
register()
await discord()
return
```

Prefer:

```text
registration result
       |
       +--> persist immediately
       |
       +--> notification queue
```

If Discord is down, the registration workflow must continue.

---

# 22. Proxy Architecture

Proxy support should exist, but should not be the default.

Support:

```text
HTTP
HTTPS
SOCKS5
```

Prefer a per-provider/per-request transport abstraction.

Example:

```yaml
proxies:
  enabled: true

  pools:
    default:
      strategy: "round-robin"
      proxies:
        - "http://proxy1:8080"
        - "http://proxy2:8080"

    namecheap:
      strategy: "static"
      proxies:
        - "http://proxy3:8080"
```

Potential strategies:

- direct,
- static,
- round-robin,
- random,
- failover.

Important:

**Do not implement proxy rotation as a mechanism to evade provider rate limits, account restrictions, CAPTCHAs, anti-abuse systems, or contractual controls.**

The application should respect provider policies, documented rate limits, and terms.

Proxy support is primarily useful for:

- controlled deployments,
- network isolation,
- corporate/VPS routing,
- privacy,
- avoiding accidental dependence on one egress path,
- provider environments that legitimately require a known source IP.

---

# 23. Transport Layer

The core should use a shared transport abstraction:

```ts
interface HttpTransport {
  request<T>(request: HttpRequest): Promise<HttpResponse<T>>;
}
```

The transport layer should handle:

- timeout,
- AbortController,
- DNS/network errors,
- connection failures,
- retry policy,
- backoff,
- proxy,
- headers,
- telemetry,
- request IDs.

Provider adapters should not each implement their own retry logic.

---

# 24. Retry Policy

Not every error is retryable.

Retry:

```text
ECONNRESET
ETIMEDOUT
temporary 5xx
transient DNS errors
```

Potentially retry with caution:

```text
429
```

Never blindly retry:

```text
4xx authentication failure
invalid domain
registration denied
budget exceeded
provider says already registered
```

For registration operations, retries need stricter rules than availability checks.

---

# 25. Rate Limit Awareness

Each provider adapter should expose:

```ts
interface ProviderLimits {
  minIntervalMs?: number;
  maxConcurrentRequests?: number;
  requestsPerMinute?: number;
}
```

The scheduler should enforce these limits.

Provider-specific limits should be configurable because they may change.

Do not assume that a provider allows arbitrary requests simply because HTTP requests technically work.

---

# 26. Hot-Window Strategy

The engine should have a special high-priority phase.

Example:

```text
DROP TIME = 12:00:00.000 UTC

11:30:00
  slow polling

11:50:00
  warm polling

11:59:00
  hot polling

11:59:55
  ultra-hot window

12:00:00
  availability + registration strategy

12:00:30
  fallback / completion
```

All values must be configurable.

The exact polling frequency should be constrained by provider rules.

---

# 27. Latency Measurement

Record:

```text
scheduledAt
requestStartedAt
requestFinishedAt
responseReceivedAt
latencyMs
```

This allows later analysis such as:

```text
Provider A: 132 ms average
Provider B: 284 ms average
Provider C: 91 ms average
```

The project should not assume the fastest provider is always the best provider; reliability and registration capabilities matter too.

---

# 28. Event Timeline

Each target should generate an event timeline.

Example:

```text
2026-10-01T11:59:50.000Z WATCH_CHECK
2026-10-01T11:59:51.102Z RDAP_UNAVAILABLE
2026-10-01T11:59:51.240Z PORKBUN_UNAVAILABLE
2026-10-01T12:00:00.281Z RDAP_NOT_FOUND
2026-10-01T12:00:00.402Z PORKBUN_AVAILABLE
2026-10-01T12:00:00.407Z REGISTRATION_STARTED
2026-10-01T12:00:01.291Z REGISTRATION_SUCCEEDED
```

This makes debugging dramatically easier.

---

# 29. SQLite Schema

Suggested tables:

## `targets`

```text
id
domain
enabled
expected_drop_at
created_at
updated_at
```

## `watch_runs`

```text
id
target_id
started_at
ended_at
status
```

## `availability_checks`

```text
id
watch_run_id
provider
domain
status
registrable
price_amount
price_currency
latency_ms
checked_at
error_code
```

## `registration_attempts`

```text
id
watch_run_id
provider
domain
status
price_amount
price_currency
started_at
finished_at
provider_reference
error_code
```

## `events`

```text
id
target_id
type
timestamp
payload_json
```

Do not store secrets in the database.

---

# 30. CLI

Suggested commands:

```bash
domain-drop init
domain-drop providers
domain-drop check example.com
domain-drop watch
domain-drop watch --target main-target
domain-drop buy example.com --dry-run
domain-drop test discord
domain-drop status
```

Useful options:

```bash
--config ./config.yaml
--log-level debug
--json
--dry-run
--provider porkbun
--target main-target
```

---

# 31. Interactive Setup

Provide:

```bash
domain-drop init
```

It should guide a new user through:

1. configuration file location,
2. timezone,
3. target domain,
4. expected drop date/time,
5. monitoring strategy,
6. registrar selection,
7. credentials,
8. Discord webhook,
9. notification-only vs auto-buy,
10. budget.

Never print secrets back to the screen unnecessarily.

---

# 32. `check` Command

A manual test command should exist.

Example:

```bash
domain-drop check example.pl
```

Output:

```text
Domain: example.pl

RDAP:
  status: not found
  latency: 94ms

Porkbun:
  available: true
  price: 10.37 USD
  latency: 211ms

Namecheap:
  available: true
  premium: false
  latency: 286ms

Decision:
  registrable signal: POSITIVE
```

This is valuable for debugging the configuration before the actual drop.

---

# 33. Dry Run Mode

Dry-run is mandatory before enabling automatic registration.

Example:

```bash
domain-drop buy example.com --dry-run
```

The program should execute:

- validation,
- availability checks,
- pricing checks,
- notification,
- registration decision,

but should never send a real registration request.

Provider adapters should support a `dryRun` flag or the orchestration layer should guarantee that registration methods cannot be reached.

---

# 34. Provider Health

At startup:

```bash
domain-drop providers
```

Show:

```text
Cloudflare
  credentials: OK
  API connectivity: OK
  registration: supported
  availability: supported

Porkbun
  credentials: OK
  API connectivity: OK
  registration: supported

Namecheap
  credentials: OK
  API connectivity: OK
```

This should also be available in a machine-readable JSON format.

---

# 35. Security

Treat this tool as a system that can trigger real financial transactions.

Requirements:

- credentials from environment/secrets,
- never log API tokens,
- never log passwords,
- redact Authorization headers,
- redact proxy credentials,
- redact Discord webhook URLs,
- file permissions for local configuration,
- database should not contain secrets,
- validate configuration before watch start,
- require explicit auto-buy enablement,
- enforce purchase budget,
- protect against duplicate registration,
- protect against configuration mistakes,
- optional confirmation test before arming,
- support credential rotation.

---

# 36. Auto-Buy Safety Guard

Implement a final purchase gate.

Concept:

```ts
interface PurchaseGateInput {
  domain: string;
  provider: string;
  availability: AvailabilityResult;
  price?: Money;
  expectedDomain: string;
  maxPrice?: Money;
}

interface PurchaseGateResult {
  allowed: boolean;
  reasons: string[];
}
```

Possible rejection reasons:

```text
DOMAIN_MISMATCH
PRICE_TOO_HIGH
PREMIUM_DOMAIN
PROVIDER_UNSUPPORTED
DUPLICATE_ATTEMPT
TARGET_DISABLED
CREDENTIALS_INVALID
OUTSIDE_DROP_WINDOW
```

Only proceed when the gate returns `allowed: true`.

---

# 37. Multi-Registrar Race Strategy

A future advanced mode may allow:

```text
Provider A
Provider B
Provider C

       ↓
availability detected
       ↓
registration candidates
       ↓
attempt according to configured strategy
```

However, this must be designed very carefully.

A failed HTTP response does not necessarily mean that registration failed.

An ambiguous timeout may mean that the registrar accepted the purchase while the client never received the response.

Therefore:

```text
UNKNOWN registration result
```

must be treated differently from:

```text
CONFIRMED FAILURE
```

The system should optionally query the account/domain state before trying another registrar.

The agent should evaluate whether multi-registrar "race" mode is actually beneficial for each target/TLD instead of implementing it blindly.

---

# 38. After-Drop Recheck

If the expected release timestamp passes but no availability is detected:

```text
12:00:00
12:00:01
12:00:02
...
```

Continue for a configurable grace period.

Some registries may not expose state transitions exactly at the expected timestamp.

The tool should display:

```text
Expected drop:
12:00:00 UTC

Actual first positive detection:
12:00:03.271 UTC
```

---

# 39. Network Failure Handling

Example:

```text
Provider A -> timeout
Provider B -> available
Provider C -> 429
```

The engine should not classify the whole target as unavailable.

Instead:

```text
Provider A: UNKNOWN
Provider B: AVAILABLE
Provider C: RATE_LIMITED

Aggregate:
POSITIVE
```

This distinction is critical.

---

# 40. Observability

Support:

```text
human CLI logs
JSON logs
SQLite event history
Discord alerts
```

Optional future integrations:

- Prometheus metrics,
- OpenTelemetry,
- Grafana,
- Sentry.

Metrics worth exposing:

```text
availability_checks_total
availability_success_total
availability_errors_total
registration_attempts_total
registration_success_total
registration_failures_total
provider_latency_ms
provider_rate_limits_total
notifications_sent_total
```

---

# 41. Testing Strategy

## Unit tests

Test:

- domain normalization,
- IDN conversion,
- configuration validation,
- drop-window calculations,
- adaptive scheduler,
- provider result normalization,
- availability aggregation,
- purchase gate,
- retry policy,
- duplicate prevention.

## Provider contract tests

Every provider adapter should satisfy the same contract tests.

Example:

```text
check() returns normalized AvailabilityResult
register() returns normalized RegistrationResult
errors map to stable internal codes
```

## Integration tests

Use:

- mocked HTTP server,
- provider sandbox where available,
- test Discord webhook endpoint,
- temporary SQLite database.

Do not use production registration APIs in automated CI.

---

# 42. Provider Sandbox Support

Where a provider offers a sandbox/test environment, the project should support it.

For example, Cloudflare documents a Registrar Sandbox suitable for programmatic testing.

The provider interface should make environment selection explicit:

```yaml
environment: "sandbox"
```

or:

```text
production
sandbox
```

Never infer this from the target domain.

---

# 43. Configuration Profiles

Support profiles:

```text
development
testing
production
```

Example:

```yaml
profile: production
```

Development:

```text
dryRun = true
mockProviders = true
```

Testing:

```text
sandbox providers
short windows
```

Production:

```text
real credentials
real registration
```

---

# 44. Docker

Provide a small production image.

Example:

```dockerfile
FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

RUN npm run build

CMD ["node", "dist/index.js", "watch"]
```

Do not bake secrets into the image.

Mount:

```text
/data
```

for SQLite persistence.

---

# 45. VPS Deployment

Recommended deployment:

```text
Ubuntu/Debian VPS
      |
      +-- Node.js app
      +-- SQLite
      +-- systemd
      +-- optional Docker
```

For a single user, SQLite + systemd is enough.

For multi-user SaaS functionality in the future, migrate persistence to PostgreSQL.

---

# 46. Systemd

Provide an optional unit:

```ini
[Unit]
Description=Domain Drop Watcher
After=network-online.target

[Service]
WorkingDirectory=/opt/domain-drop-buyer
ExecStart=/usr/bin/node /opt/domain-drop-buyer/dist/index.js watch
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
```

Use an environment file with restricted permissions.

---

# 47. README Requirements

The README should explain:

1. what the tool does,
2. supported providers,
3. installation,
4. configuration,
5. obtaining provider credentials,
6. Discord setup,
7. dry-run usage,
8. watch usage,
9. auto-buy setup,
10. provider limitations,
11. rate limits,
12. proxy configuration,
13. security,
14. troubleshooting,
15. adding a provider.

Include realistic examples.

---

# 48. Provider Plugin Model

Future providers should require minimal work.

Ideally:

```ts
export default {
  id: "example-registrar",

  capabilities: {
    availability: true,
    registration: true,
    pricing: true,
  },

  create(config) {
    return {
      check,
      register,
    };
  },
};
```

Registration should happen through dependency injection.

Avoid requiring a developer to modify the core orchestration code every time a provider is added.

---

# 49. Generic API Provider

Consider a configurable generic provider for simple APIs.

Example:

```yaml
providers:
  custom-api:
    type: generic-http
    availability:
      method: POST
      url: "https://provider.example/api/check"
    registration:
      method: POST
      url: "https://provider.example/api/register"
```

However, do not implement a dangerously flexible arbitrary-code configuration system.

The generic provider should support a strict schema with safe templating.

---

# 50. Rate-Limit and Compliance Layer

All providers should pass through a common policy engine.

Concept:

```text
Provider
  ↓
Capability check
  ↓
Rate-limit policy
  ↓
Retry policy
  ↓
Transport
  ↓
HTTP request
```

Configuration should support:

```yaml
policy:
  respectProviderLimits: true
  maxConcurrentRequests: 4
  allowRetries: true
```

Default to conservative behavior.

---

# 51. Domain-Specific Strategy

Different TLDs may need different logic.

Therefore:

```ts
interface TldStrategy {
  id: string;

  normalize(domain: string): string;

  getDropSemantics(domain: string): DropSemantics;

  createAvailabilityPlan(domain: string): AvailabilityPlan;
}
```

The initial version can include:

```text
generic
pl
```

Do not assume `.com`, `.pl`, `.eu`, `.net`, etc. all have identical drop behavior.

---

# 52. `.pl` Strategy

For `.pl`, investigate NASK-specific lifecycle and release behavior before implementing an exact "drop at X milliseconds" assumption.

Use NASK's official registry/RDAP information as a registry-level signal.

Suggested architecture:

```text
PlTldStrategy
   |
   +-- NaskRdapProvider
   |
   +-- configured registrar availability
   |
   +-- registration provider
```

The target's configured `expectedAt` is a scheduling hint, not a guarantee that the domain will become immediately purchasable at that exact timestamp.

---

# 53. Error Taxonomy

Normalize provider failures.

Example internal codes:

```text
NETWORK_TIMEOUT
NETWORK_ERROR
DNS_ERROR
HTTP_400
HTTP_401
HTTP_403
HTTP_404
HTTP_409
HTTP_429
HTTP_500
PROVIDER_UNAVAILABLE
DOMAIN_UNAVAILABLE
DOMAIN_RESERVED
DOMAIN_PREMIUM
DOMAIN_UNSUPPORTED
REGISTRATION_REJECTED
REGISTRATION_PENDING
REGISTRATION_UNKNOWN
AUTHENTICATION_FAILED
BUDGET_EXCEEDED
CONFIGURATION_ERROR
```

This makes notifications and automation predictable.

---

# 54. Registration Result Model

```ts
interface RegistrationResult {
  provider: string;
  domain: string;

  status:
    | "success"
    | "pending"
    | "failed"
    | "unknown";

  price?: Money;

  providerReference?: string;

  errorCode?: string;

  startedAt: string;
  finishedAt: string;

  raw?: unknown;
}
```

---

# 55. Auditability

Every automatic purchase must be reconstructable after the fact.

Store:

```text
which target
which provider
which availability result
which price
which policy decision
which registration attempt
which result
when
```

Do not store secrets.

---

# 56. User Experience

The CLI should feel like a professional utility rather than a debug script.

Example startup:

```text
Domain Drop Buyer v0.1.0

Target:
  example.pl

Expected drop:
  2026-10-01 12:00:00 UTC

Mode:
  AUTO-BUY

Registrar:
  Porkbun

Budget:
  50.00 USD

Discord:
  ENABLED

Safety:
  DRY RUN = OFF
  PREMIUM = BLOCKED

Status:
  ARMED
```

Then:

```text
[11:59:00.000] Entering hot window
[11:59:55.102] Checking availability
[12:00:00.481] Availability signal detected
[12:00:00.492] Final availability confirmation
[12:00:00.618] Registration request submitted
[12:00:01.293] Registration SUCCESS
[12:00:01.301] Discord notification sent
```

---

# 57. Notifications Should Include Actionable Data

For every event include:

```text
domain
provider
status
price
timestamp
latency
error
attempt number
```

Do not expose:

```text
API keys
account IDs unless intentionally configured
proxy credentials
private contact details
```

---

# 58. Future Web Dashboard

Do not build the dashboard in phase 1 unless useful.

The architecture should make a future API possible:

```text
Node.js core
     |
REST API
     |
Web dashboard
```

Possible dashboard features:

- targets,
- provider health,
- current status,
- event timeline,
- logs,
- run history,
- configuration,
- test notifications.

The CLI should remain fully functional without a dashboard.

---

# 59. Optional REST API

Future:

```text
GET    /api/targets
POST   /api/targets
PATCH  /api/targets/:id
DELETE /api/targets/:id

POST   /api/targets/:id/check
POST   /api/targets/:id/arm
POST   /api/targets/:id/stop

GET    /api/providers
GET    /api/events
```

Authentication would be mandatory if exposed outside localhost/VPN.

---

# 60. Multi-User Support

The main architecture should not assume a single user's credentials forever.

Even if phase 1 is local-only, keep configuration scoped:

```text
User/Profile
    ↓
Targets
    ↓
Provider Accounts
```

A future SaaS mode can map:

```text
user -> provider account -> targets -> watch runs
```

without rewriting the domain/watch logic.

---

# 61. Credential Profiles

Allow multiple accounts for the same registrar.

Example:

```yaml
accounts:
  porkbun-main:
    provider: porkbun
    apiKeyEnv: PORKBUN_MAIN_API_KEY
    secretEnv: PORKBUN_MAIN_SECRET

  porkbun-backup:
    provider: porkbun
    apiKeyEnv: PORKBUN_BACKUP_API_KEY
    secretEnv: PORKBUN_BACKUP_SECRET
```

Target:

```yaml
registration:
  providers:
    - account: porkbun-main
    - account: porkbun-backup
```

The final strategy needs to consider duplicate registration risk before attempting cross-account registration.

---

# 62. Credentials Validation

At startup, validate only what is needed.

Example:

```text
Porkbun:
  API key present: YES
  Secret present: YES
  connectivity: PASS

Discord:
  webhook configured: YES
  test: PASS
```

Do not start auto-buy mode if critical credentials are invalid.

---

# 63. Test Notification

Command:

```bash
domain-drop test discord
```

Expected output:

```text
Discord test message delivered successfully.
```

This should be usable before the user arms the watcher.

---

# 64. Test Provider

Command:

```bash
domain-drop test provider porkbun
```

It should validate credentials and basic API connectivity without buying anything.

---

# 65. Operational Modes

Support:

```text
watch
check
notify
auto-buy
dry-run
sandbox
test
```

The internal engine should use explicit mode values instead of scattered booleans where possible.

---

# 66. Graceful Shutdown

On:

```text
SIGINT
SIGTERM
```

the application should:

1. stop scheduling new requests,
2. cancel polling,
3. finish or safely cancel non-critical notification tasks,
4. persist final run state,
5. close SQLite,
6. exit cleanly.

Never leave the application in an internally inconsistent registration state.

---

# 67. Clock / Scheduling Edge Cases

Test:

- leap seconds are not expected to be represented directly,
- daylight-saving changes,
- timezone changes,
- invalid timezones,
- past drop timestamps,
- milliseconds,
- system clock jumps,
- VPS clock synchronization failures.

Store UTC timestamps.

---

# 68. Configuration Validation Examples

Reject:

```yaml
domain: ""
```

Reject:

```yaml
registration:
  enabled: true
  maxRegistrationPrice: -1
```

Reject:

```yaml
drop:
  expectedAt: "not-a-date"
```

Warn:

```text
AUTO-BUY enabled
Discord disabled
```

Warn:

```text
AUTO-BUY enabled
No explicit maximum price configured
```

Potentially block production auto-buy without a maximum budget.

---

# 69. Security-Oriented Defaults

Default:

```text
auto-buy = false
premium = false
proxy rotation = disabled
retries = conservative
logging = redacted
database secrets = forbidden
dry-run = true for new configs
```

The first production activation should require an explicit command or configuration change.

---

# 70. Suggested Development Phases

## Phase 1 — Core Domain Model

Implement:

- TypeScript project,
- domain normalization,
- config loading,
- schema validation,
- logging,
- basic CLI,
- target model.

No real registration yet.

## Phase 2 — Watch Engine

Implement:

- scheduling,
- adaptive polling,
- drop windows,
- UTC timing,
- event model,
- SQLite history.

## Phase 3 — RDAP

Implement:

- generic RDAP interface,
- NASK `.pl` provider,
- normalized results,
- tests.

## Phase 4 — Registrar Availability

Implement initial adapters:

1. Porkbun
2. Namecheap
3. Cloudflare

Order is provisional; the coding agent should reassess based on current API quality, TLD coverage, and sandbox availability.

## Phase 5 — Discord

Implement:

- webhook provider,
- event formatting,
- retries,
- non-blocking notification handling.

## Phase 6 — Dry-Run Registration

Implement registration interfaces but keep actual production registration disabled.

## Phase 7 — Real Registration

Implement:

- purchase gate,
- price protection,
- registration state machine,
- ambiguity handling,
- persistence.

## Phase 8 — Proxy / Transport

Implement:

- transport abstraction,
- proxy support,
- per-provider transport configuration,
- conservative limits.

## Phase 9 — Production Hardening

Implement:

- Docker,
- systemd,
- health checks,
- metrics,
- robust shutdown,
- integration tests.

## Phase 10 — Extensibility

Implement:

- provider plugin structure,
- capability discovery,
- provider documentation,
- generic provider experiments,
- future REST API hooks.

---

# 71. Agentic Workflow

The coding agent should **not blindly implement every suggestion in this document**.

Use the following workflow.

## Step A — Repository Discovery

Inspect:

- current repository,
- package manager,
- Node version,
- TypeScript config,
- existing scripts,
- linting,
- testing,
- project conventions.

Do not overwrite an existing project architecture without examining it first.

## Step B — Requirements Extraction

Convert this plan into:

```text
MUST HAVE
SHOULD HAVE
COULD HAVE
RESEARCH
DEFERRED
```

## Step C — Provider Research

For each proposed provider verify current official documentation.

Check:

- API availability,
- real-time check behavior,
- registration API,
- supported TLDs,
- premium-domain support,
- authentication,
- rate limits,
- sandbox,
- source-IP restrictions,
- current API version,
- current terms.

Prefer official documentation over third-party tutorials.

## Step D — Architecture Proposal

Before coding, produce a concise architecture decision record containing:

- chosen HTTP stack,
- chosen CLI,
- chosen validation library,
- chosen SQLite library,
- provider interfaces,
- transport design,
- scheduler design.

The agent may replace suggested dependencies when there is a demonstrable reason.

## Step E — Implement Core First

Implement and test:

```text
config
domain model
scheduler
event model
provider interfaces
```

before connecting real registrars.

## Step F — Implement Mock Providers

Create deterministic fake providers:

```text
always-unavailable
available-after-N-checks
timeout
429
5xx
registration-success
registration-failure
registration-unknown
```

Use these to test orchestration.

## Step G — Add Real Providers

Implement provider adapters one by one.

After each:

```text
compile
lint
unit tests
contract tests
mock integration
```

## Step H — Add Dry-Run

The full workflow must be usable without spending money.

## Step I — Add Production Registration

Only after:

- duplicate-purchase protection,
- budget gate,
- ambiguous-response handling,
- persistence,
- provider error handling

are implemented and tested.

## Step J — Run Realistic Simulations

Simulate:

```text
domain remains unavailable
domain becomes available
provider A fails
provider B succeeds
provider returns 429
registration times out
registration actually succeeds but response is lost
Discord fails
process restarts during registration
```

## Step K — Final Review

Review the entire implementation for:

- financial side effects,
- race conditions,
- credential leakage,
- infinite retries,
- excessive polling,
- TLD assumptions,
- provider API changes,
- duplicate purchase risks.

Only then mark the project production-ready.

---

# 72. Decision Backlog for the Coding Agent

The agent should explicitly investigate these instead of assuming the answer.

### Polling

- What is the lowest useful polling interval per provider?
- Are there published limits?
- Can concurrent checks improve latency without violating provider policy?
- Should the hot window use 250 ms, 500 ms, 1 s, or another value?

### Registrar selection

- Which providers currently support the user's desired TLD?
- Which ones perform real-time registry checks?
- Which ones expose real registration APIs?
- Which ones expose sandboxes?
- Which ones have predictable registration latency?

### Proxy

- Is a proxy actually necessary?
- Which provider APIs restrict source IP?
- Is static proxy routing safer than rotation?
- Can proxy use increase latency enough to harm the use case?

### Availability aggregation

- Should the default be `first-positive`, `registry-confirmed`, or another strategy?
- Which providers should be trusted as confirmation sources?
- How should conflicting responses be handled?

### Auto-buy race

- Is cross-registrar race actually beneficial?
- How should ambiguous registration results be resolved?
- Can account status be queried after a timeout before another registration is attempted?

### Persistence

- Is SQLite sufficient for the intended deployment?
- Should a stateless mode also exist?

### Deployment

- Docker vs systemd?
- Single VPS vs local machine?
- Should the application support both?

---

# 73. What NOT to Build

Do not initially build:

- a full web dashboard,
- automatic account creation,
- CAPTCHA bypass,
- registrar anti-bot bypass,
- undocumented private endpoints,
- browser automation where an official API exists,
- massive proxy rotation,
- unlimited polling,
- automatic payment-method manipulation,
- credential scraping,
- stealth mechanisms intended to evade provider controls.

Official APIs should be preferred.

---

# 74. Success Criteria

The MVP is successful when a user can:

```bash
npm install
npm run build
domain-drop init
domain-drop check example.pl
domain-drop test discord
domain-drop watch
```

and receive a Discord notification when the configured target appears available.

The production milestone is reached when:

```text
known drop time
        ↓
adaptive watcher
        ↓
multiple availability sources
        ↓
final confirmation
        ↓
budget gate
        ↓
safe automatic registration
        ↓
persistent audit event
        ↓
Discord success notification
```

works reliably in a controlled test environment.

---

# 75. Recommended Initial Defaults

Use conservative defaults:

```yaml
monitoring:
  strategy: adaptive
  requestTimeoutMs: 2500

registration:
  enabled: false
  mode: notify-only
  maxAttemptsPerProvider: 1
  maxTotalAttempts: 1

budget:
  allowPremium: false

proxies:
  enabled: false

notifications:
  discord:
    enabled: true
```

A user should deliberately enable full auto-buy.

---

# 76. Final Architecture Target

The final system should look like:

```text
                       ┌──────────────────────┐
                       │       CLI            │
                       │ init/check/watch/buy │
                       └──────────┬───────────┘
                                  │
                                  ▼
                       ┌──────────────────────┐
                       │   Config + Policy    │
                       │ validation + safety  │
                       └──────────┬───────────┘
                                  │
                                  ▼
                       ┌──────────────────────┐
                       │   Drop Orchestrator  │
                       └──────────┬───────────┘
                                  │
             ┌────────────────────┼─────────────────────┐
             │                    │                     │
             ▼                    ▼                     ▼
      ┌─────────────┐      ┌──────────────┐     ┌──────────────┐
      │ Watch Engine│      │ Availability │     │ Registration │
      │ scheduler   │      │ Aggregator   │     │ State Machine│
      └──────┬──────┘      └──────┬───────┘     └──────┬───────┘
             │                    │                     │
             │             ┌──────┼──────────┐          │
             │             ▼      ▼          ▼          │
             │           RDAP  Registrar A Registrar B   │
             │                                      │   │
             └──────────────────────────────────────┼───┘
                                                    │
                           ┌────────────────────────┼───────────────┐
                           │                        │               │
                           ▼                        ▼               ▼
                    ┌────────────┐          ┌────────────┐   ┌────────────┐
                    │ Transport  │          │ SQLite     │   │ Discord    │
                    │ HTTP/proxy │          │ Audit log  │   │ Webhook    │
                    └────────────┘          └────────────┘   └────────────┘
```

---

# 77. Key Engineering Rule

The application is fundamentally a **time-sensitive orchestration system**, not merely an availability checker.

Correctness should therefore be prioritized in this order:

```text
1. Do not accidentally buy the wrong domain.
2. Do not accidentally buy twice.
3. Do not exceed configured budget.
4. Do not leak credentials.
5. Respect provider policies/rate limits.
6. Detect availability quickly.
7. Register quickly.
8. Notify reliably.
9. Optimize latency further.
```

This ordering should guide all architectural decisions.

---

# 78. Official Documentation References

The coding agent should verify these sources before implementing the relevant adapters:

### Cloudflare Registrar API

https://developers.cloudflare.com/registrar/registrar-api/

https://developers.cloudflare.com/api/resources/registrar/

### Cloudflare Registration

https://developers.cloudflare.com/api/resources/registrar/subresources/registrations/methods/create/

### Cloudflare Sandbox

https://developers.cloudflare.com/api/resources/registrar_sandbox/

### Namecheap Availability API

https://www.namecheap.com/support/api/methods/domains/check/

### Namecheap Registration API

https://www.namecheap.com/support/api/methods/domains/create/

### Namecheap API Overview

https://www.namecheap.com/support/api/intro/

### Porkbun API

https://porkbun.com/api/json/v3/documentation

### NASK RDAP

https://www.dns.pl/RDAP_w_NASK

### NASK RDAP English Documentation

https://www.dns.pl/en/RDAP_in_NASK

---

# 79. Final Instruction to the Coding Agent

Treat this document as a **high-quality architectural specification and research checklist**, not as an instruction to blindly implement every proposed dependency or provider.

Before writing production code:

1. inspect the repository,
2. verify all provider APIs against current official documentation,
3. identify TLD-specific constraints,
4. identify rate limits and source-IP requirements,
5. compare implementation options,
6. create an architecture decision record,
7. implement the core abstraction layers,
8. build mocks and tests,
9. integrate real providers,
10. perform a security and financial-side-effect review,
11. document the final decisions.

The final implementation should remain modular enough that a future contributor can add another registrar by creating a new adapter without changing the watcher, scheduler, Discord notification system, purchase gate, or database model.

The end product should feel like a reusable open-source **Domain Drop Watcher / Auto-Buyer for Node.js**, not a one-domain automation script.
