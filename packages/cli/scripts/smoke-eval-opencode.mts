/**
 * Slice #43 smoke: fixture repos, parity gate, session-usage parsing.
 * No LLM, no spend — `buildFixtureRepo` only runs git plumbing, and the
 * parity/usage checks are pure.
 *
 * Asserts:
 *   (a) `buildFixtureRepo` on every fixture under `scripts/eval/fixtures/` —
 *       real fixtures use the sibling checkout when reachable, else the
 *       sparse fallback (prints which); `base...HEAD` file count = patch
 *       section count − `excludedBinary`; the temp root (and patch dir)
 *       are gone after `removeFixtureRepo`; the source repo gains no
 *       worktree (`git worktree list` unchanged).
 *   (b) the trailing-blank-line fix: a 2-line new-file patch materializes
 *       to exactly 2 lines.
 *   (c) `binaryPatchPaths` on a crafted patch.
 *   (d) `checkParity`: an all-pass pair, then one failing pair per
 *       criterion P0–P8 (the failed list names exactly that criterion),
 *       and a tie that passes. P4/P6 read every raw sample: a failed lane
 *       on a clean fixture, a 1-of-3 clean hit, and a 1-of-3 failed lane
 *       each fail. P0/P7/P8 cover a short row, a failed reference, a
 *       filtered run, a stopped run, and N=1. P0 compares tree kinds per
 *       fixture (`archive X@c` ≡ `worktree X@c`, else `sparse`). An absent
 *       reference (a run that stopped in the candidate) fails P0 + P7,
 *       prints "no reference" for P1/P2, still reports P3–P6, and P8
 *       names the stop reason. P6 fails a session-model variant mismatch.
 *   (e) `parseSessionUsage`: the verified shape (model with `#<variant>`);
 *       a model without a variant; missing `data`;
 *       non-number `cost`; negative `cost`; a `data.id` that is not the
 *       requested ID; missing `tokens.cache` → `undefined`.
 *
 * Usage:
 *   pnpm --filter @warden/cli smoke:eval-opencode
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSessionUsage } from "../src/opencode/drive.js";
import {
  binaryPatchPaths,
  buildFixtureRepo,
  materializePatchPostImages,
  removeFixtureRepo,
} from "./eval/fixture-repo.mjs";
import { aggregateScores, checkParity, scoreFixtureRun, type ParityRun } from "./eval/score.mjs";
import type { Fixture, FixtureSample, FixtureScore } from "./eval/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVAL_DIR = resolve(HERE, "eval");
const FIXTURES_DIR = resolve(EVAL_DIR, "fixtures");
// EVAL_DIR = <warden>/packages/cli/scripts/eval → up four to the warden root.
const WARDEN_ROOT = resolve(EVAL_DIR, "..", "..", "..", "..");

let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) {
    process.stdout.write(`  ✓ ${msg}\n`);
  } else {
    process.stdout.write(`  ✗ ${msg}\n`);
    failed++;
  }
}

function resolveRepoPath(repo: string): string | null {
  const envOverride = process.env[`WARDEN_EVAL_${repo.toUpperCase()}_REPO`];
  if (envOverride) return resolve(envOverride);
  const defaults: Record<string, string> = {
    warden: WARDEN_ROOT,
    alfred: resolve(WARDEN_ROOT, "..", "alfred"),
  };
  return defaults[repo] ?? null;
}

interface LoadedFixture {
  fixture: Fixture;
  sections: number;
  how: string;
  worktreeBefore?: string;
  repoPath?: string;
}

function loadFixtures(): LoadedFixture[] {
  const out: LoadedFixture[] = [];
  for (const category of ["synthetic", "real-prs"] as const) {
    const dir = resolve(FIXTURES_DIR, category);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      const fixtureDir = resolve(dir, name);
      const patchPath = resolve(fixtureDir, "diff.patch");
      const labelsPath = resolve(fixtureDir, "labels.md");
      if (!existsSync(patchPath) || !existsSync(labelsPath)) continue;
      const diff = readFileSync(patchPath, "utf8");
      const labelsRaw = readFileSync(labelsPath, "utf8");
      const expectsEmpty = /expected:\s*(zero|no)\s+comments/i.test(labelsRaw);
      const sections = diff.split("\n").filter((l) => l.startsWith("diff --git ")).length;
      const fixture: Fixture = { name, category, diff, labels: [], expectsEmpty };
      // Mirror run.mts's resolveRealRepo: meta.json + reachable checkout
      // wins, otherwise the sparse fallback.
      let how = "sparse fallback (no meta.json)";
      let worktreeBefore: string | undefined;
      let repoPath: string | undefined;
      const metaPath = resolve(fixtureDir, "meta.json");
      if (existsSync(metaPath)) {
        try {
          const meta = JSON.parse(readFileSync(metaPath, "utf8")) as {
            repo: string;
            commit: string;
          };
          const resolved = resolveRepoPath(meta.repo);
          if (resolved === null || !existsSync(resolve(resolved, ".git"))) {
            how = `sparse fallback (${meta.repo} checkout missing)`;
          } else {
            try {
              execFileSync("git", ["-C", resolved, "cat-file", "-e", `${meta.commit}^{commit}`], {
                stdio: "ignore",
              });
              fixture.realRepo = { repo: meta.repo, repoPath: resolved, commit: meta.commit };
              how = `real (archive ${meta.repo}@${meta.commit.slice(0, 8)})`;
              repoPath = resolved;
              worktreeBefore = execFileSync("git", ["-C", resolved, "worktree", "list"], {
                encoding: "utf8",
              }) as string;
            } catch {
              how = `sparse fallback (commit unreachable in ${meta.repo})`;
            }
          }
        } catch {
          how = "sparse fallback (malformed meta.json)";
        }
      }
      out.push({ fixture, sections, how, worktreeBefore, repoPath });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// (a) fixture repos round-trip through git
// ---------------------------------------------------------------------------
process.stdout.write("\n(a) buildFixtureRepo on every fixture\n");
const loaded = loadFixtures();
assert(loaded.length === 13, `13 fixtures loaded (got ${loaded.length})`);
for (const { fixture, sections, how, worktreeBefore, repoPath } of loaded) {
  const startedAt = Date.now();
  let root = "";
  try {
    const repo = buildFixtureRepo(fixture);
    root = repo.root;
    const ms = Date.now() - startedAt;
    const names = (
      execFileSync("git", ["-C", repo.root, "diff", "--name-only", `${repo.baseSha}...HEAD`], {
        encoding: "utf8",
      }) as string
    )
      .split("\n")
      .filter((l) => l.trim() !== "");
    assert(
      names.length === sections - repo.excludedBinary,
      `${fixture.name} [${how}] base...HEAD files ${names.length} = sections ${sections} − binary ${repo.excludedBinary} (${ms}ms)`,
    );
    const patchDir = repo.patchDir;
    assert(
      patchDir !== undefined && resolve(patchDir) !== resolve(root),
      `${fixture.name}: patch file lives outside the repo root`,
    );
    removeFixtureRepo(repo);
    assert(!existsSync(root), `${fixture.name}: temp root removed`);
    if (patchDir !== undefined) assert(!existsSync(patchDir), `${fixture.name}: patch dir removed`);
    if (repoPath !== undefined) {
      const after = execFileSync("git", ["-C", repoPath, "worktree", "list"], {
        encoding: "utf8",
      }) as string;
      assert(after === worktreeBefore, `${fixture.name}: no worktree registered in source repo`);
    }
  } catch (err) {
    assert(false, `${fixture.name} [${how}]: ${err instanceof Error ? err.message : String(err)}`);
    if (root !== "") rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// (b) trailing-blank-line fix
// ---------------------------------------------------------------------------
process.stdout.write("\n(b) sparse materializer writes no trailing blank line\n");
{
  const patch = [
    "diff --git a/newfile.ts b/newfile.ts",
    "new file mode 100644",
    "index 0000000..1111111",
    "--- /dev/null",
    "+++ b/newfile.ts",
    "@@ -0,0 +1,2 @@",
    "+line one",
    "+line two",
    "",
  ].join("\n");
  const dest = mkdtempSync(join(tmpdir(), "warden-eval-oc-materialize-"));
  try {
    const written = materializePatchPostImages(patch, dest);
    assert(written.length === 1, `one file materialized (got ${written.length})`);
    const content = readFileSync(resolve(dest, "newfile.ts"), "utf8");
    assert(content === "line one\nline two\n", `2-line patch materializes to exactly 2 lines`);
    // `\ No newline at end of file` is honored: the sparse post-image
    // ends without a trailing newline, so `git apply -R` can reverse it.
    const noNlPatch = [
      "diff --git a/nonl.txt b/nonl.txt",
      "new file mode 100644",
      "index 0000000..1111111",
      "--- /dev/null",
      "+++ b/nonl.txt",
      "@@ -0,0 +1,2 @@",
      "+line one",
      "+line two",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    materializePatchPostImages(noNlPatch, dest);
    const noNl = readFileSync(resolve(dest, "nonl.txt"), "utf8");
    assert(noNl === "line one\nline two", `no-newline marker omits the trailing newline`);
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// (c) binaryPatchPaths
// ---------------------------------------------------------------------------
process.stdout.write("\n(c) binaryPatchPaths\n");
{
  const patch = [
    "diff --git a/img.png b/img.png",
    "new file mode 100644",
    "index 0000000..1234567",
    "GIT binary patch",
    "literal 3",
    "z$cmX",
    "",
    "diff --git a/src/a.ts b/src/a.ts",
    "new file mode 100644",
    "index 0000000..2222222",
    "--- /dev/null",
    "+++ b/src/a.ts",
    "@@ -0,0 +1 @@",
    "+x",
    "diff --git a/logo.png b/logo.png",
    "index 3333333..4444444 100644",
    "Binary files a/logo.png and b/logo.png differ",
    "",
  ].join("\n");
  const paths = binaryPatchPaths(patch);
  assert(
    paths.length === 2 && paths[0] === "img.png" && paths[1] === "logo.png",
    `binary sections found (got ${JSON.stringify(paths)})`,
  );
  assert(binaryPatchPaths("diff --git a/x b/x\n+1\n").length === 0, `text-only patch → none`);
}

// ---------------------------------------------------------------------------
// (d) checkParity
// ---------------------------------------------------------------------------
process.stdout.write("\n(d) checkParity\n");

function makeSample(
  caughtCount: number,
  unlabeled: number,
  cost: number,
  dispatches: number,
  forbiddenCount = 0,
  costMeasured = true,
): FixtureSample {
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
    costMeasured,
  };
}

const SYN_LABELS = ["a", "b", "c", "d", "e"].map((id) => ({ id, path: "x", description: "" }));
const M14_LABELS = ["a", "b", "c"].map((id) => ({ id, path: "x", description: "" }));
const FP_LABELS = ["fp-a", "fp-b"].map((id) => ({
  id,
  expect: "absent" as const,
  path: "x",
  description: "",
}));

function passRows(suffix = ""): FixtureScore[] {
  const s = (n: number): FixtureSample[] => [
    makeSample(n, 0, 0.1, 2),
    makeSample(n, 0, 0.1, 2),
    makeSample(n, 0, 0.1, 2),
  ];
  return [
    scoreFixtureRun(
      {
        name: `plant${suffix}`,
        category: "synthetic",
        diff: "",
        labels: SYN_LABELS,
        expectsEmpty: false,
      },
      s(5),
      "c",
    ),
    scoreFixtureRun(
      { name: `clean${suffix}`, category: "synthetic", diff: "", labels: [], expectsEmpty: true },
      [makeSample(0, 0, 0.01, 1), makeSample(0, 0, 0.01, 1), makeSample(0, 0, 0.01, 1)],
      "c",
    ),
    scoreFixtureRun(
      {
        name: `m14-closeout${suffix}`,
        category: "real-prs",
        diff: "",
        labels: M14_LABELS,
        expectsEmpty: false,
      },
      s(3),
      "c",
    ),
    scoreFixtureRun(
      {
        name: `falsepos${suffix}`,
        category: "real-prs",
        diff: "",
        labels: FP_LABELS,
        expectsEmpty: false,
      },
      s(0),
      "c",
    ),
  ];
}

const GATE_RUN: ParityRun = {
  reference: "ref",
  samples: 3,
  fixtureFilter: false,
  stopReason: null,
};
const refAgg = aggregateScores(passRows(), "ref");
const candAgg = aggregateScores(passRows(), "cand");
const passVerdict = checkParity(refAgg, candAgg, GATE_RUN);
assert(passVerdict.cleared, `all-pass pair clears`);
assert(
  passVerdict.reference === "ref" && passVerdict.candidate === "cand",
  `verdict names reference + candidate`,
);

function expectSingleFail(
  label: string,
  mutate: (rows: FixtureScore[]) => FixtureScore[],
  want: string,
): void {
  const mutated = mutate(passRows());
  const verdict = checkParity(refAgg, aggregateScores(mutated, "cand"), GATE_RUN);
  assert(
    !verdict.cleared && verdict.failed.length === 1 && verdict.failed[0] === want,
    `${label} → failed is exactly [${want}] (got [${verdict.failed.join(",")}])`,
  );
}

function rename(rows: FixtureScore[], from: string, to: string): FixtureScore[] {
  return rows.map((r) => (r.fixture === from ? { ...r, fixture: to } : r));
}

function recatch(rows: FixtureScore[], name: string, caughtCount: number): FixtureScore[] {
  return rows.map((r) => (r.fixture === name ? { ...r, caughtCount } : r));
}

/** Map the raw samples of one row through `change`. */
function resample(
  rows: FixtureScore[],
  name: string,
  change: (s: FixtureSample, i: number) => FixtureSample,
): FixtureScore[] {
  return rows.map((r) =>
    r.fixture === name ? { ...r, rawSamples: r.rawSamples.map((s, i) => change(s, i)) } : r,
  );
}

