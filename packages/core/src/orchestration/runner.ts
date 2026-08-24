import type { ChangedFile } from "../diff/index.js";
import type { Comment, DegradedEntry } from "../schema.js";
import type { ToolFinding } from "../runners/types.js";

/**
 * The orchestration `Runner` contract (ADR-0023): `{ name, run(input) }` so a
 * deterministic detector speaks one input/output shape and callers store its
 * output without per-runner branches.
 *
 * Post-M14-close-out (ADR-0030), this contract no longer implies any
 * orchestration machinery — the spine's `dispatch()`/`Scratchpad`/
 * `synthesize` are retired. Its only consumers are the deterministic
 * detectors that implement it directly (`scalabilityRunner`,
 * `leverageRunner`), invoked via plain `.run()` inside
 * `det-priors.ts`'s `Promise.all` block. It remains the right shape for
 * future Phase 1 det-prior additions; it does NOT shape the review-harness
 * worker tier — M14+ workers are built around the `dispatch_worker`
 * invocation envelope instead.
 *
 * Input shape is `path[]`-based (β per ADR-0023 #5) — no current runner
 * benefits from tree-aware input. The diff tree stays internal to `diff/`
 * until a tree-aware consumer materializes. Retrieved context is not part
 * of this contract: the selector runs alongside the detectors in Phase 1
 * and its output flows to the worker tier, never back into det-prior
 * detectors.
 */

export interface RunnerInput {
  repoRoot: string;
  /** Pre-pruned post-M9; raw in M8. */
  changed: ChangedFile[];
  changedPaths: string[];
}

/**
 * Per-runner output. Findings carry `kind: "assertion"` semantics (grounded
 * tool-shaped claims); questions carry `kind: "question"` semantics
 * (sub-agent-emitted asks). Lane discipline (ADR-0021): no detector emits
 * questions, no sub-agent emits assertions. The contract permits both for
 * future flexibility, but today's runners populate exactly one side.
 *
 * `degraded` and `error` are independent: a runner may emit informational
 * `degraded` entries on a successful run; `error` is reserved for hard
 * failures that the dispatcher catches via the contract.
 */
export interface RunnerOutput {
  name: string;
  findings: ToolFinding[];
  questions?: Comment[];
  degraded: DegradedEntry[];
  /** Wall-clock duration. The dispatcher overrides whatever the runner sets. */
  durationMs: number;
  /** Populated by the dispatcher when `run()` throws; otherwise undefined. */
  error?: Error;
}

export interface Runner {
  readonly name: string;
  run(input: RunnerInput): Promise<RunnerOutput>;
}
