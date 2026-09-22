/**
 * Refuse to load configuration files that contain secrets. Credentials belong in the
 * environment (or a secret store); config files end up in git, backups and screenshots.
 */

interface Rule {
  name: string;
  pattern: RegExp;
}

const RULES: Rule[] = [
  { name: "Discord webhook URL", pattern: /discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]{20,}/i },
  { name: "Porkbun API key", pattern: /\b(?:pk1|sk1)_[a-z0-9_]{20,}/i },
  { name: "bearer token", pattern: /\bbearer\s+[A-Za-z0-9._~+/-]{20,}/i },
  { name: "credentials embedded in a URL", pattern: /[a-z][a-z0-9+.-]*:\/\/[^\s/:@'"]+:[^\s/@'"]+@/i },
  { name: "private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "Telegram bot token", pattern: /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/ },
  { name: "Cloudflare API token", pattern: /\b(?:apiToken|api_token)\s*[:=]\s*["']?[A-Za-z0-9_-]{35,}/ },
];

export interface SecretFinding {
  line: number;
  rule: string;
}

export function scanForSecrets(text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    for (const rule of RULES) {
      if (rule.pattern.test(line)) findings.push({ line: index + 1, rule: rule.name });
    }
  });
  return findings;
}
