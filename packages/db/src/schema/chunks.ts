import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Content-addressed chunk store for the M6 embedding-backed selector
 * (ADR-0019). Primary key is `chunk_hash = sha256(content)` — same content
 * across runs collapses to one row. No whitespace normalization (whitespace
 * changes are real changes per ADR-0019 #3).
 *
 * `symbol_path_json` is a JSON-stringified `string[]` representing the
 * scope chain code-chunk extracted (e.g. `["ClassFoo","method bar"]`). May
 * be empty when the chunker couldn't derive a scope.
 *
 * `file_path` + `file_sha` capture provenance — the same chunk content can
 * appear in multiple files / SHAs but the row stays unique by content. We
 * keep the first writer's provenance; subsequent identical content is a
 * no-op via `INSERT OR IGNORE`.
 */
export const chunks = sqliteTable("chunks", {
  chunkHash: text("chunk_hash").primaryKey(),
  filePath: text("file_path").notNull(),
  fileSha: text("file_sha").notNull(),
  language: text("language").notNull(),
  symbolPathJson: text("symbol_path_json").notNull(),
  startLine: integer("start_line").notNull(),
  endLine: integer("end_line").notNull(),
  content: text("content").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

export type ChunkRow = typeof chunks.$inferSelect;
export type NewChunkRow = typeof chunks.$inferInsert;
