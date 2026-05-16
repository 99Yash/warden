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
 * `tokenUsage` is summed across the worker's inner streamText steps so the
 * cost line in render.ts can break down per concern. `phase` echoes back
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
  /** Token usage for the worker's streamText call (summed across inner steps). */
  tokenUsage?: TokenUsage;
}

/**
 * Per-call token usage. The AI SDK v6 `streamText` result exposes a `usage`
 * object after the stream resolves. Cost-tracking SQLite (`reviewRuns`) is
 * deferred per M14 Q12; v0 keeps usage in-memory on the scratchpad and
 * renders it via `packages/cli/src/render.ts`.
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Anthropic-reported cache hits if `streamText` reports them; optional. */
  cachedInputTokens?: number;
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
export class ReviewScratchpad {
  private _detPriors: DetPriors | undefined;
  private readonly _workerOutputs: WorkerOutput[] = [];
  private readonly _degraded: DegradedEntry[] = [];
  private _bossTokens: TokenUsage | undefined;
  private _workerTokens: TokenUsage = { inputTokens: 0, outputTokens: 0 };

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
    if (output.tokenUsage) {
      this._workerTokens.inputTokens += output.tokenUsage.inputTokens;
      this._workerTokens.outputTokens += output.tokenUsage.outputTokens;
      if (output.tokenUsage.cachedInputTokens !== undefined) {
        this._workerTokens.cachedInputTokens =
          (this._workerTokens.cachedInputTokens ?? 0) + output.tokenUsage.cachedInputTokens;
      }
    }
  }

  workerOutputs(): readonly WorkerOutput[] {
    return this._workerOutputs;
  }

  /** Free-form degraded entries not tied to a specific worker (e.g. boss-loop budget cap). */
  recordDegraded(entry: DegradedEntry): void {
    this._degraded.push(entry);
  }

  /** Boss-loop token usage (single accumulator across all boss rounds). */
  recordBossTokens(usage: TokenUsage): void {
    if (!this._bossTokens) {
      this._bossTokens = { inputTokens: 0, outputTokens: 0 };
    }
    this._bossTokens.inputTokens += usage.inputTokens;
    this._bossTokens.outputTokens += usage.outputTokens;
    if (usage.cachedInputTokens !== undefined) {
      this._bossTokens.cachedInputTokens =
        (this._bossTokens.cachedInputTokens ?? 0) + usage.cachedInputTokens;
    }
  }

  bossTokens(): TokenUsage | undefined {
    return this._bossTokens;
  }

  workerTokens(): TokenUsage {
    return this._workerTokens;
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
}
