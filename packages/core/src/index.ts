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
import { parseUnifiedDiff } from "./diff/index.js";
import { pruneDiff } from "./diff/prune.js";
import { detectEcosystem, type Lockfile } from "./ecosystem/index.js";
import { ensureGitignore } from "./init/ensure-gitignore.js";
import { walkRepo } from "./init/walk.js";
import {
  SqliteChunkStore,
  SqliteEmbeddingStore,
  readLockedModel,
} from "./indexing/index.js";
import type { FormatterListener } from "./llm/index.js";
import { verifyCitations } from "./llm/verify-citations.js";
import {
  Scratchpad,
  deterministicSynthesize,
  dispatch,
  synthesize,
  type Runner,
  type RunnerInput,
} from "./orchestration/index.js";
import { committabilityRunner } from "./runners/committability.js";
import { runConsistency } from "./runners/consistency.js";
import { runDeadcode } from "./runners/deadcode.js";
import { runEslint } from "./runners/eslint.js";
import { runJscpd } from "./runners/jscpd.js";
import { leverageRunner } from "./runners/leverage.js";
import { leverageLibrariesRunner } from "./runners/leverage-libraries.js";
import { scalabilityRunner } from "./runners/scalability.js";
import { runTsc } from "./runners/tsc.js";
import type { ToolFinding } from "./runners/types.js";
import type {
  Category,
  Comment,
  CommentSet,
  DegradedEntry,
  RetrievedContext,
} from "./schema.js";
import { runVulnerabilityCheck } from "./vuln/index.js";

