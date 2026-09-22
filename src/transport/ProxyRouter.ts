import { Agent, ProxyAgent, Socks5ProxyAgent, type Dispatcher } from "undici";
import { ConfigError } from "../core/errors.ts";
import { describeUrl } from "../security/redaction.ts";

export type ProxyStrategy = "static" | "round-robin" | "random" | "failover";

export interface ProxyPoolConfig {
  strategy: ProxyStrategy;
  /** Fully resolved proxy URLs (env references already expanded). */
  urls: string[];
}

interface Pool {
  strategy: ProxyStrategy;
  dispatchers: Dispatcher[];
  labels: string[];
  cursor: number;
}

export interface Route {
  dispatcher: Dispatcher;
  label: string;
  /** Tell the router this route failed at the network level (drives failover). */
  reportFailure(): void;
}

function createProxyDispatcher(url: string): Dispatcher {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConfigError(`Invalid proxy URL ${describeUrl(url)}`);
  }
  switch (parsed.protocol) {
    case "http:":
    case "https:":
      return new ProxyAgent({ uri: url, keepAliveTimeout: 60_000 });
    case "socks5:":
    case "socks5h:":
    case "socks:": {
      const options: Socks5ProxyAgent.Options = {};
      if (parsed.username) options.username = decodeURIComponent(parsed.username);
      if (parsed.password) options.password = decodeURIComponent(parsed.password);
      const bare = `socks5://${parsed.host}`;
      return new Socks5ProxyAgent(bare, options);
    }
    default:
      throw new ConfigError(`Unsupported proxy protocol "${parsed.protocol}" (use http, https or socks5)`);
  }
}

/**
 * Chooses the dispatcher (direct or proxy) per request. Proxies exist for routing and
 * source-IP requirements (e.g. Namecheap whitelisting), not for evading provider limits:
 * every provider keeps one rate limiter regardless of how many proxies it can use.
 */
export class ProxyRouter {
  private readonly direct: Dispatcher;
  private readonly pools = new Map<string, Pool>();

  constructor(pools: Record<string, ProxyPoolConfig> = {}) {
    this.direct = new Agent({ keepAliveTimeout: 60_000, keepAliveMaxTimeout: 600_000, connections: 16 });
    for (const [name, cfg] of Object.entries(pools)) {
      if (cfg.urls.length === 0) throw new ConfigError(`Proxy pool "${name}" has no proxies`);
      this.pools.set(name, {
        strategy: cfg.strategy,
        dispatchers: cfg.urls.map(createProxyDispatcher),
        labels: cfg.urls.map(describeUrl),
        cursor: 0,
      });
    }
  }

  hasPool(name: string): boolean {
    return this.pools.has(name);
  }

  /** `poolName` undefined or "direct" = no proxy. */
  route(poolName?: string): Route {
    if (!poolName || poolName === "direct") {
      return { dispatcher: this.direct, label: "direct", reportFailure: () => {} };
    }
    const pool = this.pools.get(poolName);
    if (!pool) throw new ConfigError(`Unknown proxy pool "${poolName}"`);
    let index: number;
    switch (pool.strategy) {
      case "static":
        index = 0;
        break;
      case "failover":
        index = pool.cursor;
        break;
      case "round-robin":
        index = pool.cursor;
        pool.cursor = (pool.cursor + 1) % pool.dispatchers.length;
        break;
      case "random":
        index = Math.floor(Math.random() * pool.dispatchers.length);
        break;
    }
    return {
      dispatcher: pool.dispatchers[index]!,
      label: `${poolName}:${pool.labels[index]}`,
      reportFailure: () => {
        if (pool.strategy === "failover" && pool.cursor === index) {
          pool.cursor = (pool.cursor + 1) % pool.dispatchers.length;
        }
      },
    };
  }

  async close(): Promise<void> {
    const all = [this.direct, ...[...this.pools.values()].flatMap((p) => p.dispatchers)];
    await Promise.allSettled(all.map((d) => d.close()));
  }
}
