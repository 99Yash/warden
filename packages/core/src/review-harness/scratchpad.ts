import type { LanguageModelUsage } from "@warden/ai";
import type { Comment, DegradedEntry } from "../schema.js";
import type { DetPriors } from "./det-priors.js";

/**
 * Per-worker output recorded into the scratchpad by the `dispatch_worker`
 * tool. `findings` is the worker's `WorkerFinding[]` (a Comment-shaped
 * envelope before boss-side dedup/reframe); `toolCalls` counts how many
 * inner `lookupTypeDef` / `readFile` / `grepRepo` invocations the worker
 * burned; `degraded` carries the worker's degraded entries (verifier-drop
 * notices, lookup-not-installed, etc.).
 *
 * `usage` is counted per inner streamText step so the cost line can be
 * priced per model request, also when the call fails. `phase` echoes back
 * the boss's render-UX label (`plan` / `adjudicate` / `synth`) — kept for
 * post-hoc inspection, not for any control-flow decision.
 */
export interface WorkerOutput {
  /** Concern slug routed by the boss (`correctness` / `security` / etc.). */
  concern: string;
  /** Files the boss scoped this worker to. Lane discipline drops findings outside this set. */
  files: string[];
  /** Worker findings (Comment-shaped; boss may dedupe before final synth). */
  findings: Comment[];
  /** Inner-tool-call count for this worker invocation. */
  toolCalls: number;
  /** Degraded entries this worker produced (e.g. verifier drops, tool errors). */
  degraded: DegradedEntry[];
  /** Boss-supplied phase label echoed back. */
  phase: "plan" | "adjudicate" | "synth";
  /** Wall-clock duration of the worker streamText call. */
  durationMs: number;
  /**
   * Usage of the worker's streamText call: the sum, one entry per model
   * request, and the count of requests whose usage is unknown. Present on
   * a failed call too when the call spent tokens before it failed.
   */
  usage?: CallUsage;
  /**
   * Actual model tier the worker ran on. Captured at dispatch time so
   * `runReviewHarness()` can compute the per-tier cost summary without
   * re-deriving from the (concern, override?) pair. Carried alongside
   * `usage` because the boss can promote/demote a worker via the
   * dispatch tool's `tier?` field.
   */
  tier?: "sonnet" | "haiku";
  /**
   * True when this dispatch's LLM call errored and produced no output (vs a
   * worker that ran cleanly and found nothing). `runReviewHarness()` reads
   * this across all dispatches to detect the all-workers-failed false-clean
   * (issue #29). Absent/false = the worker completed (with or without
   * findings).
   */
  failed?: boolean;
}

/**
 * Token usage counts. Read per step from the AI SDK v6 `streamText`
 * `onStepFinish` callback (see `CallUsageMeter`).
 * Cost-tracking SQLite (`reviewRuns`) is deferred per M14 Q12; v0 keeps
 * usage in-memory on the scratchpad and renders it via
 * `packages/cli/src/render.ts`.
 */
export interface TokenUsage {
  /** Total input tokens, including cache reads and cache writes (AI SDK 6). */
  inputTokens: number;
  outputTokens: number;
  /** Cache-read part of `inputTokens`, when the provider reports it. */
  cachedInputTokens?: number;
  /** Cache-write part of `inputTokens`; only Anthropic reports it. */
  cacheWriteInputTokens?: number;
}

/** Map an AI SDK 6 usage object onto the harness `TokenUsage` shape. */
export function tokenUsageFromSdk(usage: LanguageModelUsage): TokenUsage {
  const { cacheReadTokens, cacheWriteTokens } = usage.inputTokenDetails;
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    ...(cacheReadTokens !== undefined ? { cachedInputTokens: cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteInputTokens: cacheWriteTokens } : {}),
  };
}

/** Add `next` into `acc` in place. Optional cache counts stay absent until reported. */
export function accumulateTokenUsage(
  acc: TokenUsage,
  next: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cachedInputTokens?: number | undefined;
    readonly cacheWriteInputTokens?: number | undefined;
  },
): void {
  acc.inputTokens += next.inputTokens;
  acc.outputTokens += next.outputTokens;
  if (next.cachedInputTokens !== undefined) {
    acc.cachedInputTokens = (acc.cachedInputTokens ?? 0) + next.cachedInputTokens;
  }
  if (next.cacheWriteInputTokens !== undefined) {
    acc.cacheWriteInputTokens = (acc.cacheWriteInputTokens ?? 0) + next.cacheWriteInputTokens;
  }
}

/**
 * Usage of one model call (one `streamText` run, all of its tool-loop
 * steps). Usage is telemetry: no reader may fail a review on it.
 */
