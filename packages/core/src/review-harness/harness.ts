import type { ContextSelector } from "../context/index.js";
import type { FormatterListener } from "../llm/index.js";
import type {
  CommentSet,
  DegradedEntry,
  RetrievedContext,
} from "../schema.js";
import { runDetPriors, type DetPriors } from "./det-priors.js";
import { ReviewScratchpad } from "./scratchpad.js";

/**
 * Local mirror of `ReviewConfig` from `../index.ts`. Defined here to avoid
 * the harness → index → harness circular import while the scaffold lands.
 * When `review()` is rewired to call `runReviewHarness()`, the index-level
 * `ReviewConfig` is the structural superset of this and threads through.
 */
export interface ReviewHarnessConfig {
  mode: "check" | "review";
  /** When `true`, tier-3 (style/dedup) findings are surfaced. Default suppresses them. */
  verbose?: boolean;
}

/**
 * Entry point for the M14 review harness (ADR-0030).
 *
 * Pipeline:
 *   - Phase 1 — `runDetPriors()`: deterministic detectors + selector run
 *     in parallel; produces `ToolFinding[]` + retrieved context + degraded.
 *   - Phase 2 — `runBossLoop()` (NOT YET IMPLEMENTED): Opus 4.6 boss runs a
 *     `streamText` tool-use loop with `stopWhen: stepCountIs(env.WARDEN_REVIEW_BOSS_ROUNDS ?? 5)`;
 *     dispatches Sonnet/Haiku workers per concern via the `dispatch_worker`
 *     tool; final round emits `Output.array(CommentSchema)`.
 *   - Phase 3 — `verifyCitations()` + `applyHardRules()` (existing M10/M13
 *     paths): substring-verifies snippet sources, drops Comments with no
 *     verified source, applies the confidence floor + Tier-3 verbose gate
 *     + priority sort.
 *
 * This commit ships scaffold only. Phase 2 throws when reached; Phase 1's
 * envelope is fully wired and ready to feed the boss-loop once it lands.
 * Nothing in `packages/core/src/index.ts` calls `runReviewHarness()` yet —
 * the existing M8 spine continues to drive `review()`.
 */
export interface ReviewHarnessInput {
  diff: string;
  repoRoot: string;
  config: ReviewHarnessConfig;
  /**
   * Override the M5/M6 cheap-signals selector. Default constructs a
   * `CheapSignalsSelector`. Pass `null` to skip context selection entirely
   * (test harnesses).
   */
  selector?: ContextSelector | null;
  /**
   * Pre-computed retrieved context. When provided, the selector is skipped
   * and this value flows directly to the boss prompt.
   */
  retrievedContext?: RetrievedContext;
  /** Listener for streaming events (boss-loop rounds, worker progress). */
  emit?: FormatterListener;
}

class BossLoopNotImplementedError extends Error {
  constructor() {
    super(
      "review-harness: Phase 2 (boss loop) not yet implemented in this scaffold commit. " +
        "Wire `runBossLoop()` in once boss-loop.ts lands.",
    );
    this.name = "BossLoopNotImplementedError";
  }
}

export async function runReviewHarness(input: ReviewHarnessInput): Promise<CommentSet> {
  const startedAt = Date.now();

  // Phase 1 — deterministic priors + selector. Always runs; check-mode
  // consumers (eventual `runCheck()`) call `runDetPriors()` directly.
  const detPriors = await runDetPriors({
    diff: input.diff,
    repoRoot: input.repoRoot,
    mode: input.config.mode,
    selector: input.selector,
    retrievedContext: input.retrievedContext,
  });

  // No package.json → empty result with the ecosystem degraded entry.
  // Matches the early-return that lives in `review()` today.
  if (!detPriors.ecosystem.hasPackageJson) {
    return makeEmptySet(startedAt, [
      ...detPriors.degraded,
      {
        kind: "info",
        topic: "ecosystem",
        message: "ecosystem: no package.json at repoRoot — TS/JS only in v0",
      },
    ]);
  }

  // Empty-diff early-return (M14 plan §Design nuances). Zero LLM calls,
  // zero cost; do not instantiate the scratchpad. Det-priors still ran so
  // its degraded entries (gitignore-ensure, banner lookup, etc.) surface.
  if (detPriors.changed.length === 0) {
    return makeEmptySet(startedAt, detPriors.degraded);
  }

  // Phase 2 — boss loop. Not implemented in the scaffold commit. The
  // scratchpad is instantiated here so the type-flow that the boss-loop
  // expects is in place; once `runBossLoop()` lands, replace the throw
  // with `await runBossLoop({ scratchpad, detPriors, ... })`.
  const scratchpad = new ReviewScratchpad();
  scratchpad.recordDetPriors(detPriors);
  throw new BossLoopNotImplementedError();
}

function makeEmptySet(startedAt: number, degraded: DegradedEntry[]): CommentSet {
  return {
    comments: [],
    metadata: {
      durationMs: Date.now() - startedAt,
      degradedWorkers: degraded,
    },
  };
}

export type { DetPriors };
export { runDetPriors } from "./det-priors.js";
export {
  ReviewScratchpad,
  type TokenUsage,
  type WorkerOutput,
} from "./scratchpad.js";
