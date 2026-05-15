/**
 * Smoke harness for M13's security sub-agent (ADR-0028 §3). Exercises the
 * structural pieces that don't require a real LLM call:
 *
 *   1. Empty changed[] → silent no-op (no questions, no degraded).
 *   2. Path-escape diff path surfaces a warning degraded entry (mirrors
 *      leverage-libraries' lane-discipline posture).
 *   3. The runner's `Runner`-contract wrapper round-trips correctly.
 *   4. When `ANTHROPIC_API_KEY` is unset (or any sub-agent call fails),
 *      the runner returns `{ questions: [], degraded: [warning] }` instead
 *      of crashing — graceful skip.
 *
 * The full LLM-driven path (citation discipline, lookupTypeDef invocation,
 * lane-drop counters) is dogfooded against the warden tree itself per the
 * m13-plan §12 acceptance criterion, not stress-tested here — the cheap-tier
 * Haiku is non-deterministic per-call and CI assertions on its output flake
 * regularly. The unit-style structural checks below stand on their own.
 *
 * Usage:
 *   pnpm --filter @warden/cli smoke:m13-sub-agent
 */

import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const TMP_ROOT = resolve(tmpdir(), `warden-m13-subagent-${process.pid}`);
const TMP_DB = resolve(tmpdir(), `warden-m13-subagent-${process.pid}.sqlite`);
process.env["WARDEN_CACHE_PATH"] = TMP_DB;

if (existsSync(TMP_DB)) unlinkSync(TMP_DB);
if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });
mkdirSync(TMP_ROOT, { recursive: true });

const { runSecurity, securityRunner } = await import("@warden/core/runners/security");

let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) {
    process.stdout.write(`  ✓ ${msg}\n`);
  } else {
    process.stdout.write(`  ✗ ${msg}\n`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// 1. Empty changed → silent no-op.
// ---------------------------------------------------------------------------

process.stdout.write(`\n[1] empty changed → silent no-op\n`);
const emptyResult = await runSecurity({ repoRoot: TMP_ROOT, changed: [] });
assert(emptyResult.questions.length === 0, "no questions emitted");
assert(emptyResult.degraded.length === 0, "no degraded entries");

// ---------------------------------------------------------------------------
// 2. Path-escape — diff path resolves outside repoRoot, surfaces warning.
// ---------------------------------------------------------------------------

process.stdout.write(`\n[2] path-escape surfaces warning degraded\n`);
mkdirSync(resolve(TMP_ROOT, "src"), { recursive: true });
writeFileSync(
  resolve(TMP_ROOT, "src/handler.ts"),
  [
    `export function handler(req: { body: { sql: string } }) {`,
    `  // intentional SQL injection bait for the dogfood path`,
    `  return req.body.sql;`,
    `}`,
    ``,
  ].join("\n"),
);
const escapeResult = await runSecurity({
  repoRoot: TMP_ROOT,
  changed: [
    { path: "../../etc/passwd", addedLines: [1] },
    { path: "src/handler.ts", addedLines: [1, 2, 3] },
  ],
  timeoutMs: 4_000,
});
const escapeWarnings = escapeResult.degraded.filter(
  (d) =>
    d.topic === "security" &&
    d.kind === "warning" &&
    d.message.includes("path escapes repoRoot"),
);
assert(
  escapeWarnings.length === 1,
  `exactly one path-escape warning (got ${escapeWarnings.length})`,
);
assert(
  escapeWarnings[0]?.message.includes("../../etc/passwd"),
  "warning names the offending path",
);

// ---------------------------------------------------------------------------
// 3. Runner-contract round-trip.
// ---------------------------------------------------------------------------

process.stdout.write(`\n[3] Runner contract shape\n`);
const contractOut = await securityRunner.run({
  repoRoot: TMP_ROOT,
  changed: [],
  changedPaths: [],
});
assert(contractOut.name === "security", `name is "security" (got ${contractOut.name})`);
assert(Array.isArray(contractOut.findings), "findings[] is an array");
assert(contractOut.findings.length === 0, "findings[] is empty (sub-agent emits questions)");
assert(Array.isArray(contractOut.questions), "questions[] is an array");
assert(Array.isArray(contractOut.degraded), "degraded[] is an array");
assert(typeof contractOut.durationMs === "number", "durationMs is a number");

// ---------------------------------------------------------------------------
// 4. No env key → graceful warning, no crash.
// ---------------------------------------------------------------------------

process.stdout.write(`\n[4] graceful failure without API keys\n`);
const hasKey = typeof process.env["ANTHROPIC_API_KEY"] === "string"
  && process.env["ANTHROPIC_API_KEY"].length > 0;
if (!hasKey) {
  // No keys → the sub-agent attempts the call, fails on missing API key,
  // and returns a warning degraded entry.
  const noKeyResult = await runSecurity({
    repoRoot: TMP_ROOT,
    changed: [{ path: "src/handler.ts", addedLines: [1, 2, 3] }],
    timeoutMs: 4_000,
  });
  assert(Array.isArray(noKeyResult.questions), "questions[] is an array (no crash)");
  assert(
    noKeyResult.degraded.some(
      (d) => d.topic === "security" && d.message.includes("sub-agent failed"),
    ) || noKeyResult.degraded.some(
      (d) => d.topic === "security" && d.message.includes("model unavailable"),
    ),
    "surfaces a graceful security degraded entry on missing key",
  );
} else {
  // With keys, just verify the call shape doesn't crash; output is
  // non-deterministic but must satisfy the lane-discipline shape.
  process.stdout.write(`  (ANTHROPIC_API_KEY is set — running shape check only)\n`);
  const result = await runSecurity({
    repoRoot: TMP_ROOT,
    changed: [{ path: "src/handler.ts", addedLines: [1, 2, 3] }],
    timeoutMs: 30_000,
  });
  assert(Array.isArray(result.questions), "questions[] is an array");
  for (const q of result.questions) {
    assert(q.category === "security", `question category is security (got ${q.category})`);
    assert(q.kind === "question", `question kind is question (got ${q.kind})`);
    assert(
      q.sources.length > 0,
      `question carries at least one source (lane discipline)`,
    );
  }
}

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
