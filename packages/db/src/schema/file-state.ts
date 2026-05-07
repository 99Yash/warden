import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Per-path pointer to the SHA the selector last observed (M5 / ADR-0018).
 * Refreshed for git-modified + untracked files at the start of every
 * `select()` invocation. The pair `(filePath, currentSha)` is the lookup
 * key into `import_graph`.
 *
 * Path-only primary key (one row per file). `currentSha` advances over time;
 * old SHAs live on in `import_graph` and are simply unreachable once the
 * pointer moves.
 */
export const fileState = sqliteTable("file_state", {
  filePath: text("file_path").primaryKey(),
  currentSha: text("current_sha").notNull(),
  observedAt: integer("observed_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

export type FileStateRow = typeof fileState.$inferSelect;
export type NewFileStateRow = typeof fileState.$inferInsert;
