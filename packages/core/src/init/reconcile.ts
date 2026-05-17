import { voyageModelMeta, type EmbeddingProvider } from "@warden/ai";
import {
  chunks as chunksTable,
  db,
  embeddings as embeddingsTable,
  eq,
  fileChunks as fileChunksTable,
  merkle as merkleTable,
} from "@warden/db";
import type {
  ChunkRecord,
  Chunker,
} from "../context/chunker.js";
import type {
  ChunkStore,
  EmbeddingStore,
  FileChunksStore,
  MerkleStore,
} from "../indexing/index.js";
import type { DegradedEntry } from "../schema.js";
import { ESTIMATE_CONSTANTS } from "./estimate.js";
import type { WalkedFile } from "./walk.js";

/**
 * Shared orchestration primitive for the M16 init/review alignment
 * (ADR-0032). Both `runInit()` (full repo) and `det-priors.ts` (stale
 * subset from `merkleStore.diff()`) call this with different scopes; the
 * function owns content-hash-gated re-embed, atomic per-file cross-table
 * commits, reference-counted orphan pruning, and the one-shot pre-M16
 * backfill.
 *
 * Ordering is load-bearing: chunk → whichExist → estimate → embed
 * (HTTP, outside the SQLite transaction) → atomic DB commit. HTTP failures
 * therefore leave the file at its pre-call state, never a torn one.
 */

export type ReconcileEvent =
  | { type: "backfilled"; rowCount: number }
  | { type: "file-start"; path: string; index: number; total: number }
  | {
      type: "file-skipped-budget";
      path: string;
      estimatedUsd: number;
      budgetRemaining: number;
    }
  | {
      type: "file-refreshed";
      path: string;
      newChunks: number;
      reusedChunks: number;
      promptTokens: number;
      usd: number;
    }
  | { type: "file-removed"; path: string }
  | {
      type: "orphans-pruned";
      chunksPruned: number;
      embeddingsPruned: number;
    }
  | { type: "complete"; summary: ReconcileSummary };

export interface ReconcileSummary {
  refreshed: string[];
  removed: string[];
  skippedOverBudget: string[];
  /** Unique chunks seen across the refreshed files. */
  chunksSeen: number;
  /** Missing embeddings written during this invocation. */
  newlyEmbedded: number;
  /** Embeddings already present under the locked model (cache hits). */
  cachedEmbeddings: number;
  /** Embedding batches that failed after provider retry/cascade. */
  failedEmbeds: number;
  promptTokens: number;
  /** Pre-flight USD estimate summed across refreshed + skipped files. */
  estimatedUsd: number;
  /** Actual provider spend derived from `EmbedResponse.promptTokens`. */
  costUsd: number;
  durationMs: number;
  degraded: DegradedEntry[];
  /** True when this invocation triggered the one-shot backfill. */
  backfilled: boolean;
  backfilledRowCount: number;
  /** Cumulative orphan-prune counts. */
  chunksPruned: number;
  embeddingsPruned: number;
}

export interface ReconcileInput {
  /** Files to ensure are current. Empty is valid — backfill + prune still runs. */
  files: WalkedFile[];
  /** Paths to delete entirely. */
  removed: string[];
  repoRoot: string;
  chunker: Chunker;
  chunkStore: ChunkStore;
  embeddingStore: EmbeddingStore;
  merkleStore: MerkleStore;
  fileChunksStore: FileChunksStore;
  provider: EmbeddingProvider;
  lockedModelId: string;
  lockedModelVersion: string;
  /** Optional USD cap. Unset = unbounded (init mode). Review passes 0.25. */
  maxUsdBudget?: number;
  emit?: (event: ReconcileEvent) => void;
}