const failedLane = (s: FixtureSample): FixtureSample => ({
  ...s,
  dispatchCount: 0,
  error: "lane down failed (no submission)",
});

// P0: different fixture-name set.
expectSingleFail("P0", (rows) => rename(rows, "plant", "plant-other"), "P0-same-fixtures");
// P0: a short row (the run stopped inside the candidate's last fixture).
expectSingleFail(
  "P0-short-row",
  (rows) =>
    rows.map((r) =>
      r.fixture === "falsepos" ? { ...r, rawSamples: r.rawSamples.slice(0, 1) } : r,
    ),
  "P0-same-fixtures",
);
// P1: real-PR recall below reference.
expectSingleFail("P1", (rows) => recatch(rows, "m14-closeout", 2), "P1-real-recall");
// P2: synthetic recall below reference.
expectSingleFail("P2", (rows) => recatch(rows, "plant", 4), "P2-synthetic-recall");
// P3: a precision-trap hit.
expectSingleFail(
  "P3",
  (rows) => rows.map((r) => (r.fixture === "falsepos" ? { ...r, maxForbidden: 1 } : r)),
  "P3-precision-traps",
);
// P4: a 1-of-3 clean hit (the median is still 0).
expectSingleFail(
  "P4-one-of-three",
  (rows) => resample(rows, "clean", (s, i) => (i === 0 ? { ...s, unlabeledComments: 4 } : s)),
  "P4-clean-zero-hit",
);
// P5a: over budget (criterion (d)).
expectSingleFail("P5-cost", (rows) => rows.map((r) => ({ ...r, medianCost: 1 })), "P5-cost");
// P5b: unmeasured spend also fails P5.
{
  const rows = resample(passRows(), "plant", (s, i) =>
    i === 0 ? { ...s, costMeasured: false } : s,
  );
  const verdict = checkParity(refAgg, aggregateScores(rows, "cand"), GATE_RUN);
  assert(
    !verdict.cleared && verdict.failed.includes("P5-cost"),
    `P5-unmeasured → P5-cost fails (got [${verdict.failed.join(",")}])`,
  );
}
// P6: the lane failed on every sample of a clean fixture (`comments: []`).
expectSingleFail(
  "P6-clean-lane-failed",
  (rows) => resample(rows, "clean", failedLane),
  "P6-lane-health",
);
// P6: a 1-of-3 failed lane on a substantive fixture (the median hides it).
expectSingleFail(
  "P6-one-of-three",
  (rows) => resample(rows, "plant", (s, i) => (i === 0 ? failedLane(s) : s)),
  "P6-lane-health",
);
// P7: the reference failed on every sample (P1/P2 vacuous).
{
  const brokenRef = aggregateScores(
    passRows().map((r) => ({
      ...r,
      caughtCount: 0,
      medianDispatches: 0,
      hadError: true,
      rawSamples: r.rawSamples.map((s) => ({ ...s, dispatchCount: 0, error: "harness threw" })),
    })),
    "ref-broken",
  );
  const verdict = checkParity(brokenRef, candAgg, GATE_RUN);
  assert(
    !verdict.cleared && verdict.failed.length === 1 && verdict.failed[0] === "P7-reference-health",
    `P7 failed reference → failed is exactly [P7-reference-health] (got [${verdict.failed.join(",")}])`,
  );
}
// P8: a tracer is never a gate — filtered, stopped, N=1.
for (const [label, run] of [
  ["P8-filtered", { ...GATE_RUN, fixtureFilter: true }],
  ["P8-stopped", { ...GATE_RUN, stopReason: "cost-ceiling" }],
] as const satisfies readonly (readonly [string, ParityRun])[]) {
  const verdict = checkParity(refAgg, candAgg, run);
  assert(
    !verdict.cleared && verdict.failed.length === 1 && verdict.failed[0] === "P8-gate-run",
    `${label} → failed is exactly [P8-gate-run] (got [${verdict.failed.join(",")}])`,
  );
}
{
  // N=1: the rows hold 1 sample each, so P0 passes and only P8 fails.
  const one = (rows: FixtureScore[]): FixtureScore[] =>
    rows.map((r) => ({ ...r, rawSamples: r.rawSamples.slice(0, 1) }));
  const verdict = checkParity(
    aggregateScores(one(passRows()), "ref"),
    aggregateScores(one(passRows()), "cand"),
    { ...GATE_RUN, samples: 1 },
  );
  assert(
    !verdict.cleared && verdict.failed.length === 1 && verdict.failed[0] === "P8-gate-run",
    `P8-N=1 → failed is exactly [P8-gate-run] (got [${verdict.failed.join(",")}])`,
  );
}
// A tie passes (parity, not superiority).
{
  const tie = checkParity(refAgg, aggregateScores(passRows(), "cand-tie"), GATE_RUN);
  assert(tie.cleared, `identical tie passes`);
}
// An absent reference: the run stopped in the candidate (it runs first).
for (const stopReason of ["cost-ceiling", "unmeasured-spend"] as const) {
  const verdict = checkParity(undefined, candAgg, { ...GATE_RUN, stopReason });
  const line = (p: string): string => verdict.details.find((d) => d.startsWith(`(${p})`)) ?? "";
  assert(
    !verdict.cleared &&
      verdict.failed.join(",") === "P0-same-fixtures,P7-reference-health,P8-gate-run",
    `absent reference (${stopReason}) → NOT MET, failed is exactly [P0, P7, P8] (got [${verdict.failed.join(",")}])`,
  );
  assert(
    ["P1", "P2"].every((p) => line(p).endsWith("NO REFERENCE") && !line(p).includes("PASS")),
    `absent reference (${stopReason}) → P1/P2 print "no reference", not PASS`,
  );
  assert(
    ["P3", "P4", "P5", "P6"].every((p) => line(p).endsWith("— PASS")),
    `absent reference (${stopReason}) → P3–P6 still report on the candidate`,
  );
  assert(
    line("P8").includes(`stop reason ${stopReason}`),
    `P8 names the stop reason ${stopReason}`,
  );
  assert(verdict.reference === "ref", `absent reference → the verdict still names it`);
}
{
  // The zero-spend dry check: the ceiling stops before the first candidate
  // sample, so the candidate aggregate is empty. No lane ran: P6 fails.
  const verdict = checkParity(undefined, aggregateScores([], "cand"), {
    ...GATE_RUN,
    stopReason: "cost-ceiling",
  });
  assert(
    verdict.failed.join(",") === "P0-same-fixtures,P6-lane-health,P7-reference-health,P8-gate-run",
    `empty candidate + absent reference → failed is exactly [P0, P6, P7, P8] (got [${verdict.failed.join(",")}])`,
  );
}

