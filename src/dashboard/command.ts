import { networkInterfaces } from "node:os";
import { ConfigError } from "../core/errors.ts";
import { bad, bold, dim, good, out, warn } from "../cli/output.ts";
import type { GlobalOptions } from "../cli/runtime.ts";
import { VERSION } from "../version.ts";
import { DashboardApp, type DashboardFlags } from "./DashboardApp.ts";
import { createDashboardServer } from "./server.ts";

function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i): i is NonNullable<typeof i> => Boolean(i && i.family === "IPv4" && !i.internal))
    .map((i) => i.address);
}

export async function dashboardCommand(globals: GlobalOptions, flags: DashboardFlags): Promise<number> {
  const app = await DashboardApp.create(globals);
  const cfg = app.rt.config.dashboard;
  const host = flags.public ? "0.0.0.0" : flags.host ?? cfg.host;
  const port = flags.port !== undefined ? Number(flags.port) : cfg.port;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new ConfigError("--port must be between 1 and 65535");

  const server = createDashboardServer(app, { host, port, trustProxy: cfg.trustProxy });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  const local = `http://${host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host}:${port}/`;
  out(bold(`dropcatch dashboard v${VERSION}`));
  out(`  Local:    ${good(local)}`);
  if (host === "0.0.0.0" || host === "::") {
    for (const ip of lanAddresses()) out(`  Network:  http://${ip}:${port}/`);
    out(warn("  Public mode: the dashboard is reachable from other machines over plain HTTP."));
    out(warn("  Put it behind HTTPS (Caddy, nginx, Cloudflare Tunnel) and a firewall before using it over the internet."));
  }
  if (app.setupToken) {
    out();
    out(bold("  First-time setup"));
    out(`  Open ${good(`${local}#/setup?token=${app.setupToken}`)}`);
    out(dim("  The setup token proves you started this server. It stops working once the admin password is set."));
  }
  if (app.configError) out(bad(`  Config has errors; open Settings > Raw config in the dashboard to fix them.`));
  out();

  if (flags.watch) {
    for (const t of app.rt.config.targets.filter((x) => x.enabled)) {
      await app.startWatch(t.id).catch((err: Error) => app.rt.logger.error(`Could not start ${t.id}: ${err.message}`));
    }
  }

  await new Promise<void>((resolve) => {
    let stopping = false;
    const stop = (signal: NodeJS.Signals): void => {
      if (stopping) {
        app.rt.logger.error("Forced exit. Any in-flight registration will show as AMBIGUOUS on the next start.");
        process.exit(130);
      }
      stopping = true;
      app.rt.logger.warn(`${signal} received: stopping watches (an in-flight registration may finish first). Press Ctrl+C again to force quit.`);
      server.close();
      server.closeAllConnections();
      void app.shutdown().finally(resolve);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
  return 0;
}