export async function reconcileFiles(
  input: ReconcileInput,
): Promise<ReconcileSummary> {
  const startedAt = Date.now();
  const emit = input.emit ?? (() => undefined);

  const backfilledRowCount = await input.fileChunksStore
    .backfillFromChunksIfNeeded();
  if (backfilledRowCount > 0) {
    emit({ type: "backfilled", rowCount: backfilledRowCount });
  }

  const refreshed: string[] = [];
  const skippedOverBudget: string[] = [];
  let remainingBudget =
    input.maxUsdBudget ?? Number.POSITIVE_INFINITY;
  let totalPromptTokens = 0;
  let totalEstimatedUsd = 0;
  let totalActualUsd = 0;
  let chunksSeen = 0;
  let newlyEmbedded = 0;
  let cachedEmbeddings = 0;
  let failedEmbeds = 0;

  for (let i = 0; i < input.files.length; i++) {
    const file = input.files[i];
    if (!file) continue;
    emit({
      type: "file-start",
      path: file.path,
      index: i + 1,
      total: input.files.length,
    });

    let chunksNew: ChunkRecord[] = [];
    try {
      chunksNew = await input.chunker.chunk(
        file.path,
        file.content,
        file.fileSha,
      );
    } catch {
      // Chunker failures are surfaced by the init flow's own degraded path;
      // reconcile keeps going so other files still refresh.
      chunksNew = [];
    }
    const newHashes = uniqueHashes(chunksNew);

    const existing =
      newHashes.length === 0
        ? new Set<string>()
        : await input.embeddingStore.whichExist(
            newHashes,
            input.lockedModelId,
            input.lockedModelVersion,
          );
    const missing = newHashes.filter((h) => !existing.has(h));

    const estimatedUsd = estimateBatchUsd(
      missing.length,
      input.lockedModelId,
    );
    totalEstimatedUsd += estimatedUsd;
    if (estimatedUsd > remainingBudget) {
      skippedOverBudget.push(file.path);
      emit({
        type: "file-skipped-budget",
        path: file.path,
        estimatedUsd,
        budgetRemaining: remainingBudget,
      });
      continue;
    }

    let newEmbeddings: {
      chunkHash: string;
      modelId: string;
      modelVersion: string;
      vector: Float32Array;
    }[] = [];
    let actualUsd = 0;
    let promptTokens = 0;
    if (missing.length > 0) {
      const hashToContent = new Map<string, string>();
      for (const c of chunksNew) {
        if (!hashToContent.has(c.chunkHash))
          hashToContent.set(c.chunkHash, c.content);
      }
      const batches = chunkArray(
        missing,
        input.provider.maxBatchSize(),
      );
      let fileFailed = false;
      for (const batch of batches) {
        if (fileFailed) break;
        const batchInputs = batch.map(
          (h) => hashToContent.get(h) ?? "",
        );
        try {
          const resp = await input.provider.embed({
            inputs: batchInputs,
            inputType: "document",
          });
          for (let j = 0; j < batch.length; j++) {
            const h = batch[j]!;
            newEmbeddings.push({
              chunkHash: h,
              modelId: resp.modelId,
              modelVersion: resp.modelVersion,
              vector: resp.vectors[j] ?? new Float32Array(0),
            });
          }
          promptTokens += resp.promptTokens;
          actualUsd += usdFromTokens(
            resp.promptTokens,
            input.lockedModelId,
          );
        } catch {
          failedEmbeds++;
          fileFailed = true;
        }
      }
      if (fileFailed) {
        // Pre-DB-commit failure — skip the file commit so its state on disk
        // remains identical to before the call. Caller surfaces a degraded
        // entry from the harness/init level if it wants to.
        continue;
      }
    }

    commitFileReconcile({
      chunks: chunksNew,
      embeddings: newEmbeddings,
      filePath: file.path,
      fileSha: file.fileSha,
      chunkHashes: newHashes,
    });

    remainingBudget -= actualUsd;
    totalPromptTokens += promptTokens;
    totalActualUsd += actualUsd;
    chunksSeen += newHashes.length;
    newlyEmbedded += missing.length;
    cachedEmbeddings += newHashes.length - missing.length;
    refreshed.push(file.path);

    emit({
      type: "file-refreshed",
      path: file.path,
      newChunks: missing.length,
      reusedChunks: newHashes.length - missing.length,
      promptTokens,
      usd: actualUsd,
    });
  }

  const removedActual: string[] = [];
  for (const path of input.removed) {
    commitFileRemoval(path);
    removedActual.push(path);
    emit({ type: "file-removed", path });
  }

  const { chunksPruned, embeddingsPruned } =
    await input.fileChunksStore.pruneOrphans();
  if (chunksPruned > 0 || embeddingsPruned > 0) {
    emit({
      type: "orphans-pruned",
      chunksPruned,
      embeddingsPruned,
    });
  }

  const degraded: DegradedEntry[] = [];
  if (
    skippedOverBudget.length > 0 &&
    input.maxUsdBudget !== undefined
  ) {
    const plural = skippedOverBudget.length === 1 ? "" : "s";
    degraded.push({
      kind: "actionable",
      topic: "context",
      message: `context: refresh capped at $${input.maxUsdBudget.toFixed(
        2,
      )} — ${skippedOverBudget.length} file${plural} skipped; run \`warden init\` for a full refresh`,
    });
  }
  if (backfilledRowCount > 0) {
    degraded.push({
      kind: "info",
      topic: "context",
      message: `context: migrated ${backfilledRowCount} rows to file_chunks (one-shot; M16 schema)`,
    });
  }
  if (failedEmbeds > 0) {
    degraded.push({
      kind: "warning",
      topic: "context",
      message: `context: ${failedEmbeds} file${failedEmbeds === 1 ? "" : "s"} skipped after Voyage error — re-run later or run \`warden init\``,
    });
  }

  const summary: ReconcileSummary = {
    refreshed,
    removed: removedActual,
    skippedOverBudget,
    chunksSeen,
    newlyEmbedded,
    cachedEmbeddings,
    failedEmbeds,
    promptTokens: totalPromptTokens,
    estimatedUsd: Number(totalEstimatedUsd.toFixed(6)),
    costUsd: Number(totalActualUsd.toFixed(6)),
    durationMs: Date.now() - startedAt,
    degraded,
    backfilled: backfilledRowCount > 0,
    backfilledRowCount,
    chunksPruned,
    embeddingsPruned,
  };
  emit({ type: "complete", summary });
  return summary;
}

