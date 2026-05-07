import type { ChangedFile } from "../diff/index.js";
import type { EcosystemContext } from "../ecosystem/index.js";

/**
 * Public surface of the M5 cheap-signals context selector (ADR-0018).
 *
 * Selector emits paths + reasons; it never reads file content for prompt
 * assembly. File I/O for content excerpts is handled by the prompt-assembly
 * layer (`./prompt.ts`) so the selector stays pure-ranking and easy to swap
 * out for an embedding-backed implementation in M6.
 */

export type Evidence = { startLine: number; endLine: number };

export type Reason =
  /** This candidate is imported by `from` (the changed file). Evidence: where the consumed exports live in the candidate. */
  | { kind: "imported-by"; from: string; evidence?: Evidence[] }
  /** This candidate imports `target` (the changed file). Evidence: import-statement line(s) + usage call sites in the candidate. */
  | { kind: "imports"; target: string; evidence?: Evidence[] }
  /** Path-only awareness signal — folders are noisy, content is not surfaced. */
  | { kind: "same-folder"; sibling: string }
  /** Candidate references `symbol` exported by a changed file. Evidence: grep-hit lines. */
  | { kind: "symbol-ref"; symbol: string; evidence: Evidence[] };

export type ContextCandidate = {
  /** Repo-relative path (POSIX separators). */
  path: string;
  /** Score in [0, 1]; higher = more relevant. */
  score: number;
  reasons: Reason[];
};

export type SelectorOutput = {
  candidates: ContextCandidate[];
  /** Surfaced via `metadata.degradedWorkers` per ADR-0018. */
  degraded: string[];
};

export interface ContextSelector {
  select(input: {
    repoRoot: string;
    changed: ChangedFile[];
    ecosystem: EcosystemContext;
  }): Promise<SelectorOutput>;
}

export { CheapSignalsSelector } from "./selector.js";
export { TsCompilerParser, type ImportRef, type ExportRef, type SourceParser } from "./parser.js";
export { candidatesToRetrievedContext } from "./prompt.js";

/**
 * Per-reason weights for v1 scoring (ADR-0018: hardcoded constants, no flag
 * plumbing for tuning). Score is sum of unique-kind weights normalized by
 * the max possible (sum of all weights), so `score ∈ [0, 1]`.
 */
export const REASON_WEIGHTS = {
  "imported-by": 1.0,
  imports: 0.8,
  "symbol-ref": 0.6,
  "same-folder": 0.3,
} as const;

export const MAX_REASON_WEIGHT_SUM =
  REASON_WEIGHTS["imported-by"] +
  REASON_WEIGHTS.imports +
  REASON_WEIGHTS["symbol-ref"] +
  REASON_WEIGHTS["same-folder"];

/** Top content-bearing candidates (any reason except same-folder-only). */
export const MAX_CONTENT_BEARING = 8;
/** Top same-folder-only candidates surfaced as path-only entries. */
export const MAX_SAME_FOLDER_ONLY = 12;
/** Per-folder cap before same-folder signal stops emitting (folders get noisy fast). */
export const SAME_FOLDER_CAP = 12;
