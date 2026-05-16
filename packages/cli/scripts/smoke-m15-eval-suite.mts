/**
 * Smoke for M15 (ADR-0031) eval suite scaffolding. Verifies the lean
 * internal calibration fixture suite at `scripts/eval/` is wired
 * correctly: fixtures load from disk, scoring math is sound, and the
 * multi-criteria threshold gate produces the expected verdicts under
 * synthetic inputs. No LLM calls.
 *
 * Asserts:
 *   1. Fixture loading: every directory under `fixtures/synthetic/`
 *      contains both `diff.patch` and `labels.md`.
 *   2. Label parsing: clean-formatting-only & clean-rename are flagged as
 *      `expectsEmpty: true`; the 6 plant fixtures parse ≥1 label each.
 *   3. `scoreFixtureRun()` against a synthetic sample stream produces a
 *      sensible row (median catch matches the median input).
 *   4. `aggregateScores()` rolls up synthetic + real-PR + clean buckets
 *      correctly.
 *   5. `checkThreshold()` returns `cleared: true` on a contrived "perfect"
 *      aggregate and `cleared: false` (with each failing criterion named)
 *      on a contrived "all-fail" aggregate.
 *
 * Usage:
 *   pnpm --filter @warden/cli smoke:m15-eval-suite
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVAL_DIR = resolve(HERE, "eval");
const SYNTHETIC_DIR = resolve(EVAL_DIR, "fixtures", "synthetic");
const REAL_PRS_DIR = resolve(EVAL_DIR, "fixtures", "real-prs");

let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) {
    process.stdout.write(`  ✓ ${msg}\n`);
  } else {
    process.stdout.write(`  ✗ ${msg}\n`);
    failed++;
  }
}

// -----------------------------------------------------------------------
// 1. Every synthetic fixture has diff.patch + labels.md
// -----------------------------------------------------------------------
process.stdout.write(`\n[1] synthetic fixtures have diff.patch + labels.md\n`);

const syntheticDirs = readdirSync(SYNTHETIC_DIR);
assert(syntheticDirs.length >= 8, `≥8 synthetic fixtures present (got ${syntheticDirs.length})`);

const expectedFixtures = [
  "correctness-off-by-one",
  "scalability-sequential-await",
  "consistency-docstring-drift",
  "security-eval-injection",
  "committability-debugger-leftover",
  "leverage-stringify-clone",
  "clean-formatting-only",
  "clean-rename",
];
for (const name of expectedFixtures) {
  const dir = resolve(SYNTHETIC_DIR, name);
  assert(existsSync(resolve(dir, "diff.patch")), `${name}/diff.patch exists`);
  assert(existsSync(resolve(dir, "labels.md")), `${name}/labels.md exists`);
}

// -----------------------------------------------------------------------
// 2. Real-PR fixture exists
// -----------------------------------------------------------------------
process.stdout.write(`\n[2] real-PR fixture for M14 close-out exists\n`);

const realDirs = readdirSync(REAL_PRS_DIR);
const m14Dirs = realDirs.filter((d) => d.startsWith("m14-closeout"));
assert(m14Dirs.length >= 1, `≥1 m14-closeout fixture (got ${m14Dirs.length})`);
const m14Dir = m14Dirs[0];
if (m14Dir) {
  const d = resolve(REAL_PRS_DIR, m14Dir);
  assert(existsSync(resolve(d, "diff.patch")), `${m14Dir}/diff.patch exists`);
  assert(existsSync(resolve(d, "labels.md")), `${m14Dir}/labels.md exists`);
}

// -----------------------------------------------------------------------
// 3. Label parsing: expectsEmpty + label-count sanity
// -----------------------------------------------------------------------
process.stdout.write(`\n[3] label parsing (expectsEmpty + per-fixture counts)\n`);

// Inline-port the parseLabels logic so the smoke doesn't import run.mts
// (which would pull the whole harness graph).
interface ParsedLabels {
  labels: { id: string; path: string; line?: number; category?: string; description: string }[];
  expectsEmpty: boolean;
}
function parseLabels(raw: string): ParsedLabels {
  if (/expected:\s*(zero|no)\s+comments/i.test(raw)) {
    return { labels: [], expectsEmpty: true };
  }
  const labels: ParsedLabels["labels"] = [];
  const blockRe = /```(?:yaml|yml)?\s*\n([\s\S]*?)\n```/g;
  let match: RegExpExecArray | null;
  while ((match = blockRe.exec(raw)) !== null) {
    const body = match[1] ?? "";
    const kv: Record<string, string> = {};
    for (const line of body.split("\n")) {
      const m = line.match(/^\s*([a-z_]+):\s*(.+)\s*$/i);
      if (!m) continue;
      const key = m[1];
      const val = m[2];
      if (key && val) kv[key.toLowerCase()] = val.trim();
    }
    if (!kv["id"] || !kv["path"]) continue;
    const entry: ParsedLabels["labels"][number] = {
      id: kv["id"],
      path: kv["path"],
      description: kv["description"] ?? "",
    };
    if (kv["line"]) {
      const n = Number(kv["line"]);
      if (Number.isFinite(n)) entry.line = n;
    }
    if (kv["category"]) entry.category = kv["category"];
    labels.push(entry);
  }
  return { labels, expectsEmpty: false };
}

const cleanFormat = parseLabels(
  readFileSync(resolve(SYNTHETIC_DIR, "clean-formatting-only", "labels.md"), "utf8"),
);
assert(cleanFormat.expectsEmpty, `clean-formatting-only → expectsEmpty`);

const cleanRename = parseLabels(
  readFileSync(resolve(SYNTHETIC_DIR, "clean-rename", "labels.md"), "utf8"),
);
assert(cleanRename.expectsEmpty, `clean-rename → expectsEmpty`);

for (const name of expectedFixtures.filter((n) => !n.startsWith("clean-"))) {
  const parsed = parseLabels(readFileSync(resolve(SYNTHETIC_DIR, name, "labels.md"), "utf8"));
  assert(parsed.labels.length >= 1, `${name} has ≥1 label (got ${parsed.labels.length})`);
  assert(!parsed.expectsEmpty, `${name} is NOT expectsEmpty`);
}

const m14Labels = m14Dir
  ? parseLabels(readFileSync(resolve(REAL_PRS_DIR, m14Dir, "labels.md"), "utf8"))
  : null;
if (m14Labels) {
  assert(m14Labels.labels.length === 3, `m14-closeout has 3 labels (got ${m14Labels.labels.length})`);
}

// -----------------------------------------------------------------------
// 4. score.mts math
// -----------------------------------------------------------------------
process.stdout.write(`\n[4] scoring math: scoreFixtureRun / aggregateScores / checkThreshold\n`);

const { scoreFixtureRun, aggregateScores, checkThreshold } = await import(
  "./eval/score.mjs"
);
const { ALL_CONFIGS } = await import("./eval/configs/index.js");

assert(
  ALL_CONFIGS.length === 4,
  `4 configs registered (baseline + B + C + PD-multi follow-up)`,
);

// Helper to fabricate samples for the scoring math test.
function makeSample(caughtCount: number, unlabeled: number, cost: number, dispatches: number) {
  return {
    fixture: "fake",
    config: "fake",
    sample: 1,
    commentCount: caughtCount + unlabeled,
    caughtLabels: Array(caughtCount)
      .fill(0)
      .map((_, i) => `lbl-${i}`),
    missedLabels: [],
    unlabeledComments: unlabeled,
    dispatchCount: dispatches,
    costUsd: cost,
    durationMs: 1000,
    error: null,
  };
}

const fakeFixture = {
  name: "fake",
  category: "synthetic" as const,
  diff: "",
  labels: [
    { id: "lbl-0", path: "a", description: "" },
    { id: "lbl-1", path: "a", description: "" },
  ],
  expectsEmpty: false,
};
const samples = [makeSample(2, 0, 0.1, 1), makeSample(1, 0, 0.2, 2), makeSample(2, 1, 0.15, 1)];
const row = scoreFixtureRun(fakeFixture, samples, "test");
assert(row.caughtCount === 2, `median caught = 2 (got ${row.caughtCount})`);
assert(row.medianCost === 0.15, `median cost = 0.15 (got ${row.medianCost})`);
assert(row.medianDispatches === 1, `median dispatches = 1 (got ${row.medianDispatches})`);

// Build an aggregate with a synthetic fixture pass + clean pass.
const cleanRow = scoreFixtureRun(
  {
    name: "clean",
    category: "synthetic" as const,
    diff: "",
    labels: [],
    expectsEmpty: true,
  },
  [makeSample(0, 0, 0.05, 0), makeSample(0, 0, 0.05, 0), makeSample(0, 0, 0.05, 0)],
  "test",
);
const m14Row = scoreFixtureRun(
  {
    name: "m14-closeout-fake",
    category: "real-prs" as const,
    diff: "",
    labels: [
      { id: "a", path: "x", description: "" },
      { id: "b", path: "x", description: "" },
      { id: "c", path: "x", description: "" },
    ],
    expectsEmpty: false,
  },
  [makeSample(3, 0, 0.5, 4), makeSample(3, 0, 0.5, 4), makeSample(2, 1, 0.6, 3)],
  "test",
);

const passingAgg = aggregateScores([row, cleanRow, m14Row], "test");
assert(passingAgg.syntheticCaught === 2, `synthetic caught = 2 (got ${passingAgg.syntheticCaught})`);
assert(passingAgg.realCaught === 3, `real-PR caught = 3 (got ${passingAgg.realCaught})`);
assert(passingAgg.cleanFixtureUnlabeled === 0, `clean unlabeled = 0`);

// -----------------------------------------------------------------------
// 5. threshold gate
// -----------------------------------------------------------------------
process.stdout.write(`\n[5] threshold gate verdicts\n`);

// Perfect aggregate that should clear everything.
const perfectRow = scoreFixtureRun(
  {
    name: "perfect-plant",
    category: "synthetic" as const,
    diff: "",
    labels: [
      { id: "a", path: "x", description: "" },
      { id: "b", path: "x", description: "" },
      { id: "c", path: "x", description: "" },
      { id: "d", path: "x", description: "" },
      { id: "e", path: "x", description: "" },
    ],
    expectsEmpty: false,
  },
  [makeSample(5, 0, 0.1, 2), makeSample(5, 0, 0.1, 2), makeSample(5, 0, 0.1, 2)],
  "perfect",
);
const cleanPerfect = scoreFixtureRun(
  {
    name: "clean-perfect",
    category: "synthetic" as const,
    diff: "",
    labels: [],
    expectsEmpty: true,
  },
  [makeSample(0, 0, 0.01, 0), makeSample(0, 0, 0.01, 0), makeSample(0, 0, 0.01, 0)],
  "perfect",
);
const perfectM14 = scoreFixtureRun(
  {
    name: "m14-closeout-perfect",
    category: "real-prs" as const,
    diff: "",
    labels: [
      { id: "a", path: "x", description: "" },
      { id: "b", path: "x", description: "" },
      { id: "c", path: "x", description: "" },
    ],
    expectsEmpty: false,
  },
  [makeSample(3, 0, 0.5, 4), makeSample(3, 0, 0.5, 4), makeSample(3, 0, 0.5, 4)],
  "perfect",
);
const perfectAgg = aggregateScores([perfectRow, cleanPerfect, perfectM14], "perfect");
const perfectVerdict = checkThreshold(perfectAgg, perfectAgg.rows);
assert(perfectVerdict.cleared, `perfect aggregate clears threshold (failed: ${perfectVerdict.failed.join(",")})`);

// Failing aggregate.
const failingRow = scoreFixtureRun(
  {
    name: "fail-plant",
    category: "synthetic" as const,
    diff: "",
    labels: [
      { id: "a", path: "x", description: "" },
      { id: "b", path: "x", description: "" },
      { id: "c", path: "x", description: "" },
      { id: "d", path: "x", description: "" },
      { id: "e", path: "x", description: "" },
    ],
    expectsEmpty: false,
  },
  [makeSample(1, 5, 5.0, 0), makeSample(1, 5, 5.0, 0), makeSample(1, 5, 5.0, 0)],
  "fail",
);
const cleanFail = scoreFixtureRun(
  {
    name: "clean-fail",
    category: "synthetic" as const,
    diff: "",
    labels: [],
    expectsEmpty: true,
  },
  [makeSample(0, 3, 0.5, 0), makeSample(0, 3, 0.5, 0), makeSample(0, 3, 0.5, 0)],
  "fail",
);
const failM14 = scoreFixtureRun(
  {
    name: "m14-closeout-fail",
    category: "real-prs" as const,
    diff: "",
    labels: [
      { id: "a", path: "x", description: "" },
      { id: "b", path: "x", description: "" },
      { id: "c", path: "x", description: "" },
    ],
    expectsEmpty: false,
  },
  [makeSample(0, 2, 2, 0), makeSample(0, 2, 2, 0), makeSample(0, 2, 2, 0)],
  "fail",
);
const failAgg = aggregateScores([failingRow, cleanFail, failM14], "fail");
const failVerdict = checkThreshold(failAgg, failAgg.rows);
assert(!failVerdict.cleared, `failing aggregate does NOT clear threshold`);
assert(failVerdict.failed.length >= 4, `≥4 criteria failed (got ${failVerdict.failed.length})`);
assert(failVerdict.failed.includes("a-m14-closeout-catch"), `(a) flagged`);
assert(failVerdict.failed.includes("b-synthetic-plants"), `(b) flagged`);
assert(failVerdict.failed.includes("c-clean-fixture-comments"), `(c) flagged`);
assert(failVerdict.failed.includes("e-min-dispatch"), `(e) flagged`);

if (failed > 0) {
  process.stdout.write(`\n${failed} assertion(s) failed\n`);
  process.exit(1);
}
process.stdout.write(`\nall assertions passed\n`);
