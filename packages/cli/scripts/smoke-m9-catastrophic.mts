/**
 * Smoke harness for M9's catastrophic case (ADR-0025 / m9-plan §7).
 * Synthesizes a unified diff with 500K added files in `node_modules/`
 * plus 12 added files in `src/`. Asserts the diff-level noise filter
 * prunes `node_modules/` cleanly and surfaces a single `noise-filter`
 * degraded entry naming the subtree.
 *
 * Wall-clock target: < 5 seconds end-to-end. The catastrophic case must
 * not be 50× slower than a normal review.
 *
 * Usage:
 *   pnpm --filter @warden/cli smoke:m9-catastrophic
 */

import { performance } from "node:perf_hooks";

const { parseUnifiedDiff, pruneDiff } = await import("@warden/core");

let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) {
    process.stdout.write(`  ✓ ${msg}\n`);
  } else {
    process.stdout.write(`  ✗ ${msg}\n`);
    failed++;
  }
}

// Build the synthetic diff. 500K entries in `node_modules/<pkg>/<file>.js`
// + 12 real source files. We bypass parseUnifiedDiff for the construction
// (going through the parser would force us to allocate hunk text per file)
// and feed the prune stage directly via a hand-built ChangedFile[]. We
// still smoke parseUnifiedDiff on a tiny sample to confirm the upstream
// stage is in working order.
process.stdout.write(`\n[1] parseUnifiedDiff — sanity check\n`);
const sampleDiff = [
  "diff --git a/src/foo.ts b/src/foo.ts",
  "--- a/src/foo.ts",
  "+++ b/src/foo.ts",
  "@@ -0,0 +1,2 @@",
  "+const x = 1;",
  "+export { x };",
].join("\n");
const sampleParsed = parseUnifiedDiff(sampleDiff);
assert(sampleParsed.length === 1, `parseUnifiedDiff returns one file (got ${sampleParsed.length})`);
assert(sampleParsed[0]?.path === "src/foo.ts", "parseUnifiedDiff resolves the b/-prefixed path");

process.stdout.write(`\n[2] pruneDiff — 500K-file node_modules dump\n`);
const NODE_MODULES_FILES = 500_000;
const SOURCE_FILES = 12;
const changed: { path: string; addedLines: number[] }[] = Array.from(
  { length: NODE_MODULES_FILES + SOURCE_FILES },
  (_, i) => {
    if (i < NODE_MODULES_FILES) {
      // Spread across 1000 fake packages × 500 files each — realistic-ish
      // shape, exercises the depth-3 aggregation for nested package files.
      const pkgIdx = Math.floor(i / 500);
      const fileIdx = i % 500;
      return {
        path: `node_modules/pkg-${pkgIdx}/dist/file-${fileIdx}.js`,
        addedLines: [1],
      };
    }
    return {
      path: `src/feature-${i - NODE_MODULES_FILES}.ts`,
      addedLines: [1, 2, 3],
    };
  },
);

const t0 = performance.now();
const result = pruneDiff(changed);
const elapsedMs = performance.now() - t0;

assert(
  result.pruned.length === SOURCE_FILES,
  `pruned ChangedFile[] has ${SOURCE_FILES} paths (got ${result.pruned.length})`,
);
assert(
  result.pruned.every((cf) => cf.path.startsWith("src/")),
  "every surviving path lives under src/",
);
const noiseFilterEntries = result.degraded.filter((d) => d.topic === "noise-filter");
assert(
  noiseFilterEntries.length === 1,
  `exactly one noise-filter degraded entry (got ${noiseFilterEntries.length})`,
);
assert(
  noiseFilterEntries[0]?.kind === "actionable",
  "noise-filter degraded entry has kind=actionable",
);
assert(
  noiseFilterEntries[0]?.message.includes("node_modules"),
  "noise-filter message names node_modules",
);
assert(
  noiseFilterEntries[0]?.message.includes(String(NODE_MODULES_FILES)),
  `noise-filter message includes the pruned count (${NODE_MODULES_FILES})`,
);
assert(
  elapsedMs < 5_000,
  `prune wall-clock < 5s (got ${elapsedMs.toFixed(1)}ms)`,
);

process.stdout.write(`\n[3] pruneDiff — baseline noise (.DS_Store + .pyc)\n`);
const baselineMix: { path: string; addedLines: number[] }[] = [
  { path: "src/foo.ts", addedLines: [1] },
  { path: ".git/HEAD", addedLines: [1] },
  { path: ".git/refs/heads/main", addedLines: [1] },
  { path: "src/.DS_Store", addedLines: [1] },
  { path: "scripts/__pycache__/x.pyc", addedLines: [1] },
  { path: ".vscode/.history/foo.ts", addedLines: [1] },
];
const baselineResult = pruneDiff(baselineMix);
assert(
  baselineResult.pruned.length === 1 && baselineResult.pruned[0]?.path === "src/foo.ts",
  `baseline noise pruned to one src file (got ${baselineResult.pruned.length})`,
);
assert(
  baselineResult.degraded.some((d) => d.topic === "noise-filter" && d.message.includes(".git")),
  "baseline noise emitted entry naming .git",
);
assert(
  baselineResult.degraded.some(
    (d) => d.topic === "noise-filter" && d.message.includes(".vscode/.history"),
  ),
  "baseline noise emitted entry naming .vscode/.history",
);

if (failed > 0) {
  process.stdout.write(`\n${failed} assertion(s) failed\n`);
  process.exit(1);
}
process.stdout.write(`\nall assertions passed\n`);
