import { stableCommentId } from "./comment-id.js";
import { applyConfidenceFloor, dropsToDegraded } from "./confidence.js";
import type { ContextSelector } from "./context/index.js";
import type { Lockfile } from "./ecosystem/index.js";
import type { FormatterListener } from "./llm/index.js";
import { runReviewHarness, type ReviewHarnessResult } from "./review-harness/harness.js";
import { runDetPriors } from "./review-harness/det-priors.js";
import { toComment } from "./runners/to-comment.js";
import {
  runSecurityHarness,
  type SecurityHarnessConfig,
  type SecurityHarnessOutput,
} from "./security/index.js";
import type {
  Category,
  Comment,
  CommentSet,
  DegradedEntry,
  RetrievedContext,
  Tier,
} from "./schema.js";

export * from "./schema.js";
// ADR-0048 — the CLI force-flushes the OTEL→Langfuse exporter on exit (the
// process is short-lived; unflushed spans are lost). Re-exported here because
// `@warden/ai` is the package boundary that owns observability and the CLI
// depends on `@warden/core` at runtime (not on `@warden/ai` directly).
export { shutdownObservability, isObservabilityEnabled } from "@warden/ai";
export { detectEcosystem, type EcosystemContext, type Lockfile } from "./ecosystem/index.js";
export { parseUnifiedDiff, type ChangedFile } from "./diff/index.js";
export { pruneDiff, type PruneResult } from "./diff/prune.js";
export { buildDiffTree, MAX_DEPTH as DIFF_TREE_MAX_DEPTH, type DiffTreeNode } from "./diff/tree.js";
export {
  resolveDiff,
  type DiffMode,
  type ResolveDiffOptions,
  type ResolvedDiff,
} from "./diff/source.js";
export type { FormatterEvent, FormatterListener } from "./llm/index.js";
export {
  verifyCitations,
  type VerifyCitationsInput,
  type VerifyCitationsOutput,
} from "./llm/verify-citations.js";
export {
  CATEGORY_CONFIDENCE_FLOOR,
  applyConfidenceFloor,
  dropsToDegraded,
  type ApplyConfidenceFloorOptions,
  type ConfidenceFloorResult,
} from "./confidence.js";
export {
  lookupTypeDef,
  type LookupTypeDefResult,
  type NotFoundReason as TypeDefNotFoundReason,
  type SuggestedApiDefSource,
  type TypeDefKind,
} from "./api/index.js";
export {
  makeLookupTypeDefTool,
  type MakeLookupTypeDefToolOptions,
} from "./llm/tools/lookup-type-def.js";
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
// M14 (ADR-0030): the M8 orchestration spine (`Scratchpad`, `dispatch`,
// `synthesize`, `deterministicSynthesize`) retired for review-mode in this
// commit. The `Runner` contract survives — it remains the right shape for
// future Phase 1 det-priors additions, and the surviving deterministic
// runners (`scalabilityRunner`, `leverageRunner`) still implement it.
export { type Runner, type RunnerInput, type RunnerOutput } from "./orchestration/index.js";
export { ensureGitignore } from "./init/ensure-gitignore.js";
export {
  estimateInit,
  ESTIMATE_CONSTANTS,
  reconcileFiles,
  runInit,
  walkRepo,
  type InitEvent,
  type InitListener,
  type InitOptions,
  type InitSummary,
  type ReconcileEvent,
  type ReconcileInput,
  type ReconcileSummary,
} from "./init/index.js";
export {
  CURRENT_FORMAT_VERSION,
  META_KEYS,
  SqliteChunkStore,
  SqliteEmbeddingStore,
  SqliteFileChunksStore,
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
  type FileChunksStore,
  type IndexExporter,
  type IndexImporter,
  type JobRunner,
  type LockedModel,
  type MerkleNode,
  type MerkleStore,
  type Task,
} from "./indexing/index.js";
// M14 (ADR-0030): review-harness surface, exported for future bot wrappers
// (the GitHub PR bot, Slack bot, etc. per ADR-0013) that want direct access
// to the 3-phase pipeline without going through the `review()` umbrella.
export {
  runReviewHarness,
  runDetPriors,
  ReviewScratchpad,
  type ReviewHarnessInput,
  type ReviewHarnessResult,
  type ReviewHarnessConfig,
  type DetPriors,
  type TokenUsage,
  type WorkerOutput,
} from "./review-harness/harness.js";
export {
  type BossLoopConfig,
  type BossLoopInput,
  type BossLoopOutput,
  runBossLoop,
} from "./review-harness/boss-loop.js";
export { type BossPromptVariant } from "./review-harness/prompts/loader.js";
export {
  runSecurityHarness,
  evaluateTriageGate,
  isSecuritySensitivePath,
  SECURITY_SENSITIVE_PATTERNS,
  type SecurityHarnessConfig,
  type SecurityHarnessInput,
  type SecurityHarnessMode,
  type SecurityHarnessOutput,
  type TriageGateInput,
  type TriageGateResult,
} from "./security/index.js";
export { toComment } from "./runners/to-comment.js";

