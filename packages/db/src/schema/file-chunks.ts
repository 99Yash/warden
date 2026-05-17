import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

/**
 * file_chunks junction table — the authoritative file→chunks mapping
 * introduced by M16 (ADR-0032). Replaces `chunks.file_path`'s first-writer-
 * wins approximation as the source of truth for "which chunks belong to
 * file X?".
 *
 * - Many-to-many: one row per (file_path, chunk_hash) pair. A single chunk
 *   appearing in two files produces two rows.
 * - `file_sha` reflects the version of the file that contained this chunk
 *   at last reconcile — used by reconcileFiles() to decide whether a file
 *   needs re-chunking.
 * - Composite PK (file_path, chunk_hash) deduplicates without effort.
 * - Indexes on both PK columns to support the two hot queries:
 *   (a) "what chunks belong to file X?" (file_path index)
 *   (b) "what files use this chunk?" (chunk_hash index — semantic.ts)
 */
export const fileChunks = sqliteTable(
  "file_chunks",
  {
    filePath: text("file_path").notNull(),
    chunkHash: text("chunk_hash").notNull(),
    fileSha: text("file_sha").notNull(),
    indexedAt: integer("indexed_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.filePath, t.chunkHash] }),
    pathIdx: index("idx_fc_path").on(t.filePath),
    hashIdx: index("idx_fc_hash").on(t.chunkHash),
  }),
);

export type FileChunksRow = typeof fileChunks.$inferSelect;
export type NewFileChunksRow = typeof fileChunks.$inferInsert;
