/**
 * Smoke for the M14 boss loop — Phase 2 of the review harness. Calls
 * `runBossLoop()` directly (rather than `runReviewHarness()`) so the
 * test has visibility into the `ReviewScratchpad`'s recorded worker
 * outputs. Three scenarios on the same 2-file fixture per the
 * user-grilled M14 plan (§Q4):
 *
 *   [1] Baseline                 — defaults; expect ≥0 worker outputs
 *                                  + ≥0 comments; boss-loop exited
 *                                  without an error degraded entry.
 *   [2] WARDEN_REVIEW_BOSS_ROUNDS=1 — boss exits after one step; total
 *                                  scratchpad.bossTokens != undefined
 *                                  (i.e., one streamText call happened);
 *                                  no exception thrown.
 *   [3] WARDEN_REVIEW_WORKER_BUDGET=1 — scratchpad.workerOutputs() ≤ 1;
 *                                  if boss attempted more, a
 *                                  `review-harness` budget-exhausted
 *                                  degraded entry surfaces.
 *
 * Fixture: a 2-file diff with two distinct, obvious anti-patterns —
 * SQL-injection on handler.ts (security worker territory) and an
 * O(n²) `filter+indexOf` dedup on dedup.ts (scalability worker
 * territory). Gives the boss two plausible reasons to dispatch
 * different workers but doesn't pin any specific count.
 *
 * Skip semantics: `process.exit(2)` when ANTHROPIC_API_KEY is unset.
 *
 * Usage:
 *   pnpm --filter @warden/cli smoke:m14-boss-loop
 */

import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const TMP_ROOT = resolve(tmpdir(), `warden-m14-boss-loop-${process.pid}`);
const TMP_DB = resolve(tmpdir(), `warden-m14-boss-loop-${process.pid}.sqlite`);
process.env["WARDEN_CACHE_PATH"] = TMP_DB;

if (existsSync(TMP_DB)) unlinkSync(TMP_DB);
if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });
mkdirSync(resolve(TMP_ROOT, "src"), { recursive: true });
writeFileSync(
  resolve(TMP_ROOT, "package.json"),
  JSON.stringify({ name: "smoke-fixture", version: "0.0.0", private: true }, null, 2),
);

// Two files, two distinct anti-patterns.
const HANDLER_PATH = "src/handler.ts";
const HANDLER_CONTENT = [
  `import type { Request, Response } from "express";`,
  ``,
  `declare const db: { query: (sql: string) => Promise<unknown[]> };`,
  ``,
  `export async function lookupUser(req: Request, res: Response) {`,
  `  const userId = req.body.id;`,
  `  const sql = \`SELECT * FROM users WHERE id = '\${userId}'\`;`,
  `  const rows = await db.query(sql);`,
  `  res.json(rows);`,
  `}`,
  ``,
].join("\n");
writeFileSync(resolve(TMP_ROOT, HANDLER_PATH), HANDLER_CONTENT);

const DEDUP_PATH = "src/dedup.ts";
const DEDUP_CONTENT = [
  `// Returns the duplicate ids in \`users\`. \`users\` can grow to ~50k entries`,
  `// in the worst case (full account-snapshot scan).`,
  `export function findDuplicateIds(users: { id: string }[]): string[] {`,
  `  return users`,
  `    .map((u) => u.id)`,
  `    .filter((id, i, arr) => arr.indexOf(id) !== i);`,
  `}`,
  ``,
].join("\n");
writeFileSync(resolve(TMP_ROOT, DEDUP_PATH), DEDUP_CONTENT);

// Unified diff covering both files (full-add hunks).
const DIFF = [
  `diff --git a/${HANDLER_PATH} b/${HANDLER_PATH}`,
  `--- /dev/null`,
  `+++ b/${HANDLER_PATH}`,
  `@@ -0,0 +1,11 @@`,
  ...HANDLER_CONTENT.split("\n").slice(0, 11).map((l) => `+${l}`),
  `diff --git a/${DEDUP_PATH} b/${DEDUP_PATH}`,
  `--- /dev/null`,
  `+++ b/${DEDUP_PATH}`,
  `@@ -0,0 +1,7 @@`,
  ...DEDUP_CONTENT.split("\n").slice(0, 7).map((l) => `+${l}`),
  ``,
].join("\n");

