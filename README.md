# dropcatch

Domain drop watcher and safe auto-buyer for Node.js.

dropcatch watches domains that are about to be released. It polls harder as the expected drop time
approaches, checks several sources at once, and when a name frees up it notifies you on Discord or
registers it through a registrar API. The purchase path has a hard budget gate and duplicate-purchase
protection that survives crashes, and it keeps a full SQLite audit trail.

It ships as a CLI and as an all-in-one web dashboard with first-run setup and password login.
`.pl` and `.com.pl` can be bought automatically through OVHcloud.

```text
known drop time -> adaptive watcher -> multiple sources -> final registrar check -> budget gate
               -> one safe registration -> persisted audit event -> Discord
```

> [!IMPORTANT]
> A successful registration spends real money and is usually non-refundable. dropcatch starts in
> **dry-run** mode and stays there until you change `app.dryRun` yourself.

## Contents

- [Features](#features)
- [Supported providers](#supported-providers)
- [Install](#install)
- [Quick start](#quick-start)
- [Dashboard](#dashboard)
- [Configuration](#configuration)
- [Getting credentials](#getting-credentials)
- [Discord and Telegram](#discord-and-telegram)
- [Dry run, watch and auto-buy](#dry-run-watch-and-auto-buy)
- [How purchases stay safe](#how-purchases-stay-safe)
- [Rate limits and proxies](#rate-limits-and-proxies)
- [Bulk import and calendar](#bulk-import-and-calendar)
- [Clock accuracy and latency](#clock-accuracy-and-latency)
- [Metrics and health](#metrics-and-health)
- [CLI reference](#cli-reference)
- [Deployment](#deployment)
- [Security](#security)
- [Troubleshooting](#troubleshooting)
- [Adding a provider](#adding-a-provider)
- [Development](#development)

## Features

- **Adaptive schedule.** Idle, warm, hot and post phases around the drop time. Ticks are aligned so one
  lands exactly on the drop instant, and they never skip a phase boundary.
- **Multiple sources.** RDAP (IANA bootstrap plus NASK for `.pl`) and registrar real-time checks, run
  concurrently. Quorum modes are `any`, `majority` and `registry-confirmed`. Timeouts and 429s never
  count as "taken".
- **Three modes.** `notify-only` (the default), `confirm` (type the domain to approve) and `auto-buy`.
- **Budget gate.** Checks the domain match, max price, currency, premium names, attempt caps and an
  optional drop window, using the price from a final check at the registrar that will register.
- **Duplicate protection.** A persisted state machine, a compare-and-set lock in SQLite, an attempt
  record written before the request is sent, and an `AMBIGUOUS` state that blocks everything after an
  unclear result.
- **Discord and Telegram.** Non-blocking queue with retries. Never delays a purchase, never includes secrets.
  On Telegram only detections and purchases ring; everything else arrives silently.
- **Clock correction.** Measures the machine against NTP and schedules drops on true time.
- **Monitoring.** Prometheus `/metrics`, `/healthz`, and per-source response-time charts in the dashboard.
- **Bulk import and calendar.** Paste or upload many domains at once, see every drop on a calendar, export `.ics`.
- **Dashboard.** Setup wizard, live overview with schedule timelines, target editor, secrets manager,
  provider tests, audit log and confirm-mode approvals.
- **Audit trail.** Every check, event and attempt goes to SQLite, with provider latency stats.
- **Extensible.** New registrars are plugins; the watcher, gate, notifier and database stay untouched.

## Supported providers

| | Availability | Registration | Server-side dry run | Sandbox | Notes |
|---|:-:|:-:|:-:|:-:|---|
| RDAP | yes | no | n/a | n/a | Registry data. `.pl` (NASK) lags up to 15 min, so treated as advisory |
| **OVHcloud** | yes | yes | yes (checkout preview) | no | **Sells `.pl` and `.com.pl`** (PLN, net of VAT). Cart based, pays with your default payment method |
| Porkbun | yes | yes | yes | yes (`pk1_sb_` keys) | Exact-cost guard. No premium via API. **Does not sell `.pl`** |
| Namecheap | yes | yes | no | yes | Whitelisted client IP required. Contact details needed to register |
| Cloudflare | yes | yes | no | yes (com/net) | API beta, subset of TLDs, non-refundable |
| Mock | yes | yes | yes | n/a | Deterministic fake for rehearsals and tests |

Details, sources and rate limits: [docs/PROVIDERS.md](docs/PROVIDERS.md). Run `dropcatch providers` for
the live capability matrix and connectivity of your accounts.

## Install

Requires **Node.js 22.18 or newer**. SQLite is built into Node, so there is no native build step.

```bash
git clone https://github.com/nvwyk/dropcatch.git
cd dropcatch
npm install
npm run build
npm link            # optional: puts `dropcatch` (and the `domain-drop` alias) on your PATH
```

Without `npm link`, use `node dist/index.js <command>`.

## Quick start

```bash
dropcatch check example.pl          # works with no config at all (RDAP only)
dropcatch dashboard                 # guided setup in the browser, or:
dropcatch init                      # guided setup in the terminal
dropcatch test discord
dropcatch test provider porkbun-main
dropcatch watch                     # dry run until you switch it off
```

## Dashboard

```bash
dropcatch dashboard                 # http://127.0.0.1:4747
dropcatch dashboard --watch         # also start watching every enabled target
dropcatch dashboard --public        # bind 0.0.0.0 so other machines can reach it
```

**First run.** The terminal prints a one-time link such as
`http://127.0.0.1:4747/#/setup?token=...`. Open it and create the admin password (at least 10
characters). The token proves you are the person who started the server, so an exposed dashboard
cannot be claimed by someone else. Next you add your first domain, and dropcatch writes
`config.yaml` in dry-run mode. From then on every visit requires the password.

What it covers:

- **Overview.** Next-drop countdown, running watches, 24 h check volume, a schedule strip per target
  showing where "now" sits against the warm, hot and post windows, latest answer per source, live event
  feed and source latency.
- **Targets.** Create, edit and delete targets, start and stop watches, and settle `AMBIGUOUS` or
  `PENDING` results.
- **Calendar.** Month view and agenda of every drop window, with `.ics` export.
- **Import.** Paste or upload many domains (plain lines or CSV), preview the result, then import.
- **Check.** One-off availability check across all sources.
- **Providers.** Add registrar accounts, set API keys (written to `.env` with mode 600, never shown
  again), test connectivity, view the capability matrix.
- **Notifications.** Discord webhook and Telegram bot (with chat discovery), event filters and test buttons.
- **Response time.** Per-source latency charts on each target, with the clock offset on the overview.
- **Activity.** Full event log and purchase attempts.
- **Settings.** Timezone, profile, the dry-run switch (going live requires typing `GO LIVE`), password
  change, sign out other sessions, and a raw YAML editor with validation.
- **Confirm mode.** Purchases wait for you to type the domain on the overview.

Security model: scrypt password hash, sessions stored as hashes, `HttpOnly` + `SameSite=Strict`
cookies, CSRF header and Origin check, per-IP login lockout, strict CSP, `noindex`, and a DNS-rebinding
guard in localhost mode. Config edits are validated by the same loader as the CLI, the previous file is
kept as `config.yaml.bak`, and the `plugins:` list (which loads code) can only be changed on disk.

**Public mode** serves plain HTTP. Put it behind a reverse proxy with TLS (Caddy, nginx, Cloudflare
Tunnel) and set `dashboard.trustProxy: true` so cookies get the `Secure` flag.

## Configuration

Everything lives in `config.yaml` (YAML or JSON). The annotated reference is
[config/example.yaml](config/example.yaml). The config file **never contains secrets**. It names the
environment variables that hold them, and the loader refuses to start if it finds a webhook URL, API
key, bearer token or `user:password@` URL in the file.

```yaml
profile: production            # development (always dry run) | testing (sandbox only) | production
app:
  timezone: Europe/Warsaw
  database: ./data/dropcatch.sqlite
  dryRun: true

accounts:
  porkbun-main:
    provider: porkbun
    credentials:
      apiKey: PORKBUN_API_KEY
      secretApiKey: PORKBUN_SECRET_API_KEY

targets:
  - id: brand-com
    domain: example-brand.com
    drop:
      expectedAt: "2026-10-01 20:00"   # naive times use drop.timezone or app.timezone
      timezone: Europe/Warsaw
      preWindowSeconds: 600
      postWindowSeconds: 900
    availability:
      providers: [rdap, porkbun-main]
      quorum: { mode: any, minimumConfirmations: 1 }
    registration:
      enabled: true
      mode: auto-buy
      providers: [porkbun-main]
      budget: { maxRegistrationPrice: 15, currency: USD }
```

Secrets go in `.env` next to the config or in the process environment (see [.env.example](.env.example)).
Run `dropcatch validate` after every edit. It lists all problems at once.

### Monitoring

| Phase | When | Interval key (default) |
|---|---|---|
| idle | before `expectedAt - preWindowSeconds` | `initialIntervalMs` (30000) |
| warm | inside the pre window | `warmupIntervalMs` (1000) |
| hot | `expectedAt +/- hotWindowSeconds` | `hotIntervalMs` (250) |
| post | until `expectedAt + postWindowSeconds` | `warmupIntervalMs` |

After the post window the watch stops (`stopAfterWindow: true`). Without a drop time, the watch
polls every `fixedIntervalMs`. Provider rate limits always apply on top: a source that is not allowed
yet is skipped for that tick rather than queued.

### `.pl` domains

NASK publishes no exact release second (expired names sit 30 days in BLOCKED, then return to the pool),
and its RDAP data lags the registry by up to 15 minutes. So for `.pl`, treat `expectedAt` as a hint and
keep a long `postWindowSeconds`. RDAP gives an early signal but never proof. Use an **OVHcloud** account
as both an availability source and the registrar (OVHcloud Poland sells `.pl` and `.com.pl`; Porkbun
does not):

```yaml
accounts:
  ovh-main:
    provider: ovh
    options: { endpoint: ovh-eu, ovhSubsidiary: PL, ownerContact: 12345 }
targets:
  - id: sklep-pl
    domain: sklep-przyklad.pl
    drop: { expectedAt: "2026-10-05 10:00", timezone: Europe/Warsaw, postWindowSeconds: 3600 }
    availability: { providers: [ovh-main, rdap] }
    registration:
      enabled: true
      mode: auto-buy
      providers: [ovh-main]
      budget: { maxRegistrationPrice: 30, currency: PLN }   # OVH prices are net of VAT
```

The OVH purchase builds an order in a dedicated cart, fills the required contacts, lets OVH validate
it, checks that the cart holds only this domain and that the net total does not exceed the verified
price, and only then places the paid checkout. Every step before that final call is a confirmed
failure (no order exists), so falling back to another registrar stays safe.

## Getting credentials

- **OVHcloud (for `.pl`):** create a token at [eu.api.ovh.com/createToken](https://eu.api.ovh.com/createToken/)
  with rights `GET/POST/DELETE /order/cart*`, `GET /me*`, `GET /domain/*`. That gives the application key,
  application secret and consumer key (`OVH_APPLICATION_KEY`, `OVH_APPLICATION_SECRET`, `OVH_CONSUMER_KEY`).
  To register, also set `options.ownerContact` (the id of an owner contact from the OVH manager, or `GET /me/contact`)
  and make sure a default payment method is saved. Rehearse with dry run: OVH validates the whole order
  (`GET /order/cart/{id}/checkout`) without placing it.
- **Porkbun:** [porkbun.com/account/api](https://porkbun.com/account/api). Create a key pair and enable
  API access. Registration via API requires a verified email and phone, account credit and one earlier
  registration. For rehearsals, create a sandbox pair (`pk1_sb_...`) and set `environment: sandbox`.
- **Namecheap:** Profile > Tools > API Access. Whitelist the public IP dropcatch calls from and set it
  as `NAMECHEAP_CLIENT_IP`. Use `environment: sandbox` with a sandbox account first.
- **Cloudflare:** create an API token with Registrar write permission and note your account ID.
- **Discord:** Server Settings > Integrations > Webhooks > New Webhook > Copy URL.
- **Telegram:** talk to [@BotFather](https://t.me/BotFather), `/newbot`, copy the token into `TELEGRAM_BOT_TOKEN`.
  Send your bot any message, then `dropcatch test telegram --chats` (or "Find my chat" in the dashboard) shows the chat id.

## Discord and Telegram

Set `DISCORD_WEBHOOK_URL` and run `dropcatch test discord`. For Telegram:

```yaml
notifications:
  telegram:
    enabled: true
    botTokenEnv: TELEGRAM_BOT_TOKEN
    chatId: "123456789"         # or -100... for a group, or @channelname
```

Then `dropcatch test telegram`. Both channels are delivered by the same background queue.
Discord 429 and 5xx responses are retried, a failing provider is reported once (plus once when it recovers), and a
failing channel never slows down a purchase. Per target, `notifications.discord.enabled` and
`notifications.telegram.enabled` switch channels off.

For Discord alone: Events are delivered by a background queue.
Discord 429 and 5xx responses are retried, a failing provider is reported once (plus once when it recovers), and a
failing webhook never slows down a purchase. `notifications.discord.events` limits what is sent, and
`mentionRoleId` pings one role on detections and purchases.

```text
DOMAIN REGISTERED
Domain: example.pl   Provider: porkbun-main   Registration: SUCCESS
Price: 12.00 USD     Request latency: 182 ms   Attempt: 1
```

## Dry run, watch and auto-buy

1. **Rehearse.** With `app.dryRun: true` (the default) the full flow runs: checks, final check, budget
   gate and notification. Instead of registering, dropcatch calls the provider's server-side dry run
   where one exists (Porkbun validates price, funds and eligibility without charging), or records a
   simulated attempt. `register()` cannot be reached in this mode.

   ```bash
   dropcatch buy example-brand.com --provider porkbun-main --max-price 15 --dry-run
   dropcatch watch
   ```

2. **Check the setup.** Run `dropcatch providers` (all accounts should show `OK`) and
   `dropcatch test discord`.
3. **Go live.** Set `app.dryRun: false`, or use the Settings switch in the dashboard. Nothing on the
   command line can turn dry run off. `--dry-run` can only force it on.
4. **Arm.** Run `dropcatch watch` or `dropcatch dashboard --watch`. For live registration, every
   registrar account must pass a health check before the watch starts.

`confirm` mode asks you to type the domain in the terminal (or the dashboard) before buying, with a
timeout. It re-checks price and availability after you answer.

Watch exit codes: `0` done (registered, detected, dry run or stopped), `3` needs attention (pending or
ambiguous), `4` failed or aborted, `5` window closed without a detection.

## How purchases stay safe

The order of priorities is: never buy the wrong domain, never buy twice, never exceed the budget, never
leak credentials.

- **Final check at the buying registrar.** An RDAP 404 only starts the flow. The price used by the gate
  comes from the registrar that will register.
- **Purchase gate.** Refuses on domain mismatch, a price that is over budget, unknown or in the wrong
  currency, an exact-price mismatch, premium names, exhausted attempts, a disabled target, invalid
  credentials, or (optionally) a time outside the drop window.
- **Write-ahead lock.** The target moves `VERIFYING -> REGISTERING` in one SQLite transaction together
  with an `in_flight` attempt record, committed with fsync before the request is sent. A second process
  cannot take the same target.
- **Ambiguity handling.** A timeout after sending, a 5xx or an unreadable reply is `unknown`, never a
  failure. dropcatch asks the registrar whether the domain is now in the account. If that is not
  confirmed, the target becomes `AMBIGUOUS` and nothing else is tried, including other registrars. Only
  a confirmed rejection (or a connection that provably never opened) moves on to the next registrar.
- **Crash safety.** A process that dies mid-request leaves `REGISTERING`. On the next start that becomes
  `AMBIGUOUS` and the target refuses to arm until you run `dropcatch resolve <target>`.
- **Retries.** Registration requests are never retried once they may have reached the server.
- **Stale signals.** If a source keeps saying "free" while the registrar says "taken", it is ignored
  until its answer changes, so there is no detection loop.

`dropcatch resolve <target>` asks the registrar, `--as succeeded|failed` records what you verified, and
`--as reset` re-arms the target and restarts attempt counting (history is kept).

## Rate limits and proxies

Each account has its own limiter, built from the provider's documented defaults (see
[docs/PROVIDERS.md](docs/PROVIDERS.md)) plus any `accounts.<id>.limits` override:

```yaml
accounts:
  porkbun-main:
    provider: porkbun
    limits:
      availability: { minIntervalMs: 1000, maxConcurrentRequests: 1, requestsPerMinute: 60 }
```

A 429 pauses that source for its `Retry-After`, or backs it off exponentially (5 s doubling up to 5 min)
when there is none. Once it answers again it eases back in one step per answer instead of jumping straight
back to full speed. `policy.maxConcurrentRequests` caps simultaneous checks across all targets.

Proxies (HTTP, HTTPS, SOCKS5) are for routing, for example a whitelisted egress IP for Namecheap. They
are **not** a way around provider limits: an account keeps one limiter however many proxies it uses.

```yaml
proxies:
  enabled: true
  defaultPool: office
  pools:
    office:
      strategy: failover               # static | round-robin | random | failover
      proxies:
        - http://10.0.0.5:3128
        - urlEnv: PROXY_BACKUP_URL     # credentialed URLs must come from the environment
accounts:
  namecheap-main:
    provider: namecheap
    proxy: office                      # or "direct"
```

## Bulk import and calendar

```bash
dropcatch import drops.csv --dry-run               # preview; nothing written
dropcatch import drops.csv --mode auto-buy --max-price 30 -r ovh-main
dropcatch calendar --days 60                       # agenda of upcoming drop windows
dropcatch calendar --ics drops.ics                 # subscribe-able iCalendar file (15 min reminders)
```

The import accepts one `domain [drop time]` per line, or a CSV (comma, semicolon or tab) with a
`domain` column and optional `expectedAt`/`drop`, `timezone`, `mode`, `maxPrice`/`budget`, `currency`,
`registrars`, `sources`, `id`. Rows are validated one by one, then the whole config is validated again;
if anything is wrong nothing is written. Existing targets are skipped unless `--update`. The dashboard
has the same import (with a preview table) on the Overview, and a Calendar page with an `.ics` export.

## Clock accuracy and latency

A drop at 12:00:00 only helps if this machine knows when 12:00:00 is. dropcatch queries NTP
(`time.cloudflare.com`, `pool.ntp.org`, `time.google.com`) at start and every 15 minutes, and with
`app.clock.correct: true` (the default) it schedules ticks on NTP time. Offsets over 10 minutes are
reported but never applied: fix the system clock then. `dropcatch check` and the dashboard show the offset.

```yaml
app:
  clock: { ntp: true, correct: true, warnMs: 500 }
```

Registrar accounts that are only used to buy (not polled) are kept warm near the drop with a cheap
unauthenticated request every 15 s, so the final check and the purchase skip the TLS handshake. The
dashboard shows response time per source on each target (hover or use the arrow keys for values).

## Metrics and health

- Dashboard: `GET /healthz` (no auth) and `GET /metrics` (Prometheus text format).
- Headless: `dropcatch watch --metrics-port 9464` serves the same two endpoints on 127.0.0.1.

`/metrics` answers loopback clients and signed-in dashboard sessions. Remote scrapers need
`Authorization: Bearer $DROPCATCH_METRICS_TOKEN`. Series include `dropcatch_availability_checks_total`,
`dropcatch_provider_latency_ms` (histogram), `dropcatch_provider_rate_limits_total`,
`dropcatch_registration_attempts_total`, `dropcatch_registrations_total{outcome}`,
`dropcatch_notifications_total`, `dropcatch_watches_running` and `dropcatch_clock_offset_ms`.

## CLI reference

```text
dropcatch init                         interactive setup (config.yaml + .env)
dropcatch validate                     validate config, print warnings
dropcatch providers [--offline]        capability matrix, credentials, connectivity
dropcatch check <domain> [-p acct]     one-off check across sources
dropcatch watch [-t id] [--dry-run] [--metrics-port 9464]
dropcatch buy <domain> -p acct --max-price N [--dry-run] [--yes]
dropcatch test discord | test telegram [--chats] | test provider <acct> [-d domain]
dropcatch import <file|-> [--dry-run] [--update] [--mode m] [--max-price n] [-r acct]
dropcatch calendar [--days 30] [--ics file]
dropcatch status [-t id] [-n 50]       states, attempts, runs, timeline, latency
dropcatch resolve <target> [--as auto|succeeded|failed|reset]
dropcatch dashboard [--host h] [--port p] [--public] [--watch]

Global: --config <path>  --env-file <path>  --log-level <lvl>  --json  --no-color
```

`--json` prints machine-readable results on stdout and JSON logs on stderr.

## Deployment

**systemd** (single VPS): see [deploy/systemd/dropcatch.service](deploy/systemd/dropcatch.service).
Build into `/opt/dropcatch`, keep secrets in `/etc/dropcatch/env` (chmod 600), and enable the unit.
It uses `SIGTERM` with a 90 s stop timeout so an in-flight registration can finish.

**Docker:**

```bash
docker compose up -d --build           # dashboard + watcher, published on 127.0.0.1:4747
```

The image runs as a non-root user, keeps state in `/data` (set `app.database: /data/dropcatch.sqlite`)
and takes secrets only from the environment.

Keep the host clock synced (NTP). `dropcatch check` warns when providers' clocks disagree with yours.

## Security

- Credentials come from the environment or `.env`. The config holds only variable names.
- Logs, stored events and error messages pass through a redactor that knows every loaded secret and
  masks webhook URLs, `Authorization` headers, proxy passwords and key fields.
- The database stores no secrets and no raw provider responses.
- On POSIX, a config or `.env` readable by group or other triggers a warning.
- Live auto-buy requires `registration.enabled: true`, `mode: auto-buy`, `app.dryRun: false`, a budget,
  a persistent database and healthy credentials.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Refusing to load config: it contains secret-looking values` | Move the value to `.env` and reference its name (`webhookEnv: DISCORD_WEBHOOK_URL`). |
| `missing environment variable(s)` | Put the variable in `.env` or the environment. `dropcatch providers` shows which. |
| Porkbun `AUTHENTICATION_FAILED` | Enable API access at porkbun.com/account/api and check both keys. |
| Namecheap `AUTHENTICATION_FAILED` | Whitelist the calling IP. With a proxy, whitelist the proxy's egress IP. |
| `DOMAIN_UNSUPPORTED` / `extension_not_supported_via_api` | That registrar does not sell the TLD via API. Use another account. |
| Target `cannot be armed` | It is `SUCCEEDED`, `PENDING` or `AMBIGUOUS`. Inspect with `dropcatch status -t <id>`, then `dropcatch resolve <id>`. |
| `window_expired` without a detection | The registry did not release in the window. Widen `postWindowSeconds` (`.pl` often needs an hour). |
| RDAP says free, registrar says taken | Normal right after a drop, or the name is reserved. dropcatch waits for the registrar. |
| Clock warning | Enable NTP (`timedatectl set-ntp true`). dropcatch corrects offsets under 10 minutes meanwhile. |
| OVH `CONFIGURATION_ERROR ... requires X` | The TLD asks for a configuration label. Set `options.ownerContact`, `acceptConditions: true`, or `extraConfiguration: { X: value }`. |
| OVH order stays `REGISTRATION_PENDING` | Usually payment: save a default payment method, or pay the order in the OVH manager, then `dropcatch resolve <id>`. |
| Telegram test fails with "chat not found" | Message the bot first, then use `test telegram --chats` for the right id (groups are negative). |
| Forgot the dashboard password | Stop dropcatch, run `sqlite3 data/dropcatch.sqlite "DELETE FROM dashboard_auth; DELETE FROM dashboard_sessions;"`, restart and use the new setup link. |

Set `--log-level debug` (or `trace` for every HTTP call, redacted) for detail.

## Adding a provider

A provider is a plugin object. The core never changes. Put it in a module and list it in the config:

```yaml
plugins: ["./providers/my-registrar.js"]   # relative to config.yaml; editable on disk only
accounts:
  mine:
    provider: my-registrar
    credentials: { token: MY_REGISTRAR_TOKEN }
```

```js
// providers/my-registrar.js
export default {
  id: "my-registrar",
  displayName: "My Registrar",
  sourceKind: "registrar",
  capabilities: {
    availability: true, registration: true, pricing: true, preflight: false,
    ownershipLookup: true, registrationStatus: false, sandbox: false, premiumRegistration: false,
  },
  credentials: [{ name: "token", defaultEnv: "MY_REGISTRAR_TOKEN", required: true, secret: true, description: "API token" }],
  defaultLimits: { availability: { minIntervalMs: 1000 }, registration: { minIntervalMs: 1000 } },
  create(ctx) {
    // ctx.http(req) is the shared transport (timeouts, proxies, redaction). Do not retry yourself.
    return {
      async check({ domain, timeoutMs, signal }) {
        /* return an AvailabilityResult: status available | unavailable | unknown | unsupported | rate_limited | error */
      },
      async register(request) {
        /* return a RegistrationResult. Use "failed" ONLY for a confirmed rejection; anything unclear is "unknown". */
      },
      async lookupOwnership(domain) { /* "owned" | "not-owned" | "unknown" */ },
    };
  },
};
```

The built-in adapters in [src/providers](src/providers) are complete examples. Copy the contract tests in
[tests/unit/providers.test.ts](tests/unit/providers.test.ts) for yours.

## Development

```bash
npm run typecheck      # tsc strict
npm test               # node:test, no network: fake transport, mock providers, temp SQLite
npm run dev -- check example.com
```

Design and research notes: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
[docs/PROVIDERS.md](docs/PROVIDERS.md), [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md). The original
specification is [domain-drop-auto-buyer-plan.md](domain-drop-auto-buyer-plan.md).

## License

MIT
