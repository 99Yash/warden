import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { lifecycle_dates } from "../helpers.js";

/**
 * Content-addressed cache for LLM formatter outputs (ADR-0007 / vision.md §9
 * "review history"). Per the M4 grilling Q10 decision: cache key is a hash
 * over `(model_id, system_prompt_hash, user_template_hash,
 * sorted_input_comment_ids, diff_hash)` — re-running an identical review
 * is a no-op against this table.
 *
 * No TTL: content addressing handles freshness. Any input change produces
 * a different `cache_key` and misses the cache; identical inputs produce
 * identical outputs and hit it.
 */
export const llmReviewCache = sqliteTable(
  "llm_review_cache",
  {
    id: text("id").primaryKey(),

    /** Synthetic content-addressed key — hash of all inputs that affect output. */
    cacheKey: text("cache_key").notNull().unique(),

    /** Provider that served this entry (`anthropic` or `google` per ADR-0017). */
    provider: text("provider", { enum: ["anthropic", "google"] }).notNull(),

    /** Model SKU at time of generation (e.g. `claude-sonnet-4-6`). */
    modelId: text("model_id").notNull(),

    /** LLM output payload — `{ revisedComments[], questions[] }`. */
    payload: text("payload", { mode: "json" }).notNull().$type<Record<string, unknown>>(),

    /** Wall-clock duration of the upstream call (ms). For dogfooding telemetry. */
    durationMs: integer("duration_ms").notNull(),

    ...lifecycle_dates,
  },
  (t) => ({
    providerIdx: index("llm_review_cache_provider_idx").on(t.provider),
  }),
);

export type LlmReviewCache = typeof llmReviewCache.$inferSelect;
export type NewLlmReviewCache = typeof llmReviewCache.$inferInsert;
