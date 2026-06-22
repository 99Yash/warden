/**
 * Smoke for the M14 leverage worker (Haiku tier).
 *
 * # Why this smoke validates the contract, not the catch
 *
 * The leverage worker's system prompt explicitly carves out stdlib
 * idiom misses (`JSON.parse(JSON.stringify(...))`, `indexOf !== -1`,
 * etc.) — those are the deterministic M12 leverage detector's job
 * (covered by `smoke-m12-detector.mts`). The worker is scoped to
 * library-substitution opportunities only, and it requires:
 *
 *   1. The diff hand-rolls something a library function would do.
 *   2. The library must be in the `Installed libraries` preamble.
 *   3. The worker must verify the substitute via `lookupTypeDef`.
 *
 * Setting up a real `node_modules/<lib>/*.d.ts` + a matching diff
 * that reimplements one of its primitives is heavy fixture
 * scaffolding for a smoke; the boss-loop smoke + dogfood cover the
 * end-to-end firing path against the real warden tree where libraries
 * are installed.
 *
 * What this smoke verifies instead:
 *
 *   - Worker dispatches without crash (no `worker-leverage` warning
 *     degraded entry).
 *   - When findings ARE emitted, they satisfy the deterministic-facet
 *     shape (category, file, lineStart range, kind, sources).
 *   - No lane-drops surface (worker stays within the dispatched files).
 *   - The dep-context preamble (leverage-only) gets built without
 *     throwing on a fixture with no installed deps.
 *
 * Empty findings IS the expected outcome on this fixture (the JSON-
 * clone is a stdlib idiom miss, not a library-substitution opportunity);
 * the smoke passes either way as long as the contract holds.
 *
 * Usage:
 *   pnpm --filter @warden/cli smoke:m14-leverage-worker
 */

import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const TMP_ROOT = resolve(tmpdir(), `warden-m14-leverage-${process.pid}`);
const TMP_DB = resolve(tmpdir(), `warden-m14-leverage-${process.pid}.sqlite`);
process.env["WARDEN_CACHE_PATH"] = TMP_DB;

if (existsSync(TMP_DB)) unlinkSync(TMP_DB);
if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });
mkdirSync(resolve(TMP_ROOT, "src"), { recursive: true });
writeFileSync(
  resolve(TMP_ROOT, "package.json"),
  JSON.stringify(
    {
      name: "smoke-fixture",
      version: "0.0.0",
      private: true,
      engines: { node: ">=18" },
    },
    null,
    2,
  ),
);

const FIXTURE_PATH = "src/clone.ts";
const FIXTURE_CONTENT = [
  `// Hand-rolled deep clone. Used by 12 call sites — perf is hot.`,
  `export function deepClone<T>(value: T): T {`,
  `  return JSON.parse(JSON.stringify(value)) as T;`,
  `}`,
  ``,
].join("\n");
writeFileSync(resolve(TMP_ROOT, FIXTURE_PATH), FIXTURE_CONTENT);

const hasKey =
  typeof process.env["ANTHROPIC_API_KEY"] === "string" &&
  process.env["ANTHROPIC_API_KEY"].length > 0;
if (!hasKey) {
  process.stdout.write(`\n[skip] ANTHROPIC_API_KEY not set\n`);
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

process.stdout.write(`\n[1] leverage worker contract — dispatch + lane discipline\n`);

const apiClaimDegraded: import("@warden/core").DegradedEntry[] = [];
const route = makeWorkerRoute({
  repoRoot: TMP_ROOT,
  changed: [{ path: FIXTURE_PATH, addedLines: [1, 2, 3, 4, 5] }],
  apiClaimDegraded,
});

const result = await route({
  repoRoot: TMP_ROOT,
  files: [FIXTURE_PATH],
  concern: "leverage",
  phase: "plan",
  focus: "Is there an installed library that replaces this hand-rolled deep clone?",
});

process.stdout.write(
  `  → worker emitted ${result.findings.length} finding(s) in ${result.durationMs}ms (${result.toolCalls} tool call(s))\n`,
);
for (const f of result.findings) {
  const summary = f.claim.length > 100 ? f.claim.slice(0, 100) + "…" : f.claim;
  process.stdout.write(
    `    [${f.category}/${f.kind}/T${f.tier}] ${f.file}:${f.lineStart} — ${summary}\n`,
  );
}

// Worker did not crash.
const workerErrorEntries = result.degraded.filter(
  (d) => d.topic === "worker-leverage" && d.kind === "warning",
);
assert(
  workerErrorEntries.length === 0,
  `no worker-leverage warning degraded entries (got ${workerErrorEntries.length})`,
);

// Findings (if any) satisfy facet shape.
for (const f of result.findings) {
  assert(f.category === "leverage", `${f.id} category="leverage" (got ${f.category})`);
  assert(f.file === FIXTURE_PATH, `${f.id} file matches fixture path (got ${f.file})`);
  assert(f.lineStart >= 1 && f.lineStart <= 6, `${f.id} lineStart ∈ [1,6] (got ${f.lineStart})`);
  assert(
    f.kind === "assertion" || f.kind === "question",
    `${f.id} kind ∈ {assertion,question} (got ${f.kind})`,
  );
  assert(f.sources.length > 0, `${f.id} carries ≥1 source`);
  for (const s of f.sources) {
    assert(
      s.type === "tool" || s.type === "api_def",
      `${f.id} source.type ∈ {tool,api_def} (got ${s.type})`,
    );
  }
}

// Lane discipline.
const laneDrops = result.degraded.filter((d) => d.topic === "review-harness");
assert(laneDrops.length === 0, `no lane-drop entries (got ${laneDrops.length})`);

// Worker actually ran (toolCalls or non-zero duration; lookupTypeDef + readFile usually
// trip ≥1 tool call even when output is empty).
assert(result.durationMs > 0, `durationMs > 0 (got ${result.durationMs})`);
assert(result.durationMs < 90_000, `durationMs < 90s (got ${result.durationMs})`);

// Document the result for the dogfood reviewer.
if (result.findings.length === 0) {
  process.stdout.write(
    `  · note: zero findings is the expected outcome — JSON-clone is a stdlib\n` +
      `    idiom miss, deferred to the deterministic leverage detector (M12).\n`,
  );
} else {
  process.stdout.write(
    `  · note: worker fired ${result.findings.length} library-substitution finding(s)\n`,
  );
}

if (existsSync(TMP_DB)) unlinkSync(TMP_DB);
if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });

if (failed > 0) {
  process.stdout.write(`\n${failed} assertion(s) failed\n`);
  process.exit(1);
}
process.stdout.write(`\nall assertions passed\n`);
