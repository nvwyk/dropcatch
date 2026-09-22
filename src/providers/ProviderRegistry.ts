import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ConfigError } from "../core/errors.ts";
import { cloudflarePlugin } from "./cloudflare/CloudflareProvider.ts";
import { mockPlugin } from "./mock/MockProvider.ts";
import { namecheapPlugin } from "./namecheap/NamecheapProvider.ts";
import { ovhPlugin } from "./ovh/OvhProvider.ts";
import { porkbunPlugin } from "./porkbun/PorkbunProvider.ts";
import { rdapPlugin } from "./rdap/RdapProvider.ts";
import type { AnyProviderPlugin } from "./types.ts";

export class ProviderRegistry {
  private readonly plugins = new Map<string, AnyProviderPlugin>();

  register(plugin: AnyProviderPlugin): this {
    validatePlugin(plugin);
    if (this.plugins.has(plugin.id)) throw new ConfigError(`Provider "${plugin.id}" is already registered`);
    this.plugins.set(plugin.id, plugin);
    return this;
  }

  get(id: string): AnyProviderPlugin | undefined {
    return this.plugins.get(id);
  }

  require(id: string): AnyProviderPlugin {
    const plugin = this.plugins.get(id);
    if (!plugin) {
      throw new ConfigError(`Unknown provider "${id}". Known providers: ${[...this.plugins.keys()].join(", ")}`);
    }
    return plugin;
  }

  list(): AnyProviderPlugin[] {
    return [...this.plugins.values()];
  }
}

function validatePlugin(plugin: AnyProviderPlugin): void {
  const problems: string[] = [];
  if (!plugin || typeof plugin !== "object") throw new ConfigError("Provider plugin must be an object");
  if (typeof plugin.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(plugin.id)) problems.push("id must be lowercase kebab-case");
  if (typeof plugin.create !== "function") problems.push("create(ctx) is required");
  if (!plugin.capabilities || typeof plugin.capabilities !== "object") problems.push("capabilities are required");
  if (!Array.isArray(plugin.credentials)) problems.push("credentials must be an array");
  if (plugin.sourceKind !== "registry" && plugin.sourceKind !== "registrar") problems.push('sourceKind must be "registry" or "registrar"');
  if (problems.length) throw new ConfigError(`Invalid provider plugin "${String(plugin?.id)}"`, problems);
}

export function builtinRegistry(): ProviderRegistry {
  return new ProviderRegistry()
    .register(rdapPlugin)
    .register(porkbunPlugin)
    .register(namecheapPlugin)
    .register(cloudflarePlugin)
    .register(ovhPlugin)
    .register(mockPlugin);
}

/** Load a third-party provider module whose default export is a ProviderPlugin. */
export async function loadPluginModule(specifier: string, baseDir: string): Promise<AnyProviderPlugin> {
  const target = specifier.startsWith(".") || isAbsolute(specifier)
    ? pathToFileURL(resolve(baseDir, specifier)).href
    : specifier;
  let mod: { default?: AnyProviderPlugin };
  try {
    mod = (await import(target)) as { default?: AnyProviderPlugin };
  } catch (err) {
    throw new ConfigError(`Cannot load provider plugin "${specifier}": ${(err as Error).message}`);
  }
  if (!mod.default) throw new ConfigError(`Provider plugin "${specifier}" has no default export`);
  return mod.default;
}
