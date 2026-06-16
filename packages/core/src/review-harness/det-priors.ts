import { CURRENT_DEFAULT, getEmbeddingProvider } from "@warden/ai";
import { wardenEnv } from "@warden/env";
import {
  bannerStateToDegraded,
  computeBannerState,
  type BannerState,
} from "../banner/index.js";
import { CodeChunkAdapter } from "../context/chunker.js";
import {
  CheapSignalsSelector,
  candidatesToRetrievedContext,
  type ContextSelector,
  type SelectorOutput,
} from "../context/index.js";
import {
  parseUnifiedDiff,
  type ChangedFile,
} from "../diff/index.js";
import { pruneDiff } from "../diff/prune.js";
import {
  detectEcosystem,
  type EcosystemContext,
} from "../ecosystem/index.js";
import { ensureGitignore } from "../init/ensure-gitignore.js";
import { reconcileFiles, type ReconcileSummary } from "../init/reconcile.js";
import { walkRepo, type WalkedFile } from "../init/walk.js";
import {
  SqliteChunkStore,
  SqliteEmbeddingStore,
  SqliteFileChunksStore,
  SqliteMerkleStore,
  readLockedModel,
} from "../indexing/index.js";
import { runConsistency } from "../runners/consistency.js";
import { runDeadcode } from "../runners/deadcode.js";
import { runEslint } from "../runners/eslint.js";
import { runEslintSecurity } from "../runners/eslint-security.js";
import { runJscpd } from "../runners/jscpd.js";
import { leverageRunner } from "../runners/leverage.js";
import { runReactDoctor } from "../runners/react-doctor.js";
import { scalabilityRunner } from "../runners/scalability.js";
import { runTsc } from "../runners/tsc.js";
import type { ToolFinding } from "../runners/types.js";
import type {
  Comment,
  DegradedEntry,
  RetrievedContext,
} from "../schema.js";
import { runVulnerabilityCheck } from "../vuln/index.js";

/**
 * Phase 1 of the M14 review harness (ADR-0030). Runs every deterministic
 * detector + the M5/M6 context selector in parallel and gathers the
 * environmental degraded entries (gitignore-ensure, diff prune, banner
 * lookup, selector setup) into one envelope.
 *
 * Reused by:
 *   - `runReviewHarness()` (Phase 1 — fed to the boss-loop as initial context).
 *   - `warden check` (consumed directly; det-prior `ToolFinding[]` map to
 *     `Comment[]` via `runners/to-comment.ts`, vuln comments pass through,
 *     no boss-loop, no citation-verify post-pass).
 *
 * Internally mirrors the parallel-runner block from
 * `packages/core/src/index.ts` (M8 spine pre-retirement). The original code
 * remains in place this commit — this module is additive scaffold only and
 * not yet wired into `review()` / `check()`.
 */
export interface DetPriorsInput {
  diff: string;
  repoRoot: string;
  mode: "check" | "review";
  /**
   * Override the M5/M6 cheap-signals selector. Default constructs a
   * `CheapSignalsSelector` keyed on the host repo's tsconfig + Voyage
   * embeddings (when the index exists). Pass `null` to skip context
   * selection entirely.
   */
  selector?: ContextSelector | null;
  /**
   * Pre-computed retrieved context. When provided, the selector is skipped
   * and this value is propagated through. Used by test harnesses.
   */
  retrievedContext?: RetrievedContext;
  /**
   * ADR-0046: the diff's resolved base ref. When `WARDEN_REACT_DOCTOR` is on,
   * the react-doctor det-prior forwards `baseRef` as `--base` so its
   * `--scope changed` delta compares against the same base warden diffed.
   * Undefined `baseRef` (or absent struct) → react-doctor auto-detects.
   */
  diffBase?: { baseRef?: string; description: string };
}

export interface DetPriors {
  ecosystem: EcosystemContext;
  /** Pruned `ChangedFile[]`; empty when input.diff is empty or every entry was pruned. */
  changed: ChangedFile[];
  /** Convenience cache of `changed.map(c => c.path)`. */
  changedPaths: string[];
  /** Aggregate `ToolFinding[]` from TSC + ESLint + ESLint-security + jscpd + scalability + consistency + deadcode + leverage detectors. */
  findings: ToolFinding[];
  /** Vuln output stays `Comment`-shaped (audit + OSV emit Comments directly). */
  vulnComments: Comment[];
  /** Banner state for review-mode; `{ kind: "no-banner" }` in check-mode or when the index walk fails. */
  bannerState: BannerState;
  /** Raw selector output (candidates + degraded). Empty `{ candidates: [], degraded: [] }` in check-mode or when skipped. */
  selectorOutput: SelectorOutput;
  /** Prompt-ready chunks + same-folder neighbors. Empty in check-mode. */
  retrievedContext: RetrievedContext;
  /** Aggregated degraded entries from every det-prior + environmental source. */
  degraded: DegradedEntry[];
}

