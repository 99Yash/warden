import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { lifecycle_dates } from "../helpers.js";

/**
 * Cache for external lookups: CVE queries (OSV.dev), package registry
 * version checks, advisory metadata, web fetches with content snippets.
 *
 * Per `vision.md` §9 this is one of four caches Warden maintains. The
 * other three (codebase snapshot, dependency state, review history)
 * land in subsequent milestones — M1 ships only this one to validate
 * the Drizzle harness end-to-end.
 *
 * Lookups are keyed by a synthetic `query_key` (e.g. `osv:npm:axios@0.21.1`)
 * so callers can compose deterministic keys without exposing schema
 * details. Payloads are opaque JSON; verification of the payload is the
 * caller's responsibility.
 */
export const externalKnowledge = sqliteTable(
  "external_knowledge",
  {
    id: text("id").primaryKey(),

    /** Synthetic deterministic key, e.g. `osv:npm:axios@0.21.1`. */
    queryKey: text("query_key").notNull().unique(),

    /** Source kind so consumers can route formatting (cve | advisory | ...). */
    sourceType: text("source_type", {
      enum: [
        "cve",
        "advisory",
        "changelog",
        "documentation",
        "web",
        "tool",
        "repo_convention",
      ],
    }).notNull(),

    /** Original URL or query target, when applicable. */
    sourceUrl: text("source_url"),

    /** Verified payload from the upstream (raw JSON). */
    payload: text("payload", { mode: "json" })
      .notNull()
      .$type<Record<string, unknown>>(),

    /** Unix epoch ms; consumers respect TTLs documented in vision.md §9. */
    ttlExpiresAt: integer("ttl_expires_at", { mode: "timestamp_ms" }).notNull(),

    /** Time the upstream was actually queried (citation timestamp). */
    retrievedAt: integer("retrieved_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),

    ...lifecycle_dates,
  },
  (t) => ({
    sourceTypeIdx: index("external_knowledge_source_type_idx").on(t.sourceType),
    ttlExpiresAtIdx: index("external_knowledge_ttl_expires_at_idx").on(t.ttlExpiresAt),
  }),
);

export type ExternalKnowledge = typeof externalKnowledge.$inferSelect;
export type NewExternalKnowledge = typeof externalKnowledge.$inferInsert;
