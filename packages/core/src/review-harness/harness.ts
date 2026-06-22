import {
  getReviewModelLabelsByTier,
  getReviewModelPricingByTier,
  type LlmModelPrice,
  type ReviewCostTier,
} from "@warden/ai";
import { createId, db, reviewRuns } from "@warden/db";
import { wardenEnv } from "@warden/env";
import { createHash } from "node:crypto";
import type { ContextSelector } from "../context/index.js";
import type { FormatterListener } from "../llm/index.js";
import { verifyCitations } from "../llm/verify-citations.js";
import { Semaphore } from "../orchestration/semaphore.js";
import type {
  CommentSet,
  CostByTier,
  CostLabelsByTier,
  DegradedEntry,
  RetrievedContext,
  TokenUsageBlock,
  TokenUsageByTier,
} from "../schema.js";
import { BOSS_LOOP_DEFAULTS, runBossLoop, type BossLoopConfig } from "./boss-loop.js";
import { scopeCommentsToDiff } from "./comment-scope.js";
import { runDetPriors, type DetPriors } from "./det-priors.js";
import { ReviewScratchpad, type TokenUsage } from "./scratchpad.js";
import type { DispatchConcurrency } from "./tools/dispatch-worker.js";
import { makeWorkerRoute } from "./workers/index.js";

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
  /**
   * M15 (ADR-0031) boss-loop calibration knobs. Defaults preserve M14
   * behavior. Surfaced on `ReviewHarnessConfig` (and re-threaded from
   * `ReviewConfig` at the public-API boundary) so the eval suite + future
   * callers can flip programmatic dispatch / prompt variant per run.
   */
  bossLoop?: BossLoopConfig;
}

/**
 * Entry point for the M14 review harness (ADR-0030).
 *
 * Three phases, end-to-end:
 *   - Phase 1 — `runDetPriors()`: deterministic detectors + selector run
 *     in parallel; produces `ToolFinding[]` + retrieved context + degraded.
 *   - Phase 2 — `runBossLoop()`: Opus 4.6 boss runs a `streamText` tool-use
 *     loop with `stopWhen: stepCountIs(env.WARDEN_REVIEW_BOSS_ROUNDS ?? 5)`;
 *     dispatches Sonnet/Haiku workers per concern via the `dispatch_worker`
 *     tool; final round calls the terminal `submit_review` tool with
 *     `{ comments: Comment[] }`.
 *   - Phase 3 — `verifyCitations()`: substring-verifies every `{path, line,
 *     snippet}` citation against the cited file; drops Comments left
 *     without a verified source.
 *
 * `applyHardRules()` (priority sort + Tier-3 verbose gate + confidence
 * floor) is intentionally NOT run here — it depends on `ReviewConfig.mode`
 * + `verbose` and is shared with the check-mode codepath. The caller in
 * `packages/core/src/index.ts` applies it uniformly after this harness OR
 * after `runDetPriors() + toComment()` (check mode).
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
  /**
   * ADR-0046: the diff's resolved base ref, forwarded to `runDetPriors` so the
   * react-doctor det-prior can drive its `--scope changed` delta.
   */
  diffBase?: { baseRef?: string; description: string };
}

export type ReviewHarnessResult = CommentSet;