/** Set the tree source on every sample of one row. */
function retree(rows: FixtureScore[], name: string, treeSource: string): FixtureScore[] {
  return resample(rows, name, (s) => ({ ...s, treeSource }));
}
{
  // A reference `worktree add` failure: sparse for the reference, the real
  // tree for the candidate.
  const ref = aggregateScores(
    retree(passRows(), "m14-closeout", "sparse (worktree add failed)"),
    "ref",
  );
  const cand = aggregateScores(retree(passRows(), "m14-closeout", "archive warden@abc123"), "cand");
  const verdict = checkParity(ref, cand, GATE_RUN);
  const p0 = verdict.details.find((d) => d.startsWith("(P0)")) ?? "";
  assert(
    verdict.failed.join(",") === "P0-same-fixtures" &&
      p0.includes("tree-kind mismatch m14-closeout"),
    `P0-tree-kind mismatch → failed is exactly [P0-same-fixtures], names m14-closeout (got [${verdict.failed.join(",")}])`,
  );
}
{
  const ref = aggregateScores(retree(passRows(), "m14-closeout", "worktree warden@abc123"), "ref");
  const cand = aggregateScores(retree(passRows(), "m14-closeout", "archive warden@abc123"), "cand");
  const verdict = checkParity(ref, cand, GATE_RUN);
  assert(verdict.cleared, `archive X@c vs worktree X@c → the same tree kind, no P0 failure`);
}
{
  const ref = aggregateScores(retree(passRows(), "m14-closeout", "worktree warden@abc123"), "ref");
  const cand = aggregateScores(retree(passRows(), "m14-closeout", "archive warden@def456"), "cand");
  const verdict = checkParity(ref, cand, GATE_RUN);
  assert(
    verdict.failed.join(",") === "P0-same-fixtures",
    `archive X@c1 vs worktree X@c2 → P0 fails (got [${verdict.failed.join(",")}])`,
  );
}
// P6: the session ran without the requested variant.
expectSingleFail(
  "P6-model-variant-mismatch",
  (rows) =>
    resample(rows, "plant", (s, i) => ({
      ...s,
      requestedModel: "anthropic/claude-opus-5-5#high",
      sessionModel: i === 0 ? "anthropic/claude-opus-5-5" : "anthropic/claude-opus-5-5#high",
    })),
  "P6-lane-health",
);
{
  // An absent session model is P5's concern (unmeasured), not P6's.
  const rows = resample(passRows(), "plant", (s) => ({
    ...s,
    requestedModel: "anthropic/claude-opus-5-5#high",
  }));
  const verdict = checkParity(refAgg, aggregateScores(rows, "cand"), GATE_RUN);
  assert(verdict.cleared, `P6 → an absent session model does not fail P6`);
}

