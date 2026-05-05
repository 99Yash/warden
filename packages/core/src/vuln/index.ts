import { readFileSync } from "node:fs";
import { join } from "node:path";
import { nanoid } from "nanoid";
import type { Lockfile } from "../ecosystem/index.js";
import { runAudit, type AuditAdvisory, type AuditSeverity } from "../runners/audit.js";
import type { Comment, Source, Tier } from "../schema.js";
import { verifyOsv, type VerifiedAdvisory } from "../verify/osv.js";

export interface VulnerabilityResult {
  comments: Comment[];
  degraded: string[];
}

/**
 * The deterministic vulnerability phase — the one that earns Warden the right
 * to claim "no hallucinated CVEs" (ADR-0008, `vision.md` §10).
 *
 * 1. Run `npm audit` / `pnpm audit` to get the registry's view of the lockfile.
 * 2. For every reported advisory, verify the GHSA exists on OSV.dev. Anything
 *    OSV doesn't recognize is dropped — the advisory might still be real, but
 *    we won't surface a claim we can't cite.
 * 3. Map verified advisories into `Comment` objects anchored to the package.json
 *    line where the dep is declared (or line 1 for transitives).
 *
 * Failures (no lockfile, audit spawn error, OSV down) become `degraded`
 * messages instead of throwing — the rest of the review still proceeds.
 */
export async function runVulnerabilityCheck(
  repoRoot: string,
  lockfile: Lockfile,
): Promise<VulnerabilityResult> {
  const audit = await runAudit(repoRoot, lockfile);
  if (audit.advisories.length === 0) {
    return { comments: [], degraded: audit.degraded };
  }

  const verified = await Promise.all(audit.advisories.map((a) => verifyOsv(a.ghsaId)));
  const pairs: { advisory: AuditAdvisory; verified: VerifiedAdvisory }[] = [];
  let droppedUnverified = 0;
  for (let i = 0; i < audit.advisories.length; i++) {
    const advisory = audit.advisories[i];
    const v = verified[i];
    if (!advisory) continue;
    if (!v) {
      droppedUnverified++;
      continue;
    }
    pairs.push({ advisory, verified: v });
  }

  const pkgLines = readPackageJsonLines(repoRoot);
  const comments = pairs.map(({ advisory, verified }) =>
    toComment(advisory, verified, pkgLines),
  );

  const degraded = [...audit.degraded];
  if (droppedUnverified > 0) {
    degraded.push(
      `osv: dropped ${droppedUnverified} unverified ${droppedUnverified === 1 ? "advisory" : "advisories"} (citation discipline)`,
    );
  }

  return { comments, degraded };
}

function toComment(
  advisory: AuditAdvisory,
  verified: VerifiedAdvisory,
  pkgLines: PkgLineIndex | undefined,
): Comment {
  const line = pkgLines?.find(advisory.packageName) ?? 1;
  const sources: Source[] = [
    {
      type: "advisory",
      url: `https://osv.dev/vulnerability/${verified.ghsaId}`,
      id: verified.ghsaId,
      title: verified.record.summary ?? advisory.title,
      retrievedAt: verified.retrievedAt,
    },
  ];

  // Surface CVE aliases as additional citations so reviewers can cross-reference.
  for (const alias of verified.record.aliases ?? []) {
    if (alias.startsWith("CVE-")) {
      sources.push({
        type: "cve",
        url: `https://nvd.nist.gov/vuln/detail/${alias}`,
        id: alias,
        retrievedAt: verified.retrievedAt,
      });
    }
  }

  const explanation = verified.record.summary ?? verified.record.details?.slice(0, 400) ?? advisory.title;

  return {
    id: nanoid(10),
    file: pkgLines?.relativePath ?? "package.json",
    lineStart: line,
    lineEnd: line,
    tier: severityToTier(advisory.severity),
    category: "vulnerability",
    claim: `${advisory.packageName}: ${advisory.title}`,
    explanation,
    sources,
    confidence: 1,
  };
}

function severityToTier(severity: AuditSeverity): Tier {
  if (severity === "critical" || severity === "high") return 1;
  if (severity === "moderate") return 2;
  return 3;
}

interface PkgLineIndex {
  relativePath: string;
  find(packageName: string): number | undefined;
}

function readPackageJsonLines(repoRoot: string): PkgLineIndex | undefined {
  const path = join(repoRoot, "package.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const lines = raw.split("\n");
  // Map first occurrence of `"<package>"` (in dependency-style position) to its
  // 1-indexed line. Naive but good enough — root package.json rarely has the
  // package name appearing in any other context. Transitive deps fall back to
  // line 1, which is fine for v0.
  const cache = new Map<string, number>();
  return {
    relativePath: "package.json",
    find(packageName: string): number | undefined {
      const cached = cache.get(packageName);
      if (cached !== undefined) return cached;
      const needle = `"${packageName}"`;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]?.includes(needle)) {
          const lineNo = i + 1;
          cache.set(packageName, lineNo);
          return lineNo;
        }
      }
      return undefined;
    },
  };
}
