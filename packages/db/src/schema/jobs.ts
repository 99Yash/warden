import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * SQLite-backed task table for the M6 sync `JobRunner` (ADR-0019 #4 —
 * Model A). Tasks are content-addressed via
 * `task_id = sha256(task_kind + ":" + sortedInputsJson)` so re-running the
 * same task is a no-op when its row is `done`. A Ctrl-C'd init resumes by
 * picking up `pending` / `in_progress` rows on the next run.
 *
 * Only one `task_kind` exists in v0: `"embed_chunk"`. The kind column is a
 * string rather than an enum so M7+ kinds (chunk-merkle aggregation,
 * cross-repo embed jobs) land additively.
 */
export const jobs = sqliteTable("jobs", {
  taskId: text("task_id").primaryKey(),
  taskKind: text("task_kind").notNull(),
  inputsJson: text("inputs_json").notNull(),
  status: text("status", { enum: ["pending", "in_progress", "done", "failed"] }).notNull(),
  errorMessage: text("error_message"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  completedAt: integer("completed_at", { mode: "timestamp_ms" }),
});

export type JobRow = typeof jobs.$inferSelect;
export type NewJobRow = typeof jobs.$inferInsert;
