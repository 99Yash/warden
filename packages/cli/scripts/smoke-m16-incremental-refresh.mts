/**
 * M16 smoke 3/4 — incremental-refresh budget paths (ADR-0032).
 *
 *  1. Generous budget: stale file refreshes; no actionable degraded entry.
 *  2. Tiny budget: per-file estimate exceeds remaining budget → file is
 *     skipped, no provider call made for it, exactly one actionable
 *     degraded entry surfaces with the "refresh capped" wording the user
 *     sees in `warden review`.
 *  3. Subsequent within-budget files DO still refresh — over-budget skip
 *     is per-file, not a hard stop.
 *  4. `WARDEN_REVIEW_REFRESH_MAX_USD=0` is parsed correctly by wardenEnv()
 *     so det-priors' opt-out check works.
 *
 * Uses a stub Chunker + stub EmbeddingProvider so the smoke runs without
 * Voyage credentials.
 */

import { createHash } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const TMP_DB = resolve(tmpdir(), `warden-m16-refresh-${process.pid}.sqlite`);
process.env["WARDEN_CACHE_PATH"] = TMP_DB;
if (existsSync(TMP_DB)) unlinkSync(TMP_DB);

const {
  SqliteChunkStore,
  SqliteEmbeddingStore,
  SqliteFileChunksStore,
  SqliteMerkleStore,
  reconcileFiles,
} = await import("@warden/core");

let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) process.stdout.write(`  ✓ ${msg}\n`);
  else {
    process.stdout.write(`  ✗ ${msg}\n`);
    failed++;
  }
}

