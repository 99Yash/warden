/**
 * Smoke for the review harness's LLM comment diff-scope post-pass. No LLM
 * call — exercises the pure filter that keeps comments anchored to added
 * lines and drops comments on unchanged lines.
 *
 * Usage:
 *   pnpm --filter @warden/cli smoke:m14-diff-scope
 */

import type { ChangedFile, Comment } from "@warden/core";

const { scopeCommentsToDiff } = await import("@warden/core/review-harness/comment-scope");

let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) {
    process.stdout.write(`  ✓ ${msg}\n`);
  } else {
    process.stdout.write(`  ✗ ${msg}\n`);
    failed++;
  }
}

function mkComment(overrides: Partial<Comment> & { id: string }): Comment {
  const { id, ...rest } = overrides;
  return {
    id,
    file: "src/example.ts",
    lineStart: 12,
    lineEnd: 12,
    tier: 2,
    category: "correctness",
    kind: "assertion",
    claim: "synthetic",
    explanation: "synthetic",
    sources: [],
    confidence: 0.9,
    ...rest,
  };
}

const changed: ChangedFile[] = [
  {
    path: "src/example.ts",
    addedLines: [12, 20],
  },
];

process.stdout.write(`\n[1] comments must overlap added lines\n`);

const onAddedLine = mkComment({ id: "on-added", lineStart: 12, lineEnd: 12 });
const rangeOverlaps = mkComment({ id: "range-overlaps", lineStart: 18, lineEnd: 20 });
const unchangedLine = mkComment({ id: "unchanged", lineStart: 16, lineEnd: 16 });
const outsideFile = mkComment({ id: "outside-file", file: "src/other.ts", lineStart: 12, lineEnd: 12 });
const fileLevel = mkComment({ id: "file-level", lineStart: 0, lineEnd: 0 });

const result = scopeCommentsToDiff(
  [onAddedLine, rangeOverlaps, unchangedLine, outsideFile, fileLevel],
  changed,
);

assert(result.comments.length === 2, `2 comments survive (got ${result.comments.length})`);
assert(
  result.comments.map((c) => c.id).join(",") === "on-added,range-overlaps",
  `survivors are the comments overlapping added lines (${result.comments.map((c) => c.id).join(",")})`,
);
assert(result.droppedCount === 3, `3 comments dropped (got ${result.droppedCount})`);

if (failed > 0) {
  process.stdout.write(`\n${failed} assertion(s) failed\n`);
  process.exit(1);
}
process.stdout.write(`\nall assertions passed\n`);
