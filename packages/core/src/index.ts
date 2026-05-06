import { stableCommentId } from "./comment-id.js";
import { parseUnifiedDiff, type ChangedFile } from "./diff/index.js";
import { detectEcosystem } from "./ecosystem/index.js";
import { formatReview } from "./llm/index.js";
import type { FormatterListener } from "./llm/index.js";
import { runEslint } from "./runners/eslint.js";
import { runTsc } from "./runners/tsc.js";
import type { ToolFinding } from "./runners/types.js";
import type { Category, Comment, CommentSet, RetrievedContext, Tier } from "./schema.js";
import { runVulnerabilityCheck } from "./vuln/index.js";

export * from "./schema.js";
export { detectEcosystem, type EcosystemContext, type Lockfile } from "./ecosystem/index.js";
export { parseUnifiedDiff, type ChangedFile } from "./diff/index.js";
export { resolveDiff, type DiffMode, type ResolveDiffOptions, type ResolvedDiff } from "./diff/source.js";
export type { FormatterEvent, FormatterListener } from "./llm/index.js";
export type { ToolFinding } from "./runners/types.js";
export type { AuditAdvisory, AuditSeverity } from "./runners/audit.js";
export { verifyOsv, type OsvRecord, type VerifiedAdvisory } from "./verify/osv.js";

export interface ReviewConfig {
  mode: "check" | "review";
  /** When `true`, tier-3 (style/dedup) findings are surfaced. Default suppresses them per vision.md §15. */
  verbose?: boolean;
}

export interface ReviewInput {
  diff: string;
  repoRoot: string;
  config: ReviewConfig;
  /**
   * M5+ context-selection output. M4 always passes `{ chunks: [] }` (the
   * default), forward-compat per ADR-0016 / the indexing-design discussion.
   */
  retrievedContext?: RetrievedContext;
  /** Optional listener for streaming events (phase progress, reasoning deltas). */
  emit?: FormatterListener;
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
  const toolComments = scoped.map(toComment);
  const vulnComments = vulnResult.comments;

  const degraded = [
    ...tscResult.degraded,
    ...eslintResult.degraded,
    ...vulnResult.degraded,
  ];

  // Mode branch per ADR-0011 + grilling Q12-D: `check` is deterministic-only;
  // `review` adds the LLM triage + clarification-question pass per Q1 (A+C).
  let comments: Comment[] = [...toolComments, ...vulnComments];
  if (input.config.mode === "review" && comments.length > 0) {
    const formatted = await formatReview({
      diff: input.diff,
      toolComments,
      vulnComments,
      retrievedContext: input.retrievedContext ?? { chunks: [] },
      emit: input.emit,
    });
    comments = formatted.comments;
    degraded.push(...formatted.degraded);
  }

  // Hard rules in code per grilling Q11 (P3): final priority sort + tier-3
  // verbose-gate. Soft rules (judgment-driven suppression) live in the LLM
  // prompt and have already been applied above.
  const finalComments = applyHardRules(comments, input.config);

  return {
    comments: finalComments,
    metadata: {
      durationMs: Date.now() - startedAt,
      degradedWorkers: degraded,
    },
  };
}

const PRIORITY_ORDER: Category[] = [
  "correctness",
  "security",
  "vulnerability",
  "contract",
  "clarity",
  "style",
  "dedup",
  "tests",
];

function applyHardRules(comments: Comment[], config: ReviewConfig): Comment[] {
  // Tier-3 verbose-gate applies only in `review` mode — the LLM has had its
  // triage pass and the user wanted curation. `check` is deterministic-only
  // per ADR-0011: surface every finding the tools produced. (Caught by M4
  // dogfood: previous version filtered tier-3 in both modes.)
  const shouldGateTier3 = config.mode === "review" && config.verbose !== true;
  const filtered = shouldGateTier3 ? comments.filter((c) => c.tier !== 3) : comments;
  return [...filtered].sort((a, b) => {
    const pa = PRIORITY_ORDER.indexOf(a.category);
    const pb = PRIORITY_ORDER.indexOf(b.category);
    if (pa !== pb) return pa - pb;
    if (a.tier !== b.tier) return a.tier - b.tier;
    return b.confidence - a.confidence;
  });
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
    id: stableCommentId(`tool:${f.source}:${f.file}:${f.line}:${f.ruleId ?? ""}:${f.message}`),
    file: f.file,
    lineStart: f.line,
    lineEnd: f.endLine ?? f.line,
    tier,
    category,
    kind: "assertion",
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
