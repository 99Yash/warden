/**
 * Smoke for M15 (ADR-0031) programmatic dispatch. Asserts that when
 * `BossLoopConfig.programmaticDispatch: true` is set, the harness runs a
 * deterministic Round 0 fan-out before the boss streamText loop —
 * dispatching one worker per (substantive file, det-prior-routed concern)
 * — and seeds the boss's initial user message with `<round_0_outputs>`.
 *
 * Fixture: 3 substantive files (≥10 added non-test/non-doc lines each).
 * Compares two runs on the same diff:
 *   [1] programmaticDispatch: false (default) — Round 0 should NOT fire.
 *   [2] programmaticDispatch: true — Round 0 fires; ≥3 workers dispatched
 *       against the 3 substantive files before the boss can possibly run.
 *
 * Verification uses a route-wrapper that records every dispatch with a
 * timestamp. Round 0 dispatches all fire in parallel before the streamText
 * call begins, so we look at the first burst of dispatches: ≥3 of them
 * citing the 3 substantive files.
 *
 * Skip semantics: `process.exit(2)` when ANTHROPIC_API_KEY is unset —
 * mirrors the M14 boss-loop smoke (the boss still needs to be invoked to
 * complete the loop, even if our assertions focus on Round 0).
 *
 * Usage:
 *   pnpm --filter @warden/cli smoke:m15-programmatic-dispatch
 */

import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const TMP_ROOT = resolve(tmpdir(), `warden-m15-progdispatch-${process.pid}`);
const TMP_DB = resolve(tmpdir(), `warden-m15-progdispatch-${process.pid}.sqlite`);
process.env["WARDEN_CACHE_PATH"] = TMP_DB;

if (existsSync(TMP_DB)) unlinkSync(TMP_DB);
if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });
mkdirSync(resolve(TMP_ROOT, "src"), { recursive: true });
writeFileSync(
  resolve(TMP_ROOT, "package.json"),
  JSON.stringify({ name: "smoke-fixture", version: "0.0.0", private: true }, null, 2),
);

// 3 substantive files. Each adds ~12 lines of non-test code so the
// SUBSTANTIVE_LINE_THRESHOLD (10) clears.
const FILES: { path: string; content: string }[] = [
  {
    path: "src/handler.ts",
    content: [
      `import type { Request, Response } from "express";`,
      `declare const db: { query: (sql: string) => Promise<unknown[]> };`,
      ``,
      `export async function lookupUser(req: Request, res: Response) {`,
      `  const userId = req.body.id;`,
      `  const sql = \`SELECT * FROM users WHERE id = '\${userId}'\`;`,
      `  const rows = await db.query(sql);`,
      `  res.json(rows);`,
      `}`,
      ``,
      `export function shutdownGracefully(): void {`,
      `  // No-op for the smoke fixture.`,
      `}`,
      ``,
    ].join("\n"),
  },
  {
    path: "src/dedup.ts",
    content: [
      `export function findDuplicateIds(users: { id: string }[]): string[] {`,
      `  return users`,
      `    .map((u) => u.id)`,
      `    .filter((id, i, arr) => arr.indexOf(id) !== i);`,
      `}`,
      ``,
      `export function uniqueIds(users: { id: string }[]): string[] {`,
      `  const seen = new Set<string>();`,
      `  const out: string[] = [];`,
      `  for (const u of users) {`,
      `    if (!seen.has(u.id)) {`,
      `      seen.add(u.id);`,
      `      out.push(u.id);`,
      `    }`,
      `  }`,
      `  return out;`,
      `}`,
      ``,
    ].join("\n"),
  },
  {
    path: "src/clone.ts",
    content: [
      `export interface NodeShape {`,
      `  id: string;`,
      `  children: NodeShape[];`,
      `}`,
      ``,
      `export function deepCloneNode(node: NodeShape): NodeShape {`,
      `  return JSON.parse(JSON.stringify(node)) as NodeShape;`,
      `}`,
      ``,
      `export function flattenIds(node: NodeShape): string[] {`,
      `  const out: string[] = [node.id];`,
      `  for (const child of node.children) {`,
      `    out.push(...flattenIds(child));`,
      `  }`,
      `  return out;`,
      `}`,
      ``,
    ].join("\n"),
  },
];

for (const f of FILES) {
  writeFileSync(resolve(TMP_ROOT, f.path), f.content);
}

const DIFF_PARTS: string[] = [];
for (const f of FILES) {
  const lines = f.content.split("\n");
  // Keep diff hunk count > 10 to clear SUBSTANTIVE_LINE_THRESHOLD.
  const count = Math.max(11, lines.length);
  DIFF_PARTS.push(
    `diff --git a/${f.path} b/${f.path}`,
    `--- /dev/null`,
    `+++ b/${f.path}`,
    `@@ -0,0 +1,${count} @@`,
    ...lines.slice(0, count).map((l) => `+${l}`),
  );
}
const DIFF = DIFF_PARTS.join("\n") + "\n";

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

type WorkerInvocation = Parameters<
  Awaited<ReturnType<typeof makeWorkerRoute>>
>[0];

let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) {
    process.stdout.write(`  ✓ ${msg}\n`);
  } else {
    process.stdout.write(`  ✗ ${msg}\n`);
    failed++;
  }
}

