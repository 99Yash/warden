import { existsSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";
import type { EmbeddingProvider } from "@warden/ai";
import type { ChunkStore, EmbeddingStore, FileChunksStore } from "../../indexing/index.js";
import { SqliteFileChunksStore } from "../../indexing/index.js";
import type { DegradedEntry } from "../../schema.js";
import type { Evidence } from "../index.js";

/**
 * Semantic signal for the M6 selector v2 (ADR-0019 #9). Embeds the unified
 * diff once via Voyage `type=query`, retrieves top-K chunks above a
 * similarity threshold, aggregates per-file via *max* (preserves "this one
 * chunk is highly relevant" without diluting via mean).
 *
 * Failure modes degrade gracefully — Voyage 5xx during `review` returns
 * empty hits + a `degraded` entry; the selector falls back to M5 cheap
 * signals only and never hard-fails the review.
 */

export const SEMANTIC_TOP_K = 50;
export const SEMANTIC_SIMILARITY_THRESHOLD = 0.5;

export interface SemanticHit {
  chunkHash: string;
  similarity: number;
  startLine: number;
  endLine: number;
}

export interface SemanticSignalInput {
  diff: string;
  embeddingProvider: EmbeddingProvider;
  embeddingStore: EmbeddingStore;
  chunkStore: ChunkStore;
  /**
   * Authoritative file→chunks junction (M16 / ADR-0032). When omitted, the
   * default `SqliteFileChunksStore` is used. Tests pass an in-memory stub.
   */
  fileChunksStore?: FileChunksStore;
  /**
   * Repo root used to resolve relative chunk paths for the on-disk existence
   * check (see filter below). Optional — when omitted, the filter is skipped
   * and behavior matches the pre-2026-05 path. Selectors should always pass
   * it so deleted files don't leak into downstream consumers (jscpd lstat).
   */
  repoRoot?: string;
  /** Voyage SKU to query under — must equal the locked-model id of the index. */
  lockedModelId: string;
  /**
   * Cache-key handle for the *corpus-side* rows (`type=document`). The query
   * is embedded with `type=query`; we search against `document` rows because
   * that's what `warden init` wrote.
   */
  lockedModelVersionForDocument: string;
}

export interface SemanticSignalOutput {
  /** filePath → max-aggregated hit info. */
  hitsByFile: Map<string, SemanticHit>;
  degraded: DegradedEntry[];
}

export async function semanticSignal(input: SemanticSignalInput): Promise<SemanticSignalOutput> {
  if (!input.diff || input.diff.trim().length === 0) {
    return { hitsByFile: new Map(), degraded: [] };
  }

  let queryVector: Float32Array;
  try {
    const embedded = await input.embeddingProvider.embed({
      inputs: [input.diff],
      inputType: "query",
    });
    const v = embedded.vectors[0];
    if (!v) {
      return {
        hitsByFile: new Map(),
        degraded: [
          {
            kind: "warning",
            topic: "context",
            message: "context: voyage query embed returned no vector — semantic signal disabled",
          },
        ],
      };
    }
    queryVector = v;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      hitsByFile: new Map(),
      degraded: [
        {
          kind: "warning",
          topic: "context",
          message: `context: voyage query embed failed (${msg.slice(0, 120)}) — semantic signal disabled`,
        },
      ],
    };
  }

  // Sanity check: empty index → cheap-signals carry the review.
  const corpusCount = await input.embeddingStore.count(
    input.lockedModelId,
    input.lockedModelVersionForDocument,
  );
  if (corpusCount === 0) {
    return {
      hitsByFile: new Map(),
      degraded: [
        {
          kind: "actionable",
          topic: "embeddings",
          message: "context: no embeddings yet — run `warden init`",
        },
      ],
    };
  }

  const ranked = await input.embeddingStore.search(
    queryVector,
    input.lockedModelId,
    input.lockedModelVersionForDocument,
    SEMANTIC_TOP_K,
  );
  const aboveThreshold = ranked.filter((r) => r.similarity >= SEMANTIC_SIMILARITY_THRESHOLD);
  if (aboveThreshold.length === 0) {
    return { hitsByFile: new Map(), degraded: [] };
  }

  const hashes = aboveThreshold.map((r) => r.chunkHash);
  const fileChunksStore = input.fileChunksStore ?? new SqliteFileChunksStore();
  const [records, attributions] = await Promise.all([
    input.chunkStore.getManyByHash(hashes),
    fileChunksStore.getFilesForHashes(hashes),
  ]);
  const hitsByFile = new Map<string, SemanticHit>();
  // Repo-audit 2026-05-18 #2: chunks.file_path can point at an M14-deleted
  // file (first-writer-wins under the M16 backfill window). Drop hits whose
  // resolved path no longer exists on disk before the selector consumes them
  // — one stat per surviving hit is cheap and survives any future
  // chunks/file_chunks drift without requiring a schema-level fix.
  const fileExists = (filePath: string): boolean => {
    if (!input.repoRoot) return true;
    const abs = isAbsolute(filePath) ? filePath : resolvePath(input.repoRoot, filePath);
    return existsSync(abs);
  };
  for (const r of aboveThreshold) {
    const record = records.get(r.chunkHash);
    if (!record) continue;
    // Authoritative attribution via the M16 junction; fall back to the
    // chunks row's first-writer-wins file_path during the backfill window
    // (post-backfill, every chunk has at least one file_chunks row).
    const attributedFiles = attributions.get(r.chunkHash);
    const filePaths =
      attributedFiles && attributedFiles.length > 0 ? attributedFiles : [record.filePath];
    for (const filePath of filePaths) {
      if (!fileExists(filePath)) continue;
      const hit: SemanticHit = {
        chunkHash: r.chunkHash,
        similarity: r.similarity,
        startLine: record.startLine,
        endLine: record.endLine,
      };
      const existing = hitsByFile.get(filePath);
      if (!existing || existing.similarity < hit.similarity) {
        hitsByFile.set(filePath, hit);
      }
    }
  }

  return { hitsByFile, degraded: [] };
}

export function semanticEvidence(hit: SemanticHit): Evidence[] {
  return [{ startLine: hit.startLine, endLine: hit.endLine }];
}
