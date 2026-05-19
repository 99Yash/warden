import { tool } from "@warden/ai";
import { z } from "zod";
import type { Semaphore } from "../../orchestration/semaphore.js";
import type { Comment, DegradedEntry } from "../../schema.js";
import type { ReviewScratchpad, TokenUsage } from "../scratchpad.js";

/**
 * M14 (ADR-0030): `dispatch_worker` tool — the *only* tool the boss has
 * during the Phase 2 streamText loop. Every action the boss takes —
 * planning, adjudication, final-synth — comes through this tool. Each
 * call routes to a per-concern worker function (in `workers/`); the tool
 * descriptor handles budget enforcement, lane discipline, and scratchpad
 * recording.
 *
 * v0 commit ships the descriptor + injection seam only. The actual
 * worker-routing function (`workers/dispatch.ts`) lands in the next slice
 * — the boss-loop slice — alongside the 6 per-concern worker
 * implementations. Tests/smokes that exercise this tool inject a stub
 * `route` directly.
 *
 * Why is this a tool and not a sequence of N separate tools (one per
 * concern)? The boss decides per round which concerns are worth running
 * and which files each should look at. Modeling that decision through a
 * single tool whose `concern` arg is one of 6 values keeps the boss's
 * action surface narrow and the dispatch logic in one place. The
 * tradeoff: the LLM has to pick the concern value, which is a tiny
 * additional reasoning step compared to picking the tool name. For a
 * 5-round loop with at most ~10 dispatches total, the cost is invisible.
 */

export const ConcernEnum = z.enum([
  "correctness",
  "scalability",
  "consistency",
  "security",
  "committability",
  "leverage",
]);
export type Concern = z.infer<typeof ConcernEnum>;

export const TierEnum = z.enum(["sonnet", "haiku"]);
export type WorkerTier = z.infer<typeof TierEnum>;

export const PhaseEnum = z.enum(["plan", "adjudicate", "synth"]);
export type DispatchPhase = z.infer<typeof PhaseEnum>;

/**
 * Default tier per concern, per ADR-0030 §5. First four concerns get
 * deep-reasoning Sonnet by default; last two pattern-match cheaply on
 * Haiku. The boss can override per dispatch via the optional `tier?`
 * field on `dispatch_worker`'s input; `resolveWorkerTier()` is the
 * single point that applies the override-or-default rule.
 *
 * Exported so `run-worker.ts` (the route consumer) and the dispatch
 * boundary (this file, where the per-tier concurrency cap is acquired
 * per ADR-0033) read the same table.
 */
export const DEFAULT_TIER_BY_CONCERN: Record<Concern, WorkerTier> = {
  correctness: "sonnet",
  scalability: "sonnet",
  consistency: "sonnet",
  security: "sonnet",
  committability: "haiku",
  leverage: "haiku",
};

/**
 * Resolve a dispatch's tier from the per-concern default + optional boss
 * override. Used by the dispatch boundary (this file) to pick which
 * per-tier semaphore to acquire, and by `run-worker.ts` to pick which
 * `getWorker{Strong,Cheap}Model()` getter to call. Single source of
 * truth so the slot and the model match.
 */
export function resolveWorkerTier(
  concern: Concern,
  tier: WorkerTier | undefined,
): WorkerTier {
  return tier ?? DEFAULT_TIER_BY_CONCERN[concern];
}

/**
 * Per-tier semaphore pair the harness constructs once per `runReview()`
 * and threads into `makeDispatchWorkerTool()`. `strong` caps Sonnet
 * (deep reasoning) dispatches; `cheap` caps Haiku (pattern-match)
 * dispatches. Per ADR-0033: strong saturation does NOT starve cheap
 * workers — the per-tier split is the entire point.
 */
export interface DispatchConcurrency {
  strong: Semaphore;
  cheap: Semaphore;
}

const InputSchema = z.object({
  files: z
    .array(z.string().min(1))
    .min(1)
    .describe(
      "Repo-relative POSIX paths the worker is scoped to. Workers may use " +
        "readFile/grepRepo on paths outside this set for context, but any " +
        "finding whose `path` is outside this set is dropped (lane discipline). " +
        "Pick the smallest file set that fits the question you want the worker " +
        "to answer.",
    ),
  concern: ConcernEnum.describe(
    "Which worker concern to dispatch. Use the system prompt's tier-default " +
      "table when unsure: correctness/scalability/consistency/security default " +
      "to Sonnet; committability/leverage default to Haiku.",
  ),
  tier: TierEnum.optional().describe(
    "Override the worker tier. Default tier per concern is set in the system " +
      "prompt; pass this only when you need cheap-tier classification on a " +
      "normally-strong concern (or vice versa).",
  ),
  focus: z
    .string()
    .min(1)
    .max(500)
    .optional()
    .describe(
      "Narrow the worker's attention to a specific question. Free-form, but " +
        "short — one sentence is enough. Example: 'does the new `parseRange` " +
        "function correctly handle negative spans?'",
    ),
  phase: PhaseEnum.describe(
    "Which round-label this dispatch belongs to. `plan` = initial fan-out; " +
      "`adjudicate` = follow-up after reading earlier worker output; `synth` = " +
      "drafting the final comment set. Used by render UX, not control flow.",
  ),
});

