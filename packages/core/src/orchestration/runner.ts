import type { ChangedFile } from "../diff/index.js";
import type { Comment, DegradedEntry, RetrievedContext } from "../schema.js";
import type { ToolFinding } from "../runners/types.js";

/**
 * The orchestration `Runner` contract (ADR-0023). Every runner — deterministic
 * detector, LLM cheap-tier sub-agent, future specialist worker — speaks the
 * same input/output shape so the dispatcher can route them uniformly and the
 * scratchpad can store their outputs without per-runner branches.
 *
 * M8 ships the spine; only `committability` and `scalability` migrate to
 * the contract. The remaining 6 runners (TSC, ESLint, jscpd, vuln, deadcode,
 * consistency) keep their inline call sites in `runReview()` and have their
 * outputs recorded directly into the scratchpad — the synthesizer sees a
 * uniform scratchpad regardless of which runners came through `dispatch()`
 * and which were inline. M9 (likely) closes this when the noise filter
 * touches the same runner-input surface.
 *
 * Input shape is `path[]`-based (β per ADR-0023 #5) — no current runner
 * benefits from tree-aware input. The diff tree stays internal to `diff/`
 * until a tree-aware consumer materializes.
 */

export interface RunnerInput {
  repoRoot: string;
  /** Pre-pruned post-M9; raw in M8. */
  changed: ChangedFile[];
  changedPaths: string[];
  retrievedContext?: RetrievedContext;
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
