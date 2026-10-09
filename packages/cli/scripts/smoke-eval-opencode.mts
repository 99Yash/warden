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
 *       criterion P0–P6 (the failed list names exactly that criterion),
 *       and a tie that passes.
 *   (e) `parseSessionUsage`: the verified shape; missing `data`;
 *       non-number `cost`; missing `tokens.cache` → `undefined`.
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
import { aggregateScores, checkParity, scoreFixtureRun } from "./eval/score.mjs";
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
              fixture.realRepo = { repoPath: resolved, commit: meta.commit };
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
      [makeSample(0, 0, 0.01, 0), makeSample(0, 0, 0.01, 0), makeSample(0, 0, 0.01, 0)],
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

const refAgg = aggregateScores(passRows(), "ref");
const candAgg = aggregateScores(passRows(), "cand");
const passVerdict = checkParity(refAgg, candAgg);
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
  const verdict = checkParity(refAgg, aggregateScores(mutated, "cand"));
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

// P0: different fixture-name set.
expectSingleFail("P0", (rows) => rename(rows, "plant", "plant-other"), "P0-same-fixtures");
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
// P4: clean-fixture comments.
expectSingleFail(
  "P4",
  (rows) => rows.map((r) => (r.fixture === "clean" ? { ...r, medianUnlabeled: 2 } : r)),
  "P4-clean-zero-hit",
);
// P5a: over budget (criterion (d)).
expectSingleFail("P5-cost", (rows) => rows.map((r) => ({ ...r, medianCost: 1 })), "P5-cost");
// P5b: unmeasured spend also fails P5.
{
  const rows = passRows().map((r) =>
    r.fixture === "plant"
      ? {
          ...r,
          rawSamples: r.rawSamples.map((s, i) => (i === 0 ? { ...s, costMeasured: false } : s)),
        }
      : r,
  );
  const verdict = checkParity(refAgg, aggregateScores(rows, "cand"));
  assert(
    !verdict.cleared && verdict.failed.includes("P5-cost"),
    `P5-unmeasured → P5-cost fails (got [${verdict.failed.join(",")}])`,
  );
}
// P6: a substantive row with no dispatch.
expectSingleFail(
  "P6",
  (rows) => rows.map((r) => (r.fixture === "plant" ? { ...r, medianDispatches: 0 } : r)),
  "P6-lane-health",
);
// A tie passes (parity, not superiority).
{
  const tie = checkParity(refAgg, aggregateScores(passRows(), "cand-tie"));
  assert(tie.cleared, `identical tie passes`);
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
      usage.model === "anthropic/claude-opus-5-5",
    `verified shape parses with model + tokens`,
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
