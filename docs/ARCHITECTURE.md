# Architecture decision record

Status: accepted for v0.1.0 (2026-09-22). Step D of the plan.

## Guiding order

Every decision below is ranked by the plan's correctness order (section 77):

1. Never buy the wrong domain. 2. Never buy twice. 3. Never exceed the budget. 4. Never leak credentials.
5. Respect provider limits. 6. Detect fast. 7. Register fast. 8. Notify reliably. 9. Optimize latency.

## Stack decisions

| Concern | Choice | Why | Rejected |
|---|---|---|---|
| Runtime | Node.js >= 22.18, ESM | Built-in SQLite, type stripping for tests, `AbortSignal.any` | Bun/Deno (plan asks for Node) |
| Language | TypeScript, `erasableSyntaxOnly` | Sources run directly under Node for tests. `tsc` emits `dist/` for production | ts-node, tsx, bundlers |
| HTTP | `undici` `request()` + `ProxyAgent` / `Socks5ProxyAgent` | Lowest overhead client in Node, keep-alive pooling, per-request dispatcher for proxies, typed errors that tell "connect failed" apart from "sent but no answer" | global `fetch` (no proxy dispatcher without undici anyway), got, axios |
| Validation | Zod 4 | Best TS inference, mature, readable error paths for config messages | Valibot (smaller, but size is irrelevant for a CLI), ArkType |
| CLI | Commander | Zero dependencies, subcommands, typed options | yargs (heavier), oclif (framework) |
| Config | `yaml` | YAML 1.2, JSON is a subset, good errors with line numbers | js-yaml |
| Persistence | `node:sqlite` (`DatabaseSync`) | No native build step (works on alpine and Windows), synchronous writes make write-ahead attempt records trivially durable | better-sqlite3 (native addon), Drizzle (abstraction not needed for 6 tables) |
| Logging | In-house structured logger (~150 lines) | Redaction must wrap every sink anyway. Pretty output for humans, JSON lines for machines, no transitive deps | Pino, Winston |
| Scheduling | Native timers + a small token-bucket limiter | Needs exact alignment to the drop instant, which a job scheduler would not give | p-queue, Bottleneck |
| IDN | `node:url` `domainToASCII` | WHATWG UTS-46 in core | punycode package (deprecated) |
| Tests | `node:test` | No test framework dependency. Runs `.ts` directly | vitest, jest |

Runtime dependencies: `undici`, `zod`, `commander`, `yaml`. Nothing else.

## Module layout

```text
src/
  cli/            commander wiring, commands, runtime assembly, prompts, output
  config/         zod schema, loader (YAML/JSON + env + profiles), secret scanner
  core/
    watcher/      pure schedule math (phases, intervals, drop-aligned grid), WatchLoop
    availability/ aggregator (pure) + service (concurrent checks, limits, early resolve)
    registration/ state machine, purchase gate (pure), registration service
    orchestration DropOrchestrator: one per target, glues everything
  providers/      plugin types, registry, rate limiter, rdap/, porkbun/, namecheap/, cloudflare/, mock/
  tld/            TLD strategies (generic, pl)
  notifications/  queue + Discord webhook
  transport/      undici transport, retry policy, proxy router
  persistence/    SQLite store + migrations
  security/       redaction
  domain/         normalization + IDN
```

The core imports provider **interfaces** only. Adding a registrar means adding a `ProviderPlugin`
(built-in or loaded from `plugins:` in config). The watcher, gate, notifier and schema never change.

## Provider interface

```ts
interface ProviderPlugin {
  id: string;
  displayName: string;
  capabilities: { availability; registration; pricing; preflight; ownershipLookup; registrationStatus; sandbox; premiumRegistration };
  sourceKind: "registry" | "registrar";
  credentials: CredentialField[];      // name + default env var
  defaultLimits: { availability: ProviderLimits; registration: ProviderLimits };
  create(ctx: ProviderContext): ProviderInstance;
}

interface ProviderInstance {
  check?(req): Promise<AvailabilityResult>;
  register?(req): Promise<RegistrationResult>;       // never called in dry-run
  preflight?(req): Promise<RegistrationResult>;      // server-side dry run (Porkbun)
  lookupOwnership?(domain): Promise<"owned" | "not-owned" | "unknown">;
  getRegistrationStatus?(domain, ref): Promise<RegistrationResult>;
  prepare?(domain): Promise<void>;                   // warm caches at arm time
  healthCheck?(): Promise<HealthResult>;
}
```

Adapters get a `ProviderContext` with resolved credentials, validated options and a transport bound to
their proxy route. They never implement retries or rate limiting themselves.

## Availability semantics

- Statuses: `available | unavailable | unknown | unsupported | rate_limited | error`.
  Only `available` and `unavailable` are definitive. Timeouts, 429 and 5xx never make a target "unavailable".
- Aggregation (`availability.quorum.mode`):
  - `any` (aliases `first-positive`, `race`, `any-confirmed`): checks run concurrently. The decision resolves
    **as soon as** `minimumConfirmations` sources say available, without waiting for slow ones. Default.
  - `majority`: waits for all sources, needs a strict majority of definitive answers plus the minimum.
  - `registry-confirmed`: needs a registry-level "not found" **and** a registrar "available".
