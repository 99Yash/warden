import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Single-key/value table for the M6 locked-model concept + repo-merkle root
 * + format version (ADR-0019 #6 + #7). Documented keys live in
 * `@warden/core/indexing/meta.ts` (`META_KEYS`); the schema deliberately
 * stays string-typed so adding new meta keys in M7+ is one constant + one
 * helper, no migration.
 */
export const indexMeta = sqliteTable("index_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

export type IndexMetaRow = typeof indexMeta.$inferSelect;
export type NewIndexMetaRow = typeof indexMeta.$inferInsert;
