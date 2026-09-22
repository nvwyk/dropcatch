import { domainToASCII, domainToUnicode } from "node:url";
import { AppError } from "../core/errors.ts";

export interface NormalizedDomain {
  /** Lowercase ASCII / punycode form used for every provider request. */
  ascii: string;
  /** Unicode form for display. Equal to ascii for non-IDN names. */
  unicode: string;
  /** Last label (e.g. "pl" for "example.com.pl"). */
  tld: string;
  labels: string[];
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

function invalid(input: string, why: string): AppError {
  return new AppError("INVALID_DOMAIN", `Invalid domain "${input}": ${why}`);
}

/**
 * Normalize user input into a registrable domain name.
 * Accepts "EXAMPLE.PL", "https://example.pl/", "example.pl.", "zażółć.pl".
 */
export function normalizeDomain(input: string): NormalizedDomain {
  let host = input.trim();
  if (!host) throw invalid(input, "empty");

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) {
    try {
      host = new URL(host).hostname;
    } catch {
      throw invalid(input, "not a valid URL");
    }
  } else {
    host = host.split(/[/?#]/, 1)[0] ?? "";
    host = host.replace(/:\d+$/, "");
  }

  host = host.replace(/\.+$/, "");
  if (!host) throw invalid(input, "empty host");
  if (/\s/.test(host)) throw invalid(input, "contains whitespace");

  const ascii = domainToASCII(host.toLowerCase());
  if (!ascii) throw invalid(input, "not a valid internationalized domain name");
  if (ascii.length > 253) throw invalid(input, "longer than 253 characters");

  const labels = ascii.split(".");
  if (labels.length < 2) throw invalid(input, "needs at least a name and a TLD");
  for (const label of labels) {
    if (!LABEL.test(label)) throw invalid(input, `bad label "${label}"`);
    if (label.slice(2, 4) === "--" && !label.startsWith("xn--")) {
      throw invalid(input, `label "${label}" uses reserved "--" in positions 3-4`);
    }
  }
  const tld = labels[labels.length - 1]!;
  if (!TLD.test(tld)) throw invalid(input, `bad TLD "${tld}"`);

  return { ascii, unicode: domainToUnicode(ascii) || ascii, tld, labels };
}

export function isValidDomain(input: string): boolean {
  try {
    normalizeDomain(input);
    return true;
  } catch {
    return false;
  }
}

/** Compare two domain inputs after normalization. */
export function sameDomain(a: string, b: string): boolean {
  try {
    return normalizeDomain(a).ascii === normalizeDomain(b).ascii;
  } catch {
    return false;
  }
}

export function displayDomain(d: NormalizedDomain): string {
  return d.unicode === d.ascii ? d.ascii : `${d.unicode} (${d.ascii})`;
}