export async function runReviewHarness(input: ReviewHarnessInput): Promise<ReviewHarnessResult> {
  const startedAt = Date.now();

  // Phase 1 — deterministic priors + selector. Always runs; check-mode
  // consumers (eventual `runCheck()`) call `runDetPriors()` directly.
  const detPriors = await runDetPriors({
    diff: input.diff,
    repoRoot: input.repoRoot,
    mode: input.config.mode,
    selector: input.selector,
    retrievedContext: input.retrievedContext,
    ...(input.diffBase !== undefined ? { diffBase: input.diffBase } : {}),
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

  // ADR-0048 §2 — durable review-run identity. Minted once, here (after the
  // empty-diff / no-package early returns so a no-LLM run never claims a
  // run-id), then threaded to the boss loop + worker route as the Langfuse
  // trace-grouping key and persisted to `reviewRuns` at the end. `inputHash`
  // is the content-addressed dedup/resume key (§8 / issue #33).
  const runId = createId("run");
  const modelLabels = getReviewModelLabelsByTier();
  const inputHash = computeInputHash(input, modelLabels);

  // Phase 2 — boss loop. The scratchpad shares state between the dispatch
  // tool (which records per-worker output + token usage) and the post-loop
  // assembly (which drains degraded entries + worker findings if the boss
  // needs to be backfilled from worker outputs at synth time).
  const scratchpad = new ReviewScratchpad();
  scratchpad.recordDetPriors(detPriors);

  // Shared api-claim-verifier degraded collector for all worker
  // `lookupTypeDef` calls (once-per-review "no node_modules/" entry).
  const apiClaimDegraded: DegradedEntry[] = [];
  const route = makeWorkerRoute({
    repoRoot: input.repoRoot,
    changed: detPriors.changed,
    apiClaimDegraded,
    runId,
    ...(input.config.bossLoop?.workerPromptVariant !== undefined
      ? { workerPromptVariant: input.config.bossLoop.workerPromptVariant }
      : {}),
    ...(input.config.bossLoop?.reasonedFindingMode !== undefined
      ? { reasonedFindingMode: input.config.bossLoop.reasonedFindingMode }
      : {}),
  });

  const workerBudgetRaw = wardenEnv().WARDEN_REVIEW_WORKER_BUDGET;
  const workerBudget = workerBudgetRaw ? Number(workerBudgetRaw) : undefined;

  // ADR-0033: per-tier dispatch concurrency. Constructed once per review;
  // both Round 0's `Promise.all` and the boss's in-loop dispatches flow
  // through the same per-tier semaphores. Defaults (4 strong / 8 cheap)
  // are applied here, not in the env layer, so test/smoke call sites that
  // bypass the harness can omit the env vars entirely.
  const concurrency = buildDispatchConcurrency();

  const bossOutput = await runBossLoop({
    repoRoot: input.repoRoot,
    diff: input.diff,
    detPriors,
    scratchpad,
    route,
    runId,
    ...(workerBudget !== undefined ? { workerBudget } : {}),
    concurrency,
    ...(input.config.bossLoop !== undefined ? { config: input.config.bossLoop } : {}),
    ...(input.emit ? { emit: input.emit } : {}),
  });

  // Phase 3 — citation verify. Substring-checks every `{path, line, snippet}`
  // citation against the cited file at `line ± DRIFT` and drops Comments
  // left without a verified source. Failure modes surface as info-level
  // degraded entries under `topic: "llm"`. Tier-3 verbose-gate + priority
  // sort + confidence floor live in `applyHardRules()` at the caller —
  // they're mode/config-dependent and shared with the check-mode codepath.
  const verified = await verifyCitations({
    comments: bossOutput.comments,
    repoRoot: input.repoRoot,
  });
  const scoped = scopeCommentsToDiff(verified.comments, detPriors.changed);

  // Aggregate degraded entries from every layer: det-priors, every worker
  // recorded into the scratchpad, the dispatch tool's budget-cap entries
  // (also on the scratchpad), the boss-loop's cascade-engaged entries,
  // the shared lookupTypeDef collector, and the Phase 3 verifier. Order
  // is intentional — environment entries first, worker-level entries
  // next, boss-level entries third, verifier entries last.
  const aggregatedDegraded: DegradedEntry[] = [
    ...scratchpad.flattenDegraded(),
    ...bossOutput.degraded,
    ...apiClaimDegraded,
    ...verified.degraded,
  ];
  if (scoped.droppedCount > 0) {
    aggregatedDegraded.push({
      kind: "info",
      topic: "review-harness",
      message:
        `diff-scope: dropped ${scoped.droppedCount} ` +
        `comment${scoped.droppedCount === 1 ? "" : "s"} outside added diff lines`,
    });
  }

  // ADR-0033: emit a single info entry when the dispatch concurrency cap
  // actually engaged. Silent on the happy path — `concurrencyAggregate()`
  // returns null when no dispatch had to queue.
  const concurrencyAgg = scratchpad.concurrencyAggregate();
  if (concurrencyAgg !== null) {
    aggregatedDegraded.push({
      kind: "info",
      topic: "worker-concurrency",
      message:
        `concurrency cap engaged: ${concurrencyAgg.totalQueued}/${concurrencyAgg.totalDispatches} ` +
        `dispatches queued (max wait ${formatMsAsSeconds(concurrencyAgg.maxWaitMs)}, ` +
        `total queued time ${formatMsAsSeconds(concurrencyAgg.totalQueuedMs)})`,
    });
  }

  // Per-tier token-usage bucket: opus (boss) + sonnet/haiku (workers).
  // Workers record their actual tier in the scratchpad even when the boss
  // overrode the per-concern default, so this aggregation is honest.
  const tokenUsage = buildTokenUsageByTier(scratchpad.bossTokens(), scratchpad.workerOutputs());
  const costs = await computeCosts(tokenUsage);

  // ADR-0048 §2 — persist the review-run row best-effort. Failure surfaces as
  // an info degraded entry and never blocks the review (caveat in the ADR).
  const recordDegraded = recordReviewRun({
    runId,
    inputHash,
    mode: input.config.mode,
    modelLabels,
    tokenUsage,
    costUsd: costs?.costUsd ?? 0,
    commentsEmitted: scoped.comments.length,
  });
  aggregatedDegraded.push(...recordDegraded);

  return {
    comments: scoped.comments,
    metadata: {
      durationMs: Date.now() - startedAt,
      degradedWorkers: aggregatedDegraded,
      runId,
      ...(tokenUsage !== undefined ? { tokenUsage } : {}),
      ...(costs !== undefined
        ? {
            costUsd: costs.costUsd,
            costByTier: costs.costByTier,
            costLabels: costs.costLabels,
          }
        : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// ADR-0048 §2 — review-run identity + persistence.
// ---------------------------------------------------------------------------

/**
 * Content-addressed dedup/resume key over `(diff_hash, resolved config,
 * sorted model-set)` — ADR-0048 §2. Two genuine re-runs of the same diff,
 * config, and models collapse to the same `inputHash` (the §8 / issue-#33
 * resume lookup), while each keeps a distinct random `id`.
 *
 * The "resolved config" folds in the boss-loop defaults so the variant
 * composition (`bossPromptVariant` / `workerPromptVariant` /
 * `reasonedFindingMode` / programmatic-dispatch shape) is part of the key —
 * flipping a variant misses the cache, as ADR-0048 §8 requires. Hashing the
 * actual prompt-file *contents* (vs. the variant selector) is deferred to the
 * resume pass (#33).
 */
function computeInputHash(
  input: ReviewHarnessInput,
  modelLabels: Record<ReviewCostTier, string>,
): string {
  const resolvedConfig = {
    mode: input.config.mode,
    verbose: input.config.verbose ?? false,
    bossLoop: { ...BOSS_LOOP_DEFAULTS, ...(input.config.bossLoop ?? {}) },
  };
  const modelSet = [modelLabels.opus, modelLabels.sonnet, modelLabels.haiku].sort();
  const payload = JSON.stringify({
    diff: createHash("sha256").update(input.diff).digest("hex"),
    config: resolvedConfig,
    models: modelSet,
  });
  return createHash("sha256").update(payload).digest("hex");
}

function recordReviewRun(input: {
  runId: string;
  inputHash: string;
  mode: "check" | "review";
  modelLabels: Record<ReviewCostTier, string>;
  tokenUsage: TokenUsageByTier | undefined;
  costUsd: number;
  commentsEmitted: number;
}): DegradedEntry[] {
  // Sum input/output tokens across all tiers for the run-level row. The
  // per-tier breakdown lives on the live Langfuse spans (ADR-0048 §5); this
  // row is the durable identity + a coarse cost/usage summary.
  let inputTokens = 0;
  let outputTokens = 0;
  for (const block of [
    input.tokenUsage?.opus,
    input.tokenUsage?.sonnet,
    input.tokenUsage?.haiku,
  ]) {
    if (!block) continue;
    inputTokens += block.inputTokens;
    outputTokens += block.outputTokens;
  }
  try {
    db()
      .insert(reviewRuns)
      .values({
        id: input.runId,
        inputHash: input.inputHash,
        mode: input.mode,
        modelBoss: input.modelLabels.opus,
        modelWorkerStrong: input.modelLabels.sonnet,
        modelWorkerCheap: input.modelLabels.haiku,
        inputTokens,
        outputTokens,
        costUsd: input.costUsd,
        commentsEmitted: input.commentsEmitted,
      })
      .run();
    return [];
  } catch (err) {
    return [
      {
        kind: "info",
        topic: "review-harness",
        message: `review run record failed (${formatErr(err)})`,
      },
    ];
  }
}

function formatErr(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 160);
  return String(err).slice(0, 160);
}

// ---------------------------------------------------------------------------
// Per-tier usage aggregation + resolved model pricing.
//
// The `opus`/`sonnet`/`haiku` keys are retained as compatibility aliases:
// boss / worker-strong / worker-cheap. The concrete provider model behind
// each alias is resolved by `@warden/ai` from the available API keys.
//
// Cached input tokens are charged at the model's cached-input price. The
// `cachedInputTokens` figure is *non-cumulative* with `inputTokens`; the
// usage object reports them as a separate count for the cache-hit portion.
// We bill `inputTokens` at the full rate and `cachedInputTokens` separately.
// ---------------------------------------------------------------------------

function toUsageBlock(usage: TokenUsage): TokenUsageBlock {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cachedInputTokens !== undefined
      ? { cachedInputTokens: usage.cachedInputTokens }
      : {}),
  };
}

function addUsage(acc: TokenUsageBlock, next: TokenUsage): TokenUsageBlock {
  return {
    inputTokens: acc.inputTokens + next.inputTokens,
    outputTokens: acc.outputTokens + next.outputTokens,
    ...(acc.cachedInputTokens !== undefined || next.cachedInputTokens !== undefined
      ? {
          cachedInputTokens: (acc.cachedInputTokens ?? 0) + (next.cachedInputTokens ?? 0),
        }
      : {}),
  };
}

function buildTokenUsageByTier(
  bossTokens: TokenUsage | undefined,
  workerOutputs: readonly { tokenUsage?: TokenUsage; tier?: "sonnet" | "haiku" }[],
): TokenUsageByTier | undefined {
  let opus: TokenUsageBlock | undefined;
  let sonnet: TokenUsageBlock | undefined;
  let haiku: TokenUsageBlock | undefined;
  if (bossTokens) opus = toUsageBlock(bossTokens);
  for (const w of workerOutputs) {
    if (!w.tokenUsage || !w.tier) continue;
    if (w.tier === "sonnet") {
      sonnet = sonnet ? addUsage(sonnet, w.tokenUsage) : toUsageBlock(w.tokenUsage);
    } else {
      haiku = haiku ? addUsage(haiku, w.tokenUsage) : toUsageBlock(w.tokenUsage);
    }
  }
  if (opus === undefined && sonnet === undefined && haiku === undefined) {
    return undefined;
  }
  return {
    ...(opus !== undefined ? { opus } : {}),
    ...(sonnet !== undefined ? { sonnet } : {}),
    ...(haiku !== undefined ? { haiku } : {}),
  };
}

function tierCost(
  block: TokenUsageBlock | undefined,
  tier: ReviewCostTier,
  prices: Record<ReviewCostTier, LlmModelPrice>,
): number {
  if (!block) return 0;
  const price = prices[tier];
  // `inputTokens` per AI SDK v6 already excludes the cache-hit portion when
  // `cachedInputTokens` is reported — bill them separately at the cache rate.
  const inputCost = (block.inputTokens / 1_000_000) * price.input;
  const cachedCost =
    block.cachedInputTokens !== undefined
      ? (block.cachedInputTokens / 1_000_000) * price.cachedInput
      : 0;
  const outputCost = (block.outputTokens / 1_000_000) * price.output;
  return inputCost + cachedCost + outputCost;
}

async function computeCosts(
  usage: TokenUsageByTier | undefined,
): Promise<{ costUsd: number; costByTier: CostByTier; costLabels: CostLabelsByTier } | undefined> {
  if (!usage) return undefined;
  const prices = await getReviewModelPricingByTier();
  const labels = getReviewModelLabelsByTier();
  const opus = usage.opus !== undefined ? round4(tierCost(usage.opus, "opus", prices)) : undefined;
  const sonnet =
    usage.sonnet !== undefined ? round4(tierCost(usage.sonnet, "sonnet", prices)) : undefined;
  const haiku =
    usage.haiku !== undefined ? round4(tierCost(usage.haiku, "haiku", prices)) : undefined;
  // Sum the raw (unrounded) tier costs then round once to preserve the
  // pre-refactor `costUsd` value to the cent. Individual tier figures are
  // rounded for display.
  const total = round4(
    tierCost(usage.opus, "opus", prices) +
      tierCost(usage.sonnet, "sonnet", prices) +
      tierCost(usage.haiku, "haiku", prices),
  );
  return {
    costUsd: total,
    costByTier: {
      ...(opus !== undefined ? { opus } : {}),
      ...(sonnet !== undefined ? { sonnet } : {}),
      ...(haiku !== undefined ? { haiku } : {}),
    },
    costLabels: labels,
  };
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

// ---------------------------------------------------------------------------
// Concurrency cap construction + info-entry formatting (ADR-0033).
// ---------------------------------------------------------------------------

const DEFAULT_CONCURRENCY_STRONG = 4;
const DEFAULT_CONCURRENCY_CHEAP = 8;

function buildDispatchConcurrency(): DispatchConcurrency {
  const env = wardenEnv();
  const strong = env.WARDEN_WORKER_CONCURRENCY_STRONG
    ? Number(env.WARDEN_WORKER_CONCURRENCY_STRONG)
    : DEFAULT_CONCURRENCY_STRONG;
  const cheap = env.WARDEN_WORKER_CONCURRENCY_CHEAP
    ? Number(env.WARDEN_WORKER_CONCURRENCY_CHEAP)
    : DEFAULT_CONCURRENCY_CHEAP;
  return {
    strong: new Semaphore(strong),
    cheap: new Semaphore(cheap),
  };
}

function formatMsAsSeconds(ms: number): string {
  // One decimal place, with a trailing 's'. 14_234 → "14.2s". Used only
  // by the concurrency-cap info entry — kept local to avoid a generic
  // formatter ADR until a second call site earns it.
  return `${(ms / 1000).toFixed(1)}s`;
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
export { ReviewScratchpad, type TokenUsage, type WorkerOutput } from "./scratchpad.js";