export interface ReviewConfig {
  mode: "check" | "review";
  /** When `true`, tier-3 (style/dedup) findings are surfaced. Default suppresses them per vision.md §15. */
  verbose?: boolean;
  /**
   * M15 (ADR-0031) boss-loop calibration knobs. Threaded straight through to
   * `ReviewHarnessConfig.bossLoop`. Default `undefined` preserves M14
   * baseline behavior (no programmatic dispatch, rules-based prompt).
   * Used by the eval suite + future bot wrappers to A/B configurations.
   */
  bossLoop?: import("./review-harness/boss-loop.js").BossLoopConfig;
  /**
   * M18 / ADR-0029: opt into the dedicated deep-security harness after the
   * default M14/M15 review harness. Ignored in check mode.
   */
  deep?: boolean;
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
  /**
   * Degraded entries surfaced *before* `review()` was called (e.g. by
   * `resolveDiff()` when git itself failed). Prepended onto
   * `metadata.degradedWorkers` so the banner + JSON consumers see the same
   * signal the CLI receives. Repo-audit 2026-05-18 #3.
   */
  extraDegraded?: DegradedEntry[];
  /**
   * ADR-0046: the diff's resolved base ref + human description, forwarded from
   * `resolveDiff()`. The react-doctor det-prior uses `baseRef` to drive its
   * `--scope changed` delta against the same base warden diffed. Public
   * surface — the `apps/github-bot/` wrapper supplies this too. Absent (or
   * `baseRef` undefined) → react-doctor auto-detects working-tree changes.
   */
  diffBase?: { baseRef?: string; description: string };
}

/**
 * Public entry point for `warden review` and `warden check`. M14 (ADR-0030)
 * collapsed the prior M4-spine review() body (~430 lines: parallel
 * detector launch + scratchpad + dispatch + synthesize + verify) into two
 * thin branches. Both paths converge on `applyHardRules()`.
 *
 *   - **review mode** routes through `runReviewHarness()` — a 3-phase
 *     pipeline (Det Priors → boss loop → Citation Verify) at
 *     `review-harness/`. The harness owns the LLM calls; this function
 *     only applies the mode/config-dependent hard rules afterward.
 *
 *   - **check mode** runs Phase 1 (`runDetPriors()`) and stops. Tool
 *     findings map to Comments via `toComment()`; vuln Comments are
 *     collapsed to a summary per ADR-0021 §8 unless the diff touches a
 *     manifest/lockfile or `--verbose` is set. Zero LLM calls per
 *     ADR-0011's deterministic-only invariant.
 *
 * The pre-M14 single-function entry point is preserved on purpose: every
 * caller (the CLI, future PR-bot wrappers, smokes) still calls one
 * function and discriminates by `config.mode`. The internal split is the
 * implementation choice; the public surface is unchanged.
 */
export async function review(input: ReviewInput): Promise<CommentSet> {
  if (input.config.mode === "check") {
    return runCheck(input);
  }
  return runReview(input);
}

