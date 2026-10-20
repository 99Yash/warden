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
 *      `expectsEmpty: true`; the 6 plant fixtures parse ≥1 label each;
 *      the alfred PR#131 false-positive fixture parses absent labels.
 *   3. `scoreFixtureRun()` against a synthetic sample stream produces a
 *      sensible row (median catch matches the median input).
 *   4. `aggregateScores()` rolls up synthetic + real-PR + clean buckets
 *      correctly.
 *   5. `checkThreshold()` returns `cleared: true` on a contrived "perfect"
 *      aggregate and `cleared: false` (with each failing criterion named)
 *      on a contrived "all-fail" aggregate.
 *   6. ADR-0052 structural fixtures: 10 of them, none selected by the
 *      PR #103 stage 1/2/4 regexes; recall and ladder fixtures carry
 *      `meta.json` and one present label; traps carry only absent
 *      labels; the ladder fixture pins `kind`. `m14-closeout` has its
 *      `meta.json`. `matchesLabel` honors the optional `kind` key, and a
 *      label without it matches any kind.
 *
 * Usage:
 *   pnpm --filter @warden/cli smoke:m15-eval-suite
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

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
process.stdout.write(`\n[2] real-PR fixtures exist\n`);

const realDirs = readdirSync(REAL_PRS_DIR);
const m14Dirs = realDirs.filter((d) => d.startsWith("m14-closeout"));
assert(m14Dirs.length >= 1, `≥1 m14-closeout fixture (got ${m14Dirs.length})`);
const m14Dir = m14Dirs[0];
if (m14Dir) {
  const d = resolve(REAL_PRS_DIR, m14Dir);
  assert(existsSync(resolve(d, "diff.patch")), `${m14Dir}/diff.patch exists`);
  assert(existsSync(resolve(d, "labels.md")), `${m14Dir}/labels.md exists`);
}
const falseposDir = "alfred-pr131-falsepos-9349d565";
assert(realDirs.includes(falseposDir), `${falseposDir} fixture exists`);
{
  const d = resolve(REAL_PRS_DIR, falseposDir);
  assert(existsSync(resolve(d, "diff.patch")), `${falseposDir}/diff.patch exists`);
  assert(existsSync(resolve(d, "labels.md")), `${falseposDir}/labels.md exists`);
  assert(existsSync(resolve(d, "meta.json")), `${falseposDir}/meta.json exists`);
}

// -----------------------------------------------------------------------
// 3. Label parsing: expectsEmpty + label-count sanity
// -----------------------------------------------------------------------
process.stdout.write(`\n[3] label parsing (expectsEmpty + per-fixture counts)\n`);

// Inline-port the parseLabels logic so the smoke doesn't import run.mts
// (which would pull the whole harness graph).
interface ParsedLabels {
  labels: {
    id: string;
    expect?: "present" | "absent";
    path: string;
    line?: number;
    category?: string;
    claimIncludes?: string;
    kind?: string;
    description: string;
  }[];
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
      expect: parseLabelExpectation(kv["expect"] ?? kv["expected"]),
      path: kv["path"],
      description: kv["description"] ?? "",
    };
    if (kv["line"]) {
      const n = Number(kv["line"]);
      if (Number.isFinite(n)) entry.line = n;
    }
    if (kv["category"]) entry.category = kv["category"];
    if (kv["claim_includes"]) entry.claimIncludes = kv["claim_includes"];
    if (kv["kind"]) entry.kind = kv["kind"];
    labels.push(entry);
  }
  return { labels, expectsEmpty: false };
}
function parseLabelExpectation(raw: string | undefined): "present" | "absent" {
  if (!raw) return "present";
  const normalized = raw.toLowerCase().trim();
  if (
    normalized === "absent" ||
    normalized === "forbidden" ||
    normalized === "false-positive" ||
    normalized === "false_positive" ||
    normalized === "no-comment"
  ) {
    return "absent";
  }
  return "present";
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
  assert(
    m14Labels.labels.length === 3,
    `m14-closeout has 3 labels (got ${m14Labels.labels.length})`,
  );
}