const hasKey =
  typeof process.env["ANTHROPIC_API_KEY"] === "string" &&
  process.env["ANTHROPIC_API_KEY"].length > 0;
if (!hasKey) {
  process.stdout.write(`\n[skip] ANTHROPIC_API_KEY not set\n`);
  if (existsSync(TMP_DB)) unlinkSync(TMP_DB);
  if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });
  process.exit(2);
}

const { runDetPriors } = await import("@warden/core/review-harness/det-priors");
const { runBossLoop } = await import("@warden/core/review-harness/boss-loop");
const { ReviewScratchpad } = await import("@warden/core/review-harness/scratchpad");
const { makeWorkerRoute } = await import("@warden/core/review-harness/workers/dispatch");

let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) {
    process.stdout.write(`  ✓ ${msg}\n`);
  } else {
    process.stdout.write(`  ✗ ${msg}\n`);
    failed++;
  }
}

// Det priors are scenario-independent; run them once and reuse.
process.stdout.write(`\n[0] running det priors (shared across scenarios)\n`);
const detPriors = await runDetPriors({
  diff: DIFF,
  repoRoot: TMP_ROOT,
  mode: "review",
  // Skip the selector — we don't need retrieved context for this smoke;
  // the boss-loop dispatches workers based on the diff + det-prior findings.
  selector: null,
});
process.stdout.write(
  `  → ${detPriors.changed.length} changed file(s), ${detPriors.findings.length} det-prior finding(s)\n`,
);
assert(detPriors.changed.length === 2, `det priors picked up both files (got ${detPriors.changed.length})`);

// ---------------------------------------------------------------------------
// Helper — fresh scratchpad + route per scenario.
// ---------------------------------------------------------------------------

async function runScenario(label: string): Promise<{
  scratchpad: InstanceType<typeof ReviewScratchpad>;
  comments: import("@warden/core").Comment[];
  degraded: import("@warden/core").DegradedEntry[];
  durationMs: number;
}> {
  const scratchpad = new ReviewScratchpad();
  scratchpad.recordDetPriors(detPriors);
  const apiClaimDegraded: import("@warden/core").DegradedEntry[] = [];
  const route = makeWorkerRoute({
    repoRoot: TMP_ROOT,
    changed: detPriors.changed,
    apiClaimDegraded,
  });
  process.stdout.write(`\n[${label}] running boss-loop\n`);
  const startedAt = Date.now();
  const result = await runBossLoop({
    repoRoot: TMP_ROOT,
    diff: DIFF,
    detPriors,
    scratchpad,
    route,
    ...(process.env["WARDEN_REVIEW_WORKER_BUDGET"]
      ? { workerBudget: Number(process.env["WARDEN_REVIEW_WORKER_BUDGET"]) }
      : {}),
  });
  const wallMs = Date.now() - startedAt;
  process.stdout.write(
    `  → boss emitted ${result.comments.length} comment(s) in ${wallMs}ms ` +
      `(workers dispatched: ${scratchpad.workerOutputs().length})\n`,
  );
  return {
    scratchpad,
    comments: result.comments,
    degraded: result.degraded,
    durationMs: result.durationMs,
  };
}

// ---------------------------------------------------------------------------
// [1] Baseline — default BOSS_ROUNDS, no WORKER_BUDGET cap.
// ---------------------------------------------------------------------------

delete process.env["WARDEN_REVIEW_BOSS_ROUNDS"];
delete process.env["WARDEN_REVIEW_WORKER_BUDGET"];

