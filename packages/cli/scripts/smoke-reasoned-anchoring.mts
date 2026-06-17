/**
 * Smoke for reasoned-lane Step 1 (ADR-0044 precision; `reasoned-lane-plan.md`
 * §Step 1): the off-hunk anchoring drop.
 *
 * Deterministic, keyless — exercises `buildAddedLineMap` + `anchorsToAddedLine`
 * + `dropUnanchoredComments` against a synthetic two-file diff. Asserts:
 *   - a comment ON an added line survives;
 *   - a comment whose range STARTS on adjacent context but EXTENDS into an
 *     added line survives (overlap ≥1 added line, not all-added);
 *   - a comment on an unchanged (non-added) line in a changed file is dropped;
 *   - a comment on a file absent from the diff is dropped.
 *
 * Usage:
 *   pnpm --filter @warden/cli smoke:reasoned-anchoring
 */

import {
  anchorsToAddedLine,
  buildAddedLineMap,
  dropUnanchoredComments,
  type Comment,
} from "@warden/core";

// Two-file diff. `src/a.ts` adds lines 10-12 (a 3-line insert after context at
// line 9). `src/b.ts` adds line 5.
const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -9,1 +9,4 @@",
  " const ctx = 1;",
  "+const x = 2;",
  "+const y = 3;",
  "+const z = 4;",
  "diff --git a/src/b.ts b/src/b.ts",
  "--- a/src/b.ts",
  "+++ b/src/b.ts",
  "@@ -4,0 +5,1 @@",
  "+const only = 1;",
  "",
].join("\n");

const map = buildAddedLineMap(DIFF);

function fail(msg: string): never {
  process.stderr.write(`[smoke:reasoned-anchoring] FAIL — ${msg}\n`);
  process.exit(1);
}

// --- buildAddedLineMap ------------------------------------------------------
const aAdded = map.get("src/a.ts");
const bAdded = map.get("src/b.ts");
if (!aAdded || !(aAdded.has(10) && aAdded.has(11) && aAdded.has(12)) || aAdded.has(9)) {
  fail(`src/a.ts added lines wrong: ${aAdded ? [...aAdded].join(",") : "absent"} (want 10,11,12)`);
}
if (!bAdded || !bAdded.has(5) || bAdded.size !== 1) {
  fail(`src/b.ts added lines wrong: ${bAdded ? [...bAdded].join(",") : "absent"} (want 5)`);
}

// --- anchorsToAddedLine -----------------------------------------------------
const onHunk = { file: "src/a.ts", lineStart: 11, lineEnd: 11 };
const contextIntoHunk = { file: "src/a.ts", lineStart: 9, lineEnd: 10 }; // 9=context, 10=added
const offHunk = { file: "src/a.ts", lineStart: 9, lineEnd: 9 }; // unchanged context only
const otherFile = { file: "src/c.ts", lineStart: 1, lineEnd: 1 }; // not in diff

if (!anchorsToAddedLine(onHunk, map)) fail("on-hunk comment should anchor");
if (!anchorsToAddedLine(contextIntoHunk, map)) fail("context-into-hunk comment should anchor");
if (anchorsToAddedLine(offHunk, map)) fail("off-hunk (context-only) comment should NOT anchor");
if (anchorsToAddedLine(otherFile, map)) fail("comment on file absent from diff should NOT anchor");

// --- dropUnanchoredComments (partition + count) -----------------------------
const mk = (id: string, file: string, lineStart: number, lineEnd: number): Comment =>
  ({
    id,
    file,
    lineStart,
    lineEnd,
    tier: 2,
    category: "correctness",
    kind: "assertion",
    claim: id,
    explanation: "",
    suggestedAction: "",
    sources: [],
    confidence: 0.9,
  }) as unknown as Comment;

const comments: Comment[] = [
  mk("keep-on-hunk", "src/a.ts", 11, 11),
  mk("keep-context-into-hunk", "src/a.ts", 9, 10),
  mk("drop-off-hunk", "src/a.ts", 9, 9),
  mk("drop-other-file", "src/c.ts", 1, 1),
  mk("keep-b", "src/b.ts", 5, 5),
];

const { kept, dropped } = dropUnanchoredComments(comments, map);
const keptIds = kept.map((c) => c.id).sort();
const expectedKept = ["keep-b", "keep-context-into-hunk", "keep-on-hunk"];
if (dropped !== 2) fail(`expected 2 drops, got ${dropped}`);
if (JSON.stringify(keptIds) !== JSON.stringify(expectedKept)) {
  fail(`kept ids wrong: ${keptIds.join(",")} (want ${expectedKept.join(",")})`);
}

process.stdout.write(
  "[smoke:reasoned-anchoring] PASS — anchoring map + predicate + partition behave\n",
);
