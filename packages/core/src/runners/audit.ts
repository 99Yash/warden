import { z } from "zod";
import type { Lockfile } from "../ecosystem/index.js";
import type { DegradedEntry } from "../schema.js";
import { spawnCapture } from "./_shared.js";

export type AuditSeverity = "info" | "low" | "moderate" | "high" | "critical";

export interface AuditAdvisory {
  /** Package the advisory applies to. */
  packageName: string;
  /** GitHub advisory identifier (`GHSA-xxxx-yyyy-zzzz`). The OSV verifier
   *  treats this as authoritative; advisories without a GHSA are dropped. */
  ghsaId: string;
  severity: AuditSeverity;
  title: string;
  /** Upstream advisory URL (typically `https://github.com/advisories/GHSA-...`). */
  url: string;
  /** SemVer range that's vulnerable, e.g. `<1.2.3`. Optional — not all
   *  registries report it. */
  vulnerableRange?: string;
}

export interface AuditRunResult {
  advisories: AuditAdvisory[];
  degraded: DegradedEntry[];
}

export async function runAudit(repoRoot: string, lockfile: Lockfile): Promise<AuditRunResult> {
  if (lockfile === "yarn") {
    // yarn audit's JSON shape is line-delimited and differs from npm/pnpm; it's
    // not worth supporting in M3. When a real yarn project shows up, lift the
    // parser out separately.
    return {
      advisories: [],
      degraded: [
        {
          kind: "info",
          topic: "audit",
          message: "audit: yarn lockfiles are not supported in v0",
        },
      ],
    };
  }

  const cmd = lockfile === "pnpm" ? "pnpm" : "npm";
  const result = await spawnCapture(cmd, ["audit", "--json"], { cwd: repoRoot });

  if (!result.ok) {
    return {
      advisories: [],
      degraded: [{ kind: "warning", topic: "audit", message: `audit(${cmd}): spawn failed` }],
    };
  }

  // npm/pnpm audit exits non-zero (1) when vulnerabilities are found — that
  // is the success path. We only care about whether the JSON parsed.
  const parsed = parseAuditOutput(result.stdout);
  if (!parsed) {
    const tail = result.stderr.trim().slice(-200);
    return {
      advisories: [],
      degraded: [
        {
          kind: "warning",
          topic: "audit",
          message: `audit(${cmd}): exit ${result.exitCode ?? "?"} — could not parse JSON${tail ? `: ${tail}` : ""}`,
        },
      ],
    };
  }
  return { advisories: parsed, degraded: [] };
}

/** Detects whether output is npm v2 (`vulnerabilities`) or pnpm v1 (`advisories`)
 *  and routes to the matching parser. Returns `undefined` if JSON is malformed. */
function parseAuditOutput(stdout: string): AuditAdvisory[] | undefined {
  const start = stdout.indexOf("{");
  if (start === -1) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(stdout.slice(start));
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== "object") return undefined;
  if ("advisories" in raw && raw.advisories && typeof raw.advisories === "object") {
    return parsePnpmShape(Object.values(raw.advisories));
  }
  if ("vulnerabilities" in raw && raw.vulnerabilities && typeof raw.vulnerabilities === "object") {
    return parseNpmShape(Object.values(raw.vulnerabilities));
  }
  // Empty result — both registries omit the key entirely when nothing matched.
  return [];
}

/** A field of the wrong type reads as absent, the same as a missing field. */
const optionalString = z.string().optional().catch(undefined);

const PnpmAdvisoryEntrySchema = z.object({
  github_advisory_id: optionalString,
  module_name: optionalString,
  severity: optionalString,
  title: optionalString,
  url: optionalString,
  vulnerable_versions: optionalString,
});

function parsePnpmShape(entries: unknown[]): AuditAdvisory[] {
  const out: AuditAdvisory[] = [];
  for (const entry of entries) {
    const parsed = PnpmAdvisoryEntrySchema.safeParse(entry);
    if (!parsed.success) continue;
    const a = parsed.data;
    const ghsaId = a.github_advisory_id ?? extractGhsa(a.url);
    if (!ghsaId || !a.module_name) continue;
    out.push({
      packageName: a.module_name,
      ghsaId,
      severity: normalizeSeverity(a.severity),
      title: a.title ?? a.module_name,
      url: a.url ?? `https://github.com/advisories/${ghsaId}`,
      ...(a.vulnerable_versions !== undefined ? { vulnerableRange: a.vulnerable_versions } : {}),
    });
  }
  return dedupeByGhsa(out);
}

const NpmViaEntrySchema = z.object({
  name: optionalString,
  title: optionalString,
  url: optionalString,
  severity: optionalString,
  range: optionalString,
});

const NpmVulnerabilitySchema = z.object({ via: z.array(z.unknown()) });

function parseNpmShape(entries: unknown[]): AuditAdvisory[] {
  const out: AuditAdvisory[] = [];
  for (const entry of entries) {
    const vulnerability = NpmVulnerabilitySchema.safeParse(entry);
    if (!vulnerability.success) continue;
    for (const v of vulnerability.data.via) {
      // `via` items can be plain strings (transitive references). Skip those —
      // they're not citable advisories on their own; the leaf advisory will be
      // present elsewhere in the same `vulnerabilities` map.
      const parsed = NpmViaEntrySchema.safeParse(v);
      if (!parsed.success) continue;
      const adv = parsed.data;
      const ghsaId = extractGhsa(adv.url);
      if (!ghsaId || !adv.name) continue;
      out.push({
        packageName: adv.name,
        ghsaId,
        severity: normalizeSeverity(adv.severity),
        title: adv.title ?? adv.name,
        url: adv.url ?? `https://github.com/advisories/${ghsaId}`,
        ...(adv.range !== undefined ? { vulnerableRange: adv.range } : {}),
      });
    }
  }
  return dedupeByGhsa(out);
}

const GHSA_RE = /GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/i;

function extractGhsa(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const m = GHSA_RE.exec(url);
  return m ? m[0].toUpperCase() : undefined;
}

function normalizeSeverity(s: string | undefined): AuditSeverity {
  switch (s) {
    case "critical":
    case "high":
    case "moderate":
    case "low":
    case "info":
      return s;
    default:
      return "moderate";
  }
}

function dedupeByGhsa(advisories: AuditAdvisory[]): AuditAdvisory[] {
  const seen = new Map<string, AuditAdvisory>();
  for (const a of advisories) {
    const key = `${a.ghsaId}:${a.packageName}`;
    if (!seen.has(key)) seen.set(key, a);
  }
  return Array.from(seen.values());
}
