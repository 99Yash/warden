/**
 * Smoke for the M14 review-harness's empty-diff short-circuit. Calls
 * `runReviewHarness()` with `diff: ""` and asserts the harness returns
 * before instantiating the scratchpad or making any LLM call. Per the
 * M14 plan §Design nuances, an empty diff is a one-line early-return at
 * harness entry — zero LLM calls, zero cost.
 *
 * Asserts:
 *   1. `comments` is empty.
 *   2. `metadata.degradedWorkers` contains no `topic: "llm"` entries
 *      (any environmental entries like gitignore/banner are fine).
 *   3. `metadata.durationMs` is small (< 5000ms — generous to accommodate
 *      Phase 1's environment setup like the banner walk; the assertion
 *      is "no LLM was called", not "fast").
 *
 * Cannot assert "zero network requests" without instrumentation, so we
 * use absence-of-llm-degraded as the proxy: if the boss-loop had run,
 * it would have either succeeded (no degraded) or failed (warning
 * topic="llm") — either way, the absence of any llm-topic entry
 * combined with the short duration is sufficient evidence the boss
 * didn't fire.
 *
 * Usage:
 *   pnpm --filter @warden/cli smoke:m14-empty-diff
 */

import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const TMP_ROOT = resolve(tmpdir(), `warden-m14-empty-diff-${process.pid}`);
const TMP_DB = resolve(tmpdir(), `warden-m14-empty-diff-${process.pid}.sqlite`);
process.env["WARDEN_CACHE_PATH"] = TMP_DB;

if (existsSync(TMP_DB)) unlinkSync(TMP_DB);
if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });
mkdirSync(TMP_ROOT, { recursive: true });

// Minimal package.json — `detectEcosystem()` returns `hasPackageJson: false`
// otherwise, and the harness short-circuits earlier with an ecosystem
// degraded entry. We want the empty-diff path specifically.
writeFileSync(
  resolve(TMP_ROOT, "package.json"),
  JSON.stringify({ name: "smoke-fixture", version: "0.0.0", private: true }, null, 2),
);

const { runReviewHarness } = await import("@warden/core/review-harness/harness");

let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) {
    process.stdout.write(`  ✓ ${msg}\n`);
  } else {
    process.stdout.write(`  ✗ ${msg}\n`);
    failed++;
  }
}

process.stdout.write(`\n[1] empty diff → no LLM call, fast return\n`);

const startedAt = Date.now();
const result = await runReviewHarness({
  diff: "",
  repoRoot: TMP_ROOT,
  config: { mode: "review" },
  // Skip the selector — empty diff means it would have nothing to look at,
  // but null is the cleaner intent signal.
  selector: null,
});
const wallMs = Date.now() - startedAt;

assert(result.comments.length === 0, `comments[] is empty (got ${result.comments.length})`);

const llmEntries = result.metadata.degradedWorkers.filter((d) => d.topic === "llm");
assert(
  llmEntries.length === 0,
  `no llm-topic degraded entries (got ${llmEntries.length}: ${llmEntries.map((d) => d.message).join(" | ")})`,
);

assert(
  result.metadata.durationMs < 5_000,
  `harness duration < 5000ms (got ${result.metadata.durationMs})`,
);
assert(
  wallMs < 5_000,
  `wall-clock < 5000ms (got ${wallMs})`,
);

// ---------------------------------------------------------------------------
// 2. check-mode empty-diff also short-circuits cleanly.
// ---------------------------------------------------------------------------

process.stdout.write(`\n[2] check-mode empty diff → no banner walk, no LLM\n`);

const checkStart = Date.now();
const checkResult = await runReviewHarness({
  diff: "",
  repoRoot: TMP_ROOT,
  config: { mode: "check" },
  selector: null,
});
const checkWallMs = Date.now() - checkStart;

assert(checkResult.comments.length === 0, `check comments[] is empty`);
assert(
  checkResult.metadata.degradedWorkers.filter((d) => d.topic === "llm").length === 0,
  `check mode: no llm-topic degraded`,
);
assert(checkWallMs < 5_000, `check mode wall-clock < 5000ms (got ${checkWallMs})`);

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
