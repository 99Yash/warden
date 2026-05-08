import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * File-level Merkle store for change detection (ADR-0019 #5 — banner state
 * "stale" trigger). Each row is a leaf (file) hash; the repo root hash is
 * computed deterministically by aggregating leaves in path order and stored
 * separately in `index_meta`.
 *
 * `kind = "dir"` rows are reserved for the M7+ chunk-level Merkle expansion
 * (ADR-0018 nuance — Merkle tree earns rent later). M6 only writes `"file"`
 * rows; the schema flexibility is cheap and avoids a future migration.
 */
export const merkle = sqliteTable("merkle", {
  nodePath: text("node_path").primaryKey(),
  hash: text("hash").notNull(),
  kind: text("kind", { enum: ["file", "dir"] }).notNull(),
  observedAt: integer("observed_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

export type MerkleRow = typeof merkle.$inferSelect;
export type NewMerkleRow = typeof merkle.$inferInsert;