const EMPTY_SELECTOR_OUTPUT: SelectorOutput = { candidates: [], degraded: [] };
const EMPTY_RETRIEVED_CONTEXT: RetrievedContext = { chunks: [], sameFolderPaths: [] };

export async function runDetPriors(input: DetPriorsInput): Promise<DetPriors> {
  const ecosystem = detectEcosystem(input.repoRoot);

  // Caller (harness or check) handles the no-package-json early-return; det
  // priors still runs in that case so degraded entries surface uniformly.
  const environmentalDegraded: DegradedEntry[] = [];

  // ADR-0019 #12: ensure `.warden/` lives in `.gitignore` before any cache
  // write — first verb a user runs in a fresh repo gets the entry.
  try {
    const gitignore = await ensureGitignore(input.repoRoot);
    if (gitignore.added)
      environmentalDegraded.push({
        kind: "info",
        topic: "gitignore",
        message: "gitignore: added .warden/ entry",
      });
  } catch (err) {
    environmentalDegraded.push({
      kind: "warning",
      topic: "gitignore",
      message: `gitignore: failed to ensure entry (${formatErr(err)})`,
    });
  }

  // M9 (ADR-0025): diff-level noise filter. Inlined so the parser's
  // unpruned output is unreferenced after `pruneDiff()` returns.
  const pruneResult = input.diff ? pruneDiff(parseUnifiedDiff(input.diff)) : undefined;
  const changed = pruneResult?.pruned ?? [];
  environmentalDegraded.push(...(pruneResult?.degraded ?? []));
  const changedPaths = changed.map((c) => c.path);

  // Banner state (review-mode only). `check` skips — deterministic-only.
  let bannerState: BannerState = { kind: "no-banner" };
  let walkedForRefresh: Map<string, WalkedFile> | null = null;
  let currentHashesForRefresh: Map<string, string> | null = null;
  if (input.mode === "review") {
    try {
      const walk = await walkRepo(input.repoRoot);
      walkedForRefresh = walk.files;
      const currentHashes = new Map<string, string>();
      for (const f of walk.files.values()) currentHashes.set(f.path, f.fileSha);
      currentHashesForRefresh = currentHashes;
      bannerState = await computeBannerState({
        repoRoot: input.repoRoot,
        currentDefault: CURRENT_DEFAULT,
        currentHashes,
      });
    } catch (err) {
      bannerState = { kind: "no-banner" };
      environmentalDegraded.push({
        kind: "warning",
        topic: "banner",
        message: `banner: state lookup failed (${formatErr(err)})`,
      });
    }
  }

  // M16 / ADR-0032: implicit incremental refresh of the index when review
  // sees a stale banner. The budget defaults to $0.25; set
  // `WARDEN_REVIEW_REFRESH_MAX_USD=0` to opt out and keep the existing
  // stale-index banner as the only surface. Failures degrade cleanly — the
  // review continues against the (possibly stale) index.
  if (
    input.mode === "review" &&
    bannerState.kind === "stale" &&
    walkedForRefresh &&
    currentHashesForRefresh
  ) {
    const refreshBudget = wardenEnv().WARDEN_REVIEW_REFRESH_MAX_USD ?? 0.25;
    if (refreshBudget > 0) {
      try {
        const merkleStore = new SqliteMerkleStore();
        const diff = await merkleStore.diff(currentHashesForRefresh);
        const staleFiles: WalkedFile[] = [];
        for (const path of [...diff.changed, ...diff.added]) {
          const wf = walkedForRefresh.get(path);
          if (wf) staleFiles.push(wf);
        }
        if (staleFiles.length > 0 || diff.removed.length > 0) {
          const locked = await readLockedModel();
          const provider = getEmbeddingProvider();
          const reconcile = await reconcileFiles({
            files: staleFiles,
            removed: diff.removed,
            repoRoot: input.repoRoot,
            chunker: new CodeChunkAdapter(),
            chunkStore: new SqliteChunkStore(),
            embeddingStore: new SqliteEmbeddingStore(),
            merkleStore,
            fileChunksStore: new SqliteFileChunksStore(),
            provider,
            lockedModelId: locked?.modelId ?? CURRENT_DEFAULT,
            lockedModelVersion:
              locked?.modelVersion ?? `dim=1024;type=document`,
            maxUsdBudget: refreshBudget,
          });
          environmentalDegraded.push(...reconcile.degraded);
          if (reconcile.refreshed.length > 0 || reconcile.removed.length > 0) {
            environmentalDegraded.push({
              kind: "info",
              topic: "context",
              message: formatRefreshSummary(reconcile),
            });
          }
          // Banner now reflects the post-reconcile state. If every stale
          // file refreshed within budget, this clears to "no-banner".
          try {
            bannerState = await computeBannerState({
              repoRoot: input.repoRoot,
              currentDefault: CURRENT_DEFAULT,
              currentHashes: currentHashesForRefresh,
            });
          } catch {
            // Banner re-read failures are non-fatal — keep the prior stale
            // state so the user still sees the actionable surface.
          }
        }
      } catch (err) {
        environmentalDegraded.push({
          kind: "warning",
          topic: "context",
          message: `context: incremental refresh failed (${formatErr(err)}) — running against possibly-stale index`,
        });
      }
    }
  }

  // Selector setup (review-mode only; skipped when caller passes selector === null
  // or supplies a pre-computed retrievedContext).
  const shouldRunSelector =
    input.mode === "review" &&
    input.selector !== null &&
    !input.retrievedContext &&
    changed.length > 0;

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
      environmentalDegraded.push({
        kind: "warning",
        topic: "context",
        message: `context: semantic signal disabled (${formatErr(err)}) — falling back to cheap signals`,
      });
    }
  }

  const selector: ContextSelector | null =
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

  // Parallel detectors. scalabilityRunner + leverageRunner are `Runner`-
  // contract objects (M8); call `.run()` directly here — the M8
  // `dispatch()` is retired from the review codepath in a later commit.
  const runnerInput = {
    repoRoot: input.repoRoot,
    changed,
    changedPaths,
  };

  const [
    tscResult,
    eslintResult,
    eslintSecurityResult,
    vulnResult,
    selectorResult,
    deadcodeResult,
    consistencyResult,
    scalabilityResult,
    leverageResult,
    reactDoctorResult,
  ] = await Promise.all([
    runTsc(input.repoRoot, ecosystem.tsconfigPaths),
    ecosystem.hasEslint && changedPaths.length > 0
      ? runEslint(input.repoRoot, changedPaths)
      : Promise.resolve({ findings: [] as ToolFinding[], degraded: [] as DegradedEntry[] }),
    changedPaths.length > 0
      ? runEslintSecurity(input.repoRoot, changedPaths).catch((err: unknown) => ({
          findings: [] as ToolFinding[],
          degraded: [
            {
              kind: "warning",
              topic: "eslint-security",
              message: `eslint-security: detector failed (${formatErr(err)})`,
            },
          ] as DegradedEntry[],
        }))
      : Promise.resolve({ findings: [] as ToolFinding[], degraded: [] as DegradedEntry[] }),
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
            changed,
            ecosystem,
            diff: input.diff,
          })
          .catch(
            (err: unknown): SelectorOutput => ({
              candidates: [],
              degraded: [
                {
                  kind: "warning",
                  topic: "context",
                  message: `context: selector failed (${formatErr(err)})`,
                },
              ],
            }),
          )
      : Promise.resolve(EMPTY_SELECTOR_OUTPUT),
    changed.length > 0
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
    changed.length > 0
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
    changed.length > 0
      ? scalabilityRunner.run(runnerInput).catch((err: unknown) => ({
          name: scalabilityRunner.name,
          findings: [] as ToolFinding[],
          degraded: [
            {
              kind: "warning",
              topic: "scalability",
              message: `scalability: detector failed (${formatErr(err)})`,
            },
          ] as DegradedEntry[],
          durationMs: 0,
        }))
      : Promise.resolve({
          name: scalabilityRunner.name,
          findings: [] as ToolFinding[],
          degraded: [] as DegradedEntry[],
          durationMs: 0,
        }),
    changed.length > 0
      ? leverageRunner.run(runnerInput).catch((err: unknown) => ({
          name: leverageRunner.name,
          findings: [] as ToolFinding[],
          degraded: [
            {
              kind: "warning",
              topic: "leverage",
              message: `leverage: detector failed (${formatErr(err)})`,
            },
          ] as DegradedEntry[],
          durationMs: 0,
        }))
      : Promise.resolve({
          name: leverageRunner.name,
          findings: [] as ToolFinding[],
          degraded: [] as DegradedEntry[],
          durationMs: 0,
        }),
    // ADR-0046: react-doctor det-prior, gated behind WARDEN_REACT_DOCTOR
    // (default off; eval-gated). Subprocesses the published react-doctor CLI;
    // `runReactDoctor` never throws (every failure degrades internally), but
    // the `.catch` mirrors the surrounding style as a belt-and-suspenders.
    wardenEnv().WARDEN_REACT_DOCTOR && changedPaths.length > 0
      ? runReactDoctor({
          repoRoot: input.repoRoot,
          changedPaths,
          mode: input.mode,
          ...(input.diffBase?.baseRef !== undefined
            ? { baseRef: input.diffBase.baseRef }
            : {}),
        }).catch((err: unknown) => ({
          findings: [] as ToolFinding[],
          degraded: [
            {
              kind: "warning",
              topic: "react-doctor",
              message: `react-doctor: detector failed (${formatErr(err)})`,
            },
          ] as DegradedEntry[],
        }))
      : Promise.resolve({ findings: [] as ToolFinding[], degraded: [] as DegradedEntry[] }),
  ]);

  // jscpd runs sequentially after the selector — it consumes the candidate
  // path set per ADR-0018. Skipped when there's nothing scoped to look at.
  const candidatePaths = selectorResult.candidates.map((c) => c.path);
  const scopedForJscpd = uniqStrings([...changedPaths, ...candidatePaths]);
  const jscpdResult =
    scopedForJscpd.length > 0
      ? await runJscpd(input.repoRoot, scopedForJscpd, new Set(changedPaths))
      : { findings: [] as ToolFinding[], degraded: [] as DegradedEntry[] };

  // Retrieved context: prompt-assembly happens here when not pre-supplied.
  // Failures degrade to diff-only context rather than aborting the run.
  let retrievedContext: RetrievedContext = EMPTY_RETRIEVED_CONTEXT;
  if (input.retrievedContext) {
    retrievedContext = input.retrievedContext;
  } else if (input.mode === "review" && selectorResult.candidates.length > 0) {
    try {
      retrievedContext = await candidatesToRetrievedContext(
        selectorResult.candidates,
        input.repoRoot,
      );
    } catch (err) {
      environmentalDegraded.push({
        kind: "warning",
        topic: "context",
        message: `context: prompt-assembly failed (${formatErr(err)})`,
      });
    }
  }

  const findings: ToolFinding[] = [
    ...tscResult.findings,
    ...eslintResult.findings,
    ...eslintSecurityResult.findings,
    ...jscpdResult.findings,
    ...deadcodeResult.findings,
    ...consistencyResult.findings,
    ...scalabilityResult.findings,
    ...leverageResult.findings,
    ...reactDoctorResult.findings,
  ];

  const degraded: DegradedEntry[] = [
    ...environmentalDegraded,
    ...bannerStateToDegraded(bannerState),
    ...vulnResult.degraded,
    ...selectorResult.degraded,
    ...tscResult.degraded,
    ...eslintResult.degraded,
    ...eslintSecurityResult.degraded,
    ...jscpdResult.degraded,
    ...deadcodeResult.degraded,
    ...consistencyResult.degraded,
    ...scalabilityResult.degraded,
    ...leverageResult.degraded,
    ...reactDoctorResult.degraded,
  ];

  return {
    ecosystem,
    changed,
    changedPaths,
    findings,
    vulnComments: vulnResult.comments,
    bannerState,
    selectorOutput: selectorResult,
    retrievedContext,
    degraded,
  };
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

function formatErr(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 160);
  return String(err).slice(0, 160);
}

function formatRefreshSummary(reconcile: ReconcileSummary): string {
  const parts: string[] = [];
  if (reconcile.refreshed.length > 0) {
    parts.push(
      `refreshed ${reconcile.refreshed.length} file${reconcile.refreshed.length === 1 ? "" : "s"}`,
    );
  }
  if (reconcile.removed.length > 0) {
    parts.push(
      `removed ${reconcile.removed.length} file${reconcile.removed.length === 1 ? "" : "s"}`,
    );
  }
  // Voyage cost applies to refreshes only; deletes are free. Show 4 decimals
  // — incremental refresh spend is typically $0.0008–$0.05 per review.
  const head = `context: ${parts.join(", ")}`;
  if (reconcile.costUsd > 0) {
    return `${head} ($${reconcile.costUsd.toFixed(4)})`;
  }
  return head;
}
