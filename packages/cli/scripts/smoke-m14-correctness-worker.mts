/**
 * Smoke for the M14 correctness worker (Sonnet tier). Plants an
 * unambiguous off-by-one bug in a 5-line fixture, dispatches the
 * correctness worker via `makeWorkerRoute()`, and asserts on
 * deterministic facets of the result (per the user-grilled M14 plan
 * §Q3):
 *
 *   - `result.findings.length >= 1` — worker did not return empty.
 *   - For at least one finding: `category === "correctness"`,
 *     `file === fixture path`, `lineStart` in the expected range,
 *     `kind` ∈ {"assertion", "question"}, `sources[].length > 0`,
 *     every source `type` ∈ {"tool", "api_def"}.
 *   - Soft signal: at least one finding's `claim` carries an off-by-one
 *     adjacent keyword (out/bound/length/undefined) — flagged, not
 *     asserted, so model variance doesn't break CI.
 *
 * Skips cleanly with `process.exit(2)` when ANTHROPIC_API_KEY is unset
 * — provider-error semantics distinct from a logic failure.
 *
 * Usage:
 *   pnpm --filter @warden/cli smoke:m14-correctness-worker
 */

import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const TMP_ROOT = resolve(tmpdir(), `warden-m14-correctness-${process.pid}`);
const TMP_DB = resolve(tmpdir(), `warden-m14-correctness-${process.pid}.sqlite`);
process.env["WARDEN_CACHE_PATH"] = TMP_DB;

if (existsSync(TMP_DB)) unlinkSync(TMP_DB);
if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });
mkdirSync(resolve(TMP_ROOT, "src"), { recursive: true });

writeFileSync(
  resolve(TMP_ROOT, "package.json"),
  JSON.stringify({ name: "smoke-fixture", version: "0.0.0", private: true }, null, 2),
);

const FIXTURE_PATH = "src/last-item.ts";
const FIXTURE_CONTENT = [
  `export function lastItem<T>(arr: T[]): T {`,
  `  // Returns the final element of \`arr\`.`,
  `  // BUG: accesses arr[arr.length] (undefined) instead of arr[arr.length - 1].`,
  `  return arr[arr.length] as T;`,
  `}`,
  ``,
].join("\n");
writeFileSync(resolve(TMP_ROOT, FIXTURE_PATH), FIXTURE_CONTENT);

const hasKey =
  typeof process.env["ANTHROPIC_API_KEY"] === "string" &&
  process.env["ANTHROPIC_API_KEY"].length > 0;
if (!hasKey) {
  process.stdout.write(`\n[skip] ANTHROPIC_API_KEY not set — correctness worker needs Sonnet\n`);
  if (existsSync(TMP_DB)) unlinkSync(TMP_DB);
  if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });
  process.exit(2);
}

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

process.stdout.write(`\n[1] correctness worker catches off-by-one\n`);

const apiClaimDegraded: import("@warden/core").DegradedEntry[] = [];
const route = makeWorkerRoute({
  repoRoot: TMP_ROOT,
  changed: [{ path: FIXTURE_PATH, addedLines: [1, 2, 3, 4, 5] }],
  apiClaimDegraded,
});

const result = await route({
  repoRoot: TMP_ROOT,
  files: [FIXTURE_PATH],
  concern: "correctness",
  phase: "plan",
  focus: "Does this off-by-one access produce undefined?",
});

process.stdout.write(
  `  → worker emitted ${result.findings.length} finding(s) in ${result.durationMs}ms (${result.toolCalls} tool call(s))\n`,
);
for (const f of result.findings) {
  const summary = f.claim.length > 100 ? f.claim.slice(0, 100) + "…" : f.claim;
  process.stdout.write(`    [${f.category}/${f.kind}/T${f.tier}] ${f.file}:${f.lineStart} — ${summary}\n`);
}

assert(result.findings.length >= 1, `worker returned ≥1 finding`);

const ourCategoryFindings = result.findings.filter((f) => f.category === "correctness");
assert(
  ourCategoryFindings.length >= 1,
  `≥1 finding has category="correctness" (got ${ourCategoryFindings.length})`,
);

const fileMatched = result.findings.filter((f) => f.file === FIXTURE_PATH);
assert(
  fileMatched.length === result.findings.length,
  `every finding's file equals fixture path (got ${fileMatched.length}/${result.findings.length})`,
);

const inLineRange = result.findings.filter((f) => f.lineStart >= 1 && f.lineStart <= 5);
assert(
  inLineRange.length === result.findings.length,
  `every finding's lineStart ∈ [1,5] (got ${inLineRange.length}/${result.findings.length})`,
);

for (const f of result.findings) {
  assert(
    f.kind === "assertion" || f.kind === "question",
    `kind ∈ {assertion,question} for ${f.id} (got ${f.kind})`,
  );
  assert(f.sources.length > 0, `${f.id} carries ≥1 source`);
  for (const s of f.sources) {
    assert(
      s.type === "tool" || s.type === "api_def",
      `${f.id} source.type ∈ {tool,api_def} (got ${s.type})`,
    );
  }
}

// Soft signal — flag-don't-fail. Keywords adjacent to an off-by-one diagnosis.
const offByOneKeywords = ["out", "bound", "length", "undefined", "off-by", "index"];
const softHit = result.findings.some((f) =>
  offByOneKeywords.some((kw) => f.claim.toLowerCase().includes(kw)),
);
process.stdout.write(
  `  ${softHit ? "✓" : "·"} soft: at least one claim mentions off-by-one adjacent keyword\n`,
);

// Lane discipline + degraded shape.
const reviewHarnessDegraded = result.degraded.filter((d) => d.topic === "review-harness");
assert(
  reviewHarnessDegraded.length === 0,
  `no review-harness lane-drop entries (got ${reviewHarnessDegraded.length})`,
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
