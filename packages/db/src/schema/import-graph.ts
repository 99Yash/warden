import { sql } from "drizzle-orm";
import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Content-addressed parsed-imports cache for the M5 cheap-signals context
 * selector (ADR-0018). Primary key is `(file_path, file_sha)` — a row is
 * forever-valid for that exact content. Stale rows for the same path with
 * older SHAs are harmless; never `UPDATE`, only `INSERT OR IGNORE`.
 *
 * There is no invalidation step: `loadImportGraph` hashes every tracked
 * source file per review and reads only the rows for those hashes, so rows
 * for other snapshots stay here but are never active (ADR-0018 amendment,
 * issue #62).
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
