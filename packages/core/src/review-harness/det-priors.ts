import { CURRENT_DEFAULT, getEmbeddingProvider } from "@warden/ai";
import {
  bannerStateToDegraded,
  computeBannerState,
  type BannerState,
} from "../banner/index.js";
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
import { walkRepo } from "../init/walk.js";
import {
  SqliteChunkStore,
  SqliteEmbeddingStore,
  readLockedModel,
} from "../indexing/index.js";
import { runConsistency } from "../runners/consistency.js";
import { runDeadcode } from "../runners/deadcode.js";
import { runEslint } from "../runners/eslint.js";
import { runEslintSecurity } from "../runners/eslint-security.js";
import { runJscpd } from "../runners/jscpd.js";
import { leverageRunner } from "../runners/leverage.js";
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
  if (input.mode === "review") {
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
      environmentalDegraded.push({
        kind: "warning",
        topic: "banner",
        message: `banner: state lookup failed (${formatErr(err)})`,
      });
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