export * from "./schema.js";
export { detectEcosystem, type EcosystemContext, type Lockfile } from "./ecosystem/index.js";
export { parseUnifiedDiff, type ChangedFile } from "./diff/index.js";
export { pruneDiff, type PruneResult } from "./diff/prune.js";
export { buildDiffTree, MAX_DEPTH as DIFF_TREE_MAX_DEPTH, type DiffTreeNode } from "./diff/tree.js";
export { resolveDiff, type DiffMode, type ResolveDiffOptions, type ResolvedDiff } from "./diff/source.js";
export type { FormatterEvent, FormatterListener } from "./llm/index.js";
export {
  verifyCitations,
  type VerifyCitationsInput,
  type VerifyCitationsOutput,
} from "./llm/verify-citations.js";
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
export {
  Scratchpad,
  deterministicSynthesize,
  dispatch,
  synthesize,
  type DeterministicSynthesizeInput,
  type Runner,
  type RunnerInput,
  type RunnerOutput,
  type SynthesizeInput,
  type SynthesizeOutput,
} from "./orchestration/index.js";
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

  // M9 (ADR-0025): diff-level noise filter. Pre-runner stage between
  // `parseUnifiedDiff()` and runner dispatch — every downstream runner
  // (TSC, ESLint, jscpd, vuln, scalability, deadcode, consistency,
  // committability) consumes the *pruned* `ChangedFile[]`. Defends the
  // catastrophic case (committed `node_modules/` etc.) for every runner
  // simultaneously, supersedes the M7 directory-concentration heuristic
  // formerly in committability.ts.
  //
  // Inlined so the parser's unpruned output is unreferenced after
  // `pruneDiff()` returns — a 500K-file diff would otherwise pin the
  // pre-prune array for the lifetime of `review()`.
  const pruneResult = input.diff ? pruneDiff(parseUnifiedDiff(input.diff)) : undefined;
  const changed = pruneResult?.pruned;
  const noiseFilterDegraded: DegradedEntry[] = pruneResult?.degraded ?? [];
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

  // M8 (ADR-0023): scratchpad is the single sink for runner outputs. Inline
  // runners (TSC, ESLint, jscpd, deadcode) record into it directly; the two
  // contract-migrated runners (committability, scalability) flow through
  // dispatch(). Vuln stays inline outside the scratchpad — its already-mapped
  // `Comment[]` shape doesn't fit `RunnerOutput.findings: ToolFinding[]`
  // cleanly; M9+ may revisit when the noise filter touches that surface.
  const scratchpad = new Scratchpad();

  // Decide orchestration runners up-front so dispatch() can run *concurrently*
  // with the inline Promise.all instead of serializing after it. Pre-M8
  // scalability ran in parallel with TSC/ESLint/vuln/deadcode; routing it
  // through the contract must preserve that parallelism (caught by Copilot
  // review on PR #5).
  const orchestrationRunners: Runner[] = [];
  if (changed && changed.length > 0) {
    orchestrationRunners.push(scalabilityRunner);
    // M12 (ADR-0027): leverage detector — bounded stdlib idiom-miss patterns.
    // Pure AST; runs in both `check` and `review`.
    orchestrationRunners.push(leverageRunner);
    // Committability + leverage-libraries fire only in `review` mode. `check`
    // is deterministic-only per ADR-0011 — no LLM calls — and these are
    // cheap-tier LLM sub-agents.
    if (input.config.mode === "review") {
      orchestrationRunners.push(committabilityRunner);
      orchestrationRunners.push(leverageLibrariesRunner);
    }
  }
  const dispatchPromise: Promise<void> =
    orchestrationRunners.length > 0
      ? dispatch(
          orchestrationRunners,
          {
            repoRoot: input.repoRoot,
            changed: changed ?? [],
            changedPaths: changedPaths ?? [],
          } satisfies RunnerInput,
          scratchpad,
        )
      : Promise.resolve();

  const [
    tscResult,
    eslintResult,
    vulnResult,
    selectorResult,
    deadcodeResult,
    consistencyResult,
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
      // ADR-0021 #1: deadcode detector — diff-touched exported fns + 1-hop
      // reverse `import_graph` for caller arity inspection. Stays inline in
      // M8; M9 likely migrates it through the contract.
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
      // M10 (ADR-0021 §1c): consistency detector — verifies doc claims about
      // env-vars / CLI surface / `.warden/*` path constants against the
      // current code. Stays inline like deadcode; not contract-migrated.
      changed && changed.length > 0
        ? runConsistency({ repoRoot: input.repoRoot, changed }).catch((err: unknown) => ({
            findings: [] as ToolFinding[],
            degraded: [
              {
                kind: "warning",
                topic: "consistency",
                message: `consistency: detector failed (${formatErr(err)})`,
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

  // Wait for the orchestration-tier runners before reading the scratchpad.
  // dispatch() has been running in parallel with everything above; this
  // join only blocks if its longest runner outlasted jscpd.
  await dispatchPromise;

  // Record inline-runner outputs into the scratchpad. Findings stay raw here;
  // synthesis applies `scopeToDiff` uniformly across the whole scratchpad,
  // which is a no-op on detectors that already filter against `addedLines`.
  scratchpad.record({
    name: "tsc",
    findings: tscResult.findings,
    degraded: tscResult.degraded,
    durationMs: 0,
  });
  scratchpad.record({
    name: "eslint",
    findings: eslintResult.findings,
    degraded: eslintResult.degraded,
    durationMs: 0,
  });
  scratchpad.record({
    name: "jscpd",
    findings: jscpdResult.findings,
    degraded: jscpdResult.degraded,
    durationMs: 0,
  });
  scratchpad.record({
    name: "deadcode",
    findings: deadcodeResult.findings,
    degraded: deadcodeResult.degraded,
    durationMs: 0,
  });
  scratchpad.record({
    name: "consistency",
    findings: consistencyResult.findings,
    degraded: consistencyResult.degraded,
    durationMs: 0,
  });

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
      : collapseVulnComments(vulnResult.comments, ecosystem.lockfile);

  // Aggregate environmental degraded entries (those not produced by runners
  // recorded in the scratchpad). Runner-produced degraded entries flow
  // through `scratchpad.flattenDegraded()`.
  const environmentalDegraded: DegradedEntry[] = [
    ...gitignoreDegraded,
    ...noiseFilterDegraded,
    ...bannerStateToDegraded(bannerState),
    ...vulnResult.degraded,
    ...selectorResult.degraded,
  ];

  // Synthesis ending diverges per ADR-0023 #7. `check` is deterministic-only;
  // `review` runs the M4 formatter cascade through the synthesizer.
  let synthOutput: { comments: Comment[]; degraded: DegradedEntry[] };
  if (input.config.mode === "check") {
    synthOutput = deterministicSynthesize({
      scratchpad,
      vulnComments,
      changed,
    });
  } else {
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
        environmentalDegraded.push({
          kind: "warning",
          topic: "context",
          message: `context: prompt-assembly failed (${formatErr(err)})`,
        });
      }
    }
    synthOutput = await synthesize({
      scratchpad,
      vulnComments,
      diff: input.diff,
      retrievedContext: ctxFromSelector,
      changed,
      repoRoot: input.repoRoot,
      emit: input.emit,
    });
  }

  // M10 (ADR-0021 §3): global substring-verifier post-pass. Runs over every
  // Comment whose sources[] carries a `{path, line, snippet}` triple; drops
  // sources whose snippet doesn't substring-match the cited file, and drops
  // Comments left with zero verified snippet sources (if they had ≥1 to
  // begin with). Catches both deterministic-runner snippet citations and
  // LLM-authored ones in a single pass — placed before `applyHardRules()`
  // so the priority-sort + tier-3 gate see the verified set.
  const verified = await verifyCitations({
    comments: synthOutput.comments,
    repoRoot: input.repoRoot,
  });

  // Hard rules in code per grilling Q11 (P3): final priority sort + tier-3
  // verbose-gate. Soft rules (judgment-driven suppression) live in the LLM
  // prompt and have already been applied above.
  const finalComments = applyHardRules(verified.comments, input.config);

  return {
    comments: finalComments,
    metadata: {
      durationMs: Date.now() - startedAt,
      degradedWorkers: [
        ...environmentalDegraded,
        ...scratchpad.flattenDegraded(),
        ...synthOutput.degraded,
        ...verified.degraded,
      ],
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
function collapseVulnComments(comments: Comment[], lockfile: Lockfile | undefined): Comment[] {
  if (comments.length === 0) return [];
  const total = comments.length;
  const file = comments[0]?.file ?? "package.json";
  // Cite the actual auditor that ran. The audit runner only emits advisories
  // for npm/pnpm lockfiles, so `yarn`/`undefined` shouldn't reach here in
  // practice — keep the neutral fallback for type safety anyway.
  const auditorTitle =
    lockfile === "pnpm" ? "pnpm audit" : lockfile === "npm" ? "npm audit" : "npm/pnpm audit";
  const summary: Comment = {
    id: stableCommentId(`vuln-summary:${file}:${total}`),
    file,
    lineStart: 1,
    lineEnd: 1,
    tier: 3,
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

function formatErr(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 160);
  return String(err).slice(0, 160);
}
