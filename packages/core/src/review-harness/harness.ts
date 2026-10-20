import {
  getReviewModelLabelsByTier,
  getReviewModelPricingByTier,
  recordDroppedCandidate,
  type LlmModelPrice,
  type ReviewCostTier,
} from "@warden/ai";
import { createId, db, eq, reviewRuns } from "@warden/db";
import { wardenEnv } from "@warden/env";
import type { ContextSelector } from "../context/index.js";
import { canonicalJson, sha256Hex } from "../hash.js";
import type { FormatterListener } from "../llm/index.js";
import { verifyCitations } from "../llm/verify-citations.js";
import { Semaphore } from "../orchestration/semaphore.js";
import { toComment } from "../runners/to-comment.js";
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
import {
  accumulateTokenUsage,
  ReviewScratchpad,
  type CallUsage,
  type TokenUsage,
} from "./scratchpad.js";
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
    ...(input.selector !== undefined ? { selector: input.selector } : {}),
    ...(input.retrievedContext !== undefined ? { retrievedContext: input.retrievedContext } : {}),
    ...(input.diffBase !== undefined ? { diffBase: input.diffBase } : {}),
  });
  // ADR-0054: these signals are published independently of model output,
  // including no-package and all-pruned early returns.
  const integrityComments = detPriors.findings
    .filter((f) => f.source === "input-integrity" || f.source === "secret-diff")
    .map(toComment);

  // No package.json → skip the model, but keep language-independent signals.
  if (!detPriors.ecosystem.hasPackageJson) {
    const result = makeEmptySet(startedAt, [
      ...detPriors.degraded,
      {
        kind: "info",
        topic: "ecosystem",
        message: "ecosystem: no package.json at repoRoot — TS/JS only in v0",
      },
    ]);
    return { ...result, comments: integrityComments };
  }

  // Empty-diff early-return (M14 plan §Design nuances). Zero LLM calls,
  // zero cost; do not instantiate the scratchpad. Det-priors still ran so
  // its degraded entries (gitignore-ensure, banner lookup, etc.) surface.
  if (detPriors.changed.length === 0) {
    return { ...makeEmptySet(startedAt, detPriors.degraded), comments: integrityComments };
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

  let bossOutput: Awaited<ReturnType<typeof runBossLoop>>;
  try {
    bossOutput = await runBossLoop({
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
  } catch (err) {
    // The boss hard-fails the review (ADR-0017 amendment), but the boss and
    // the workers already spent tokens. Write that spend to the review-run
    // row before the rethrow. Best-effort: this path never replaces `err`.
    await recordFailedReviewRun({
      runId,
      inputHash,
      mode: input.config.mode,
      modelLabels,
      scratchpad,
    });
    throw err;
  }

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
  const finalComments = [...scoped.comments, ...integrityComments];

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
    // ADR-0048 §4 — off-hunk scope-drop. Runs post-loop (outside any LLM-call
    // span), so `recordDroppedCandidate` mints its own run-id-grouped span
    // rather than relying on an ambient active span.
    recordDroppedCandidate("off-hunk", { runId, attrs: { "warden.count": scoped.droppedCount } });
  }

  // Issue #29: never let a review built entirely from errored workers render
  // as a clean result. A worker LLM call that 400s / times out returns no
  // findings and marks `failed`; if *every* dispatched worker failed, an empty
  // `comments` array is a false negative, not a clean diff. Surface it as an
  // `actionable` entry (visible in default mode, not just `--verbose`) so the
  // CLI can flag a non-zero signal and the user does not trust the silence.
  // A partial failure (some workers errored) gets a `warning` summary — the
  // review is still useful but incomplete.
  const dispatched = scratchpad.workerOutputs();
  const failedCount = dispatched.filter((w) => w.failed === true).length;
  if (dispatched.length > 0 && failedCount === dispatched.length) {
    aggregatedDegraded.push({
      kind: "actionable",
      topic: "worker-health",
      message:
        `all ${dispatched.length} review worker${dispatched.length === 1 ? "" : "s"} failed — ` +
        "this is NOT a clean result; findings are unreliable. Check provider keys/quota and rerun.",
    });
  } else if (failedCount > 0) {
    aggregatedDegraded.push({
      kind: "warning",
      topic: "worker-health",
      message:
        `${failedCount} of ${dispatched.length} review workers failed — ` +
        "results may be incomplete.",
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
  const { tokenUsage, unknownRequests } = summarizeUsage(scratchpad);
  const costs = await computeCosts(tokenUsage);
  if (unknownRequests > 0) {
    aggregatedDegraded.push(unknownUsageEntry(unknownRequests));
  }

  // ADR-0048 §2 — persist the review-run row best-effort. Failure surfaces as
  // an info degraded entry and never blocks the review (caveat in the ADR).
  const recordDegraded = recordReviewRun({
    runId,
    inputHash,
    mode: input.config.mode,
    modelLabels,
    tokenUsage,
    costUsd: costs?.costUsd ?? 0,
    commentsEmitted: finalComments.length,
    usageUnknownRequests: unknownRequests,
  });
  aggregatedDegraded.push(...recordDegraded);

  return {
    comments: finalComments,
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
      ...(unknownRequests > 0 ? { usageUnknownRequests: unknownRequests } : {}),
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
 * flipping a variant misses the cache, as ADR-0048 §8 requires. It also folds
 * in the output-affecting env knobs (boss rounds, worker budget, react-doctor,
 * confidence floor) and the diff base ref so two materially different reviews
 * never alias to the same resume key. Hashing the actual prompt-file
 * *contents* (vs. the variant selector) is deferred to the resume pass (#33).
 *
 * The pre-image is `canonicalJson`, not `JSON.stringify`, so the key does not
 * depend on the order the config objects' keys were inserted in. Keys written before 2026-10-18
 * hashed `JSON.stringify` and do not match keys written after; nothing reads
 * `input_hash` yet (resume is deferred), so an older row is only a miss.
 */
function computeInputHash(
  input: ReviewHarnessInput,
  modelLabels: Record<ReviewCostTier, string>,
): string {
  const env = wardenEnv();
  const resolvedConfig = {
    mode: input.config.mode,
    verbose: input.config.verbose ?? false,
    bossLoop: { ...BOSS_LOOP_DEFAULTS, ...input.config.bossLoop },
    // Output-affecting runtime knobs (ADR-0048 §8). Without these, two reviews
    // that differ only in e.g. boss-round count or whether the react-doctor
    // det-prior ran would collide on the resume key.
    runtime: {
      bossRounds: env.WARDEN_REVIEW_BOSS_ROUNDS ?? null,
      workerBudget: env.WARDEN_REVIEW_WORKER_BUDGET ?? null,
      reactDoctor: env.WARDEN_REACT_DOCTOR,
      confidenceFloor: env.WARDEN_SECURITY_CONFIDENCE_FLOOR ?? null,
    },
    // react-doctor's `--scope changed` delta is keyed off the base ref.
    diffBase: input.diffBase?.baseRef ?? null,
  };
  const modelSet = [modelLabels.opus, modelLabels.sonnet, modelLabels.haiku].sort();
  return sha256Hex(
    canonicalJson({ diff: sha256Hex(input.diff), config: resolvedConfig, models: modelSet }),
  );
}

function recordReviewRun(input: {
  runId: string;
  inputHash: string;
  mode: "check" | "review";
  modelLabels: Record<ReviewCostTier, string>;
  tokenUsage: TokenUsageByTier | undefined;
  costUsd: number;
  commentsEmitted: number;
  usageUnknownRequests: number;
}): DegradedEntry[] {
  // Sum input/output tokens across all tiers for the run-level row. The
  // per-tier breakdown lives on the live Langfuse spans (ADR-0048 §5); this
  // row is the durable identity + a coarse cost/usage summary.
  let inputTokens = 0;
  let outputTokens = 0;
  for (const block of [input.tokenUsage?.opus, input.tokenUsage?.sonnet, input.tokenUsage?.haiku]) {
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
        usageUnknownRequests: input.usageUnknownRequests,
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

/**
 * Write the review-run row for a review whose boss loop threw. The row
 * carries the spend known at the failure, so the durable record does not
 * read $0 for a run that spent tokens. `commentsEmitted` is 0: the review
 * emitted nothing. Never throws.
 */
async function recordFailedReviewRun(input: {
  runId: string;
  inputHash: string;
  mode: "check" | "review";
  modelLabels: Record<ReviewCostTier, string>;
  scratchpad: ReviewScratchpad;
}): Promise<void> {
  try {
    const { tokenUsage, unknownRequests } = summarizeUsage(input.scratchpad);
    const costs = await computeCosts(tokenUsage);
    recordReviewRun({
      runId: input.runId,
      inputHash: input.inputHash,
      mode: input.mode,
      modelLabels: input.modelLabels,
      tokenUsage,
      costUsd: costs?.costUsd ?? 0,
      commentsEmitted: 0,
      usageUnknownRequests: unknownRequests,
    });
  } catch {
    // Usage is telemetry; the boss error is the one the caller must see.
  }
}

/**
 * ADR-0048 §2 — correct a review-run row's `commentsEmitted` after the public
 * boundary (`packages/core/src/index.ts`) applies `applyHardRules()`: the
 * confidence floor + Tier-3 verbose gate run there, NOT in the harness, so
 * `recordReviewRun` can only persist the harness-level (post-citation,
 * post-scope) count. Callers that surface comments to the user should call
 * this with the final emitted count so the durable row stops overcounting.
 * Best-effort: a failed update never breaks a review.
 */
export function updateReviewRunCommentsEmitted(runId: string, commentsEmitted: number): void {
  try {
    db().update(reviewRuns).set({ commentsEmitted }).where(eq(reviewRuns.id, runId)).run();
  } catch {
    // Durable bookkeeping is non-authoritative dev tooling; swallow.
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
// AI SDK 6 reports `inputTokens` as the TOTAL input: it already includes the
// cache-read and cache-write parts (Anthropic: `total = input + cacheWrite +
// cacheRead`; OpenAI and Google: `total = prompt tokens`, cached included).
// `tierCost` splits the total into its three parts and bills each part once.
// ---------------------------------------------------------------------------

function toUsageBlock(usage: TokenUsageBlock): TokenUsageBlock {
  const block: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  accumulateTokenUsage(block, usage);
  return block;
}

function addUsage(acc: TokenUsageBlock, next: TokenUsage): TokenUsageBlock {
  const block: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  accumulateTokenUsage(block, acc);
  accumulateTokenUsage(block, next);
  return block;
}

/**
 * Per-tier token usage plus the count of model requests whose usage is
 * unknown, over the boss and every worker (failed ones included).
 */
function summarizeUsage(scratchpad: ReviewScratchpad): {
  tokenUsage: TokenUsageByTier | undefined;
  unknownRequests: number;
} {
  const boss = scratchpad.bossUsage();
  const workers = scratchpad.workerOutputs();
  let unknownRequests = boss?.unknownRequests ?? 0;
  for (const w of workers) unknownRequests += w.usage?.unknownRequests ?? 0;
  return { tokenUsage: buildTokenUsageByTier(boss, workers), unknownRequests };
}

function unknownUsageEntry(unknownRequests: number): DegradedEntry {
  return {
    kind: "info",
    topic: "cost",
    message:
      `cost: ${unknownRequests} model request${unknownRequests === 1 ? "" : "s"} ` +
      "failed, timed out, or aborted before the provider reported usage — " +
      "the token counts and the cost are lower bounds",
  };
}

function buildTokenUsageByTier(
  bossUsage: CallUsage | undefined,
  workerOutputs: readonly { usage?: CallUsage; tier?: "sonnet" | "haiku" }[],
): TokenUsageByTier | undefined {
  let opus: TokenUsageBlock | undefined;
  let sonnet: TokenUsageBlock | undefined;
  let haiku: TokenUsageBlock | undefined;
  if (bossUsage) opus = toUsageBlock(bossUsage.total);
  for (const w of workerOutputs) {
    if (!w.usage || !w.tier) continue;
    if (w.tier === "sonnet") {
      sonnet = sonnet ? addUsage(sonnet, w.usage.total) : toUsageBlock(w.usage.total);
    } else {
      haiku = haiku ? addUsage(haiku, w.usage.total) : toUsageBlock(w.usage.total);
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
  // `inputTokens` is the total input (AI SDK 6). Take the cache parts out so
  // each token is billed once: uncached at `input`, cache reads at
  // `cachedInput`, cache writes at `cacheWriteInput`. The uncached part equals
  // the SDK's `inputTokenDetails.noCacheTokens` for every installed provider.
  const cacheRead = block.cachedInputTokens ?? 0;
  const cacheWrite = block.cacheWriteInputTokens ?? 0;
  const noCache = Math.max(0, block.inputTokens - cacheRead - cacheWrite);
  const inputCost = (noCache / 1_000_000) * price.input;
  const cacheReadCost = (cacheRead / 1_000_000) * price.cachedInput;
  const cacheWriteCost = (cacheWrite / 1_000_000) * price.cacheWriteInput;
  const outputCost = (block.outputTokens / 1_000_000) * price.output;
  return inputCost + cacheReadCost + cacheWriteCost + outputCost;
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