export interface CallUsage {
  /** Sum over `requests`. */
  total: TokenUsage;
  /**
   * One entry per model request (tool-loop step) that reported usage. The
   * long-context price tiers apply per request, so the cost is priced from
   * these entries, not from `total`.
   */
  requests: TokenUsage[];
  /**
   * Model requests (or retried attempts) that started but reported no
   * usage: an error, a timeout, or an abort during the request. The
   * provider can bill these, so when this is above 0 the cost is a lower
   * bound. Warden does not guess a number for them.
   */
  unknownRequests: number;
}

export function emptyCallUsage(): CallUsage {
  return { total: { inputTokens: 0, outputTokens: 0 }, requests: [], unknownRequests: 0 };
}

/** Add `next` into `acc` in place. */
export function mergeCallUsage(acc: CallUsage, next: CallUsage): void {
  accumulateTokenUsage(acc.total, next.total);
  acc.requests.push(...next.requests);
  acc.unknownRequests += next.unknownRequests;
}

/**
 * Counts the usage of one `streamText` call step by step, so that a call
 * that fails still records the tokens it spent.
 *
 * Why not `result.totalUsage`: in `ai@6.0.77` (`dist/index.mjs`, the
 * `flush` of the event processor), `totalUsage` rejects when no step
 * finished, and resolves to the all-`undefined` null usage when a later
 * step errors or the call aborts (the final `finish` part never arrives).
 * Both cases lose the usage of the steps that did finish. `onStepFinish`
 * fires once per finished step with that step's usage, and `prepareStep`
 * fires once before each step's model request, so the difference between
 * the two counts is the requests whose usage is unknown.
 *
 * Wire it with `prepareStep: meter.prepareStep` and
 * `onStepFinish: meter.onStepFinish`. Every method is total: none throws.
 */
export class CallUsageMeter {
  private readonly requests: TokenUsage[] = [];
  private unknown = 0;
  private pending = false;
  private pendingFailedAttempts = 0;

  /** `streamText({ prepareStep })` hook. Returns `undefined`: no step override. */
  readonly prepareStep = (): undefined => {
    // Steps run in sequence, so a step that is still pending here never
    // reported usage.
    if (this.pending) this.unknown += Math.max(1, this.pendingFailedAttempts);
    this.pending = true;
    this.pendingFailedAttempts = 0;
    return undefined;
  };

  /** `streamText({ onStepFinish })` hook. */
  readonly onStepFinish = (step: { readonly usage: LanguageModelUsage }): void => {
    const { usage } = step;
    if (usage.inputTokens === undefined && usage.outputTokens === undefined) {
      // A step that ends on a stream error has the null usage.
      this.unknown += 1;
    } else {
      this.requests.push(tokenUsageFromSdk(usage));
    }
    // A failed attempt that a retry recovered is a request with no usage.
    this.unknown += this.pendingFailedAttempts;
    this.pending = false;
    this.pendingFailedAttempts = 0;
  };

  /**
   * Record one failed attempt of the current request (for example from an
   * `ai-retry` `onError` callback). The attempt can be billed, but the
   * provider reports no usage for it.
   */
  attemptFailed(): void {
    this.pendingFailedAttempts += 1;
  }

  /** The usage known so far. Safe to call after a failure. */
  snapshot(): CallUsage {
    const total: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    for (const r of this.requests) accumulateTokenUsage(total, r);
    const inFlight = this.pending ? Math.max(1, this.pendingFailedAttempts) : 0;
    return {
      total,
      requests: this.requests.map((r) => ({ ...r })),
      unknownRequests: this.unknown + inFlight,
    };
  }
}

/**
 * In-memory scratchpad for the M14 review harness. Different shape from the
 * M8 `Scratchpad` (which keyed `RunnerOutput` by runner name). The harness
 * never needs name-keyed lookup — the boss reads worker results via the
 * tool-call return values, not by polling the scratchpad — so the scratchpad
 * is structured around append-only worker outputs + a single det-priors
 * snapshot + accumulated tokens + a flat degraded list.
 *
 * `ReviewScratchpad` intentionally does NOT carry a structured `plan` field
 * (M14-security's design did). The dynamic boss loop emits dispatch
 * decisions per round rather than upfront, so there is no plan to store.
 *
 * Per ADR-0030, cost tracking is deferred (no `costUsd` field, no SQLite
 * `reviewRuns` table). Token usage is summed so render.ts can compute a
 * cost line at the end of the run; persistence lands when `--deep` ships
 * in M15+ and the cost story matters across both verbs.
 */
/**
 * Per-dispatch concurrency datapoint (ADR-0033). Recorded by
 * `runOneDispatch` in the dispatch tool right after the per-tier semaphore
 * resolves. `waitMs` is the wall-clock time the dispatch spent blocked
 * waiting for a slot — 0 when the dispatch acquired immediately. The
 * aggregator on `ReviewScratchpad` rolls these into a single info entry
 * the harness emits when the cap actually engaged.
 */
export interface ConcurrencyMetric {
  /** Milliseconds the dispatch spent blocked at `acquire()` before running. */
  waitMs: number;
}

