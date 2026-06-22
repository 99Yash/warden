import { real, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createId } from "../helpers.js";

/**
 * ADR-0048 §2 — durable review-run identity. Mirrors `securityRuns` but for
 * the default `warden review` / `warden check` harness, and carries the
 * **split key** the ADR specifies:
 *
 *   - `id` = random `createId("run")` — the durable run identity AND the
 *     Langfuse trace-grouping key. Two genuine re-runs of the same diff stay
 *     distinct rows so cross-run diffing has history.
 *   - `inputHash` = content-addressed hash over `(diff_hash, resolved config,
 *     sorted model-set)` — the dedup/resume lookup key (ADR-0048 §8 / issue
 *     #33). A future resume path recognises "same review" by this hash; this
 *     table is the substrate that supersedes the dead `llm_review_cache`
 *     (ADR-0007).
 *
 * The row is written **best-effort** at the end of `runReviewHarness()` and
 * must never block or fail a review (ADR-0048 caveat) — see
 * `recordReviewRun()` in the review harness.
 */
export const reviewRuns = sqliteTable("review_runs", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => createId("run")),
  timestamp: integer("timestamp", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  /**
   * Content-addressed dedup/resume key over `(diff_hash, resolved config,
   * sorted model-set)`. NOT unique — two re-runs of the same diff share an
   * `inputHash` but keep distinct `id`s (the split is deliberate, ADR-0048 §2).
   */
  inputHash: text("input_hash").notNull(),
  mode: text("mode", { enum: ["check", "review"] }).notNull(),
  modelBoss: text("model_boss").notNull(),
  modelWorkerStrong: text("model_worker_strong").notNull(),
  modelWorkerCheap: text("model_worker_cheap").notNull(),
  inputTokens: integer("input_tokens").notNull(),
  outputTokens: integer("output_tokens").notNull(),
  costUsd: real("cost_usd").notNull(),
  commentsEmitted: integer("comments_emitted").notNull(),
});

export type ReviewRunRow = typeof reviewRuns.$inferSelect;
export type NewReviewRunRow = typeof reviewRuns.$inferInsert;
