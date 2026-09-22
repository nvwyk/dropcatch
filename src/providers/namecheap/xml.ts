/**
 * Minimal reader for Namecheap's attribute-based XML responses. It never resolves
 * entities beyond the five predefined ones and ignores DTDs, so there is no XXE surface.
 */

export interface XmlElement {
  attrs: Record<string, string>;
  text: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, e: string) => {
    if (e[0] === "#") {
      const code = e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    }
    return ENTITIES[e.toLowerCase()] ?? "";
  });
}

export function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of source.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) attrs[m[1]!] = decodeEntities(m[2]!);
  return attrs;
}

export function elements(xml: string, tag: string): XmlElement[] {
  const re = new RegExp(`<${tag}\\b([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/${tag}>)`, "g");
  return [...xml.matchAll(re)].map((m) => ({ attrs: parseAttrs(m[1] ?? ""), text: decodeEntities((m[2] ?? "").trim()) }));
}

export function apiStatus(xml: string): "OK" | "ERROR" | undefined {
  const root = elements(xml, "ApiResponse")[0];
  const status = root?.attrs.Status?.toUpperCase();
  return status === "OK" || status === "ERROR" ? status : undefined;
}

export function apiErrors(xml: string): Array<{ number: string; message: string }> {
  return elements(xml, "Error").map((e) => ({ number: e.attrs.Number ?? "", message: e.text }));
}
