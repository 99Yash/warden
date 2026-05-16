/**
 * M14 bug-floor smoke for the generalized concat-then-substring-match in
 * `verify-citations.ts`.
 *
 *   1. Single-line snippets at lines 5 / 50 / 500 / 5000 of a 10000-line
 *      fixture all verify (regression: head-only bug stays dead — the line
 *      streaming reads to `line + LINE_DRIFT`, not just the first N).
 *   2. Multi-line snippets verify for non-`api_def` source types (`tool`,
 *      `repo_convention`). M10's per-line match couldn't handle this; the
 *      M14 generalization can.
 *   3. A bogus snippet not in the file at the cited line still drops.
 *
 * Usage: pnpm --filter @warden/cli smoke:bugfloor-verify-citations
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const TMP_ROOT = resolve(
  tmpdir(),
  `warden-bugfloor-verify-${process.pid}-${Date.now()}`,
);

if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });
mkdirSync(resolve(TMP_ROOT, "src"), { recursive: true });

// 10000-line fixture. Each line embeds its own line number so we can prove
// the verifier reads beyond the file head. Marker lines at 5, 50, 500, 5000
// carry a unique recognizable token; the rest are filler.
const BIG_PATH = "src/big.ts";
const BIG_LINES: string[] = [];
const MARKER_LINES = [5, 50, 500, 5000];
for (let i = 1; i <= 10000; i++) {
  if (MARKER_LINES.includes(i)) {
    BIG_LINES.push(`const marker_${i} = "verify-line-${i}";`);
  } else {
    BIG_LINES.push(`// filler line ${i}`);
  }
}
writeFileSync(resolve(TMP_ROOT, BIG_PATH), BIG_LINES.join("\n"));

// Multi-line fixture for case 2. The token sequence
// `if (x) { doThing(x); return true; }` spans 5 lines as written, but a
// producer that collapses node text via `s.replace(/\s+/g, " ").trim()`
// emits it as a single token sequence — M10's per-line match would never
// find it; M14's concat-then-match finds it once.
const MULTILINE_PATH = "src/multiline.ts";
const MULTILINE_CONTENT = [
  "// header",
  "export function check(x: unknown): boolean {",
  "  if (x) {",
  "    doThing(",
  "      x,",
  "    );",
  "    return true;",
  "  }",
  "  return false;",
  "}",
].join("\n");
writeFileSync(resolve(TMP_ROOT, MULTILINE_PATH), MULTILINE_CONTENT);

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

const now = new Date().toISOString();

process.stdout.write(`\n[1] single-line snippets at lines 5 / 50 / 500 / 5000\n`);

const singleLineComments: Comment[] = MARKER_LINES.map((ln) => ({
  id: `W-single${String(ln).padStart(7, "0")}`,
  file: BIG_PATH,
  lineStart: ln,
  lineEnd: ln,
  tier: 2,
  category: "correctness",
  kind: "question" as const,
  claim: `line ${ln} citation`,
  explanation: "",
  sources: [
    {
      type: "repo_convention" as const,
      id: "test",
      title: BIG_PATH,
      retrievedAt: now,
      path: BIG_PATH,
      line: ln,
      snippet: `const marker_${ln} = "verify-line-${ln}";`,
    },
  ],
  confidence: 0.5,
}));

const singleResult = await verifyCitations({
  comments: singleLineComments,
  repoRoot: TMP_ROOT,
});

for (const ln of MARKER_LINES) {
  const survived = singleResult.comments.find((c) =>
    c.id === `W-single${String(ln).padStart(7, "0")}`,
  );
  assert(survived !== undefined, `single-line snippet at line ${ln} verifies`);
}

assert(
  singleResult.degraded.length === 0,
  "no degraded entries when every snippet verified",
);

process.stdout.write(`\n[2] multi-line snippet for non-api_def source types\n`);

// Collapsed (single-token-sequence) form of `MULTILINE_CONTENT` lines 3-8.
// The line `if (x) {` cited starts at line 3; the collapsed snippet spans
// to line 8. M10 per-line: fails. M14 concat: matches within LINE_DRIFT=5.
const collapsedMultiSnippet =
  "if (x) { doThing( x, ); return true; }";

const multiToolComment: Comment = {
  id: "W-multi-tool0001",
  file: MULTILINE_PATH,
  lineStart: 3,
  lineEnd: 3,
  tier: 1,
  category: "correctness",
  kind: "assertion",
  claim: "tool-grounded multi-line snippet",
  explanation: "",
  sources: [
    {
      type: "tool",
      id: "fake-detector",
      title: MULTILINE_PATH,
      retrievedAt: now,
      path: MULTILINE_PATH,
      line: 3,
      snippet: collapsedMultiSnippet,
    },
  ],
  confidence: 1,
};

const multiRepoConventionComment: Comment = {
  id: "W-multi-conv0002",
  file: MULTILINE_PATH,
  lineStart: 3,
  lineEnd: 3,
  tier: 2,
  category: "consistency",
  kind: "question",
  claim: "repo_convention multi-line snippet",
  explanation: "",
  sources: [
    {
      type: "repo_convention",
      id: "test-conv",
      title: MULTILINE_PATH,
      retrievedAt: now,
      path: MULTILINE_PATH,
      line: 3,
      snippet: collapsedMultiSnippet,
    },
  ],
  confidence: 0.6,
};

const multiResult = await verifyCitations({
  comments: [multiToolComment, multiRepoConventionComment],
  repoRoot: TMP_ROOT,
});

assert(
  multiResult.comments.some((c) => c.id === multiToolComment.id),
  "multi-line tool snippet verifies via concat-then-match",
);
assert(
  multiResult.comments.some((c) => c.id === multiRepoConventionComment.id),
  "multi-line repo_convention snippet verifies via concat-then-match",
);
assert(
  multiResult.degraded.length === 0,
  "no degraded entries when every multi-line snippet verified",
);

process.stdout.write(`\n[3] bogus snippet still drops\n`);

const bogusComment: Comment = {
  id: "W-bogus0001",
  file: MULTILINE_PATH,
  lineStart: 3,
  lineEnd: 3,
  tier: 2,
  category: "correctness",
  kind: "question",
  claim: "bogus citation",
  explanation: "",
  sources: [
    {
      type: "repo_convention",
      id: "bogus",
      title: MULTILINE_PATH,
      retrievedAt: now,
      path: MULTILINE_PATH,
      line: 3,
      snippet: "this token sequence does not appear anywhere in the file",
    },
  ],
  confidence: 0.5,
};

const bogusResult = await verifyCitations({
  comments: [bogusComment],
  repoRoot: TMP_ROOT,
});

assert(
  bogusResult.comments.find((c) => c.id === bogusComment.id) === undefined,
  "bogus-only snippet drops the whole Comment",
);
assert(
  bogusResult.degraded.some((d) => /dropped 1 citation/.test(d.message)),
  "degraded entry counts the dropped citation",
);
assert(
  bogusResult.degraded.some((d) => /dropped 1 comment/.test(d.message)),
  "degraded entry counts the dropped Comment",
);

// Cleanup.
if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });

if (failed > 0) {
  process.stdout.write(`\n${failed} assertion(s) failed\n`);
  process.exit(1);
}
process.stdout.write(`\nall assertions passed\n`);