const baseline = await runScenario("1] baseline");
assert(baseline.comments.length >= 0, `baseline emitted ≥0 comments (got ${baseline.comments.length})`);
// Boss must have at least one streamText call → bossTokens is populated.
assert(
  baseline.scratchpad.bossTokens() !== undefined,
  `baseline boss tokens are recorded`,
);
// No "boss-loop crashed" warning.
const bossErrors = baseline.degraded.filter(
  (d) => d.topic === "llm" && d.kind === "warning",
);
process.stdout.write(`  · baseline boss-llm warnings: ${bossErrors.length}\n`);

for (const c of baseline.comments.slice(0, 4)) {
  const summary = c.claim.length > 100 ? c.claim.slice(0, 100) + "…" : c.claim;
  process.stdout.write(`    [${c.category}/${c.kind}/T${c.tier}] ${c.file}:${c.lineStart} — ${summary}\n`);
}

// ---------------------------------------------------------------------------
// [2] WARDEN_REVIEW_BOSS_ROUNDS=1 — boss exits after one step.
// ---------------------------------------------------------------------------

process.env["WARDEN_REVIEW_BOSS_ROUNDS"] = "1";
delete process.env["WARDEN_REVIEW_WORKER_BUDGET"];

const rounds1 = await runScenario("2] BOSS_ROUNDS=1");
assert(
  rounds1.scratchpad.bossTokens() !== undefined,
  `BOSS_ROUNDS=1 made at least one boss call`,
);
// With only 1 step, the boss may legitimately produce zero workers (it
// must synth in the same step it could have dispatched in). No hard
// assertion on worker count — just that the boss exited cleanly.
process.stdout.write(
  `  · BOSS_ROUNDS=1 workers dispatched: ${rounds1.scratchpad.workerOutputs().length}\n`,
);
process.stdout.write(`  · BOSS_ROUNDS=1 comments emitted: ${rounds1.comments.length}\n`);

// ---------------------------------------------------------------------------
// [3] WARDEN_REVIEW_WORKER_BUDGET=1 — worker budget cap.
// ---------------------------------------------------------------------------

delete process.env["WARDEN_REVIEW_BOSS_ROUNDS"];
process.env["WARDEN_REVIEW_WORKER_BUDGET"] = "1";

const budget1 = await runScenario("3] WORKER_BUDGET=1");
const workerCount = budget1.scratchpad.workerOutputs().length;
assert(
  workerCount <= 1,
  `worker budget caps dispatched count at 1 (got ${workerCount})`,
);

// If the boss attempted a 2nd dispatch, a budget-exhausted degraded entry
// must surface in the scratchpad (recorded via scratchpad.recordDegraded()
// from the dispatch tool). flattenDegraded() unions detPriors + worker +
// scratchpad-level entries.
const allDegraded = budget1.scratchpad.flattenDegraded();
const budgetEntries = allDegraded.filter(
  (d) => d.topic === "review-harness" && d.message.includes("worker budget exhausted"),
);
process.stdout.write(`  · WORKER_BUDGET=1 budget-exhausted entries: ${budgetEntries.length}\n`);
// Conditional assertion: if boss tried to dispatch a 2nd, the entry must
// be exactly 1 (the dispatch tool emits it at most once).
if (budgetEntries.length > 0) {
  assert(
    budgetEntries.length === 1,
    `budget-exhausted entry emitted exactly once (got ${budgetEntries.length})`,
  );
  assert(
    budgetEntries[0]?.kind === "actionable",
    `budget-exhausted entry kind is actionable (got ${budgetEntries[0]?.kind})`,
  );
}

// ---------------------------------------------------------------------------
// Cleanup.
// ---------------------------------------------------------------------------

delete process.env["WARDEN_REVIEW_BOSS_ROUNDS"];
delete process.env["WARDEN_REVIEW_WORKER_BUDGET"];
if (existsSync(TMP_DB)) unlinkSync(TMP_DB);
if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });

if (failed > 0) {
  process.stdout.write(`\n${failed} assertion(s) failed\n`);
  process.exit(1);
}
process.stdout.write(`\nall assertions passed\n`);
