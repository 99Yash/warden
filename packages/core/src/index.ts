import { CURRENT_DEFAULT, getEmbeddingProvider } from "@warden/ai";
import {
  bannerStateToDegraded,
  computeBannerState,
  type BannerState,
} from "./banner/index.js";
import { stableCommentId } from "./comment-id.js";
import {
  CheapSignalsSelector,
  candidatesToRetrievedContext,
  type ContextSelector,
  type SelectorOutput,
} from "./context/index.js";
import { parseUnifiedDiff, type ChangedFile } from "./diff/index.js";
import { detectEcosystem } from "./ecosystem/index.js";
import { ensureGitignore } from "./init/ensure-gitignore.js";
import { walkRepo } from "./init/walk.js";
import {
  SqliteChunkStore,
  SqliteEmbeddingStore,
  readLockedModel,
} from "./indexing/index.js";
import { formatReview } from "./llm/index.js";
import type { FormatterListener } from "./llm/index.js";
import { runDeadcode } from "./runners/deadcode.js";
import { runEslint } from "./runners/eslint.js";
import { runJscpd } from "./runners/jscpd.js";
import { runScalability } from "./runners/scalability.js";
import { runTsc } from "./runners/tsc.js";
import type { ToolFinding } from "./runners/types.js";
import type {
  Category,
  Comment,
  CommentSet,
  DegradedEntry,
  RetrievedContext,
  Tier,
} from "./schema.js";
import { runVulnerabilityCheck } from "./vuln/index.js";

