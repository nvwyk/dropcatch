import { bold, dim, good, out, printJson, warn } from "../output.ts";
import type { Runtime } from "../runtime.ts";

export async function validateCommand(rt: Runtime, opts: { json?: boolean }): Promise<number> {
  const c = rt.config;
  const summary = {
    ok: true,
    path: c.path,
    profile: c.profile,
    dryRun: c.app.dryRun,
    accounts: Object.keys(c.accounts),
    targets: c.targets.map((t) => ({
      id: t.id,
      domain: t.domain.ascii,
      mode: t.registration.mode,
      expectedAt: t.drop ? new Date(t.drop.expectedAtMs).toISOString() : null,
    })),
    warnings: c.warnings,
  };
  if (opts.json) {
    printJson(summary);
    return 0;
  }
  out(good(bold("Configuration OK")) + dim(` ${c.path ?? ""}`));
  out(`  profile ${c.profile}, dry run ${c.app.dryRun ? good("ON") : warn("OFF")}, ${summary.accounts.length} account(s), ${summary.targets.length} target(s)`);
  for (const t of summary.targets) out(`  - ${t.id}: ${t.domain} ${dim(`${t.mode}${t.expectedAt ? `, drop ${t.expectedAt}` : ""}`)}`);
  if (c.warnings.length) {
    out();
    out(warn(`${c.warnings.length} warning(s) above.`));
  }
  return 0;
}