- RDAP results on TLDs with delayed registry data (`.pl`) are flagged `advisory`.
- A positive aggregate only **starts** the purchase flow. The flow always re-checks at the registrar that
  would perform the registration (final check) and uses that price for the gate.

## Scheduling

Phases from the drop instant `T`: `idle` (before `T - preWindow`), `warm` (up to `T - hotWindow`),
`hot` (`T ± hotWindow`), `post` (until `T + postWindow`), then `expired`. Each phase has an interval.
Ticks sit on a grid anchored at `T`, so one tick lands exactly on the drop instant, and the next tick never
jumps over a phase boundary. Missed slots are skipped, never burst. The phase is recomputed from the wall
clock every tick, so clock jumps self-correct and are logged.

Per-source limiters (`minIntervalMs`, `maxConcurrentRequests`, `requestsPerMinute`) are checked with a
non-blocking `tryAcquire` on each tick. A source that is not allowed yet, or still has a request in flight,
is skipped for that tick instead of queued, because a stale queued check is worthless. A 429 pauses that
source until `Retry-After`.

## Registration safety

Persisted per-target state machine:

```text
IDLE -> ARMED -> CHECKING -> AVAILABLE -> VERIFYING -> REGISTERING -> SUCCEEDED
                                                              |-> REGISTRATION_PENDING
                                                              |-> AMBIGUOUS   (blocks everything)
                                                              |-> FAILED / back to ARMED (confirmed failure)
any pre-purchase state -> ABORTED
```

1. **Arming** refuses to start when the persisted state is `SUCCEEDED`, `REGISTERING`, `REGISTRATION_PENDING`
   or `AMBIGUOUS`. A leftover `REGISTERING` (crash mid-request) is converted to `AMBIGUOUS` first.
2. **Final check** at the registrar, then the **purchase gate** (pure function, every rejection reason listed).
3. **Confirm mode** asks the operator to type the domain name, with a timeout.
4. **Dry run** stops here: it calls `preflight()` when the adapter has one, otherwise simulates. `register()`
   is unreachable, and a second guard inside the registration service throws if it ever is reached.
5. **Compare-and-set** in SQLite moves the state to `REGISTERING`. If another process already did, abort.
6. **Write-ahead**: the attempt row (`in_flight`) is committed before the HTTP request is sent.
7. The request runs with its own timeout and is **not** cancelled by SIGINT. Shutdown waits for it.
8. Outcomes:
   - `success`: `SUCCEEDED`, stop.
   - `pending`: poll status for a bounded time, else `REGISTRATION_PENDING`, stop.
   - `unknown` (timeout after send, 5xx, unparseable body): ownership lookup a few times. If owned, `SUCCEEDED`.
     Otherwise `AMBIGUOUS`, stop, loud notification. **Never** try another registrar.
   - `failed` (the provider explicitly rejected it, or the connection was never established): record it, then
     try the next registrar or resume watching while attempt caps allow.
9. Attempt caps (`maxAttemptsPerProvider`, `maxTotalAttempts`) are counted from SQLite, so they survive restarts.
   `dropcatch resolve <target> --reset` re-arms a target without deleting history.

Transport error classification drives step 8. DNS failure, connection refused or connect timeout means the
request was never sent, so it is a confirmed failure. A reset, header or body timeout, or an abort after
connect means the request may have been processed, so it is `unknown`.

## Mode model

- `registration.enabled: false` (default) or `mode: notify-only`: detect, notify, stop.
- `mode: confirm`: detect, notify, ask on the terminal, register.
- `mode: auto-buy`: requires `registration.enabled: true`, a `budget.maxRegistrationPrice`, a persistent
  database, and passing credential health checks at startup.
- `app.dryRun` defaults to `true`. Going live is an explicit config change. `--dry-run` can force it on but
  nothing on the command line can turn it off.
- `profile: development` forces dry-run. `testing` requires every account to be `sandbox` or `mock`.
  `production` rejects mock accounts.

## Notifications

Events go to SQLite synchronously and to an in-memory queue that a single worker drains to Discord.
The purchase path never awaits Discord. Discord 429 honours `retry_after`, 5xx and network errors back
off and retry three times, and repeated `provider_error` / `rate_limited` events are de-duplicated for
5 minutes per provider and code. On shutdown the queue gets a bounded drain window.

## Security

- Config holds env var **names** (`^[A-Z_][A-Z0-9_]*$`), never values. The loader scans raw config text
  for Discord webhook URLs, Porkbun keys, bearer tokens and credentialed URLs, and refuses to load.
- Every resolved secret is registered with the redactor, which wraps the logger, stored event payloads and
  error messages. Pattern redaction covers webhook URLs, `Authorization`, URL userinfo and key fields.
- Raw provider responses are never persisted. On POSIX, config and `.env` files readable by group or other
  trigger a warning.

## Deferred, with reasons

- Parallel multi-registrar purchase ("race"): a lost response at registrar A cannot be told apart from a
  real purchase in time, so parallel purchase risks a double charge. Sequential fallback after a confirmed
  failure gets most of the benefit.
- Generic HTTP provider: plugins cover the need without a templating language in config.
- Prometheus, OpenTelemetry, REST API, dashboard: the SQLite schema and event model already expose everything
  they would need.
