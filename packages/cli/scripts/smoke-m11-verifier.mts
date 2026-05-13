/**
 * Smoke harness for M11's verifier extension for `api_def` sources
 * (ADR-0026 §14 + verify-citations.ts).
 *
 *   1. Single-line api_def signature matching a real `.d.ts` line → survives.
 *   2. Multi-line signature (collapsed-to-single-line snippet) within
 *      `API_DEF_DRIFT = 30` of `line_start` → survives (regression guard
 *      for the concat-and-match path).
 *   3. Bogus api_def signature not present anywhere in the cited file →
 *      dropped + counted in the forensic info entry.
 *   4. Comment whose only source is a dropped api_def → whole Comment
 *      drops (M10 drop semantics preserved).
 *
 * Usage: pnpm --filter @warden/cli smoke:m11-verifier
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const TMP_ROOT = resolve(tmpdir(), `warden-m11-verifier-${process.pid}-${Date.now()}`);

if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });
mkdirSync(resolve(TMP_ROOT, "node_modules", "fake-pkg"), { recursive: true });

// Fixture .d.ts. The first declaration is single-line; the second spans
// multiple lines (generics + multi-line params) — the snippet for case (2)
// is its whitespace-collapsed form.
const DTS_REL = "node_modules/fake-pkg/index.d.ts";
const DTS_ABS = resolve(TMP_ROOT, DTS_REL);
const DTS_CONTENT = [
  "// header",
  "export declare function singleLineSig(x: number): boolean;",
  "",
  "export declare function multilineSig<",
  "  T extends { id: string },",
  "  U = T",
  ">(",
  "  first: T,",
  "  second: U,",
  "): Promise<T & U>;",
  "",
  "// trailer",
  "",
].join("\n");
writeFileSync(DTS_ABS, DTS_CONTENT);

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

// Case 1: single-line signature pointing at line 2 of DTS_CONTENT.
const commentSingle: Comment = {
  id: "W-single0001",
  file: "src/x.ts",
  lineStart: 1,
  lineEnd: 1,
  tier: 2,
  category: "correctness",
  kind: "assertion",
  claim: "fake-pkg exposes singleLineSig",
  explanation: "",
  sources: [
    {
      type: "api_def",
      id: "fake-pkg@0.0.0#singleLineSig",
      title: "function singleLineSig",
      retrievedAt: now,
      path: DTS_REL,
      line: 2,
      snippet: "export declare function singleLineSig(x: number): boolean;",
    },
  ],
  confidence: 0.9,
};

// Case 2: multi-line signature. The `.d.ts` has it on lines 4-10 (1-indexed:
// `export declare function multilineSig<` is line 4, closing `): Promise<...>;`
// is line 10). We cite line 4 (line_start) and supply the whitespace-
// collapsed single-line signature as the snippet, matching the resolver's
// behavior.
const multilineSnippet =
  "export declare function multilineSig< T extends { id: string }, U = T >( first: T, second: U, ): Promise<T & U>;";
const commentMulti: Comment = {
  id: "W-multi0002",
  file: "src/y.ts",
  lineStart: 1,
  lineEnd: 1,
  tier: 2,
  category: "correctness",
  kind: "assertion",
  claim: "fake-pkg exposes multilineSig",
  explanation: "",
  sources: [
    {
      type: "api_def",
      id: "fake-pkg@0.0.0#multilineSig",
      title: "function multilineSig",
      retrievedAt: now,
      path: DTS_REL,
      line: 4,
      snippet: multilineSnippet,
    },
  ],
  confidence: 0.9,
};

// Case 3+4: bogus api_def. The Comment has ONE source (the bogus api_def),
// so when it drops, the whole Comment drops.
const commentBogus: Comment = {
  id: "W-bogus0003",
  file: "src/z.ts",
  lineStart: 1,
  lineEnd: 1,
  tier: 2,
  category: "correctness",
  kind: "assertion",
  claim: "fake-pkg has a method that does not exist",
  explanation: "",
  sources: [
    {
      type: "api_def",
      id: "fake-pkg@0.0.0#hallucinatedMethod",
      title: "function hallucinatedMethod",
      retrievedAt: now,
      path: DTS_REL,
      line: 2,
      snippet: "export declare function hallucinatedMethod(secret: string): never;",
    },
  ],
  confidence: 0.9,
};

process.stdout.write(`\n[1] api_def verifier — mixed Comment[]\n`);

const result = await verifyCitations({
  comments: [commentSingle, commentMulti, commentBogus],
  repoRoot: TMP_ROOT,
});

const sawSingle = result.comments.find((c) => c.id === commentSingle.id);
const sawMulti = result.comments.find((c) => c.id === commentMulti.id);
const sawBogus = result.comments.find((c) => c.id === commentBogus.id);

assert(sawSingle !== undefined, "single-line api_def Comment survives");
assert(
  sawSingle?.sources[0]?.snippet === commentSingle.sources[0]!.snippet,
  "single-line source kept intact",
);
assert(sawMulti !== undefined, "multi-line api_def Comment survives the concat-match path");
assert(
  sawMulti?.sources[0]?.snippet === multilineSnippet,
  "multi-line source kept intact",
);
assert(sawBogus === undefined, "bogus-only api_def Comment dropped entirely (M10 drop semantics)");

const infoEntries = result.degraded.filter((d) => d.kind === "info" && d.topic === "llm");
assert(
  infoEntries.some((e) => /dropped 1 citation/.test(e.message)),
  "one info entry reports the dropped api_def citation count",
);
assert(
  infoEntries.some((e) => /dropped 1 comment/.test(e.message)),
  "one info entry reports the dropped Comment count",
);

// Cleanup.
if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });

if (failed > 0) {
  process.stdout.write(`\n${failed} assertion(s) failed\n`);
  process.exit(1);
}
process.stdout.write(`\nall assertions passed\n`);