async function runReview(input: ReviewInput): Promise<CommentSet> {
  const harness: ReviewHarnessResult = await runReviewHarness({
    diff: input.diff,
    repoRoot: input.repoRoot,
    config: {
      mode: "review",
      ...(input.config.verbose !== undefined ? { verbose: input.config.verbose } : {}),
      ...(input.config.bossLoop !== undefined ? { bossLoop: input.config.bossLoop } : {}),
    },
    ...(input.selector !== undefined ? { selector: input.selector } : {}),
    ...(input.retrievedContext !== undefined ? { retrievedContext: input.retrievedContext } : {}),
    ...(input.emit !== undefined ? { emit: input.emit } : {}),
    ...(input.diffBase !== undefined ? { diffBase: input.diffBase } : {}),
  });
  const ruled = applyHardRules(harness.comments, {
    mode: "review",
    ...(input.config.verbose !== undefined ? { verbose: input.config.verbose } : {}),
    harness: "m14-review",
  });
  const security =
    input.config.deep === true
      ? await runSecurityHarness({
          diff: input.diff,
          repoRoot: input.repoRoot,
          config: {
            mode: "review-deep",
            ...(input.config.verbose !== undefined ? { verbose: input.config.verbose } : {}),
          },
        })
      : undefined;
  const ruledSecurity =
    security !== undefined
      ? applyHardRules(security.comments, {
          mode: "review",
          harness: "m18-security",
          ...(input.config.verbose !== undefined ? { verbose: input.config.verbose } : {}),
        })
      : undefined;
  const mergedComments =
    ruledSecurity !== undefined ? [...ruled.comments, ...ruledSecurity.comments] : ruled.comments;
  return {
    comments: mergedComments,
    metadata: {
      durationMs: harness.metadata.durationMs + (security?.metadata.durationMs ?? 0),
      degradedWorkers: [
        ...(input.extraDegraded ?? []),
        ...harness.metadata.degradedWorkers,
        ...ruled.degraded,
        ...(security?.metadata.degradedWorkers ?? []),
        ...(ruledSecurity?.degraded ?? []),
      ],
      ...(harness.metadata.tokenUsage !== undefined
        ? { tokenUsage: harness.metadata.tokenUsage }
        : {}),
      ...(harness.metadata.costUsd !== undefined ? { costUsd: harness.metadata.costUsd } : {}),
      ...(harness.metadata.costByTier !== undefined
        ? { costByTier: harness.metadata.costByTier }
        : {}),
      ...(harness.metadata.costLabels !== undefined
        ? { costLabels: harness.metadata.costLabels }
        : {}),
    },
  };
}

export async function security(
  input: Omit<ReviewInput, "config"> & {
    config?: Partial<SecurityHarnessConfig>;
  },
): Promise<CommentSet> {
  const harness: SecurityHarnessOutput = await runSecurityHarness({
    diff: input.diff,
    repoRoot: input.repoRoot,
    config: {
      mode: input.config?.mode ?? "security",
      ...(input.config?.verbose !== undefined ? { verbose: input.config.verbose } : {}),
    },
  });
  const ruled = applyHardRules(harness.comments, {
    mode: "review",
    harness: "m18-security",
    ...(input.config?.verbose !== undefined ? { verbose: input.config.verbose } : {}),
  });
  return {
    comments: ruled.comments,
    metadata: {
      durationMs: harness.metadata.durationMs,
      degradedWorkers: [
        ...(input.extraDegraded ?? []),
        ...harness.metadata.degradedWorkers,
        ...ruled.degraded,
      ],
    },
  };
}