/**
 * Per-file cross-table commit. One better-sqlite3 transaction wraps the
 * `chunks` + `file_chunks` + `embeddings` + `merkle` writes so a process
 * crash mid-flight leaves the index at its previous state, never a torn
 * one. The store interfaces stay narrowly scoped for read/test paths; the
 * write commit owns the crash-safety guarantee ADR-0032 depends on.
 */
function commitFileReconcile(args: {
  chunks: ChunkRecord[];
  embeddings: {
    chunkHash: string;
    modelId: string;
    modelVersion: string;
    vector: Float32Array;
  }[];
  filePath: string;
  fileSha: string;
  chunkHashes: string[];
}): void {
  const conn = db();
  conn.transaction((tx) => {
    if (args.chunks.length > 0) {
      const rows = args.chunks.map((r) => ({
        chunkHash: r.chunkHash,
        filePath: r.filePath,
        fileSha: r.fileSha,
        language: r.language,
        symbolPathJson: JSON.stringify(r.symbolPath),
        startLine: r.startLine,
        endLine: r.endLine,
        content: r.content,
        createdAt: new Date(),
      }));
      tx.insert(chunksTable).values(rows).onConflictDoNothing().run();
    }
    if (args.embeddings.length > 0) {
      const now = new Date();
      const rows = args.embeddings.map((e) => ({
        chunkHash: e.chunkHash,
        modelId: e.modelId,
        modelVersion: e.modelVersion,
        vector: Buffer.from(
          e.vector.buffer,
          e.vector.byteOffset,
          e.vector.byteLength,
        ),
        createdAt: now,
      }));
      tx.insert(embeddingsTable).values(rows).onConflictDoNothing().run();
    }
    // Junction rows: replace-for-file semantics keep file_chunks authoritative.
    tx.delete(fileChunksTable)
      .where(eq(fileChunksTable.filePath, args.filePath))
      .run();
    if (args.chunkHashes.length > 0) {
      const seen = new Set<string>();
      const now = new Date();
      const rows: {
        filePath: string;
        chunkHash: string;
        fileSha: string;
        indexedAt: Date;
      }[] = [];
      for (const h of args.chunkHashes) {
        if (seen.has(h)) continue;
        seen.add(h);
        rows.push({
          filePath: args.filePath,
          chunkHash: h,
          fileSha: args.fileSha,
          indexedAt: now,
        });
      }
      if (rows.length > 0) {
        tx.insert(fileChunksTable)
          .values(rows)
          .onConflictDoNothing()
          .run();
      }
    }
    // Merkle leaf: keep the file's recorded sha in sync so the next
    // merkleStore.diff() reads "clean" for this path.
    tx.insert(merkleTable)
      .values({
        nodePath: args.filePath,
        hash: args.fileSha,
        kind: "file",
        observedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: merkleTable.nodePath,
        set: {
          hash: args.fileSha,
          kind: "file",
          observedAt: new Date(),
        },
      })
      .run();
  });
}

function commitFileRemoval(filePath: string): void {
  const conn = db();
  conn.transaction((tx) => {
    tx.delete(fileChunksTable)
      .where(eq(fileChunksTable.filePath, filePath))
      .run();
    tx.delete(merkleTable)
      .where(eq(merkleTable.nodePath, filePath))
      .run();
  });
}

function uniqueHashes(records: ChunkRecord[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of records) {
    if (seen.has(r.chunkHash)) continue;
    seen.add(r.chunkHash);
    out.push(r.chunkHash);
  }
  return out;
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  if (size <= 0) return [arr];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Pre-flight USD estimate for one file's missing chunks. Mirrors the
 * `estimateInit()` math at the chunk-batch granularity so the running
 * budget shares one source-of-truth for the per-million-token price.
 */
function estimateBatchUsd(
  missingCount: number,
  modelId: string,
): number {
  if (missingCount <= 0) return 0;
  const tokens = missingCount * ESTIMATE_CONSTANTS.TOKENS_PER_CHUNK;
  const usd = (tokens / 1_000_000) * voyageModelMeta(modelId).usdPerMTokens;
  return Number(usd.toFixed(6));
}

function usdFromTokens(tokens: number, modelId: string): number {
  if (tokens <= 0) return 0;
  return (tokens / 1_000_000) * voyageModelMeta(modelId).usdPerMTokens;
}
