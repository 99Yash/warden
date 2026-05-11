/**
 * Smoke harness for M10's global substring-verifier post-pass (ADR-0021 §3).
 *
 *   - Comment A carries a verifiable `{path, line, snippet}` triple — passes
 *     through with sources intact.
 *   - Comment B carries a bogus triple — its source is dropped and, since
 *     it had no other sources, the whole Comment is dropped.
 *   - Comment C carries a snippet-less (tool-grounded) source — pass-through.
 *
 * Forensic count: exactly one "dropped 1 citation" + one "dropped 1 comment"
 * `info` entry on `degraded`.
 *
 * Usage:
 *   pnpm --filter @warden/cli smoke:m10-verifier
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const TMP_ROOT = resolve(tmpdir(), `warden-m10-verifier-${process.pid}`);

if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });
mkdirSync(resolve(TMP_ROOT, "src"), { recursive: true });

// Fixture file with a recognizable line at line 5.
const FIXTURE_PATH = "src/example.ts";
writeFileSync(
  resolve(TMP_ROOT, FIXTURE_PATH),
  [
    "// header",
    "import { foo } from './foo.js';",
    "",
    "export function authenticate(user: string) {",
    "  return user === 'admin';",
    "}",
    "",
    "// trailer",
    "",
  ].join("\n"),
);

const { verifyCitations } = await import("@warden/core");
import type { Comment } from "@warden/core";

let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) {
    process.stdout.write(`  ✓ ${msg}\n`);
  } else {
    process.stdout.write(`  ✗ ${msg}\n`);
    failed++;
  }
}

process.stdout.write(`\n[1] verifyCitations — mixed Comment[]\n`);

const now = new Date().toISOString();

const commentA: Comment = {
  id: "W-aaaaaa0001",
  file: FIXTURE_PATH,
  lineStart: 5,
  lineEnd: 5,
  tier: 2,
  category: "committability",
  kind: "question",
  claim: "Hard-coded admin check looks suspicious.",
  explanation: "return user === 'admin';",
  sources: [
    {
      type: "repo_convention",
      id: "committability-subagent",
      title: FIXTURE_PATH,
      retrievedAt: now,
      path: FIXTURE_PATH,
      line: 5,
      snippet: "return user === 'admin';",
    },
  ],
  confidence: 0.5,
};

const commentB: Comment = {
  id: "W-bbbbbb0002",
  file: FIXTURE_PATH,
  lineStart: 5,
  lineEnd: 5,
  tier: 2,
  category: "committability",
  kind: "question",
  claim: "Bogus citation that doesn't exist in source.",
  explanation: "<llm hallucinated a snippet>",
  sources: [
    {
      type: "repo_convention",
      id: "committability-subagent",
      title: FIXTURE_PATH,
      retrievedAt: now,
      path: FIXTURE_PATH,
      line: 5,
      snippet: "const ADMIN_MASTER_KEY = 'hunter2';",
    },
  ],
  confidence: 0.5,
};

const commentC: Comment = {
  id: "W-cccccc0003",
  file: FIXTURE_PATH,
  lineStart: 5,
  lineEnd: 5,
  tier: 1,
  category: "correctness",
  kind: "assertion",
  claim: "tsc: error TS2322",
  explanation: "Type 'string' is not assignable to type 'number'.",
  sources: [
    {
      type: "tool",
      id: "tsc",
      title: "tsc",
      retrievedAt: now,
    },
  ],
  confidence: 1,
};

const result = await verifyCitations({
  comments: [commentA, commentB, commentC],
  repoRoot: TMP_ROOT,
});

const survivedA = result.comments.find((c) => c.id === commentA.id);
const survivedB = result.comments.find((c) => c.id === commentB.id);
const survivedC = result.comments.find((c) => c.id === commentC.id);

assert(survivedA !== undefined, "Comment A (verifiable triple) survives");
assert(
  survivedA?.sources.length === 1 &&
    survivedA.sources[0]?.snippet === "return user === 'admin';",
  "Comment A keeps its verified source intact",
);
assert(survivedB === undefined, "Comment B (bogus triple) is dropped — its only source was unverifiable");
assert(survivedC !== undefined, "Comment C (snippet-less tool source) passes through unchanged");
assert(
  survivedC?.sources.length === 1 && survivedC.sources[0]?.type === "tool",
  "Comment C's tool-grounded source survives unchanged",
);

const infoEntries = result.degraded.filter((d) => d.kind === "info" && d.topic === "llm");
assert(infoEntries.length === 2, `exactly two forensic info entries (got ${infoEntries.length})`);
assert(
  infoEntries.some((e) => /dropped 1 citation/.test(e.message)),
  "one degraded line reports dropped citation count",
);
assert(
  infoEntries.some((e) => /dropped 1 comment/.test(e.message)),
  "one degraded line reports dropped comment count",
);

// Cleanup.
if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });

if (failed > 0) {
  process.stdout.write(`\n${failed} assertion(s) failed\n`);
  process.exit(1);
}
process.stdout.write(`\nall assertions passed\n`);
