/**
 * Smoke harness for M9's legitimate-large-refactor case (m9-plan §7).
 * Synthesizes a diff with 1K added files inside a real source directory
 * (`packages/api/src/`) and asserts the prune stage emits **zero**
 * `noise-filter` degraded entries.
 *
 * The M7 directory-concentration heuristic (now removed in M9 per
 * ADR-0025) would have skipped committability on this diff because
 * 1000/1000 files concentrate in `packages/`. M9's profile-only filter
 * lets the diff through untouched — strictly improving on the
 * placeholder.
 *
 * Usage:
 *   pnpm --filter @warden/cli smoke:m9-large-refactor
 */

const { pruneDiff } = await import("@warden/core");

let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) {
    process.stdout.write(`  ✓ ${msg}\n`);
  } else {
    process.stdout.write(`  ✗ ${msg}\n`);
    failed++;
  }
}

const FILE_COUNT = 1000;
const changed: { path: string; addedLines: number[] }[] = Array.from(
  { length: FILE_COUNT },
  (_, i) => ({
    path: `packages/api/src/handlers/handler-${i}.ts`,
    addedLines: [1, 2, 3],
  }),
);

process.stdout.write(`\n[1] pruneDiff — legitimate ${FILE_COUNT}-file refactor\n`);
const result = pruneDiff(changed);
assert(
  result.pruned.length === FILE_COUNT,
  `every file survives the prune (got ${result.pruned.length}/${FILE_COUNT})`,
);
const noiseFilterEntries = result.degraded.filter((d) => d.topic === "noise-filter");
assert(
  noiseFilterEntries.length === 0,
  `zero noise-filter degraded entries (got ${noiseFilterEntries.length})`,
);

if (failed > 0) {
  process.stdout.write(`\n${failed} assertion(s) failed\n`);
  process.exit(1);
}
process.stdout.write(`\nall assertions passed\n`);
