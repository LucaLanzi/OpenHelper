/**
 * Secrets are removed before anything is indexed or shown to a model.
 * Files that usually hold secrets are skipped entirely.
 */

export const SECRET_FILE_PATTERNS: RegExp[] = [
  /(^|\/)\.env(\..*)?$/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.pypirc$/,
  /(^|\/)\.netrc$/,
  /(^|\/)id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /(^|\/)credentials(\.json)?$/i,
  /(^|\/)secrets?(\.[a-z]+)?$/i,
  /(^|\/)\.git-credentials$/,
];

const RULES: { name: string; re: RegExp }[] = [
  { name: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: "aws-access-key", re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "github-token", re: /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/g },
  { name: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: "openai-style-key", re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  {
    name: "assigned-secret",
    re: /\b((?:api[_-]?key|secret|token|passw(?:or)?d|auth)[A-Za-z0-9_]*)\s*[:=]\s*(["'])([^"'\s]{8,})\2/gi,
  },
];

export function isSecretFile(relPath: string): boolean {
  return SECRET_FILE_PATTERNS.some((re) => re.test(relPath));
}

export interface ScrubResult {
  text: string;
  redactions: number;
}

export function scrub(text: string): ScrubResult {
  let redactions = 0;
  let out = text;
  for (const r of RULES) {
    out = out.replace(r.re, (...args: unknown[]) => {
      redactions++;
      if (r.name === "assigned-secret") {
        const [, key, quote] = args as [string, string, string];
        return `${key} = ${quote}[REDACTED]${quote}`;
      }
      return `[REDACTED:${r.name}]`;
    });
  }
  return { text: out, redactions };
}
