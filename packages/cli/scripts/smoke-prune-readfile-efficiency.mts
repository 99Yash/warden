/**
 * Smoke harness for the file-reading-efficiency work (issue #34 + readFile
 * pagination). Two behaviors that protect the review context window:
 *
 *  [1] Loud large-file prune drops — a generated file pruned by extension is
 *      silent when small but emits one `info` noise-filter entry when its
 *      changed-line count exceeds the threshold, so a future 6.6k-line
 *      `_snapshot.json` can never silently drive cost up the way it did once.
 *
 *  [2] `readFile` windowed pagination — a large file can be walked in
 *      fixed-size windows via `offset`/`nextOffset`, instead of only ever
 *      returning its head. Lines past 1000 used to be unreachable.
 *
 * Usage:
 *   pnpm --filter @warden/cli smoke:prune-readfile-efficiency
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { pruneDiff } = await import("@warden/core");
const { makeReadFileTool } = await import("@warden/core/review-harness/tools/read-file");
import type { ReadFileResult } from "@warden/core/review-harness/tools/read-file";

let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) {
    process.stdout.write(`  ✓ ${msg}\n`);
  } else {
    process.stdout.write(`  ✗ ${msg}\n`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
process.stdout.write(`\n[1] pruneDiff — loud about large generated drops, quiet about small\n`);

const bigGenerated = {
  path: "migrations/meta/0044_snapshot.json",
  addedLines: Array.from({ length: 6618 }, (_, i) => i + 1),
};
const smallGenerated = { path: "vendor/lib.min.js", addedLines: [1, 2, 3] };
const realCode = { path: "src/foo.ts", addedLines: [10, 11] };

const pruneRes = pruneDiff([bigGenerated, smallGenerated, realCode]);

assert(
  pruneRes.pruned.length === 1 && pruneRes.pruned[0]?.path === "src/foo.ts",
  `only hand-authored source survives the prune (got ${pruneRes.pruned.map((f) => f.path).join(", ")})`,
);

const noiseEntries = pruneRes.degraded.filter((d) => d.topic === "noise-filter");
assert(
  noiseEntries.length === 1,
  `exactly one noise-filter entry — the large file, not the small one (got ${noiseEntries.length})`,
);
const entry = noiseEntries[0];
assert(entry?.kind === "info", `large-drop entry is kind=info (got ${entry?.kind})`);
assert(
  entry?.message.includes("6618-line") && entry.message.includes("0044_snapshot.json"),
  `entry names the line count and path (got "${entry?.message}")`,
);
assert(
  !pruneRes.degraded.some((d) => d.message.includes("lib.min.js")),
  `the 3-line generated file is dropped silently (no entry naming it)`,
);

// ---------------------------------------------------------------------------
process.stdout.write(`\n[2] readFile — windowed pagination over a 2500-line file\n`);

const dir = mkdtempSync(join(tmpdir(), "warden-readfile-"));
const body = Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join("\n");
writeFileSync(join(dir, "big.log"), body);
const readFile = makeReadFileTool({ repoRoot: dir });

// The AI SDK `tool().execute` is optional, takes a 2nd options arg, and
// returns `RESULT | AsyncIterable<RESULT>`. This tool always returns a single
// `ReadFileResult` — narrow it once here so the assertions stay readable.
async function read(args: { path: string; offset?: number; limit?: number }): Promise<ReadFileResult> {
  const exec = readFile.execute;
  if (!exec) throw new Error("readFile tool has no execute");
  return (await exec(args, { toolCallId: "smoke", messages: [] })) as ReadFileResult;
}

const w1 = await read({ path: "big.log" });
assert(
  w1.ok && w1.startLine === 1 && w1.endLine === 1000 && w1.truncated && w1.nextOffset === 1001,
  `window 1 is lines 1–1000, truncated, nextOffset 1001`,
);

const w2 = await read({ path: "big.log", offset: w1.ok ? w1.nextOffset : undefined });
assert(
  w2.ok && w2.startLine === 1001 && w2.content.split("\n")[0] === "line 1001",
  `window 2 continues at line 1001 — the previously-unreachable region`,
);

const w3 = await read({ path: "big.log", offset: w2.ok ? w2.nextOffset : undefined });
assert(
  w3.ok && w3.startLine === 2001 && w3.endLine === 2500 && !w3.truncated,
  `final window is lines 2001–2500, not truncated`,
);

const windowed = await read({ path: "big.log", offset: 5, limit: 3 });
assert(
  windowed.ok &&
    windowed.startLine === 5 &&
    windowed.endLine === 7 &&
    windowed.lineCount === 3 &&
    windowed.truncated,
  `custom limit returns exactly the requested 3-line window`,
);

const pastEof = await read({ path: "big.log", offset: 9999 });
assert(
  pastEof.ok && pastEof.lineCount === 0 && !pastEof.truncated,
  `offset past EOF returns empty without error or false truncation`,
);

if (failed > 0) {
  process.stdout.write(`\n${failed} assertion(s) failed\n`);
  process.exit(1);
}
process.stdout.write(`\nall assertions passed\n`);