// One shared det-priors pass — same fixture, both scenarios.
process.stdout.write(`\n[0] running det priors (shared across scenarios)\n`);
const detPriors = await runDetPriors({
  diff: DIFF,
  repoRoot: TMP_ROOT,
  mode: "review",
  selector: null,
});
process.stdout.write(
  `  → ${detPriors.changed.length} changed file(s); ${detPriors.findings.length} det-prior finding(s)\n`,
);
assert(detPriors.changed.length === 3, `det priors picked up 3 files (got ${detPriors.changed.length})`);

// Wrap the route to record every dispatch with a timestamp.
function makeRecordingRoute(): {
  route: Awaited<ReturnType<typeof makeWorkerRoute>>;
  records: { file: string; concern: string; phase: string; ts: number }[];
} {
  const apiClaimDegraded: import("@warden/core").DegradedEntry[] = [];
  const inner = makeWorkerRoute({
    repoRoot: TMP_ROOT,
    changed: detPriors.changed,
    apiClaimDegraded,
  });
  const records: { file: string; concern: string; phase: string; ts: number }[] = [];
  const route = async (
    invocation: WorkerInvocation,
  ): Promise<Awaited<ReturnType<typeof inner>>> => {
    for (const file of invocation.files) {
      records.push({ file, concern: invocation.concern, phase: invocation.phase, ts: Date.now() });
    }
    return inner(invocation);
  };
  return { route, records };
}

// ---------------------------------------------------------------------------
// [1] programmaticDispatch: false (explicit opt-out) — Round 0 should NOT
// fire. Post-ADR-0031-close-out the harness defaults to PD-multi, so
// recovering "no Round 0" requires an explicit `false`.
// ---------------------------------------------------------------------------
process.stdout.write(`\n[1] programmaticDispatch: false → no Round 0 fan-out\n`);

const r1 = makeRecordingRoute();
const scratch1 = new ReviewScratchpad();
scratch1.recordDetPriors(detPriors);
const startMs1 = Date.now();
const result1 = await runBossLoop({
  repoRoot: TMP_ROOT,
  diff: DIFF,
  detPriors,
  scratchpad: scratch1,
  route: r1.route,
  config: { programmaticDispatch: false, roundZeroExtraConcerns: [] },
});
const wall1 = Date.now() - startMs1;
process.stdout.write(`  → ${result1.comments.length} comment(s) emitted in ${wall1}ms\n`);
process.stdout.write(`  → ${r1.records.length} dispatch(es) total\n`);

// Within the first 500ms, baseline shouldn't have spammed dispatches — the
// boss takes a few seconds to produce its first tool call. (Not a strict
// invariant of the boss-loop, but a reasonable signal that there was no
// deterministic Round 0 pre-burst.)
const earlyDispatches1 = r1.records.filter((r) => r.ts - startMs1 < 1500);
process.stdout.write(`  → ${earlyDispatches1.length} dispatch(es) in first 1.5s\n`);

// ---------------------------------------------------------------------------
// [2] programmaticDispatch: true (single-routed) — Round 0 fans out 3
// workers (one per substantive file, det-routed concern). Explicit
// `roundZeroExtraConcerns: []` keeps this scenario testing the plain
// single-concern shape rather than the new PD-multi default.
// ---------------------------------------------------------------------------
process.stdout.write(`\n[2] programmaticDispatch: true → Round 0 fires before boss\n`);

const r2 = makeRecordingRoute();
const scratch2 = new ReviewScratchpad();
scratch2.recordDetPriors(detPriors);
const startMs2 = Date.now();
const result2 = await runBossLoop({
  repoRoot: TMP_ROOT,
  diff: DIFF,
  detPriors,
  scratchpad: scratch2,
  route: r2.route,
  config: { programmaticDispatch: true, roundZeroExtraConcerns: [] },
});
const wall2 = Date.now() - startMs2;
process.stdout.write(`  → ${result2.comments.length} comment(s) emitted in ${wall2}ms\n`);
process.stdout.write(`  → ${r2.records.length} dispatch(es) total\n`);

// All 3 substantive files should appear in the dispatch record.
const filesSeen = new Set(r2.records.map((r) => r.file.replace(/\\/g, "/")));
const expectedFiles = ["src/handler.ts", "src/dedup.ts", "src/clone.ts"];
for (const f of expectedFiles) {
  assert(filesSeen.has(f), `Round 0 dispatched against ${f}`);
}

// Round 0 dispatches all fire in parallel before the streamText boss-loop
// call. They should arrive in the FIRST burst (≤ ~2s from start, well
// before the boss can complete its first thinking pass).
const round0Window = r2.records.filter((r) => r.ts - startMs2 < 2500);
process.stdout.write(`  → ${round0Window.length} dispatch(es) within first 2.5s (Round 0 window)\n`);
assert(
  round0Window.length >= 3,
  `≥3 dispatches in first 2.5s (Round 0 fan-out) — got ${round0Window.length}`,
);

// All Round 0 dispatches use phase: 'plan' per ROUND_0_PHASE in boss-loop.ts.
const planPhaseEarly = round0Window.filter((r) => r.phase === "plan");
assert(
  planPhaseEarly.length >= 3,
  `Round 0 dispatches use phase:'plan' (got ${planPhaseEarly.length} 'plan' in the window)`,
);

// ---------------------------------------------------------------------------
// Cleanup.
// ---------------------------------------------------------------------------

if (existsSync(TMP_DB)) unlinkSync(TMP_DB);
if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });

if (failed > 0) {
  process.stdout.write(`\n${failed} assertion(s) failed\n`);
  process.exit(1);
}
process.stdout.write(`\nall assertions passed\n`);
