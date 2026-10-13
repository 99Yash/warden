import { sql } from "drizzle-orm";
import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Content-addressed parse cache for the import graph (ADR-0018). Primary key
 * is `(file_path, file_sha)`. Rows are immutable: never `UPDATE`, only
 * `INSERT OR IGNORE`. Rows for older SHAs of the same path stay here.
 *
 * `loadImportGraph` hashes every tracked source file on each load and reads
 * only the rows for those `(path, sha)` keys. Rows for other snapshots are
 * never active (ADR-0018 amendment, issue #62).
 *
 * The loader trusts only the facts that the file's own bytes determine:
 * specifiers, symbols, ranges, exports. Each stored `ImportRef` also keeps
 * `resolved` from the parse. That target depends on other files and on
 * tsconfig, so the loader ignores the stored value and resolves each import
 * again on each load.
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
