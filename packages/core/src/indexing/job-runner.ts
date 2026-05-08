import { createHash } from "node:crypto";
import { db, eq, inArray, jobs as jobsTable } from "@warden/db";
import type { JobRunResult, JobRunner, JobRunnerProgress, Task } from "./interfaces.js";

/**
 * Default in-process `JobRunner` for M6 (ADR-0019 #4 — Model A). Tasks run
 * via a concurrency-limited promise pool; SQLite-backed task table provides
 * crash recovery so a Ctrl-C'd `init` resumes correctly on re-run.
 *
 * Idempotency contract: each task carries a content-addressed `taskId`.
 * Re-running a task that's already `done` is a no-op (the row stays as-is
 * and we count it under `alreadyDone`). Failed tasks become `pending` on
 * the next run so transient failures self-heal.
 */

const DEFAULT_CONCURRENCY = 4;

export interface SyncJobRunnerOptions {
  concurrency?: number;
}

export class SyncJobRunner implements JobRunner {
  private readonly concurrency: number;

  constructor(opts: SyncJobRunnerOptions = {}) {
    this.concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  }

  async pendingTaskIds(taskKind: string): Promise<string[]> {
    const rows = db()
      .select({ taskId: jobsTable.taskId, status: jobsTable.status })
      .from(jobsTable)
      .where(eq(jobsTable.taskKind, taskKind))
      .all();
    return rows
      .filter((r) => r.status === "pending" || r.status === "in_progress")
      .map((r) => r.taskId);
  }

  async run<TInput, TOutput>(
    tasks: Task<TInput, TOutput>[],
    opts: {
      onProgress?: (p: JobRunnerProgress) => void;
      tokensFor?: (output: TOutput) => number;
    } = {},
  ): Promise<JobRunResult<TOutput>> {
    if (tasks.length === 0) {
      return { outputs: [], failed: [], alreadyDone: 0 };
    }
    const taskKind = tasks[0]?.taskKind ?? "";

    // Initial sync: register tasks, mark cache hits.
    const existing = readJobRows(tasks.map((t) => t.taskId));
    const todo: Task<TInput, TOutput>[] = [];
    let alreadyDone = 0;
    const insertQueue: { taskId: string; taskKind: string; inputsJson: string }[] = [];

    for (const task of tasks) {
      const row = existing.get(task.taskId);
      if (row?.status === "done") {
        alreadyDone++;
        continue;
      }
      if (!row) {
        insertQueue.push({
          taskId: task.taskId,
          taskKind: task.taskKind,
          inputsJson: JSON.stringify(task.input ?? null),
        });
      } else {
        // Reset failed/in_progress to pending so this run picks them up.
        db()
          .update(jobsTable)
          .set({ status: "pending", errorMessage: null })
          .where(eq(jobsTable.taskId, task.taskId))
          .run();
      }
      todo.push(task);
    }

    if (insertQueue.length > 0) {
      db()
        .insert(jobsTable)
        .values(
          insertQueue.map((r) => ({
            taskId: r.taskId,
            taskKind: r.taskKind,
            inputsJson: r.inputsJson,
            status: "pending" as const,
            createdAt: new Date(),
          })),
        )
        .onConflictDoNothing()
        .run();
    }

    const outputs: TOutput[] = [];
    const failed: { taskId: string; error: string }[] = [];
    let completed = alreadyDone;
    const total = tasks.length;
    let promptTokensSoFar = 0;
    const startedAt = Date.now();

    let cursor = 0;
    const inFlight: Promise<void>[] = [];

    const runOne = async (task: Task<TInput, TOutput>): Promise<void> => {
      db()
        .update(jobsTable)
        .set({ status: "in_progress" })
        .where(eq(jobsTable.taskId, task.taskId))
        .run();
      try {
        const out = await task.run();
        db()
          .update(jobsTable)
          .set({ status: "done", completedAt: new Date(), errorMessage: null })
          .where(eq(jobsTable.taskId, task.taskId))
          .run();
        outputs.push(out);
        if (opts.tokensFor) promptTokensSoFar += opts.tokensFor(out);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        db()
          .update(jobsTable)
          .set({ status: "failed", errorMessage: msg.slice(0, 1000) })
          .where(eq(jobsTable.taskId, task.taskId))
          .run();
        failed.push({ taskId: task.taskId, error: msg });
      } finally {
        completed++;
        opts.onProgress?.({
          taskKind,
          completed,
          total,
          promptTokensSoFar,
          elapsedMs: Date.now() - startedAt,
        });
      }
    };

    const next = (): Promise<void> | undefined => {
      if (cursor >= todo.length) return undefined;
      const task = todo[cursor++];
      if (!task) return undefined;
      return runOne(task).then(() => {
        const follow = next();
        if (follow) return follow;
        return undefined;
      });
    };

    for (let i = 0; i < this.concurrency; i++) {
      const p = next();
      if (p) inFlight.push(p);
    }
    await Promise.all(inFlight);

    return { outputs, failed, alreadyDone };
  }
}

/**
 * Compute the content-addressed task id for `(kind, input)`. Sort key order
 * for inputs so JSON canonicalization is stable across runs.
 */
export function taskIdFor(kind: string, input: unknown): string {
  const json = canonicalJson(input);
  return createHash("sha256").update(`${kind}:${json}`, "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

function readJobRows(
  taskIds: string[],
): Map<string, { taskId: string; status: "pending" | "in_progress" | "done" | "failed" }> {
  if (taskIds.length === 0) return new Map();
  const out = new Map<
    string,
    { taskId: string; status: "pending" | "in_progress" | "done" | "failed" }
  >();
  const BATCH = 500;
  for (let i = 0; i < taskIds.length; i += BATCH) {
    const slice = taskIds.slice(i, i + BATCH);
    if (slice.length === 0) continue;
    const rows = db()
      .select({ taskId: jobsTable.taskId, status: jobsTable.status })
      .from(jobsTable)
      .where(inArray(jobsTable.taskId, slice))
      .all();
    for (const r of rows) out.set(r.taskId, r);
  }
  return out;
}
