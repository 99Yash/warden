import { and, chunks as chunksTable, count, db, eq, inArray } from "@warden/db";
import { isSupportedLanguage } from "../context/chunker.js";
import type { ChunkRecord, ChunkStore } from "./interfaces.js";

/**
 * SQLite `ChunkStore` impl (ADR-0019 #10). All writes are
 * `INSERT OR IGNORE` on `chunkHash` — chunk rows are immutable per content
 * (M5/M6 cache rule). Reads avoid `SELECT *` to keep types narrow.
 */
export class SqliteChunkStore implements ChunkStore {
  async upsert(chunk: ChunkRecord): Promise<void> {
    await this.upsertMany([chunk]);
  }

  async upsertMany(records: ChunkRecord[]): Promise<void> {
    if (records.length === 0) return;
    const rows = records.map((r) => ({
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
    db().insert(chunksTable).values(rows).onConflictDoNothing().run();
  }

  async getByHash(chunkHash: string): Promise<ChunkRecord | null> {
    const row = db().select().from(chunksTable).where(eq(chunksTable.chunkHash, chunkHash)).get();
    return row ? rowToRecord(row) : null;
  }

  async getManyByHash(chunkHashes: string[]): Promise<Map<string, ChunkRecord>> {
    if (chunkHashes.length === 0) return new Map();
    const out = new Map<string, ChunkRecord>();
    // SQLite caps `IN (...)` lists at ~1000 by default; chunk into batches so
    // 50k-chunk repos don't trip the limit.
    const BATCH = 500;
    for (let i = 0; i < chunkHashes.length; i += BATCH) {
      const slice = chunkHashes.slice(i, i + BATCH);
      const rows = db()
        .select()
        .from(chunksTable)
        .where(inArray(chunksTable.chunkHash, slice))
        .all();
      for (const row of rows) {
        const record = rowToRecord(row);
        if (record !== null) out.set(row.chunkHash, record);
      }
    }
    return out;
  }

  async getByFile(filePath: string, fileSha: string): Promise<ChunkRecord[]> {
    const rows = db()
      .select()
      .from(chunksTable)
      .where(and(eq(chunksTable.filePath, filePath), eq(chunksTable.fileSha, fileSha)))
      .all();
    return rows.flatMap((row) => rowToRecord(row) ?? []);
  }

  async count(): Promise<number> {
    const row = db().select({ value: count() }).from(chunksTable).get();
    return row?.value ?? 0;
  }
}

/**
 * `null` when the row's language is not a `SupportedLanguage`. The chunker
 * writes only supported languages, but the JSONL importer (`importer.ts`)
 * writes the language of an imported row as it is. The readers treat such a
 * row as absent.
 */
function rowToRecord(row: typeof chunksTable.$inferSelect): ChunkRecord | null {
  const language = row.language;
  if (!isSupportedLanguage(language)) return null;
  let symbolPath: string[] = [];
  try {
    const parsed = JSON.parse(row.symbolPathJson) as unknown;
    if (Array.isArray(parsed))
      symbolPath = parsed.filter((s): s is string => typeof s === "string");
  } catch {
    // Malformed JSON is treated as empty scope chain — chunk row stays usable.
  }
  return {
    chunkHash: row.chunkHash,
    filePath: row.filePath,
    fileSha: row.fileSha,
    language,
    symbolPath,
    startLine: row.startLine,
    endLine: row.endLine,
    content: row.content,
  };
}