/**
 * The return value the boss sees from a `dispatch_worker` call. `findings`
 * is the worker's `Comment[]` after lane-discipline drops; `toolCalls` is
 * the inner tool-call count (for the per-worker render line); `degraded`
 * carries the worker's degraded entries (verifier-drop notices, tool
 * errors, lane-drops). On budget exhaustion the tool returns
 * `{ findings: [], toolCalls: 0, degraded: [<budget entry>] }` and the
 * boss knows it must wind down.
 */
export interface DispatchWorkerResult {
  findings: Comment[];
  toolCalls: number;
  degraded: DegradedEntry[];
}

/**
 * Invocation envelope passed to the injected `route` function. Mirrors
 * `dispatch_worker`'s input plus `repoRoot` and any other harness-scoped
 * context workers will need (the scratchpad reference is intentionally
 * not threaded — workers don't write to it directly; the dispatch tool
 * does, after lane discipline).
 */
export interface WorkerInvocation {
  repoRoot: string;
  files: string[];
  concern: Concern;
  tier?: WorkerTier;
  focus?: string;
  phase: DispatchPhase;
}

export interface WorkerInvocationResult {
  findings: Comment[];
  toolCalls: number;
  degraded: DegradedEntry[];
  durationMs: number;
  tokenUsage?: TokenUsage;
  /**
   * Actual model tier the worker ran on. Computed by the route function
   * via the per-concern default + any boss-supplied override. Surfaced
   * here (rather than re-derived in `recordWorker`) so the harness can
   * bucket per-tier token usage when the boss promotes a Haiku-default
   * concern to Sonnet (or vice versa).
   */
  tier?: "sonnet" | "haiku";
}

export type WorkerRoute = (
  invocation: WorkerInvocation,
) => Promise<WorkerInvocationResult>;

export interface MakeDispatchWorkerToolOptions {
  repoRoot: string;
  scratchpad: ReviewScratchpad;
  /**
   * Total cap across the whole boss loop. `undefined` = unbounded (boss
   * self-budgets within the round cap × max-tool-calls-per-round). When
   * set, the (N+1)th call returns budget-exhaustion without invoking the
   * route function.
   */
  workerBudget?: number;
  /**
   * Worker-routing function. Provided by `workers/dispatch.ts` once that
   * lands; until then, callers (tests, smokes) inject a stub. Keeping
   * this as an option rather than importing a concrete dispatcher keeps
   * the boundary clean — the dispatch tool stays pure routing + safety.
   */
  route: WorkerRoute;
  /**
   * Per-tier concurrency cap (ADR-0033). When provided, every dispatch
   * acquires a slot from the tier matching the *resolved* worker tier
   * (i.e., `args.tier ?? DEFAULT_TIER_BY_CONCERN[args.concern]`) before
   * the route call, and releases in a `finally`. Wait time is recorded
   * into the scratchpad via `recordConcurrencyMetric()`. Omit for
   * unbounded dispatch — the test/smoke path defaults to this so the
   * route stays the unit of observation.
   */
  concurrency?: DispatchConcurrency;
}

/**
 * Args accepted by both the AI SDK tool's `execute()` and the directly-
 * callable `dispatch()`. Mirrors `WorkerInvocation` minus `repoRoot` (which
 * is bound by `makeDispatchWorkerTool`'s closure).
 */
export type DispatchWorkerArgs = z.infer<typeof InputSchema>;

/**
 * Return value of `makeDispatchWorkerTool()`. `tool` is the AI SDK tool the
 * boss invokes via `streamText`; `dispatch` is a directly-callable function
 * sharing the same budget/lane-discipline/scratchpad-recording state, used
 * by the M15 (ADR-0031) programmatic-dispatch Round 0 fan-out path. Both
 * paths produce identical scratchpad effects + return shape. Return type
 * intentionally inferred from the function body so AI SDK's generic
 * `Tool<...>` shape flows through without a hand-written interface.
 */
