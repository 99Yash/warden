/**
 * M16 smoke 4/4 — one-shot pre-M16 → M16 backfill (ADR-0032).
 *
 *  1. Populate `chunks` directly (simulating a pre-M16 index) — leave
 *     `file_chunks` empty + leave the backfill marker unset.
 *  2. First call to backfillFromChunksIfNeeded() runs the migration
 *     query, inserts rows into file_chunks, sets the marker.
 *  3. Second call short-circuits — returns 0, no DB writes.
 *  4. Backfilled rows reflect chunks.file_path (first-writer-wins, the
 *     known approximation). The smoke confirms the row count matches,
 *     not the per-row attribution truth — that's expected per the
 *     "approximate by design" plan note.
 *  5. Subsequent reconcileFiles() for a file overwrites the approximate
 *     junction rows with the authoritative set.
 */

import { createHash } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const TMP_DB = resolve(tmpdir(), `warden-m16-backfill-${process.pid}.sqlite`);
process.env["WARDEN_CACHE_PATH"] = TMP_DB;
if (existsSync(TMP_DB)) unlinkSync(TMP_DB);

const { db, chunks, fileChunks, indexMeta, sql } = await import("@warden/db");
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

// Pre-populate chunks directly so file_chunks is empty + the marker is
// unset — that's the pre-M16 index state.
process.stdout.write(`\n[1] pre-M16 index state\n`);
db()
  .insert(chunks)
  .values([
    {
      chunkHash: "h1",
      filePath: "src/a.ts",
      fileSha: "sha-a",
      language: "typescript",
      symbolPathJson: "[]",
      startLine: 1,
      endLine: 1,
      content: "// chunk 1",
      createdAt: new Date(),
    },
    {
      chunkHash: "h2",
      filePath: "src/a.ts",
      fileSha: "sha-a",
      language: "typescript",
      symbolPathJson: "[]",
      startLine: 2,
      endLine: 2,
      content: "// chunk 2",
      createdAt: new Date(),
    },
    {
      chunkHash: "h3",
      filePath: "src/b.ts",
      fileSha: "sha-b",
      language: "typescript",
      symbolPathJson: "[]",
      startLine: 1,
      endLine: 1,
      content: "// chunk 3",
      createdAt: new Date(),
    },
  ])
  .run();
const initialFileChunksCount =
  db()
    .select({ c: sql<number>`count(*)` })
    .from(fileChunks)
    .get()?.c ?? 0;
assert(initialFileChunksCount === 0, "file_chunks starts empty");
const initialMarker = db()
  .select({ k: indexMeta.key })
  .from(indexMeta)
  .where(sql`${indexMeta.key} = 'file_chunks_backfilled_at'`)
  .get();
assert(!initialMarker, "backfill marker absent on fresh pre-M16 index");

process.stdout.write(`\n[2] first invocation triggers backfill\n`);
const store = new SqliteFileChunksStore();
const inserted = await store.backfillFromChunksIfNeeded();
assert(inserted === 3, `backfill inserted 3 rows (got ${inserted})`);
assert((await store.count()) === 3, "file_chunks now has 3 rows");
const aHashes = await store.getHashesForFile("src/a.ts");
assert(aHashes.length === 2, `a.ts backfilled with 2 chunks (got ${aHashes.length})`);
const bHashes = await store.getHashesForFile("src/b.ts");
assert(bHashes.length === 1, `b.ts backfilled with 1 chunk (got ${bHashes.length})`);
const postMarker = db()
  .select({ k: indexMeta.key, v: indexMeta.value })
  .from(indexMeta)
  .where(sql`${indexMeta.key} = 'file_chunks_backfilled_at'`)
  .get();
assert(postMarker !== undefined, "backfill marker recorded after migration");

process.stdout.write(`\n[3] second invocation is a no-op\n`);
const second = await store.backfillFromChunksIfNeeded();
assert(second === 0, `second backfill returned 0 (got ${second})`);
assert((await store.count()) === 3, "file_chunks row count unchanged");

process.stdout.write(`\n[4] subsequent reconcile overwrites approximations\n`);
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
const stubProvider = {
  modelId: () => "voyage-code-3",
  modelVersion: () => "dim=4;type=document",
  maxBatchSize: () => 16,
  maxInputTokens: () => 1024,
  async embed(req: { inputs: string[] }) {
    return {
      vectors: req.inputs.map(() => new Float32Array([0, 1, 0, 1])),
      modelId: "voyage-code-3",
      modelVersion: "dim=4;type=document",
      promptTokens: 0,
    };
  },
};

const content = "edited line one\nedited line two";
const file = {
  path: "src/a.ts",
  content,
  fileSha: sha(content),
  loc: 2,
};
await reconcileFiles({
  files: [file],
  removed: [],
  repoRoot: ".",
  chunker: stubChunker,
  chunkStore: new SqliteChunkStore(),
  embeddingStore: new SqliteEmbeddingStore(),
  merkleStore: new SqliteMerkleStore(),
  fileChunksStore: store,
  provider: stubProvider,
  lockedModelId: "voyage-code-3",
  lockedModelVersion: "dim=4;type=document",
});
const aHashesAfter = (await store.getHashesForFile("src/a.ts")).sort();
const expected = [sha("src/a.ts:edited line one"), sha("src/a.ts:edited line two")].sort();
assert(
  aHashesAfter.length === 2 && aHashesAfter[0] === expected[0] && aHashesAfter[1] === expected[1],
  "post-reconcile junction holds the new chunk hashes, not the backfilled approximations",
);

if (existsSync(TMP_DB)) unlinkSync(TMP_DB);

if (failed > 0) {
  process.stdout.write(`\n${failed} assertion(s) failed\n`);
  process.exit(1);
}
process.stdout.write(`\nall assertions passed\n`);
