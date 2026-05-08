import { and, count, db, embeddings as embeddingsTable, eq, inArray } from "@warden/db";
import type { EmbeddingRecord, EmbeddingStore } from "./interfaces.js";

/**
 * SQLite `EmbeddingStore` impl (ADR-0019 #10). Stores raw little-endian
 * Float32Array bytes; cosine search loads the entire row set for the
 * locked `(modelId, modelVersion)` into memory and computes JS-side. v0
 * tradeoff: a 5k-file repo ≈ ~50k chunks × 4KB = ~200MB resident, which
 * is acceptable for one-shot CLI runs. Stream-based search is M7+ if
 * dogfood shows pressure.
 */

export class SqliteEmbeddingStore implements EmbeddingStore {
  async upsert(record: EmbeddingRecord): Promise<void> {
    await this.upsertMany([record]);
  }

  async upsertMany(records: EmbeddingRecord[]): Promise<void> {
    if (records.length === 0) return;
    const rows = records.map((r) => ({
      chunkHash: r.chunkHash,
      modelId: r.modelId,
      modelVersion: r.modelVersion,
      vector: vectorToBuffer(r.vector),
      createdAt: new Date(),
    }));
    db().insert(embeddingsTable).values(rows).onConflictDoNothing().run();
  }

  async getByHash(
    chunkHash: string,
    modelId: string,
    modelVersion: string,
  ): Promise<Float32Array | null> {
    const row = db()
      .select({ vector: embeddingsTable.vector })
      .from(embeddingsTable)
      .where(
        and(
          eq(embeddingsTable.chunkHash, chunkHash),
          eq(embeddingsTable.modelId, modelId),
          eq(embeddingsTable.modelVersion, modelVersion),
        ),
      )
      .get();
    return row ? bufferToVector(row.vector) : null;
  }

  async search(
    query: Float32Array,
    modelId: string,
    modelVersion: string,
    topK: number,
  ): Promise<{ chunkHash: string; similarity: number }[]> {
    if (topK <= 0) return [];
    const rows = db()
      .select({ chunkHash: embeddingsTable.chunkHash, vector: embeddingsTable.vector })
      .from(embeddingsTable)
      .where(
        and(eq(embeddingsTable.modelId, modelId), eq(embeddingsTable.modelVersion, modelVersion)),
      )
      .all();

    const queryNorm = norm(query);
    if (queryNorm === 0) return [];

    const results: { chunkHash: string; similarity: number }[] = [];
    for (const row of rows) {
      const v = bufferToVector(row.vector);
      const sim = cosineSimilarity(query, queryNorm, v);
      results.push({ chunkHash: row.chunkHash, similarity: sim });
    }
    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, topK);
  }

  async whichExist(
    chunkHashes: string[],
    modelId: string,
    modelVersion: string,
  ): Promise<Set<string>> {
    if (chunkHashes.length === 0) return new Set();
    const present = new Set<string>();
    const BATCH = 500;
    for (let i = 0; i < chunkHashes.length; i += BATCH) {
      const slice = chunkHashes.slice(i, i + BATCH);
      const rows = db()
        .select({ chunkHash: embeddingsTable.chunkHash })
        .from(embeddingsTable)
        .where(
          and(
            inArray(embeddingsTable.chunkHash, slice),
            eq(embeddingsTable.modelId, modelId),
            eq(embeddingsTable.modelVersion, modelVersion),
          ),
        )
        .all();
      for (const r of rows) present.add(r.chunkHash);
    }
    return present;
  }

  async count(modelId: string, modelVersion: string): Promise<number> {
    const row = db()
      .select({ value: count() })
      .from(embeddingsTable)
      .where(
        and(eq(embeddingsTable.modelId, modelId), eq(embeddingsTable.modelVersion, modelVersion)),
      )
      .get();
    return row?.value ?? 0;
  }

  async deleteByModel(modelId: string, modelVersion: string): Promise<number> {
    const result = db()
      .delete(embeddingsTable)
      .where(
        and(eq(embeddingsTable.modelId, modelId), eq(embeddingsTable.modelVersion, modelVersion)),
      )
      .run();
    return Number(result.changes ?? 0);
  }
}

function vectorToBuffer(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

function bufferToVector(buf: Buffer): Float32Array {
  // Slice() copies into a fresh ArrayBuffer so we don't share memory with
  // the SQLite row; aligning to 4 bytes is required for Float32Array.
  const aligned = new Uint8Array(buf.byteLength);
  aligned.set(buf);
  return new Float32Array(aligned.buffer);
}

function norm(v: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < v.length; i++) {
    const x = v[i] ?? 0;
    sum += x * x;
  }
  return Math.sqrt(sum);
}

function cosineSimilarity(a: Float32Array, normA: number, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let bSum = 0;
  for (let i = 0; i < len; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    bSum += bi * bi;
  }
  const normB = Math.sqrt(bSum);
  if (normA === 0 || normB === 0) return 0;
  return dot / (normA * normB);
}