function sha(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

let providerCallCount = 0;
const stubProvider = {
  modelId: () => "voyage-code-3",
  modelVersion: () => "dim=4;type=document",
  maxBatchSize: () => 16,
  maxInputTokens: () => 1024,
  async embed(req: { inputs: string[] }) {
    providerCallCount++;
    return {
      vectors: req.inputs.map(() => new Float32Array([0, 1, 0, 1])),
      modelId: "voyage-code-3",
      modelVersion: "dim=4;type=document",
      promptTokens: 100,
    };
  },
};

// Synthesize many "lines" so the estimate is non-trivial.
function bigFile(path: string, lineCount: number) {
  const content = Array.from(
    { length: lineCount },
    (_, i) => `line_${path}_${i}_${path}`,
  ).join("\n");
  return {
    path,
    content,
    fileSha: sha(content),
    loc: lineCount,
  };
}

const stubChunker = {
  supportedLanguages: () => ["typescript"] as const,
  detectLanguage: () => "typescript" as const,
  async chunk(filePath: string, fileContent: string, fileSha: string) {
    const lines = fileContent.split("\n").filter((l) => l.length > 0);
    return lines.map((line, i) => ({
      chunkHash: sha(`${filePath}:${line}`),
      filePath,
      fileSha,
      language: "typescript" as const,
      symbolPath: [] as string[],
      startLine: i + 1,
      endLine: i + 1,
      content: line,
    }));
  },
};

const chunkStore = new SqliteChunkStore();
const embeddingStore = new SqliteEmbeddingStore();
const fileChunksStore = new SqliteFileChunksStore();
const merkleStore = new SqliteMerkleStore();

process.stdout.write(`\n[1] generous budget → refresh proceeds\n`);
providerCallCount = 0;
const file1 = bigFile("src/big1.ts", 30);
const r1 = await reconcileFiles({
  files: [file1],
  removed: [],
  repoRoot: ".",
  chunker: stubChunker,
  chunkStore,
  embeddingStore,
  merkleStore,
  fileChunksStore,
  provider: stubProvider,
  lockedModelId: "voyage-code-3",
  lockedModelVersion: "dim=4;type=document",
  maxUsdBudget: 10,
});
assert(r1.refreshed.length === 1, "generous budget: file refreshed");
assert(r1.skippedOverBudget.length === 0, "generous budget: nothing skipped");
assert(
  !r1.degraded.some((d) => d.message.includes("refresh capped")),
  "generous budget: no `refresh capped` degraded entry",
);
assert(providerCallCount > 0, "generous budget: provider was called");

process.stdout.write(`\n[2] tiny budget → file skipped + actionable surfaced\n`);
providerCallCount = 0;
const file2 = bigFile("src/big2.ts", 500);
const r2 = await reconcileFiles({
  files: [file2],
  removed: [],
  repoRoot: ".",
  chunker: stubChunker,
  chunkStore,
  embeddingStore,
  merkleStore,
  fileChunksStore,
  provider: stubProvider,
  lockedModelId: "voyage-code-3",
  lockedModelVersion: "dim=4;type=document",
  maxUsdBudget: 0.0000001, // far below any per-file estimate
});
assert(r2.refreshed.length === 0, "tiny budget: nothing refreshed");
assert(
  r2.skippedOverBudget.length === 1 && r2.skippedOverBudget[0] === "src/big2.ts",
  "tiny budget: file recorded as skippedOverBudget",
);
assert(providerCallCount === 0, "tiny budget: provider NOT called");
const cappedEntries = r2.degraded.filter((d) =>
  d.message.includes("refresh capped"),
);
assert(
  cappedEntries.length === 1 && cappedEntries[0]?.kind === "actionable",
  "tiny budget: exactly one actionable `refresh capped` degraded entry",
);
assert(
  cappedEntries[0]?.message.includes("warden init"),
  "actionable message points user at `warden init` for full refresh",
);

process.stdout.write(`\n[3] mixed budget: cheap file fits, expensive skipped\n`);
providerCallCount = 0;
const tinyFile = bigFile("src/tiny.ts", 1);
const hugeFile = bigFile("src/huge.ts", 5000);
const r3 = await reconcileFiles({
  files: [tinyFile, hugeFile],
  removed: [],
  repoRoot: ".",
  chunker: stubChunker,
  chunkStore,
  embeddingStore,
  merkleStore,
  fileChunksStore,
  provider: stubProvider,
  lockedModelId: "voyage-code-3",
  lockedModelVersion: "dim=4;type=document",
  // Enough to fit one tiny chunk (~$0.0000675) but not 5000 chunks.
  maxUsdBudget: 0.0001,
});
assert(
  r3.refreshed.includes("src/tiny.ts"),
  "mixed budget: tiny file did refresh",
);
assert(
  r3.skippedOverBudget.includes("src/huge.ts"),
  "mixed budget: huge file skipped",
);
assert(providerCallCount > 0, "mixed budget: provider called for tiny file only");

process.stdout.write(`\n[4] WARDEN_REVIEW_REFRESH_MAX_USD parses correctly\n`);
// wardenEnv() asserts presence of ANTHROPIC_API_KEY — stub it for the
// purpose of parsing the new M16 knob only.
const prevAnthropic = process.env["ANTHROPIC_API_KEY"];
const prevRefreshKnob = process.env["WARDEN_REVIEW_REFRESH_MAX_USD"];
if (!prevAnthropic) process.env["ANTHROPIC_API_KEY"] = "sk-stub";
process.env["WARDEN_REVIEW_REFRESH_MAX_USD"] = "0";
const { wardenEnv: zeroEnv } = await import("@warden/env");
assert(
  zeroEnv().WARDEN_REVIEW_REFRESH_MAX_USD === 0,
  "WARDEN_REVIEW_REFRESH_MAX_USD=0 parses to 0",
);
if (!prevAnthropic) delete process.env["ANTHROPIC_API_KEY"];
if (prevRefreshKnob === undefined) delete process.env["WARDEN_REVIEW_REFRESH_MAX_USD"];
else process.env["WARDEN_REVIEW_REFRESH_MAX_USD"] = prevRefreshKnob;

if (existsSync(TMP_DB)) unlinkSync(TMP_DB);

if (failed > 0) {
  process.stdout.write(`\n${failed} assertion(s) failed\n`);
  process.exit(1);
}
process.stdout.write(`\nall assertions passed\n`);
