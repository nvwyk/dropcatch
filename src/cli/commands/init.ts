import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { upsertEnvFile } from "../../config/envFile.ts";
import { parseConfigText, resolveConfig } from "../../config/loader.ts";
import { accountId, renderConfig, type RegistrarChoice, type TemplateAnswers } from "../../config/template.ts";
import { ConfigError } from "../../core/errors.ts";
import { formatInstant, isValidTimeZone, localTimeZone, parseInstant } from "../../core/time.ts";
import { normalizeDomain } from "../../domain/normalize.ts";
import { builtinRegistry } from "../../providers/ProviderRegistry.ts";
import { porkbunPlugin } from "../../providers/porkbun/PorkbunProvider.ts";
import { namecheapPlugin } from "../../providers/namecheap/NamecheapProvider.ts";
import { cloudflarePlugin } from "../../providers/cloudflare/CloudflareProvider.ts";
import { ovhPlugin } from "../../providers/ovh/OvhProvider.ts";
import { bold, dim, good, out, warn } from "../output.ts";
import { isInteractive, Prompter } from "../prompt.ts";

const PLUGINS = { porkbun: porkbunPlugin, namecheap: namecheapPlugin, cloudflare: cloudflarePlugin, ovh: ovhPlugin } as const;

export async function initCommand(opts: { config?: string; force?: boolean }): Promise<number> {
  if (!isInteractive()) {
    throw new ConfigError('dropcatch init is interactive. In scripts, copy config/example.yaml to config.yaml instead (or use "dropcatch dashboard").');
  }
  const p = new Prompter();
  try {
    out(bold("dropcatch setup"));
    out(dim("Answers go into a config file and a private .env file. Press Enter to accept [defaults]."));
    out();

    // 1. location
    const path = resolve(await p.ask("1. Config file", opts.config ?? "./config.yaml"));
    if (existsSync(path) && !opts.force && !(await p.confirm(`${path} exists. Overwrite?`))) {
      out("Nothing written.");
      return 0;
    }
    const envPath = resolve(dirname(path), ".env");

    // 2. timezone
    let timezone = "";
    while (!isValidTimeZone(timezone)) {
      timezone = await p.ask("2. Your timezone (IANA name)", localTimeZone());
      if (!isValidTimeZone(timezone)) out(warn(`Unknown timezone "${timezone}", e.g. Europe/Warsaw or UTC`));
    }

    // 3. domain
    let domain = "";
    for (;;) {
      try {
        domain = normalizeDomain(await p.ask("3. Domain to watch")).ascii;
        break;
      } catch (err) {
        out(warn((err as Error).message));
      }
    }

    // 4. drop time
    let expectedAt: string | undefined;
    for (;;) {
      const raw = await p.ask(`4. Expected release time in ${timezone}, e.g. 2026-10-01 14:00 (blank = unknown)`);
      if (!raw) break;
      try {
        const parsed = parseInstant(raw.length === 16 ? `${raw}:00` : raw, timezone);
        expectedAt = new Date(parsed.utcMs).toISOString();
        out(dim(`   = ${formatInstant(parsed.utcMs, "UTC", { withDate: true, withZone: true })}`));
        break;
      } catch (err) {
        out(warn((err as Error).message));
      }
    }

    // 5. monitoring
    const strategy = await p.choose("5. Monitoring strategy", ["adaptive", "fixed"] as const, "adaptive");

    // 6. registrars
    const registrars: RegistrarChoice[] = [];
    const picked = await p.ask("6. Registrar accounts to use (ovh, porkbun, namecheap, cloudflare; comma separated, blank = RDAP only; ovh sells .pl)");
    for (const name of picked.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)) {
      if (name in PLUGINS && !registrars.includes(name as RegistrarChoice)) registrars.push(name as RegistrarChoice);
      else out(warn(`Ignoring unknown registrar "${name}"`));
    }

    // 7. credentials
    const secrets: Record<string, string> = {};
    for (const r of registrars) {
      out(dim(`   ${PLUGINS[r].displayName} credentials (stored in ${envPath})`));
      for (const field of PLUGINS[r].credentials) {
        const value = field.secret ? await p.askSecret(`   ${field.description} [${field.defaultEnv}]`) : await p.ask(`   ${field.description} [${field.defaultEnv}]`);
        if (value) secrets[field.defaultEnv] = value;
      }
    }

    // 8. Discord
    const webhook = await p.askSecret("8. Discord webhook URL");
    if (webhook) secrets.DISCORD_WEBHOOK_URL = webhook;

    // 9. mode
    let mode: TemplateAnswers["mode"] = "notify-only";
    if (registrars.length) mode = await p.choose("9. When the domain frees up", ["notify-only", "confirm", "auto-buy"] as const, "notify-only");

    // 10. budget
    let budget: TemplateAnswers["budget"];
    if (mode !== "notify-only") {
      for (;;) {
        const max = Number(await p.ask("10. Maximum price you will pay", "20"));
        if (Number.isFinite(max) && max > 0) {
          budget = { max, currency: (await p.ask("    Currency", registrars.includes("ovh") ? "PLN" : "USD")).toUpperCase() };
          break;
        }
        out(warn("Enter a positive number"));
      }
    }

    let namecheapContact: Record<string, string> | undefined;
    if (mode !== "notify-only" && registrars.includes("namecheap")) {
      out(dim("   Namecheap needs registrant contact details to register:"));
      namecheapContact = {
        firstName: await p.ask("   First name"),
        lastName: await p.ask("   Last name"),
        address1: await p.ask("   Street address"),
        city: await p.ask("   City"),
        stateProvince: await p.ask("   State/province"),
        postalCode: await p.ask("   Postal code"),
        country: (await p.ask("   Country (2 letters)", "PL")).toUpperCase(),
        phone: await p.ask("   Phone (+48.123456789)"),
        email: await p.ask("   Email"),
      };
    }

    let ovhOwnerContact: string | undefined;
    if (mode !== "notify-only" && registrars.includes("ovh")) {
      ovhOwnerContact = (await p.ask("   OVH owner contact id (OVH manager > contacts, or GET /me/contact)")) || undefined;
    }

    const text = renderConfig({
      timezone,
      target: { id: domain.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""), domain, expectedAt, strategy },
      registrars,
      mode,
      budget,
      namecheapContact,
      ovhOwnerContact,
      discord: true,
    });
    // Validate before writing, so init never produces a broken config.
    resolveConfig(parseConfigText(text), { registry: builtinRegistry(), baseDir: dirname(path), env: { ...process.env, ...secrets } });

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, { mode: 0o600 });
    if (Object.keys(secrets).length) upsertEnvFile(envPath, secrets);

    out();
    out(good(`Wrote ${path}`) + (Object.keys(secrets).length ? good(` and ${Object.keys(secrets).length} secret(s) to ${envPath}`) : ""));
    out(bold("Next steps"));
    out(`  dropcatch check ${domain}`);
    if (secrets.DISCORD_WEBHOOK_URL) out("  dropcatch test discord");
    for (const r of registrars) out(`  dropcatch test provider ${accountId(r)}`);
    out("  dropcatch watch            (dry run: nothing is bought)");
    if (mode !== "notify-only") out(dim("  When the rehearsal looks right, set app.dryRun: false in the config to go live."));
    return 0;
  } finally {
    p.close();
  }
}