export * from "./schema.js";
export { detectEcosystem, type EcosystemContext, type Lockfile } from "./ecosystem/index.js";
export { parseUnifiedDiff, type ChangedFile } from "./diff/index.js";
export { resolveDiff, type DiffMode, type ResolveDiffOptions, type ResolvedDiff } from "./diff/source.js";
export type { FormatterEvent, FormatterListener } from "./llm/index.js";
export type { ToolFinding } from "./runners/types.js";
export type { AuditAdvisory, AuditSeverity } from "./runners/audit.js";
export { verifyOsv, type OsvRecord, type VerifiedAdvisory } from "./verify/osv.js";
export {
  CheapSignalsSelector,
  CodeChunkAdapter,
  TsCompilerParser,
  candidatesToRetrievedContext,
  type ChunkRecord,
  type Chunker,
  type ContextCandidate,
  type ContextSelector,
  type Reason,
  type SelectorOutput,
} from "./context/index.js";
export {
  bannerStateToDegraded,
  computeBannerState,
  computeSoftNotice,
  type BannerState,
  type SoftNotice,
} from "./banner/index.js";
export { ensureGitignore } from "./init/ensure-gitignore.js";
export {
  estimateInit,
  ESTIMATE_CONSTANTS,
  runInit,
  walkRepo,
  type InitEvent,
  type InitListener,
  type InitOptions,
  type InitSummary,
} from "./init/index.js";
export {
  CURRENT_FORMAT_VERSION,
  META_KEYS,
  SqliteChunkStore,
  SqliteEmbeddingStore,
  SqliteIndexExporter,
  SqliteIndexImporter,
  SqliteMerkleStore,
  SyncJobRunner,
  readLockedModel,
  readRepoMerkleRoot,
  taskIdFor,
  writeLockedModel,
  writeRepoMerkleRoot,
  type ChunkStore,
  type EmbeddingRecord,
  type EmbeddingStore,
  type ExportCounts,
  type IndexExporter,
  type IndexImporter,
  type JobRunner,
  type LockedModel,
  type MerkleNode,
  type MerkleStore,
  type Task,
} from "./indexing/index.js";

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
   * Override the M5 cheap-signals selector. Default constructs a
   * `CheapSignalsSelector` with the host repo's tsconfig. Pass `null` to
   * skip context selection entirely (e.g. test harnesses).
   */
  selector?: ContextSelector | null;
  /**
   * Pre-computed context (e.g. injected by tests). When provided the selector
   * is skipped and this value flows directly to the LLM formatter.
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
        degradedWorkers: [
          {
            kind: "info",
            topic: "ecosystem",
            message: "ecosystem: no package.json at repoRoot — TS/JS only in v0",
          },
        ],
      },
    };
  }

  // ADR-0019 #12: ensure `.warden/` lives in `.gitignore` before any cache
  // write — first verb a user runs in a fresh repo gets the entry.
  const gitignoreDegraded: DegradedEntry[] = [];
  try {
    const gitignore = await ensureGitignore(input.repoRoot);
    if (gitignore.added)
      gitignoreDegraded.push({
        kind: "info",
        topic: "gitignore",
        message: "gitignore: added .warden/ entry",
      });
  } catch (err) {
    gitignoreDegraded.push({
      kind: "warning",
      topic: "gitignore",
      message: `gitignore: failed to ensure entry (${formatErr(err)})`,
    });
  }

  const changed = input.diff ? parseUnifiedDiff(input.diff) : undefined;
  const changedPaths = changed?.map((c) => c.path);

  // M6 (ADR-0019 #7): banner state is computed *before* the selector runs,
  // off the index's current state. `check` skips it — deterministic-only verb.
  // Walk the repo to feed `currentHashes` so the `stale` banner can fire when
  // the working tree has drifted from the merkle snapshot. Sharing this walk
  // with the selector's own incremental hash pass is a M7+ optimization.
  let bannerState: BannerState = { kind: "no-banner" };
  if (input.config.mode === "review") {
    try {
      const walk = await walkRepo(input.repoRoot);
      const currentHashes = new Map<string, string>();
      for (const f of walk.files.values()) currentHashes.set(f.path, f.fileSha);
      bannerState = await computeBannerState({
        repoRoot: input.repoRoot,
        currentDefault: CURRENT_DEFAULT,
        currentHashes,
      });
    } catch (err) {
      bannerState = { kind: "no-banner" };
      gitignoreDegraded.push({
        kind: "warning",
        topic: "banner",
        message: `banner: state lookup failed (${formatErr(err)})`,
      });
    }
  }

  // M5 (ADR-0018): selector runs parallel with TSC/ESLint/vuln. `check` mode
  // skips it — `check` is deterministic-only and never invokes the LLM, so
  // there's no consumer that would benefit from selector output.
  const shouldRunSelector =
    input.config.mode === "review" &&
    input.selector !== null &&
    !input.retrievedContext &&
    changed !== undefined &&
    changed.length > 0;

  // Wire the M6 semantic signal in when the index is ready. Banner state
  // already told us if it isn't (no-index / model-deprecated trigger
  // degradedWorkers and the selector falls back to cheap signals only).
  let semanticDeps:
    | {
        embeddingProvider: ReturnType<typeof getEmbeddingProvider>;
        embeddingStore: SqliteEmbeddingStore;
        chunkStore: SqliteChunkStore;
        lockedModelId: string;
        lockedModelVersionForDocument: string;
      }
    | undefined;
  if (shouldRunSelector && bannerState.kind !== "no-index") {
    try {
      const locked = await readLockedModel();
      if (locked) {
        semanticDeps = {
          embeddingProvider: getEmbeddingProvider(),
          embeddingStore: new SqliteEmbeddingStore(),
          chunkStore: new SqliteChunkStore(),
          lockedModelId: locked.modelId,
          lockedModelVersionForDocument: locked.modelVersion,
        };
      }
    } catch (err) {
      gitignoreDegraded.push({
        kind: "warning",
        topic: "context",
        message: `context: semantic signal disabled (${formatErr(err)}) — falling back to cheap signals`,
      });
    }
  }

  const selector =
    shouldRunSelector && input.selector !== undefined
      ? input.selector
      : shouldRunSelector
      ? new CheapSignalsSelector({
          tsconfigPath: ecosystem.tsconfigPaths[0],
          embeddingProvider: semanticDeps?.embeddingProvider ?? null,
          embeddingStore: semanticDeps?.embeddingStore ?? null,
          chunkStore: semanticDeps?.chunkStore ?? null,
          lockedModelId: semanticDeps?.lockedModelId,
          lockedModelVersionForDocument: semanticDeps?.lockedModelVersionForDocument,
        })
      : null;

  const emptySelectorResult: SelectorOutput = { candidates: [], degraded: [] };

  const [
    tscResult,
    eslintResult,
    vulnResult,
    selectorResult,
    scalabilityResult,
    deadcodeResult,
  ] = await Promise.all([
      runTsc(input.repoRoot, ecosystem.tsconfigPaths),
      ecosystem.hasEslint && changedPaths && changedPaths.length > 0
        ? runEslint(input.repoRoot, changedPaths)
        : Promise.resolve({ findings: [], degraded: [] as DegradedEntry[] }),
      ecosystem.lockfile
        ? runVulnerabilityCheck(input.repoRoot, ecosystem.lockfile)
        : Promise.resolve({
            comments: [] as Comment[],
            degraded: [
              {
                kind: "info",
                topic: "audit",
                message:
                  "audit: no lockfile detected (npm/pnpm/yarn) — skipping vulnerability scan",
              },
            ] as DegradedEntry[],
          }),
      selector
        ? selector
            .select({
              repoRoot: input.repoRoot,
              changed: changed ?? [],
              ecosystem,
              diff: input.diff,
            })
            .catch((err: unknown) => ({
              candidates: [],
              degraded: [
                {
                  kind: "warning",
                  topic: "context",
                  message: `context: selector failed (${formatErr(err)})`,
                },
              ],
            }) satisfies SelectorOutput)
        : Promise.resolve(emptySelectorResult),
      // ADR-0021 #1: scalability detector — direct findings from AST patterns
      // touching diff-added lines. Skipped when there's nothing to inspect.
      changed && changed.length > 0
        ? runScalability({ repoRoot: input.repoRoot, changed }).catch((err: unknown) => ({
            findings: [] as ToolFinding[],
            degraded: [
              {
                kind: "warning",
                topic: "scalability",
                message: `scalability: detector failed (${formatErr(err)})`,
              },
            ] as DegradedEntry[],
          }))
        : Promise.resolve({ findings: [] as ToolFinding[], degraded: [] as DegradedEntry[] }),
      // ADR-0021 #1: deadcode detector — diff-touched exported fns + 1-hop
      // reverse `import_graph` for caller arity inspection.
      changed && changed.length > 0
        ? runDeadcode({ repoRoot: input.repoRoot, changed }).catch((err: unknown) => ({
            findings: [] as ToolFinding[],
            degraded: [
              {
                kind: "warning",
                topic: "deadcode",
                message: `deadcode: detector failed (${formatErr(err)})`,
              },
            ] as DegradedEntry[],
          }))
        : Promise.resolve({ findings: [] as ToolFinding[], degraded: [] as DegradedEntry[] }),
    ]);

  // jscpd runs sequentially after the selector — it consumes the candidate
  // path set per ADR-0018. Skipped when there's nothing scoped to look at.
  const candidatePaths = selectorResult.candidates.map((c) => c.path);
  const scopedForJscpd = uniqStrings([...(changedPaths ?? []), ...candidatePaths]);
  const jscpdResult =
    scopedForJscpd.length > 0
      ? await runJscpd(
          input.repoRoot,
          scopedForJscpd,
          new Set(changedPaths ?? []),
        )
      : { findings: [] as ToolFinding[], degraded: [] as DegradedEntry[] };

  const allFindings = [
    ...tscResult.findings,
    ...eslintResult.findings,
    ...jscpdResult.findings,
    ...scalabilityResult.findings,
    ...deadcodeResult.findings,
  ];
  // Tool findings are file/line-anchored, so they get diff-scoped. Vulnerability
  // findings live in package.json and surface across the whole tree — a CVE in
  // an existing dep is still a CVE even if this PR didn't touch the lockfile.
  const scoped = changed ? scopeToDiff(allFindings, changed) : allFindings;
  const toolComments = scoped.map(toComment);
  // ADR-0021 #8: when the diff doesn't touch a manifest / lockfile, collapse
  // npm-audit findings into a single summary comment. The full per-advisory
  // list is still surfaced in `--verbose` mode and whenever the user is
  // actually editing dependency wiring (manifest-touched). Verifier discipline
  // (OSV citation, ADR-0008) is unchanged — this only changes aggregation.
  const manifestTouched = (changedPaths ?? []).some(isManifestPath);
  const verboseMode = input.config.verbose === true;
  const vulnComments =
    manifestTouched || verboseMode
      ? vulnResult.comments
      : collapseVulnComments(vulnResult.comments);

  const degraded: DegradedEntry[] = [
    ...gitignoreDegraded,
    ...bannerStateToDegraded(bannerState),
    ...tscResult.degraded,
    ...eslintResult.degraded,
    ...vulnResult.degraded,
    ...jscpdResult.degraded,
    ...selectorResult.degraded,
    ...scalabilityResult.degraded,
    ...deadcodeResult.degraded,
  ];

  // Mode branch per ADR-0011 + grilling Q12-D: `check` is deterministic-only;
  // `review` adds the LLM triage + clarification-question pass per Q1 (A+C).
  let comments: Comment[] = [...toolComments, ...vulnComments];
  if (input.config.mode === "review" && comments.length > 0) {
    let ctxFromSelector: RetrievedContext = { chunks: [], sameFolderPaths: [] };
    if (input.retrievedContext) {
      ctxFromSelector = input.retrievedContext;
    } else if (selectorResult.candidates.length > 0) {
      try {
        ctxFromSelector = await candidatesToRetrievedContext(
          selectorResult.candidates,
          input.repoRoot,
        );
      } catch (err) {
        // Mirrors the selector's own `.catch()` — prompt-assembly failures
        // (e.g. a candidate file disappearing between selection and read)
        // shouldn't abort the LLM pass; degrade to diff-only context.
        degraded.push({
          kind: "warning",
          topic: "context",
          message: `context: prompt-assembly failed (${formatErr(err)})`,
        });
      }
    }
    const formatted = await formatReview({
      diff: input.diff,
      toolComments,
      vulnComments,
      retrievedContext: ctxFromSelector,
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
  "scalability",
  "consistency",
  "deadcode",
  "committability",
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
    // Range-overlap, not point-match: detectors like scalability/deadcode
    // anchor `line` to a construct's start (function signature, first
    // statement) and only fire when an added line is somewhere inside
    // `[line, endLine]`. A point-match here would drop those findings when
    // the diff touched a middle/late line of the construct.
    const end = f.endLine ?? f.line;
    for (let l = f.line; l <= end; l++) {
      if (lines.has(l)) return true;
    }
    return false;
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
  if (f.source === "jscpd") {
    return { tier: 3, category: "dedup" };
  }
  // ADR-0021 #1: M7 detector outputs. Each maps to its named category at
  // tier 2 — assertions with grounded citations from AST evidence.
  if (f.source === "scalability") {
    return { tier: 2, category: "scalability" };
  }
  if (f.source === "deadcode") {
    return { tier: 2, category: "deadcode" };
  }
  if (f.source === "consistency") {
    return { tier: 2, category: "consistency" };
  }
  return f.severity === "error"
    ? { tier: 2, category: "style" }
    : { tier: 3, category: "style" };
}

function uniqStrings(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

const MANIFEST_BASENAMES: ReadonlySet<string> = new Set([
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);

function isManifestPath(path: string): boolean {
  const segments = path.split("/");
  const base = segments[segments.length - 1];
  return base !== undefined && MANIFEST_BASENAMES.has(base);
}

/**
 * Collapse per-advisory vuln comments to a single summary line per ADR-0021
 * #8. `package.json:1` is the canonical anchor — every per-advisory comment
 * already pinned there. Returns `[]` when the input is empty.
 */
function collapseVulnComments(comments: Comment[]): Comment[] {
  if (comments.length === 0) return [];
  const total = comments.length;
  const file = comments[0]?.file ?? "package.json";
  const summary: Comment = {
    id: stableCommentId(`vuln-summary:${file}:${total}`),
    file,
    lineStart: 1,
    lineEnd: 1,
    tier: 3,
    category: "vulnerability",
    kind: "assertion",
    claim: `Repo has ${total} known ${total === 1 ? "vulnerability" : "vulnerabilities"}; none introduced by this diff.`,
    explanation: `Run \`pnpm audit\` (or your package manager's equivalent) for per-advisory detail. Re-run with --verbose to surface them inline.`,
    // The summary is a real claim ("repo has N vulns") and must carry a
    // citation per ADR-0008 — the per-advisory OSV records collapse into a
    // single audit-tool source so auditors can trace the count back to its
    // generator.
    sources: [
      {
        type: "tool",
        id: "audit",
        title: "npm audit",
        retrievedAt: new Date().toISOString(),
      },
    ],
    confidence: 1,
  };
  return [summary];
}

function formatErr(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 160);
  return String(err).slice(0, 160);
}