async function runCheck(input: ReviewInput): Promise<CommentSet> {
  const startedAt = Date.now();
  const detPriors = await runDetPriors({
    diff: input.diff,
    repoRoot: input.repoRoot,
    mode: "check",
    // check mode never invokes the selector — the LLM is the only consumer
    // of retrieved context and check skips the LLM entirely.
    selector: null,
    ...(input.diffBase !== undefined ? { diffBase: input.diffBase } : {}),
  });

  // No package.json at repoRoot → preserve pre-M14 behavior: short-circuit
  // before any further synthesis with a single `info` degraded entry.
  // Det-prior detectors degrade gracefully on missing tooling, but we
  // surface this explicit signal for the no-Node project case so the user
  // sees one clear "skipping — TS/JS only in v0" line.
  if (!detPriors.ecosystem.hasPackageJson) {
    return {
      comments: [],
      metadata: {
        durationMs: Date.now() - startedAt,
        degradedWorkers: [
          ...(input.extraDegraded ?? []),
          ...detPriors.degraded,
          {
            kind: "info",
            topic: "ecosystem",
            message: "ecosystem: no package.json at repoRoot — TS/JS only in v0",
          },
        ],
      },
    };
  }

  // Det-prior findings → Comments via the existing tool→Comment mapping.
  // Vuln Comments pass through as-is (audit + OSV already shape them).
  const toolComments = detPriors.findings.map(toComment);
  const verboseMode = input.config.verbose === true;
  const manifestTouched = detPriors.changedPaths.some(isManifestPath);
  const vulnComments =
    manifestTouched || verboseMode
      ? detPriors.vulnComments
      : collapseVulnComments(detPriors.vulnComments, detPriors.ecosystem.lockfile);

  const merged: Comment[] = [...toolComments, ...vulnComments];
  const ruled = applyHardRules(merged, input.config);
  return {
    comments: ruled.comments,
    metadata: {
      durationMs: Date.now() - startedAt,
      degradedWorkers: [...(input.extraDegraded ?? []), ...detPriors.degraded, ...ruled.degraded],
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
  "leverage",
  "dedup",
  "tests",
];

interface HardRulesOutput {
  comments: Comment[];
  degraded: DegradedEntry[];
}

type HarnessHardRulesContext = "m14-review" | "m18-security";

type HardRulesConfig = Pick<ReviewConfig, "mode" | "verbose"> & {
  harness?: HarnessHardRulesContext;
};

function applyHardRules(comments: Comment[], config: HardRulesConfig): HardRulesOutput {
  // Off-hunk anchoring is enforced upstream by `scopeCommentsToDiff()` in the
  // review harness (`review-harness/harness.ts`), which drops any boss comment
  // whose `[lineStart, lineEnd]` overlaps zero added lines in the *pruned*
  // `ChangedFile[]`. No added-line rule is duplicated here: a second pass over
  // the raw diff could only ever keep a superset of what the harness already
  // kept (pruning is a subset filter), so it would be a no-op for the
  // m14-review path and would silently re-scope check / m18-security comments
  // (deterministic / vuln summaries anchored at `package.json:1`) if it ran.

  // M13 (ADR-0028 §5): confidence-floor filter runs first. Per-category
  // numeric floor; Tier-1 findings bypass unconditionally (critical-finding
  // short-circuit per `project_warden_security_depth_tiers.md`). Drops
  // surface as one info-level degraded entry per non-zero drop count per
  // category — never per dropped Comment.
  const shouldApplyConfidenceFloor = config.harness !== "m18-security";
  const { kept, drops } = shouldApplyConfidenceFloor
    ? applyConfidenceFloor(comments)
    : { kept: comments, drops: new Map<Category, { count: number; floor: number }>() };
  const floorDegraded = shouldApplyConfidenceFloor ? dropsToDegraded(drops) : [];

  // Tier-3 verbose-gate applies only in `review` mode — the LLM has had its
  // triage pass and the user wanted curation. `check` is deterministic-only
  // per ADR-0011: surface every finding the tools produced. (Caught by M4
  // dogfood: previous version filtered tier-3 in both modes.)
  const shouldGateTier3 = config.mode === "review" && config.verbose !== true;
  const filtered = shouldGateTier3 ? kept.filter((c) => c.tier !== 3) : kept;
  const sorted = [...filtered].sort((a, b) => {
    const pa = PRIORITY_ORDER.indexOf(a.category);
    const pb = PRIORITY_ORDER.indexOf(b.category);
    if (pa !== pb) return pa - pb;
    if (a.tier !== b.tier) return a.tier - b.tier;
    return b.confidence - a.confidence;
  });
  return { comments: sorted, degraded: floorDegraded };
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
function collapseVulnComments(comments: Comment[], lockfile: Lockfile | undefined): Comment[] {
  if (comments.length === 0) return [];
  const total = comments.length;
  const file = comments[0]?.file ?? "package.json";
  // Cite the actual auditor that ran. The audit runner only emits advisories
  // for npm/pnpm lockfiles, so `yarn`/`undefined` shouldn't reach here in
  // practice — keep the neutral fallback for type safety anyway.
  const auditorTitle =
    lockfile === "pnpm" ? "pnpm audit" : lockfile === "npm" ? "npm audit" : "npm/pnpm audit";
  // The summary inherits the highest severity in the input set (lowest tier
  // number). A repo with a critical CVE collapses to a tier-1 summary that
  // stays visible by default; a low-only repo collapses to tier-3 and
  // suppresses unless --verbose. Pre-fix this was a fixed tier-3 — silently
  // swallowing tier-1 advisories on non-manifest-touching diffs, which
  // contradicted ADR-0021 #8's "replaced by a single summary line" intent.
  const summaryTier = comments.reduce<Tier>((worst, c) => (c.tier < worst ? c.tier : worst), 3);
  const summary: Comment = {
    id: stableCommentId(`vuln-summary:${file}:${total}`),
    file,
    lineStart: 1,
    lineEnd: 1,
    tier: summaryTier,
    category: "vulnerability",
    kind: "assertion",
    claim: `Repo has ${total} known ${total === 1 ? "vulnerability" : "vulnerabilities"}; none introduced by this diff.`,
    explanation: `Run \`${auditorTitle}\` for per-advisory detail. Re-run with --verbose to surface them inline.`,
    // The summary is a real claim ("repo has N vulns") and must carry a
    // citation per ADR-0008 — the per-advisory OSV records collapse into a
    // single audit-tool source so auditors can trace the count back to its
    // generator.
    sources: [
      {
        type: "tool",
        id: "audit",
        title: auditorTitle,
        retrievedAt: new Date().toISOString(),
      },
    ],
    confidence: 1,
  };
  return [summary];
}