const falseposLabels = parseLabels(
  readFileSync(resolve(REAL_PRS_DIR, falseposDir, "labels.md"), "utf8"),
);
assert(falseposLabels.labels.length === 8, `${falseposDir} has 8 labels`);
assert(
  falseposLabels.labels.every((l) => l.expect === "absent"),
  `${falseposDir} labels are absent traps`,
);
assert(
  falseposLabels.labels.every((l) => l.claimIncludes !== undefined),
  `${falseposDir} labels pin claim_includes`,
);

// -----------------------------------------------------------------------
// 3b. ADR-0052 structural fixtures (Lever D eval legs i, ii, iv)
// -----------------------------------------------------------------------
process.stdout.write(`\n[3b] ADR-0052 structural fixtures\n`);

// The eval plan's stage 3 selects these fixtures with `--fixture-regex
// structural`. Stages 1, 2, and 4 (PR #103) use the regexes below, which
// must not select them.
const STAGE_REGEXES = [
  /^(clean-|committability-|consistency-|correctness-|leverage-|scalability-|security-|alfred-pr131-)/,
  /(misses|m14-closeout)/,
  /^(clean-|committability-|consistency-|correctness-|leverage-|scalability-|security-|alfred-pr(131|14|235)-|m14-closeout-|m6-misses-)/,
];
// ADR-0052 routes structural findings to these categories by axis.
const STRUCTURAL_CATEGORIES = new Set(["dedup", "consistency", "deadcode", "leverage", "clarity"]);
const structuralDirs = [
  ...syntheticDirs.map((name) => ({ name, dir: resolve(SYNTHETIC_DIR, name), real: false })),
  ...realDirs.map((name) => ({ name, dir: resolve(REAL_PRS_DIR, name), real: true })),
].filter(({ name }) => /structural/.test(name));
assert(structuralDirs.length === 10, `10 structural fixtures (got ${structuralDirs.length})`);
for (const { name, dir, real } of structuralDirs) {
  assert(
    STAGE_REGEXES.every((re) => !re.test(name)),
    `${name} is outside the stage 1, 2, and 4 regexes`,
  );
  const parsed = parseLabels(readFileSync(resolve(dir, "labels.md"), "utf8"));
  const present = parsed.labels.filter((l) => l.expect === "present");
  const absent = parsed.labels.filter((l) => l.expect === "absent");
  assert(
    parsed.labels.every((l) => l.description.startsWith("[structural]")),
    `${name}: every label is tagged [structural]`,
  );
  if (name.startsWith("structural-trap-")) {
    assert(!real, `${name}: trap fixtures are synthetic`);
    assert(present.length === 0 && absent.length >= 1, `${name}: only expect: absent labels`);
  } else {
    assert(real, `${name}: recall and ladder fixtures are real PRs`);
    assert(existsSync(resolve(dir, "meta.json")), `${name}: has meta.json (real-repo tree)`);
    assert(present.length === 1, `${name}: one present label (got ${present.length})`);
    assert(
      present.every((l) => l.line !== undefined && STRUCTURAL_CATEGORIES.has(l.category ?? "")),
      `${name}: the present label pins a line and a structural category`,
    );
  }
}
const ladder = structuralDirs.find(({ name }) => name.startsWith("structural-ladder-"));
assert(ladder !== undefined, `the leg (iv) ladder fixture exists`);
if (ladder) {
  const parsed = parseLabels(readFileSync(resolve(ladder.dir, "labels.md"), "utf8"));
  assert(
    parsed.labels.some((l) => l.expect === "present" && l.kind === "question") &&
      parsed.labels.some((l) => l.expect === "absent" && l.kind === "assertion"),
    `${ladder.name}: a present kind:question label and an absent kind:assertion trap`,
  );
}
{
  const metaPath = resolve(REAL_PRS_DIR, m14Dir ?? "", "meta.json");
  const meta: unknown = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) : null;
  assert(
    isDeepStrictEqual(meta, { repo: "warden", commit: "89bf988" }),
    `m14-closeout has meta.json {repo: warden, commit: 89bf988}`,
  );
}

