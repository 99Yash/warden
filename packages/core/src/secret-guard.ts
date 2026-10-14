/**
 * ADR-0054 §3: the publication-side secret guard. Pure and deterministic —
 * no I/O, no LLM. The post-pass drops a lane finding that this guard
 * matches; the OpenCode driver applies the same check before it writes
 * `--lanes-out`. A match reports the rule id only, never the value.
 *
 * Two rule families:
 *  - secret-file citation: a `file` or `path` string names a secret file
 *    (a broader policy than the lane's read deny list);
 *  - known credential formats: fixed shapes with a known prefix. No
 *    entropy rule in v0 — code quotes hashes and ids that look random.
 */

/**
 * The lane `read` guard globs, in OpenCode wildcard syntax (`*` matches
 * any run of characters, `/` included; anchored). The materializer emits
 * the deny rules in this order, then the template allow rules and Git
 * metadata denies. Publication uses a separate, broader policy.
 */
export const READ_SECRET_FILE_GLOBS = {
  deny: [
    "*.env",
    "*.env.*",
    ".npmrc",
    "*/.npmrc",
    ".netrc",
    "*/.netrc",
    ".dev.vars",
    "*/.dev.vars",
    ".dev.vars.*",
    "*/.dev.vars.*",
    ".envrc",
    "*/.envrc",
    "id_rsa",
    "*/id_rsa",
    "id_ed25519",
    "*/id_ed25519",
    "id_dsa",
    "*/id_dsa",
    "id_ecdsa",
    "*/id_ecdsa",
    "*.pem",
    "*.key",
    "*.p12",
    "*.pfx",
    ".aws/credentials",
    "*/.aws/credentials",
  ],
  allow: ["*.env.example", "*.env.sample", "*.env.*.example", "*.env.*.sample"],
} as const;

/** Publication may drop more findings than read permissions block files. */
const PUBLICATION_ONLY_GLOBS = ["*.credentials.json", ".ssh/*", "*/.ssh/*"] as const;
export const SECRET_FILE_GLOBS = {
  deny: [...READ_SECRET_FILE_GLOBS.deny, ...PUBLICATION_ONLY_GLOBS],
  allow: [...READ_SECRET_FILE_GLOBS.allow],
} as const;

/** Denied after env-example allows: Git metadata can contain checkout credentials. */
export const GIT_METADATA_GLOBS = [".git/*", "*/.git/*"] as const;

export const SECRET_FILE_RULE_ID = "secret-file-citation";

export interface CredentialRule {
  id: string;
  pattern: RegExp;
}

export const CREDENTIAL_RULES: readonly CredentialRule[] = [
  { id: "pem-private-key", pattern: /-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----/i },
  { id: "aws-access-key-id", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: "github-token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/ },
  { id: "anthropic-api-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  {
    id: "openai-api-key",
    pattern:
      /\bsk-(?:(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}|[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20})/,
  },
  { id: "slack-token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { id: "slack-app-token", pattern: /\bxapp-\d-[A-Za-z0-9]+-\d+-[A-Za-z0-9]+/i },
  {
    id: "slack-webhook",
    pattern: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9]+\/[A-Za-z0-9]+\/[A-Za-z0-9]+/i,
  },
  { id: "gitlab-token", pattern: /\bglpat-[A-Za-z0-9_-]{20,}/ },
  { id: "huggingface-token", pattern: /\bhf_[A-Za-z0-9]{20,}/ },
  { id: "stripe-webhook-secret", pattern: /\bwhsec_[A-Za-z0-9]{20,}/ },
  { id: "url-credentials", pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i },
  {
    id: "basic-authorization",
    pattern: /\bauthorization["']?\s*:\s*["']?basic\s+[A-Za-z0-9+/]{2,}={0,2}/i,
  },
  {
    id: "cloudflare-api-token",
    pattern:
      /(?:\b(?:CF_AIG_TOKEN|CLOUDFLARE_API_TOKEN)["']?\s*[:=]\s*["']?|\bcf-aig-authorization["']?\s*:\s*["']?(?:Bearer\s+)?)[A-Za-z0-9_-]{20,}/i,
  },
  { id: "stripe-live-key", pattern: /\b[rs]k_live_[A-Za-z0-9]{16,}/ },
  { id: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}/ },
  { id: "npm-token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { id: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
];

/** Keys whose string value is a repo path, checked against the secret-file globs. */
const PATH_KEYS = new Set(["file", "path"]);

export interface SecretMatch {
  rule: string;
}

/** OpenCode `Wildcard.match`: `*` → `.*`, `?` → `.`, anchored, no alternation. */
function globToRegExp(glob: string): RegExp {
  const body = glob
    .split("")
    .map((ch) => {
      if (ch === "*") return ".*";
      if (ch === "?") return ".";
      return ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  return new RegExp(`^${body}$`);
}

const SECRET_FILE_RULES = [
  ...SECRET_FILE_GLOBS.deny.map((glob) => ({ re: globToRegExp(glob), deny: true })),
  ...SECRET_FILE_GLOBS.allow.map((glob) => ({ re: globToRegExp(glob), deny: false })),
  // Template exceptions apply to env files, not private credential directories.
  ...PUBLICATION_ONLY_GLOBS.map((glob) => ({ re: globToRegExp(glob), deny: true })),
  ...GIT_METADATA_GLOBS.map((glob) => ({ re: globToRegExp(glob), deny: true })),
];

/**
 * True iff the publication guard denies this path (last match wins).
 * Case-insensitive, unlike the host's matcher: `.ENV` on a
 * case-insensitive filesystem is the same file, and a broader match here
 * only drops more findings.
 */
export function isSecretFilePath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  let denied = false;
  for (const rule of SECRET_FILE_RULES) {
    if (rule.re.test(normalized)) denied = rule.deny;
  }
  return denied;
}

/** The first credential rule that matches `text`, else undefined. */
export function matchCredential(text: string): string | undefined {
  return CREDENTIAL_RULES.find((rule) => rule.pattern.test(text))?.id;
}

/**
 * Screens one finding — a validated `Comment` or a raw lane object — by
 * walking every string value. A `file`/`path` value is also checked as a
 * secret-file path. Returns the first match, else undefined.
 */
export function screenFinding(value: unknown): SecretMatch | undefined {
  return walk(value, undefined);
}

function walk(value: unknown, key: string | undefined): SecretMatch | undefined {
  if (typeof value === "string") {
    if (key !== undefined && PATH_KEYS.has(key) && isSecretFilePath(value)) {
      return { rule: SECRET_FILE_RULE_ID };
    }
    const rule = matchCredential(value);
    return rule !== undefined ? { rule } : undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const match = walk(item, undefined);
      if (match !== undefined) return match;
    }
    return undefined;
  }
  if (value !== null && typeof value === "object") {
    for (const [childKey, child] of Object.entries(value)) {
      const match = walk(child, childKey);
      if (match !== undefined) return match;
    }
  }
  return undefined;
}