// ---------------------------------------------------------------------------
// (e) parseSessionUsage
// ---------------------------------------------------------------------------
process.stdout.write("\n(e) parseSessionUsage\n");
{
  const usage = parseSessionUsage({
    data: {
      id: "ses_1",
      model: { id: "claude-opus-5-5", providerID: "anthropic", variant: "high" },
      cost: 0.0123,
      tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 20, write: 30 } },
      outcome: "succeeded",
    },
  });
  assert(
    usage !== undefined &&
      usage.costUsd === 0.0123 &&
      usage.tokens.input === 100 &&
      usage.tokens.output === 50 &&
      usage.tokens.reasoning === 10 &&
      usage.tokens.cacheRead === 20 &&
      usage.tokens.cacheWrite === 30 &&
      usage.model === "anthropic/claude-opus-5-5#high",
    `verified shape parses with model#variant + tokens`,
  );
  assert(
    parseSessionUsage({
      data: {
        model: { id: "claude-opus-5-5", providerID: "anthropic" },
        cost: 0.1,
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    })?.model === "anthropic/claude-opus-5-5",
    `a session model without a variant → <providerID>/<id>`,
  );
  assert(parseSessionUsage({ foo: 1 }) === undefined, `missing data → undefined`);
  assert(
    parseSessionUsage({
      data: {
        cost: "0.1",
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    }) === undefined,
    `non-number cost → undefined`,
  );
  const okData = {
    id: "ses_1",
    cost: 0.5,
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
  };
  assert(parseSessionUsage({ data: okData }, "ses_1") !== undefined, `matching data.id parses`);
  assert(
    parseSessionUsage({ data: okData }, "ses_2") === undefined,
    `data.id not the requested ID → undefined`,
  );
  assert(
    parseSessionUsage({ data: { ...okData, cost: -0.1 } }) === undefined,
    `negative cost → undefined`,
  );
  assert(
    parseSessionUsage({ data: { cost: 0, tokens: { input: 0, output: 0, reasoning: 0 } } }) ===
      undefined,
    `missing tokens.cache → undefined`,
  );
}

if (failed > 0) {
  process.stdout.write(`\n${failed} assertion(s) failed\n`);
  process.exit(1);
}
process.stdout.write("\nall assertions passed\n");