// -----------------------------------------------------------------------
// 4. score.mts math
// -----------------------------------------------------------------------
process.stdout.write(`\n[4] scoring math: scoreFixtureRun / aggregateScores / checkThreshold\n`);

const { scoreFixtureRun, aggregateScores, checkThreshold } = await import("./eval/score.mjs");
const { ALL_CONFIGS } = await import("./eval/configs/index.js");

assert(
  ALL_CONFIGS.length >= 6,
  `≥6 configs registered (baseline + B + C + PD-multi + sentry-borrow + reasoned)`,
);

// Helper to fabricate samples for the scoring math test.
function makeSample(
  caughtCount: number,
  unlabeled: number,
  cost: number,
  dispatches: number,
  forbiddenCount = 0,
) {
  return {
    fixture: "fake",
    config: "fake",
    sample: 1,
    commentCount: caughtCount + unlabeled,
    comments: [],
    caughtLabels: Array(caughtCount)
      .fill(0)
      .map((_, i) => `lbl-${i}`),
    missedLabels: [],
    forbiddenLabels: Array(forbiddenCount)
      .fill(0)
      .map((_, i) => `fp-${i}`),
    unlabeledComments: unlabeled,
    dispatchCount: dispatches,
    costUsd: cost,
    durationMs: 1000,
    error: null,
    costMeasured: true,
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
assert(
  passingAgg.syntheticCaught === 2,
  `synthetic caught = 2 (got ${passingAgg.syntheticCaught})`,
);
assert(passingAgg.realCaught === 3, `real-PR caught = 3 (got ${passingAgg.realCaught})`);
assert(passingAgg.cleanFixtureUnlabeled === 0, `clean unlabeled = 0`);

const falseposFixture = {
  name: "falsepos-fake",
  category: "real-prs" as const,
  diff: "",
  labels: [
    { id: "fp-a", expect: "absent" as const, path: "x", description: "" },
    { id: "fp-b", expect: "absent" as const, path: "x", description: "" },
  ],
  expectsEmpty: false,
};
const falseposCleanRow = scoreFixtureRun(
  falseposFixture,
  [makeSample(0, 0, 0.05, 1), makeSample(0, 0, 0.05, 1), makeSample(0, 0, 0.05, 1)],
  "test",
);
assert(falseposCleanRow.totalLabels === 0, `false-positive traps add no recall labels`);
assert(falseposCleanRow.totalForbiddenLabels === 2, `false-positive traps counted as forbidden`);
assert(falseposCleanRow.maxForbidden === 0, `absent labels have 0 hits when clean`);

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
const perfectFalsepos = scoreFixtureRun(
  falseposFixture,
  [makeSample(0, 0, 0.05, 1), makeSample(0, 0, 0.05, 1), makeSample(0, 0, 0.05, 1)],
  "perfect",
);
const perfectAgg = aggregateScores(
  [perfectRow, cleanPerfect, perfectM14, perfectFalsepos],
  "perfect",
);
assert(
  perfectAgg.falsePositiveTrapHits === 0 && perfectAgg.falsePositiveTraps === 2,
  `perfect aggregate has 0/2 false-positive trap hits`,
);
const perfectVerdict = checkThreshold(perfectAgg, perfectAgg.rows);
assert(
  perfectVerdict.cleared,
  `perfect aggregate clears threshold (failed: ${perfectVerdict.failed.join(",")})`,
);

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

const falseposHit = scoreFixtureRun(
  falseposFixture,
  [makeSample(0, 1, 0.05, 1, 1), makeSample(0, 1, 0.05, 1, 1), makeSample(0, 1, 0.05, 1, 1)],
  "falsepos-hit",
);
const falseposFailAgg = aggregateScores(
  [perfectRow, cleanPerfect, perfectM14, falseposHit],
  "falsepos-hit",
);
const falseposFailVerdict = checkThreshold(falseposFailAgg, falseposFailAgg.rows);
assert(!falseposFailVerdict.cleared, `false-positive trap hit does NOT clear threshold`);
assert(falseposFailVerdict.failed.includes("f-false-positive-traps"), `(f) flagged`);

const intermittentFalsepos = scoreFixtureRun(
  falseposFixture,
  [makeSample(0, 0, 0.05, 1), makeSample(0, 1, 0.05, 1, 1), makeSample(0, 0, 0.05, 1)],
  "falsepos-intermittent",
);
const intermittentAgg = aggregateScores(
  [perfectRow, cleanPerfect, perfectM14, intermittentFalsepos],
  "falsepos-intermittent",
);
const intermittentVerdict = checkThreshold(intermittentAgg, intermittentAgg.rows);
assert(intermittentAgg.falsePositiveTrapHits === 1, `1-of-3 trap hit is counted`);
assert(
  intermittentVerdict.failed.includes("f-false-positive-traps"),
  `(f) catches intermittent false positives`,
);

// Gate (b) SKIPPED branch: a no-synthetic aggregate (e.g. a real-PR-only
// `--fixture-regex misses` run) must SKIP the plant gate, never fail it.
const realOnlyRow = scoreFixtureRun(
  {
    name: "m6-misses",
    category: "real-prs" as const,
    diff: "",
    labels: [
      { id: "a", path: "x", description: "" },
      { id: "b", path: "x", description: "" },
    ],
    expectsEmpty: false,
  },
  [makeSample(2, 0, 1, 2), makeSample(2, 0, 1, 2), makeSample(2, 0, 1, 2)],
  "real-only",
);
const noSyntheticAgg = aggregateScores([realOnlyRow], "real-only");
assert(
  noSyntheticAgg.syntheticPlants === 0,
  `no-synthetic aggregate has 0 plants (got ${noSyntheticAgg.syntheticPlants})`,
);
const noSyntheticVerdict = checkThreshold(noSyntheticAgg, noSyntheticAgg.rows);
assert(
  !noSyntheticVerdict.failed.includes("b-synthetic-plants"),
  `(b) is SKIPPED (not failed) when no synthetic plants are present`,
);
assert(
  noSyntheticVerdict.details.some((d) => d.includes("(b)") && d.includes("SKIPPED")),
  `(b) detail line reports SKIPPED`,
);

// -----------------------------------------------------------------------
// 6. matchesLabel: the optional `kind` key (ADR-0052 leg iv)
// -----------------------------------------------------------------------
process.stdout.write(`\n[6] matchesLabel honors an optional kind\n`);

const { matchesLabel } = await import("./eval/score.mjs");
const at = {
  file: "src/a.ts",
  lineStart: 10,
  lineEnd: 12,
  category: "consistency",
  claim: "LANE_SPECS and the down charter disagree",
} as const;
const asQuestion = { ...at, kind: "question" } as const;
const asAssertion = { ...at, kind: "assertion" } as const;
const noKind = { id: "k", path: "src/a.ts", line: 11, description: "" };
assert(
  matchesLabel(asQuestion, noKind) && matchesLabel(asAssertion, noKind),
  `a label without kind matches both kinds (existing labels score as before)`,
);
assert(
  matchesLabel(asQuestion, { ...noKind, kind: "question" }) &&
    !matchesLabel(asAssertion, { ...noKind, kind: "question" }),
  `kind: question matches only a question`,
);
assert(
  matchesLabel(asAssertion, { ...noKind, kind: "assertion" }) &&
    !matchesLabel(asQuestion, { ...noKind, kind: "assertion" }),
  `kind: assertion matches only an assertion`,
);
assert(
  !matchesLabel(asQuestion, { ...noKind, kind: "question", line: 30 }) &&
    !matchesLabel(asQuestion, { ...noKind, kind: "question", category: "dedup" }),
  `kind does not bypass the line window or the category`,
);

if (failed > 0) {
  process.stdout.write(`\n${failed} assertion(s) failed\n`);
  process.exit(1);
}
process.stdout.write(`\nall assertions passed\n`);
