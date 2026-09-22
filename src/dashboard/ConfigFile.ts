import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isMap, isSeq, parseDocument, type Document } from "yaml";
import { parseConfigText, resolveConfig } from "../config/loader.ts";
import { ConfigError } from "../core/errors.ts";
import { builtinRegistry, loadPluginModule } from "../providers/ProviderRegistry.ts";

export interface ValidationReport {
  ok: boolean;
  issues: string[];
  warnings: string[];
}

function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined || v === null || v === "") continue;
      out[k] = strip(v);
    }
    return out;
  }
  return value;
}

/**
 * Config file editing for the dashboard. Edits go through the YAML Document API so comments
 * survive, every write is validated with the same loader as the CLI, and the previous file is
 * kept as config.yaml.bak.
 */
export class ConfigFile {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  exists(): boolean {
    return existsSync(this.path);
  }

  read(): string {
    return this.exists() ? readFileSync(this.path, "utf8") : "";
  }

  /** Plain JS view of the raw (unresolved) config, for prefilling forms. */
  raw(text = this.read()): Record<string, unknown> {
    try {
      const js = parseDocument(text).toJS() as unknown;
      return js && typeof js === "object" ? (js as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  async validate(text: string): Promise<ValidationReport> {
    try {
      const parsed = parseConfigText(text, "config");
      const registry = builtinRegistry();
      for (const plugin of parsed.plugins) {
        const loaded = await loadPluginModule(plugin, dirname(this.path));
        if (!registry.get(loaded.id)) registry.register(loaded);
      }
      const resolved = resolveConfig(parsed, { registry, baseDir: dirname(this.path), path: this.path });
      return { ok: true, issues: [], warnings: resolved.warnings };
    } catch (err) {
      if (err instanceof ConfigError) return { ok: false, issues: err.issues.length ? err.issues : [err.message], warnings: [] };
      return { ok: false, issues: [(err as Error).message], warnings: [] };
    }
  }

  /** Validate, back up, then atomically replace the file. Plugin changes are filesystem-only. */
  async save(text: string): Promise<ValidationReport> {
    const before = this.raw();
    const after = this.raw(text);
    if (JSON.stringify(before.plugins ?? []) !== JSON.stringify(after.plugins ?? [])) {
      throw new ConfigError("The plugins list loads code, so it can only be changed by editing the file on the server.");
    }
    const report = await this.validate(text);
    if (!report.ok) throw new ConfigError("Configuration is invalid", report.issues);
    mkdirSync(dirname(this.path), { recursive: true });
    if (this.exists()) copyFileSync(this.path, `${this.path}.bak`);
    const tmp = `${this.path}.tmp-${process.pid}`;
    writeFileSync(tmp, text.endsWith("\n") ? text : `${text}\n`, { mode: 0o600 });
    renameSync(tmp, this.path);
    return report;
  }

  private document(): Document {
    const doc = parseDocument(this.read() || "{}\n");
    if (doc.errors.length) throw new ConfigError("The current config file has YAML errors; fix it in the raw editor first", doc.errors.map((e) => e.message));
    if (!isMap(doc.contents)) doc.contents = doc.createNode({}) as never;
    return doc;
  }

  private upsertInSeq(key: string, matchId: string, value: Record<string, unknown>): string {
    const doc = this.document();
    let seq = doc.get(key, true);
    if (!isSeq(seq)) {
      doc.set(key, doc.createNode([]));
      seq = doc.get(key, true);
    }
    const items = (seq as { items: unknown[] }).items;
    const index = items.findIndex((item) => isMap(item) && item.get("id") === matchId);
    const node = doc.createNode(strip(value));
    if (index >= 0) items[index] = node;
    else items.push(node);
    return doc.toString({ lineWidth: 0 });
  }

  upsertTarget(id: string, target: Record<string, unknown>): string {
    return this.upsertInSeq("targets", id, target);
  }

  removeTarget(id: string): string {
    const doc = this.document();
    const seq = doc.get("targets", true);
    if (isSeq(seq)) seq.items = seq.items.filter((item) => !(isMap(item) && item.get("id") === id));
    return doc.toString({ lineWidth: 0 });
  }

  /** Apply several edits to one document and return the new text (not saved yet). */
  edit(fn: (doc: Document) => void): string {
    const doc = this.document();
    fn(doc);
    return doc.toString({ lineWidth: 0 });
  }

  setIn(path: string[], value: unknown): string {
    const doc = this.document();
    if (value === undefined) doc.deleteIn(path);
    else doc.setIn(path, doc.createNode(strip(value)));
    return doc.toString({ lineWidth: 0 });
  }

  /** Merge a partial object into a map at `path` (undefined values are left alone, null deletes). */
  merge(path: string[], patch: Record<string, unknown>): string {
    const doc = this.document();
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if (value === null) doc.deleteIn([...path, key]);
      else doc.setIn([...path, key], doc.createNode(value));
    }
    return doc.toString({ lineWidth: 0 });
  }
}
