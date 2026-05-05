import { nanoid } from "nanoid";
import { parseUnifiedDiff, type ChangedFile } from "./diff/index.js";
import { detectEcosystem } from "./ecosystem/index.js";
import { runEslint } from "./runners/eslint.js";
import { runTsc } from "./runners/tsc.js";
import type { ToolFinding } from "./runners/types.js";
import type { Category, Comment, CommentSet, Tier } from "./schema.js";
import { runVulnerabilityCheck } from "./vuln/index.js";

export * from "./schema.js";
export { detectEcosystem, type EcosystemContext, type Lockfile } from "./ecosystem/index.js";
export { parseUnifiedDiff, type ChangedFile } from "./diff/index.js";
export type { ToolFinding } from "./runners/types.js";
export type { AuditAdvisory, AuditSeverity } from "./runners/audit.js";
export { verifyOsv, type OsvRecord, type VerifiedAdvisory } from "./verify/osv.js";

export interface ReviewConfig {
  mode: "check" | "review";
}

export interface ReviewInput {
  diff: string;
  repoRoot: string;
  config: ReviewConfig;
}

export async function review(input: ReviewInput): Promise<CommentSet> {
  const startedAt = Date.now();

  const ecosystem = detectEcosystem(input.repoRoot);
  if (!ecosystem.hasPackageJson) {
    return {
      comments: [],
      metadata: {
        durationMs: Date.now() - startedAt,
        degradedWorkers: ["ecosystem: no package.json at repoRoot — TS/JS only in v0"],
      },
    };
  }

  const changed = input.diff ? parseUnifiedDiff(input.diff) : undefined;
  const changedPaths = changed?.map((c) => c.path);

  const [tscResult, eslintResult, vulnResult] = await Promise.all([
    runTsc(input.repoRoot, ecosystem.tsconfigPaths),
    ecosystem.hasEslint && changedPaths && changedPaths.length > 0
      ? runEslint(input.repoRoot, changedPaths)
      : Promise.resolve({ findings: [], degraded: [] as string[] }),
    ecosystem.lockfile
      ? runVulnerabilityCheck(input.repoRoot, ecosystem.lockfile)
      : Promise.resolve({
          comments: [] as Comment[],
          degraded: ["audit: no lockfile detected (npm/pnpm/yarn) — skipping vulnerability scan"],
        }),
  ]);

  const allFindings = [...tscResult.findings, ...eslintResult.findings];
  // Tool findings are file/line-anchored, so they get diff-scoped. Vulnerability
  // findings live in package.json and surface across the whole tree — a CVE in
  // an existing dep is still a CVE even if this PR didn't touch the lockfile.
  const scoped = changed ? scopeToDiff(allFindings, changed) : allFindings;
  const comments = [...scoped.map(toComment), ...vulnResult.comments];

  return {
    comments,
    metadata: {
      durationMs: Date.now() - startedAt,
      degradedWorkers: [...tscResult.degraded, ...eslintResult.degraded, ...vulnResult.degraded],
    },
  };
}

function scopeToDiff(findings: ToolFinding[], changed: ChangedFile[]): ToolFinding[] {
  const byPath = new Map<string, Set<number>>();
  for (const f of changed) byPath.set(f.path, new Set(f.addedLines));
  return findings.filter((f) => {
    const lines = byPath.get(f.file);
    if (!lines) return false;
    return lines.has(f.line);
  });
}

function toComment(f: ToolFinding): Comment {
  const { tier, category } = mapSeverity(f);
  return {
    id: nanoid(10),
    file: f.file,
    lineStart: f.line,
    lineEnd: f.endLine ?? f.line,
    tier,
    category,
    claim: f.ruleId ? `${f.source} ${f.ruleId}: ${f.message}` : `${f.source}: ${f.message}`,
    explanation: f.message,
    sources: [
      {
        type: "tool",
        id: f.ruleId ?? f.source,
        title: f.source,
        retrievedAt: new Date().toISOString(),
      },
    ],
    confidence: 1,
  };
}

function mapSeverity(f: ToolFinding): { tier: Tier; category: Category } {
  if (f.source === "tsc") {
    return f.severity === "error"
      ? { tier: 1, category: "correctness" }
      : { tier: 2, category: "correctness" };
  }
  return f.severity === "error"
    ? { tier: 2, category: "style" }
    : { tier: 3, category: "style" };
}
