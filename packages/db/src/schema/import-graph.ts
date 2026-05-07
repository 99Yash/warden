import { sql } from "drizzle-orm";
import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Content-addressed parsed-imports cache for the M5 cheap-signals context
 * selector (ADR-0018). Primary key is `(file_path, file_sha)` — a row is
 * forever-valid for that exact content. Stale rows for the same path with
 * older SHAs are harmless; never `UPDATE`, only `INSERT OR IGNORE`.
 *
 * Invalidation is `git ls-files --modified --others --exclude-standard` →
 * fresh SHA → cache miss → reparse. See ADR-0018 "content-addressing turns
 * cache invalidation into cache lookup."
 */
export const importGraph = sqliteTable(
  "import_graph",
  {
    filePath: text("file_path").notNull(),
    fileSha: text("file_sha").notNull(),
    /** JSON-stringified `ImportRef[]` from `@warden/core/context/parser`. */
    importsJson: text("imports_json").notNull(),
    /** JSON-stringified `ExportRef[]` from `@warden/core/context/parser`. */
    exportsJson: text("exports_json").notNull(),
    computedAt: integer("computed_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.filePath, t.fileSha] }),
  }),
);

export type ImportGraphRow = typeof importGraph.$inferSelect;
export type NewImportGraphRow = typeof importGraph.$inferInsert;
