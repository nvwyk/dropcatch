import { createServer, type Server } from "node:http";
import { VERSION } from "../version.ts";
import { metricsAllowed, renderMetrics } from "./metrics.ts";

/**
 * Minimal /metrics + /healthz server for headless `watch`. Binds to loopback by default;
 * non-loopback scrapers need DROPCATCH_METRICS_TOKEN as a bearer token.
 */
export async function startMetricsServer(opts: { host: string; port: number; token?: string; health: () => Record<string, unknown> }): Promise<Server> {
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/healthz") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify({ status: "ok", version: VERSION, ...opts.health() }));
      return;
    }
    if (path === "/metrics") {
      if (!metricsAllowed(req.socket.remoteAddress, req.headers.authorization, opts.token, false)) {
        res.writeHead(401, { "www-authenticate": "Bearer" }).end("unauthorized");
        return;
      }
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" }).end(renderMetrics(VERSION));
      return;
    }
    res.writeHead(404).end("not found");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => resolve());
  });
  server.unref();
  return server;
}