/**
 * Output shape of `ReviewScratchpad.concurrencyAggregate()`. `null` when
 * no dispatch was queued — i.e., the cap never engaged. The harness reads
 * this once at the end of Phase 2 and only emits the info entry on a
 * non-null return; the happy path stays silent.
 */
export interface ConcurrencyAggregate {
  /** Total dispatches that booked a slot (regardless of wait time). */
  totalDispatches: number;
  /** Subset of `totalDispatches` whose `waitMs > 0`. */
  totalQueued: number;
  /** Max `waitMs` across all queued dispatches. */
  maxWaitMs: number;
  /** Sum of `waitMs` across all queued dispatches. */
  totalQueuedMs: number;
}

export class ReviewScratchpad {
  private _detPriors: DetPriors | undefined;
  private readonly _workerOutputs: WorkerOutput[] = [];
  private readonly _degraded: DegradedEntry[] = [];
  private _bossUsage: CallUsage | undefined;
  private readonly _workerUsage: CallUsage = emptyCallUsage();
  private readonly _concurrencyMetrics: ConcurrencyMetric[] = [];

  /**
   * Phase 1 result. Set exactly once by the harness; reading before set
   * returns `undefined`. The boss prompt-assembly path reads this to
   * include det-prior findings in the boss's initial user message.
   */
  recordDetPriors(detPriors: DetPriors): void {
    this._detPriors = detPriors;
  }

  detPriors(): DetPriors | undefined {
    return this._detPriors;
  }

  /**
   * Append a worker output. The boss loop calls this once per
   * `dispatch_worker` tool invocation. Order matches dispatch order; the
   * boss reads worker results via the tool-call return value, not by
   * iterating the scratchpad — `workerOutputs()` is for post-hoc render
   * + final-synth assembly.
   */
  recordWorker(output: WorkerOutput): void {
    this._workerOutputs.push(output);
    if (output.usage) mergeCallUsage(this._workerUsage, output.usage);
  }

  workerOutputs(): readonly WorkerOutput[] {
    return this._workerOutputs;
  }

  /** Free-form degraded entries not tied to a specific worker (e.g. boss-loop budget cap). */
  recordDegraded(entry: DegradedEntry): void {
    this._degraded.push(entry);
  }

  /**
   * Boss-loop usage (single accumulator across all boss rounds). The boss
   * records it on failure too, so a failed review still knows its spend.
   */
  recordBossUsage(usage: CallUsage): void {
    if (!this._bossUsage) this._bossUsage = emptyCallUsage();
    mergeCallUsage(this._bossUsage, usage);
  }

  bossUsage(): CallUsage | undefined {
    return this._bossUsage;
  }

  bossTokens(): TokenUsage | undefined {
    return this._bossUsage?.total;
  }

  workerTokens(): TokenUsage {
    return this._workerUsage.total;
  }

  /**
   * Flatten every degraded entry the scratchpad has seen: from det priors,
   * from each worker output, and from scratchpad-level entries
   * (`recordDegraded`). Harness merges this with environmental degraded
   * entries before returning.
   */
  flattenDegraded(): DegradedEntry[] {
    const out: DegradedEntry[] = [];
    if (this._detPriors) out.push(...this._detPriors.degraded);
    for (const w of this._workerOutputs) out.push(...w.degraded);
    out.push(...this._degraded);
    return out;
  }

  /** Aggregate read of every worker's findings. Boss synth and render both use this. */
  flattenWorkerFindings(): Comment[] {
    return this._workerOutputs.flatMap((w) => w.findings);
  }

  /**
   * ADR-0033 — record one dispatch's concurrency wait. Called by
   * `runOneDispatch` in the dispatch tool right after the per-tier
   * semaphore returns. `waitMs` of 0 means the dispatch got its slot
   * immediately; positive values mean it queued behind in-flight work.
   */
  recordConcurrencyMetric(metric: ConcurrencyMetric): void {
    this._concurrencyMetrics.push(metric);
  }

  /**
   * ADR-0033 — fold the per-dispatch metrics into a single aggregate.
   * Returns `null` when no dispatch was queued (the cap never engaged);
   * the harness skips the info entry on null so the happy path stays
   * silent. Discipline: the four numbers the surface message renders
   * (queued/total/max-wait/total-wait) all derive from this aggregate.
   */
  concurrencyAggregate(): ConcurrencyAggregate | null {
    if (this._concurrencyMetrics.length === 0) return null;
    let totalQueued = 0;
    let maxWaitMs = 0;
    let totalQueuedMs = 0;
    for (const m of this._concurrencyMetrics) {
      if (m.waitMs > 0) {
        totalQueued += 1;
        totalQueuedMs += m.waitMs;
        if (m.waitMs > maxWaitMs) maxWaitMs = m.waitMs;
      }
    }
    if (totalQueued === 0) return null;
    return {
      totalDispatches: this._concurrencyMetrics.length,
      totalQueued,
      maxWaitMs,
      totalQueuedMs,
    };
  }
}
