/**
 * Smoke harness for M12's leverage detector. Builds in-memory fixtures, runs
 * the detector, asserts the three v0 patterns fire correctly + diff-localness
 * gates fire on un-touched lines.
 *
 * Usage:
 *   pnpm --filter @warden/cli smoke:m12-detector
 */

import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const TMP_ROOT = resolve(tmpdir(), `warden-m12-detector-${process.pid}`);
const TMP_DB = resolve(tmpdir(), `warden-m12-detector-${process.pid}.sqlite`);
process.env["WARDEN_CACHE_PATH"] = TMP_DB;

if (existsSync(TMP_DB)) unlinkSync(TMP_DB);
if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });
mkdirSync(resolve(TMP_ROOT, "src"), { recursive: true });

const { runLeverage } = await import("@warden/core/runners/leverage");
const { toComment } = await import("@warden/core/runners/to-comment");

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
// 1. structuredClone substitution.
// ---------------------------------------------------------------------------

process.stdout.write(`\n[1] leverage — JSON.parse(JSON.stringify(...))\n`);
const clonePath = "src/clone.ts";
writeFileSync(
  resolve(TMP_ROOT, clonePath),
  [
    `export function clone(payload: Record<string, unknown>) {`,
    `  return JSON.parse(JSON.stringify(payload));`,
    `}`,
    ``,
  ].join("\n"),
);
const cloneResult = await runLeverage({
  repoRoot: TMP_ROOT,
  changed: [{ path: clonePath, addedLines: [1, 2, 3] }],
});
const cloneFindings = cloneResult.findings.filter((f) => f.ruleId === "structured-clone");
assert(
  cloneFindings.length === 1,
  `exactly one structured-clone finding (got ${cloneFindings.length})`,
);
assert(
  cloneFindings[0]?.message.includes("structuredClone"),
  "message mentions structuredClone",
);
assert(
  cloneFindings[0]?.evidence?.snippet.includes("JSON.parse(JSON.stringify(payload))"),
  "evidence snippet quotes the call site",
);

// ---------------------------------------------------------------------------
// 2. includes substitution — !== -1 / != -1 / > -1 / >= 0 / reversed.
// ---------------------------------------------------------------------------

process.stdout.write(`\n[2] leverage — indexOf(x) <cmp> <pivot>\n`);
const includesPath = "src/includes.ts";
writeFileSync(
  resolve(TMP_ROOT, includesPath),
  [
    `export function check(users: string[], targetId: string) {`,
    `  if (users.indexOf(targetId) !== -1) return true;`,
    `  if (users.indexOf(targetId) > -1) return true;`,
    `  if (users.indexOf(targetId) >= 0) return true;`,
    `  if (-1 !== users.indexOf(targetId)) return true;`,
    `  return false;`,
    `}`,
    ``,
  ].join("\n"),
);
const includesResult = await runLeverage({
  repoRoot: TMP_ROOT,
  changed: [{ path: includesPath, addedLines: [1, 2, 3, 4, 5, 6, 7, 8] }],
});
const includesFindings = includesResult.findings.filter((f) => f.ruleId === "includes");
assert(
  includesFindings.length === 4,
  `four includes findings (got ${includesFindings.length})`,
);
assert(
  includesFindings.every((f) => f.message.toLowerCase().includes("includes")),
  "every finding mentions includes",
);

// Negative control: `indexOf(...) >= 5` should NOT fire (not the right pivot).
process.stdout.write(`\n[2b] leverage — indexOf >= 5 negative control\n`);
const includesNegPath = "src/includes-neg.ts";
writeFileSync(
  resolve(TMP_ROOT, includesNegPath),
  [
    `export function check(xs: number[]) {`,
    `  return xs.indexOf(7) >= 5;`,
    `}`,
    ``,
  ].join("\n"),
);
const includesNegResult = await runLeverage({
  repoRoot: TMP_ROOT,
  changed: [{ path: includesNegPath, addedLines: [1, 2, 3] }],
});
assert(
  includesNegResult.findings.every((f) => f.ruleId !== "includes"),
  "indexOf >= 5 does not fire (negative control)",
);

// ---------------------------------------------------------------------------
// 3. some substitution — filter(...).length OP pivot + find(...) != undef.
// ---------------------------------------------------------------------------

process.stdout.write(`\n[3] leverage — filter(...).length / find(...) !== undefined\n`);
const somePath = "src/some.ts";
writeFileSync(
  resolve(TMP_ROOT, somePath),
  [
    `export function check(entries: { active: boolean }[]) {`,
    `  if (entries.filter((e) => e.active).length > 0) return true;`,
    `  if (entries.filter((e) => e.active).length >= 1) return true;`,
    `  if (entries.filter((e) => e.active).length !== 0) return true;`,
    `  if (entries.find((e) => e.active) !== undefined) return true;`,
    `  if (entries.find((e) => e.active) != null) return true;`,
    `  return false;`,
    `}`,
    ``,
  ].join("\n"),
);
const someResult = await runLeverage({
  repoRoot: TMP_ROOT,
  changed: [{ path: somePath, addedLines: [1, 2, 3, 4, 5, 6, 7, 8, 9] }],
});
const someFindings = someResult.findings.filter((f) => f.ruleId === "some");
assert(
  someFindings.length === 5,
  `five some findings (got ${someFindings.length})`,
);

// ---------------------------------------------------------------------------
// 4. Diff-localness — pattern in source but outside addedLines must not fire.
// ---------------------------------------------------------------------------

process.stdout.write(`\n[4] leverage — diff-localness regression guard\n`);
const dlPath = "src/diff-localness.ts";
writeFileSync(
  resolve(TMP_ROOT, dlPath),
  [
    `// line 1 — untouched`,
    `export function untouched(x: unknown) {`,
    `  return JSON.parse(JSON.stringify(x)); // line 3 — untouched`,
    `}`,
    `export function touched(x: unknown) {`,
    `  // unrelated added line`,
    `  return x;`,
    `}`,
    ``,
  ].join("\n"),
);
// Only the second function is "added"; the JSON.parse pattern lives in lines 1-4.
const dlResult = await runLeverage({
  repoRoot: TMP_ROOT,
  changed: [{ path: dlPath, addedLines: [5, 6, 7, 8] }],
});
assert(
  dlResult.findings.length === 0,
  `untouched pattern does not fire (got ${dlResult.findings.length} finding(s))`,
);

// ---------------------------------------------------------------------------
// 5. Mapping through toComment — category leverage, kind assertion, tier 2,
//    snippet evidence flows to source.path/line/snippet.
// ---------------------------------------------------------------------------

process.stdout.write(`\n[5] toComment mapping — leverage source → category leverage\n`);
const sample = cloneFindings[0];
if (sample) {
  const comment = toComment(sample);
  assert(comment.category === "leverage", "category is leverage");
  assert(comment.kind === "assertion", "kind is assertion");
  assert(comment.tier === 2, "tier is 2");
  const src = comment.sources[0];
  assert(
    src !== undefined &&
      src.path === sample.evidence?.path &&
      src.line === sample.evidence?.line &&
      src.snippet === sample.evidence?.snippet,
    "tool source carries the evidence triple verbatim",
  );
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
