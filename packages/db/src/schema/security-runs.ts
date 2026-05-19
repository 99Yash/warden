import { real, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createId } from "../helpers.js";

export const securityRuns = sqliteTable("security_runs", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => createId("sec")),
  timestamp: integer("timestamp", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  mode: text("mode", { enum: ["security", "review-deep"] }).notNull(),
  modelBoss: text("model_boss").notNull(),
  modelWorkerStrong: text("model_worker_strong").notNull(),
  modelWorkerCheap: text("model_worker_cheap").notNull(),
  inputTokens: integer("input_tokens").notNull(),
  outputTokens: integer("output_tokens").notNull(),
  costUsd: real("cost_usd").notNull(),
  commentsEmitted: integer("comments_emitted").notNull(),
});

export type SecurityRunRow = typeof securityRuns.$inferSelect;
export type NewSecurityRunRow = typeof securityRuns.$inferInsert;
