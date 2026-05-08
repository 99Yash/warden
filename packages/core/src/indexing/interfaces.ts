import type { ChunkRecord } from "../context/chunker.js";

/**
 * Storage seam interfaces for the M6 indexing layer (ADR-0016 + ADR-0019
 * #10). Pure types — no Drizzle imports. SQLite default impls live in
 * sibling modules; future hosted impls (Postgres, Pinecone, S3+Faiss)
 * implement the same shapes without touching consumers.
 *
 * `IndexExporter` / `IndexImporter` are interface-ready in M6 (per
 * ADR-0019 #8) but the CLI verbs are deferred to a real consumer (CI
 * cache / hosted migration / laptop-switching pain).
 */

export type { ChunkRecord } from "../context/chunker.js";

export interface ChunkStore {
  /** Idempotent — duplicate `chunkHash` is a no-op. */
  upsert(chunk: ChunkRecord): Promise<void>;
  upsertMany(chunks: ChunkRecord[]): Promise<void>;
  getByHash(chunkHash: string): Promise<ChunkRecord | null>;
  getManyByHash(chunkHashes: string[]): Promise<Map<string, ChunkRecord>>;
  /** Returns rows whose `(filePath, fileSha)` provenance matches. */
  getByFile(filePath: string, fileSha: string): Promise<ChunkRecord[]>;
  count(): Promise<number>;
}

export interface EmbeddingRecord {
  chunkHash: string;
  modelId: string;
  modelVersion: string;
  vector: Float32Array;
}

export interface EmbeddingStore {
  upsert(record: EmbeddingRecord): Promise<void>;
  upsertMany(records: EmbeddingRecord[]): Promise<void>;
  getByHash(
    chunkHash: string,
    modelId: string,
    modelVersion: string,
  ): Promise<Float32Array | null>;
  /** Cosine-similarity search; returns top-K (chunk_hash, similarity) sorted descending. */
  search(
    query: Float32Array,
    modelId: string,
    modelVersion: string,
    topK: number,
  ): Promise<{ chunkHash: string; similarity: number }[]>;
  /** Bulk membership test for `(modelId, modelVersion)` — used to plan re-embed work. */
  whichExist(
    chunkHashes: string[],
    modelId: string,
    modelVersion: string,
  ): Promise<Set<string>>;
  count(modelId: string, modelVersion: string): Promise<number>;
  /** Drops all rows for `(modelId, modelVersion)` — supports `--rebuild`. */
  deleteByModel(modelId: string, modelVersion: string): Promise<number>;
}

export interface MerkleNode {
  /** Repo-relative POSIX path or directory path. */
  nodePath: string;
  /** sha256 of file content (leaf) or aggregate (interior). */
  hash: string;
  kind: "file" | "dir";
}

export interface MerkleDiffResult {
  /** Paths whose stored hash differs from the supplied set. */
  changed: string[];
  /** Paths in the supplied set but not in the store (new files). */
  added: string[];
  /** Paths in the store but not in the supplied set (deleted files). */
  removed: string[];
}

export interface MerkleStore {
  upsertNode(node: MerkleNode): Promise<void>;
  upsertNodes(nodes: MerkleNode[]): Promise<void>;
  getAllFileHashes(): Promise<Map<string, string>>;
  /** Compares the supplied path→sha map against the store's `file` rows. */
  diff(currentHashes: Map<string, string>): Promise<MerkleDiffResult>;
  /** Drops every node row (used by `--rebuild`). */
  clear(): Promise<void>;
}

export interface Task<TInput, TOutput> {
  /** Content-addressed: sha256(taskKind + ":" + sortedJson(input)). */
  taskId: string;
  taskKind: string;
  input: TInput;
  /** Workhorse closure. Idempotent execution is the runner's contract. */
  run: () => Promise<TOutput>;
}

export interface JobRunResult<TOutput> {
  outputs: TOutput[];
  /** Tasks that errored after retries. */
  failed: { taskId: string; error: string }[];
  /** Tasks that were already `done` (cache-hits). */
  alreadyDone: number;
}

export interface JobRunnerProgress {
  taskKind: string;
  completed: number;
  total: number;
  /** Cumulative `promptTokens` (for the embed kind; 0 for kinds without a token cost). */
  promptTokensSoFar: number;
  /** Cumulative wall-clock ms spent in successful tasks (proxy for observed throughput). */
  elapsedMs: number;
}

export interface JobRunner {
  /**
   * Run a homogenous batch of tasks with concurrency-limited parallelism.
   * Tasks already marked `done` in the persistent table are skipped.
   * `onProgress` is called after every task settlement (success/failure).
   */
  run<TInput, TOutput>(
    tasks: Task<TInput, TOutput>[],
    opts?: { onProgress?: (p: JobRunnerProgress) => void; tokensFor?: (output: TOutput) => number },
  ): Promise<JobRunResult<TOutput>>;
  /** Returns task ids that are `pending` or `in_progress` for a given kind. */
  pendingTaskIds(taskKind: string): Promise<string[]>;
}

export interface ExportCounts {
  chunks: number;
  embeddings: number;
  merkleNodes: number;
  meta: number;
}

export interface IndexExporter {
  /** Stream chunks + embeddings + merkle rows + meta to the destination. */
  exportAll(stream: NodeJS.WritableStream): Promise<{ counts: ExportCounts }>;
}

export interface IndexImporter {
  importAll(
    stream: NodeJS.ReadableStream,
    opts: { mode: "merge" | "replace" },
  ): Promise<{ counts: ExportCounts }>;
}
