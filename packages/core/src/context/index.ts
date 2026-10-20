import type { ChangedFile } from "../diff/index.js";
import type { EcosystemContext } from "../ecosystem/index.js";
import type { DegradedEntry } from "../schema.js";
import type { ImportGraphLoader } from "./import-graph.js";

export type { DegradedEntry } from "../schema.js";

/**
 * Public surface of the M5 cheap-signals + M6 semantic context selector
 * (ADR-0018 + ADR-0019). The selector emits paths + reasons; it never
 * reads file content for prompt assembly. File I/O for content excerpts
 * is handled by `./prompt.ts` so the selector stays pure-ranking.
 */

export type Evidence = { startLine: number; endLine: number };

export type Reason =
  /** Upstream / contract: changed file `from` depends on this candidate. Evidence: where the consumed exports live in the candidate. */
  | { kind: "imported-by"; from: string; evidence?: Evidence[] }
  /** Downstream / blast radius: this candidate depends on changed file `target`. Evidence: import-statement line(s) + usage call sites in the candidate. */
  | { kind: "imports"; target: string; evidence?: Evidence[] }
  /** Path-only awareness signal — folders are noisy, content is not surfaced. */
  | { kind: "same-folder"; sibling: string }
  /** Candidate references `symbol` exported by a changed file. Evidence: grep-hit lines. */
  | { kind: "symbol-ref"; symbol: string; evidence: Evidence[] }
  /**
   * M6: chunk in this file scored highly against the diff query embedding.
   * `similarity` is cosine in [0, 1]; `evidence` always has length 1 (the
   * chunk's line range). Selector keeps only the max-similarity hit per file.
   */
  | { kind: "semantic"; chunkHash: string; similarity: number; evidence: Evidence[] };

export type ContextCandidate = {
  /** Repo-relative path (POSIX separators). */
  path: string;
  /** Score in [0, 1]; higher = more relevant. */
  score: number;
  reasons: Reason[];
};

export type SelectorOutput = {
  candidates: ContextCandidate[];
  /** Surfaced via `metadata.degradedWorkers` per ADR-0018 (now discriminated per ADR-0021 #7). */
  degraded: DegradedEntry[];
};

export interface ContextSelector {
  select(input: {
    repoRoot: string;
    changed: ChangedFile[];
    ecosystem: EcosystemContext;
    /** Unified diff text — required for the M6 semantic signal; cheap signals ignore it. */
    diff?: string;
    /**
     * The review's shared import graph. A selector that reads the graph uses
     * this instead of loading its own, and leaves the snapshot's degraded
     * entries to the caller, which reports them once per review.
     */
    importGraph?: ImportGraphLoader;
  }): Promise<SelectorOutput>;
}

export { CheapSignalsSelector } from "./selector.js";
export { TsCompilerParser, type ImportRef, type ExportRef, type SourceParser } from "./parser.js";
export { candidatesToRetrievedContext } from "./prompt.js";
export {
  CodeChunkAdapter,
  SUPPORTED_LANGUAGES,
  type ChunkRecord,
  type Chunker,
  type SupportedLanguage,
} from "./chunker.js";
export {
  SEMANTIC_SIMILARITY_THRESHOLD,
  SEMANTIC_TOP_K,
  semanticEvidence,
  semanticSignal,
  type SemanticHit,
  type SemanticSignalInput,
  type SemanticSignalOutput,
} from "./signals/semantic.js";
export {
  MAX_CONTENT_BEARING,
  MAX_REASON_WEIGHT_SUM,
  MAX_SAME_FOLDER_ONLY,
  REASON_WEIGHTS,
  SAME_FOLDER_CAP,
} from "./scoring.js";
