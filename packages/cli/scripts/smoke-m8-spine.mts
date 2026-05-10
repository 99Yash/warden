/**
 * Smoke harness for M8's orchestration spine (ADR-0023). Validates the
 * `Runner` contract + in-memory `Scratchpad` + parallel `dispatch()` +
 * deterministic synthesis directly, without going through `review()` —
 * the spine pieces are unit-shaped enough that mocking the LLM cascade for
 * a `review`-mode end-to-end isn't worth the harness overhead in v0.
 *
 * Usage:
 *   pnpm --filter @warden/cli smoke:m8-spine
 */

import { mkdirSync, writeFileSync, existsSync, unlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const TMP_ROOT = resolve(tmpdir(), `warden-m8-spine-${process.pid}`);
const TMP_DB = resolve(tmpdir(), `warden-m8-spine-${process.pid}.sqlite`);
process.env["WARDEN_CACHE_PATH"] = TMP_DB;

if (existsSync(TMP_DB)) unlinkSync(TMP_DB);
if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });
mkdirSync(TMP_ROOT, { recursive: true });

const {
  Scratchpad,
  deterministicSynthesize,
  dispatch,
} = await import("@warden/core");
const { scalabilityRunner } = await import("@warden/core/runners/scalability");

let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) {
    process.stdout.write(`  ✓ ${msg}\n`);
  } else {
    process.stdout.write(`  ✗ ${msg}\n`);
    failed++;
  }
}

// 1. Scratchpad shape: record / get / all / flatten / flattenQuestions /
// flattenDegraded. The Map is bounded by runner count.
process.stdout.write(`\n[1] Scratchpad — record + flatten\n`);
const sp1 = new Scratchpad();
sp1.record({
  name: "tsc",
  findings: [
    {
      source: "tsc",
      file: "src/foo.ts",
      line: 42,
      column: 1,
      severity: "error",
      ruleId: "TS2322",
      message: "Type 'string' is not assignable to type 'number'.",
    },
  ],
  degraded: [{ kind: "info", topic: "tsc", message: "tsc: 1 finding" }],
  durationMs: 12,
});
sp1.record({
  name: "scalability",
  findings: [
    {
      source: "scalability",
      file: "src/bar.ts",
      line: 10,
      column: 1,
      severity: "warning",
      ruleId: "load-then-narrow",
      message: "Query loads all rows then narrows in JS",
    },
  ],
  degraded: [],
  durationMs: 5,
});
sp1.record({
  name: "committability",
  findings: [],
  questions: [
    {
      id: "W-abc1234567",
      file: "scripts-bootstrap-blair.mts",
      lineStart: 1,
      lineEnd: 1,
      tier: 2,
      category: "committability",
      kind: "question",
      claim: "Filename matches the dev-script pattern (`scripts-bootstrap-*`).",
      explanation: "scripts-bootstrap-blair.mts",
      sources: [
        {
          type: "repo_convention",
          id: "committability-subagent",
          title: "scripts-bootstrap-blair.mts",
          retrievedAt: new Date().toISOString(),
        },
      ],
      confidence: 0.5,
    },
  ],
  degraded: [],
  durationMs: 850,
});

assert(sp1.has("tsc") && sp1.has("scalability") && sp1.has("committability"), "all three runners recorded");
assert(sp1.flatten().length === 2, `flatten() collects findings from non-empty runners (got ${sp1.flatten().length})`);
assert(sp1.flattenQuestions().length === 1, `flattenQuestions() collects sub-agent questions (got ${sp1.flattenQuestions().length})`);
assert(sp1.flattenDegraded().length === 1, `flattenDegraded() collects per-runner degraded entries (got ${sp1.flattenDegraded().length})`);
assert(sp1.all().length === 3, `all() returns one entry per recorded runner (got ${sp1.all().length})`);

