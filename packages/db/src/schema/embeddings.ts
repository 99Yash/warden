import { sql } from "drizzle-orm";
import { blob, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Embeddings keyed on `(chunk_hash, model_id, model_version)` per ADR-0016 #2
 * + ADR-0019 #3. Composite PK so the same chunk under a different setup is
 * a separate row, both valid; old rows under a deprecated SKU stay readable
 * but unreachable when the locked model moves on.
 *
 * `vector` stores raw little-endian `Float32Array` bytes (1024 × 4 = 4 KB
 * per row for `voyage-code-3`). Drizzle's `blob({ mode: "buffer" })` returns
 * `Buffer`; the embedding-store impl converts to/from `Float32Array`.
 *
 * No DB-level FK to `chunks` — cardinality is asymmetric (chunk + multiple
 * model versions) and content-addressing covers correctness.
 */
export const embeddings = sqliteTable(
  "embeddings",
  {
    chunkHash: text("chunk_hash").notNull(),
    modelId: text("model_id").notNull(),
    modelVersion: text("model_version").notNull(),
    vector: blob("vector", { mode: "buffer" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.chunkHash, t.modelId, t.modelVersion] }),
  }),
);

export type EmbeddingRow = typeof embeddings.$inferSelect;
export type NewEmbeddingRow = typeof embeddings.$inferInsert;
