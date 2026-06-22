import {
  chunks as chunksTable,
  db,
  eq,
  fileChunks as fileChunksTable,
  inArray,
  indexMeta,
  sql,
} from "@warden/db";
import type { FileChunksStore } from "./interfaces.js";
import { META_KEYS } from "./meta.js";

/**
 * SQLite `FileChunksStore` impl (ADR-0032). The store owns the authoritative
 * file→chunks junction; cross-table consistency between `chunks`,
 * `file_chunks`, `embeddings`, and `merkle` is the caller's responsibility
 * (`init/reconcile.ts` wraps that work in one better-sqlite3 transaction per
 * file). The store methods stay narrowly scoped so they remain a useful read/
 * test seam.
 */
export class SqliteFileChunksStore implements FileChunksStore {
  async replaceForFile(filePath: string, fileSha: string, chunkHashes: string[]): Promise<void> {
    const conn = db();
    conn.transaction((tx) => {
      tx.delete(fileChunksTable).where(eq(fileChunksTable.filePath, filePath)).run();
      if (chunkHashes.length === 0) return;
      const now = new Date();
      // SQLite's compiled-statement parameter cap is ~999. With 4 columns per
      // row that's ~249 rows per statement at the safe ceiling — batch at 200
      // to leave headroom and keep each statement cheap.
      const BATCH = 200;
      const seen = new Set<string>();
      for (let i = 0; i < chunkHashes.length; i += BATCH) {
        const slice = chunkHashes.slice(i, i + BATCH);
        const rows = [];
        for (const h of slice) {
          if (seen.has(h)) continue;
          seen.add(h);
          rows.push({
            filePath,
            chunkHash: h,
            fileSha,
            indexedAt: now,
          });
        }
        if (rows.length === 0) continue;
        tx.insert(fileChunksTable).values(rows).onConflictDoNothing().run();
      }
    });
  }

  async deleteForFile(filePath: string): Promise<void> {
    db().delete(fileChunksTable).where(eq(fileChunksTable.filePath, filePath)).run();
  }

  async getFilesForHashes(chunkHashes: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (chunkHashes.length === 0) return out;
    const BATCH = 500;
    for (let i = 0; i < chunkHashes.length; i += BATCH) {
      const slice = chunkHashes.slice(i, i + BATCH);
      const rows = db()
        .select({
          chunkHash: fileChunksTable.chunkHash,
          filePath: fileChunksTable.filePath,
        })
        .from(fileChunksTable)
        .where(inArray(fileChunksTable.chunkHash, slice))
        .all();
      for (const r of rows) {
        const arr = out.get(r.chunkHash);
        if (arr) arr.push(r.filePath);
        else out.set(r.chunkHash, [r.filePath]);
      }
    }
    return out;
  }

  async getHashesForFile(filePath: string): Promise<string[]> {
    const rows = db()
      .select({ chunkHash: fileChunksTable.chunkHash })
      .from(fileChunksTable)
      .where(eq(fileChunksTable.filePath, filePath))
      .all();
    return rows.map((r) => r.chunkHash);
  }

  async count(): Promise<number> {
    const row = db()
      .select({ c: sql<number>`count(*)` })
      .from(fileChunksTable)
      .get();
    return row?.c ?? 0;
  }

  async pruneOrphans(): Promise<{
    chunksPruned: number;
    embeddingsPruned: number;
  }> {
    const conn = db();
    let chunksPruned = 0;
    let embeddingsPruned = 0;
    conn.transaction((tx) => {
      // Orphan chunks: not referenced by any file_chunks row.
      const chunkRes = tx.run(
        sql`DELETE FROM chunks WHERE chunk_hash NOT IN (SELECT chunk_hash FROM file_chunks)`,
      );
      chunksPruned = Number(chunkRes.changes ?? 0);
      // Orphan embeddings: their chunk no longer exists.
      const embRes = tx.run(
        sql`DELETE FROM embeddings WHERE chunk_hash NOT IN (SELECT chunk_hash FROM chunks)`,
      );
      embeddingsPruned = Number(embRes.changes ?? 0);
    });
    return { chunksPruned, embeddingsPruned };
  }

  async backfillFromChunksIfNeeded(): Promise<number> {
    const conn = db();
    // Idempotency gate: index_meta row records the one-shot run.
    const marker = conn
      .select({ k: indexMeta.key })
      .from(indexMeta)
      .where(eq(indexMeta.key, META_KEYS.FILE_CHUNKS_BACKFILLED_AT))
      .get();
    if (marker) return 0;
    const chunkCountRow = conn
      .select({ c: sql<number>`count(*)` })
      .from(chunksTable)
      .get();
    const chunkCount = chunkCountRow?.c ?? 0;
    const fileChunkCountBefore = await this.count();
    if (chunkCount === 0 || fileChunkCountBefore > 0) {
      // Either nothing to backfill, or some other path already populated the
      // table — still record the run so we stop re-checking on every call.
      conn
        .insert(indexMeta)
        .values({
          key: META_KEYS.FILE_CHUNKS_BACKFILLED_AT,
          value: new Date().toISOString(),
          updatedAt: new Date(),
        })
        .onConflictDoNothing()
        .run();
      return 0;
    }
    let inserted = 0;
    conn.transaction((tx) => {
      const before =
        tx
          .select({ c: sql<number>`count(*)` })
          .from(fileChunksTable)
          .get()?.c ?? 0;
      tx.run(
        sql`INSERT OR IGNORE INTO file_chunks (file_path, chunk_hash, file_sha, indexed_at)
            SELECT file_path, chunk_hash, file_sha, created_at FROM chunks`,
      );
      const after =
        tx
          .select({ c: sql<number>`count(*)` })
          .from(fileChunksTable)
          .get()?.c ?? 0;
      inserted = Math.max(0, after - before);
      tx.insert(indexMeta)
        .values({
          key: META_KEYS.FILE_CHUNKS_BACKFILLED_AT,
          value: new Date().toISOString(),
          updatedAt: new Date(),
        })
        .onConflictDoNothing()
        .run();
    });
    // Mirror against the embeddings table from chunks would be incorrect —
    // chunks.file_path is first-writer-wins, so a backfilled junction row
    // may map an embedding to the wrong file. That's the documented
    // approximation; first real reconcile overwrites with truth.
    return inserted;
  }
}