// 2. dispatch() — happy path: parallel invocation, durations recorded by
// the dispatcher (not the runner).
process.stdout.write(`\n[2] dispatch — happy path\n`);
mkdirSync(resolve(TMP_ROOT, "src"), { recursive: true });
const fixturePath = "src/fixture.ts";
writeFileSync(
  resolve(TMP_ROOT, fixturePath),
  `
import { db } from "./db";
export async function listOpenForUser(userId: string) {
  return (await db.select().from(orders).where(eq(orders.userId, userId)).all())
    .filter((r) => r.status === "open");
}
declare const orders: { userId: string; status: string };
declare function eq(a: unknown, b: unknown): boolean;
`,
);
const sp2 = new Scratchpad();
const fixtureAddedLines = Array.from({ length: 10 }, (_, i) => i + 1);
await dispatch(
  [scalabilityRunner],
  {
    repoRoot: TMP_ROOT,
    changed: [{ path: fixturePath, addedLines: fixtureAddedLines }],
    changedPaths: [fixturePath],
  },
  sp2,
);
const scalOut = sp2.get("scalability");
assert(scalOut !== undefined, "scalability runner output recorded under its name");
assert(scalOut?.error === undefined, "scalability runner ran without throwing");
assert((scalOut?.durationMs ?? 0) > 0, `dispatcher overrode durationMs to wall-clock (got ${scalOut?.durationMs ?? 0})`);
assert(
  (scalOut?.findings ?? []).some((f) => f.ruleId === "load-then-narrow"),
  "scalability emits load-then-narrow finding via the contract",
);

// 3. dispatch() — error injection: a throwing runner gets its error
// captured and a `degraded` warning entry emitted.
process.stdout.write(`\n[3] dispatch — error capture\n`);
const failingRunner = {
  name: "exploding-detector",
  async run() {
    throw new Error("intentional failure for smoke test");
  },
};
const sp3 = new Scratchpad();
await dispatch(
  // The runner type is shaped per the contract; intentional any-cast for
  // the smoke harness — typed runners don't accidentally throw, and the
  // contract permits failure.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [failingRunner as any],
  {
    repoRoot: TMP_ROOT,
    changed: [],
    changedPaths: [],
  },
  sp3,
);
const failOut = sp3.get("exploding-detector");
assert(failOut !== undefined, "failed runner is still recorded under its name");
assert(failOut?.error instanceof Error, "RunnerOutput.error is populated when run() throws");
assert(failOut?.findings.length === 0, "failed runner contributes no findings");
assert(
  (failOut?.degraded ?? []).some(
    (e) => e.kind === "warning" && e.topic === "exploding-detector",
  ),
  "failed runner emits a degraded warning entry naming itself",
);
assert((failOut?.durationMs ?? 0) >= 0, "failed runner still records a duration");

// 4. deterministicSynthesize — `check`-mode synthesis path: scratchpad →
// CommentSet without an LLM call. Findings get scope-filtered, mapped to
// Comments, and concatenated with vulnComments + sub-agent questions.
process.stdout.write(`\n[4] deterministicSynthesize — check-mode synthesis\n`);
const sp4 = new Scratchpad();
sp4.record({
  name: "tsc",
  findings: [
    {
      source: "tsc",
      file: fixturePath,
      line: 4,
      column: 1,
      severity: "error",
      ruleId: "TS2322",
      message: "Type mismatch on filter callback",
    },
    {
      // off-diff finding — should be filtered by scopeToDiff
      source: "tsc",
      file: "src/other.ts",
      line: 99,
      column: 1,
      severity: "error",
      ruleId: "TS2322",
      message: "Off-diff TSC error",
    },
  ],
  degraded: [],
  durationMs: 10,
});
sp4.record({
  name: "committability",
  findings: [],
  questions: [
    {
      id: "W-deadbeef01",
      file: "scripts-bootstrap-blair.mts",
      lineStart: 1,
      lineEnd: 1,
      tier: 2,
      category: "committability",
      kind: "question",
      claim: "Looks like a one-off bootstrap script.",
      explanation: "filename pattern",
      sources: [],
      confidence: 0.5,
    },
  ],
  degraded: [],
  durationMs: 250,
});
const det = deterministicSynthesize({
  scratchpad: sp4,
  vulnComments: [],
  changed: [{ path: fixturePath, addedLines: fixtureAddedLines }],
});
assert(
  det.comments.some((c) => c.file === fixturePath && c.category === "correctness"),
  "in-diff TSC finding survives synthesis as a correctness comment",
);
assert(
  !det.comments.some((c) => c.file === "src/other.ts"),
  "off-diff TSC finding is dropped by scopeToDiff",
);
assert(
  det.comments.some((c) => c.kind === "question" && c.category === "committability"),
  "sub-agent committability question lands in synthesis output",
);
assert(det.degraded.length === 0, "deterministic synthesis emits no extra degraded entries");

// 5. Cleanup.
if (existsSync(TMP_DB)) unlinkSync(TMP_DB);
if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });

if (failed > 0) {
  process.stdout.write(`\n${failed} assertion(s) failed\n`);
  process.exit(1);
}
process.stdout.write(`\nall assertions passed\n`);
