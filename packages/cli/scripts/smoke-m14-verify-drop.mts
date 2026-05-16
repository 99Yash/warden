/**
 * Smoke for the M14 review-harness's Phase 3 (citation verify). No LLM
 * call — hands `verifyCitations()` a synthetic `Comment[]` whose only
 * snippet source carries a snippet that does NOT substring-match the
 * cited file. Asserts:
 *
 *   1. The bad source is dropped.
 *   2. Because that was the comment's only triple-bearing source, the
 *      entire Comment is dropped.
 *   3. Two `info` degraded entries surface (one for the dropped citation
 *      count, one for the dropped comment count), both with topic="llm".
 *   4. A control comment with a snippet that DOES match the file passes
 *      through untouched.
 *
 * This smoke covers what the per-worker smokes can't: the verifier
 * post-pass is the only thing standing between a hallucinated citation
 * and shipped output. Per the user-grilled M14 plan, getting a real
 * worker to fabricate a source on demand isn't reproducible, so the
 * verifier gets exercised against synthetic input instead.
 *
 * Usage:
 *   pnpm --filter @warden/cli smoke:m14-verify-drop
 */

import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const TMP_ROOT = resolve(tmpdir(), `warden-m14-verify-drop-${process.pid}`);
const TMP_DB = resolve(tmpdir(), `warden-m14-verify-drop-${process.pid}.sqlite`);
process.env["WARDEN_CACHE_PATH"] = TMP_DB;

if (existsSync(TMP_DB)) unlinkSync(TMP_DB);
if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });
mkdirSync(resolve(TMP_ROOT, "src"), { recursive: true });

const FIXTURE_PATH = "src/handler.ts";
const FIXTURE_CONTENT = [
  `export function handler(req: { body: { id: string } }) {`,
  `  const id = req.body.id;`,
  `  return { id, ts: Date.now() };`,
  `}`,
  ``,
].join("\n");
writeFileSync(resolve(TMP_ROOT, FIXTURE_PATH), FIXTURE_CONTENT);

const { verifyCitations } = await import("@warden/core");
type Comment = Awaited<ReturnType<typeof verifyCitations>>["comments"][number];

let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) {
    process.stdout.write(`  ✓ ${msg}\n`);
  } else {
    process.stdout.write(`  ✗ ${msg}\n`);
    failed++;
  }
}

const nowIso = new Date().toISOString();

// ---------------------------------------------------------------------------
// 1. Bad-snippet Comment: cited line is real, snippet text isn't present.
// ---------------------------------------------------------------------------

const badComment: Comment = {
  id: "synthetic-bad-1",
  file: FIXTURE_PATH,
  lineStart: 2,
  lineEnd: 2,
  tier: 2,
  category: "correctness",
  kind: "assertion",
  claim: "Possible null-deref on req.body.id when callers omit body",
  explanation: "Synthetic assertion for the smoke.",
  sources: [
    {
      type: "tool",
      id: "synthetic",
      title: "synthetic",
      retrievedAt: nowIso,
      path: FIXTURE_PATH,
      line: 2,
      // Real line 2 is `const id = req.body.id;` — this snippet is fabricated.
      snippet: "const id = req.body.payload.id; // fabricated",
    },
  ],
  confidence: 0.85,
};

// ---------------------------------------------------------------------------
// 2. Control Comment: snippet really is on the cited line.
// ---------------------------------------------------------------------------

const goodComment: Comment = {
  id: "synthetic-good-1",
  file: FIXTURE_PATH,
  lineStart: 3,
  lineEnd: 3,
  tier: 3,
  category: "clarity",
  kind: "question",
  claim: "Why include `ts` in the response shape?",
  explanation: "Synthetic question for the smoke.",
  sources: [
    {
      type: "tool",
      id: "synthetic",
      title: "synthetic",
      retrievedAt: nowIso,
      path: FIXTURE_PATH,
      line: 3,
      // Real line 3 — substring-match must succeed.
      snippet: "return { id, ts: Date.now() };",
    },
  ],
  confidence: 0.9,
};

// ---------------------------------------------------------------------------
// Run the verifier.
// ---------------------------------------------------------------------------

process.stdout.write(`\n[1] verify-citations drops bad source + bad comment\n`);
const result = await verifyCitations({
  comments: [badComment, goodComment],
  repoRoot: TMP_ROOT,
});

assert(result.comments.length === 1, `1 comment survives (got ${result.comments.length})`);
assert(
  result.comments[0]?.id === goodComment.id,
  `survivor is the good comment (got ${result.comments[0]?.id})`,
);
assert(
  result.comments[0]?.sources.length === 1,
  `survivor's good source is intact (got ${result.comments[0]?.sources.length})`,
);

const llmDegraded = result.degraded.filter((d) => d.topic === "llm");
assert(
  llmDegraded.length === 2,
  `two llm-topic degraded entries surface (got ${llmDegraded.length})`,
);
assert(
  llmDegraded.some((d) => d.message.includes("dropped 1 citation")),
  `one entry counts the dropped citation`,
);
assert(
  llmDegraded.some((d) => d.message.includes("dropped 1 comment")),
  `one entry counts the dropped comment`,
);
assert(
  llmDegraded.every((d) => d.kind === "info"),
  `degraded kind is info (not actionable/warning)`,
);

// ---------------------------------------------------------------------------
// 3. Belt-and-suspenders: a snippet-less Comment passes through untouched.
// ---------------------------------------------------------------------------

process.stdout.write(`\n[2] snippet-less comment bypasses verifier\n`);
const snipless: Comment = {
  id: "synthetic-snipless-1",
  file: FIXTURE_PATH,
  lineStart: 1,
  lineEnd: 1,
  tier: 1,
  category: "vulnerability",
  kind: "assertion",
  claim: "Synthetic snippet-less assertion",
  explanation: "Has only non-triple sources; nothing for verifier to check.",
  sources: [
    {
      type: "tool",
      id: "audit",
      title: "npm audit",
      retrievedAt: nowIso,
      // No path/line/snippet triple.
    },
  ],
  confidence: 1,
};
const result2 = await verifyCitations({ comments: [snipless], repoRoot: TMP_ROOT });
assert(result2.comments.length === 1, `snippet-less comment passes through`);
assert(
  result2.degraded.filter((d) => d.topic === "llm").length === 0,
  `no verifier degraded entries fire`,
);

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