export function makeDispatchWorkerTool(opts: MakeDispatchWorkerToolOptions) {
  let dispatchedCount = 0;
  let budgetEntryEmitted = false;

  const runOneDispatch = async (
    args: DispatchWorkerArgs,
  ): Promise<DispatchWorkerResult> => {
    // Budget gate: emit a single degraded entry the first time we hit
    // it, then short-circuit subsequent dispatches without invoking
    // the route. This mirrors M11 lookupTypeDef's once-per-review
    // "no node_modules" degraded entry pattern.
    if (opts.workerBudget !== undefined && dispatchedCount >= opts.workerBudget) {
      if (!budgetEntryEmitted) {
        const entry: DegradedEntry = {
          kind: "actionable",
          topic: "review-harness",
          message:
            `worker budget exhausted at ${opts.workerBudget} dispatches — raise ` +
            "WARDEN_REVIEW_WORKER_BUDGET to allow deeper adjudication.",
        };
        opts.scratchpad.recordDegraded(entry);
        budgetEntryEmitted = true;
        return { findings: [], toolCalls: 0, degraded: [entry] };
      }
      return { findings: [], toolCalls: 0, degraded: [] };
    }
    dispatchedCount += 1;

    const invocation: WorkerInvocation = {
      repoRoot: opts.repoRoot,
      files: args.files,
      concern: args.concern,
      tier: args.tier,
      focus: args.focus,
      phase: args.phase,
    };

    // ADR-0033: acquire a slot from the per-tier semaphore before invoking
    // the route. Tier is resolved here (override-or-default) so the slot
    // picked matches the tier the worker's LLM call will actually use.
    // `release()` runs in `finally` to guarantee the slot frees on both
    // happy + throw paths. The semaphore reports `waitMs` intrinsically
    // (0 when the slot was free), so a `Date.now()`-measured microtask
    // hop can't false-positive as a real queue event.
    let release: (() => void) | undefined;
    if (opts.concurrency) {
      const resolvedTier = resolveWorkerTier(args.concern, args.tier);
      const sem =
        resolvedTier === "sonnet" ? opts.concurrency.strong : opts.concurrency.cheap;
      const acquired = await sem.acquire();
      release = acquired.release;
      opts.scratchpad.recordConcurrencyMetric({ waitMs: acquired.waitMs });
    }

    let result: WorkerInvocationResult;
    try {
      try {
        result = await opts.route(invocation);
      } catch (err) {
        const detail = formatErr(err);
        const entry: DegradedEntry = {
          kind: "warning",
          topic: "review-harness",
          message: `dispatch_worker(${args.concern}): worker threw (${detail})`,
        };
        opts.scratchpad.recordWorker({
          concern: args.concern,
          files: args.files,
          findings: [],
          toolCalls: 0,
          degraded: [entry],
          phase: args.phase,
          durationMs: 0,
        });
        return { findings: [], toolCalls: 0, degraded: [entry] };
      }
    } finally {
      release?.();
    }

    // Lane discipline: drop findings whose `path` is outside the
    // dispatched `files` set. Findings carry paths through their
    // `sources[].path` (the canonical citation site) — drop the whole
    // Comment if none of its sources cite a file inside the lane. This
    // mirrors the M13 security sub-agent's lane policy.
    const lane = new Set(args.files.map((p) => p.replace(/\\/g, "/")));
    const inLane: Comment[] = [];
    const droppedCount = { value: 0 };
    for (const finding of result.findings) {
      if (commentInLane(finding, lane)) {
        inLane.push(finding);
      } else {
        droppedCount.value += 1;
      }
    }
    const laneDegraded: DegradedEntry[] = [...result.degraded];
    if (droppedCount.value > 0) {
      laneDegraded.push({
        kind: "info",
        topic: "review-harness",
        message:
          `dispatch_worker(${args.concern}): dropped ${droppedCount.value} ` +
          "finding(s) whose path was outside the dispatched file set.",
      });
    }

    opts.scratchpad.recordWorker({
      concern: args.concern,
      files: args.files,
      findings: inLane,
      toolCalls: result.toolCalls,
      degraded: laneDegraded,
      phase: args.phase,
      durationMs: result.durationMs,
      ...(result.tokenUsage !== undefined ? { tokenUsage: result.tokenUsage } : {}),
      ...(result.tier !== undefined ? { tier: result.tier } : {}),
    });

    return {
      findings: inLane,
      toolCalls: result.toolCalls,
      degraded: laneDegraded,
    };
  };

  const aiTool = tool({
    description: [
      "Dispatch a per-concern worker against a file set. Returns the",
      "worker's findings (already filtered to your `files` scope),",
      "tool-call count, and any degraded entries. Use this tool to plan",
      "(round 1: spread Sonnet workers across the diff), adjudicate",
      "(rounds 2-4: follow up on specific files based on earlier output),",
      "and synth (final round: optional last-mile dispatches before",
      "emitting the comment set). The boss MUST emit the final comment",
      "array via the structured output, NOT through this tool.",
    ].join(" "),
    inputSchema: InputSchema,
    execute: runOneDispatch,
  });

  return { tool: aiTool, dispatch: runOneDispatch };
}

/**
 * A comment is in-lane iff at least one of its sources cites a path in
 * the dispatched `files` set. Comments with zero path-bearing sources
 * (e.g. pure-tool sources with no `path`) are kept — they aren't pinned
 * to any file, so lane discipline doesn't apply.
 */
function commentInLane(comment: Comment, lane: Set<string>): boolean {
  let sawPath = false;
  for (const src of comment.sources) {
    if (src.path === undefined) continue;
    sawPath = true;
    const normalized = src.path.replace(/\\/g, "/");
    if (lane.has(normalized)) return true;
  }
  return !sawPath;
}

function formatErr(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 160);
  return String(err).slice(0, 160);
}
