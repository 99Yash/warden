/**
 * M16 smoke 1/4 — file_chunks junction round-trip (ADR-0032).
 *
 *  1. Schema migration applies cleanly to a fresh cache (file_chunks table
 *     exists; both indexes present).
 *  2. SqliteFileChunksStore exercises all six methods:
 *     replaceForFile + getHashesForFile + getFilesForHashes + count
 *     + deleteForFile + pruneOrphans.
 *  3. backfillFromChunksIfNeeded() is idempotent — first call when chunks
 *     are empty records the marker; second call returns 0 without writing.
 *
 * Usage:
 *   node --import tsx/esm packages/cli/scripts/smoke-m16-junction.mts
 */

import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const TMP_DB = resolve(tmpdir(), `warden-m16-junction-${process.pid}.sqlite`);
process.env["WARDEN_CACHE_PATH"] = TMP_DB;
if (existsSync(TMP_DB)) unlinkSync(TMP_DB);

const { db, fileChunks, indexMeta, chunks, sql } = await import("@warden/db");
const { SqliteFileChunksStore } = await import("@warden/core");

let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) process.stdout.write(`  ✓ ${msg}\n`);
  else {
    process.stdout.write(`  ✗ ${msg}\n`);
    failed++;
  }
}

process.stdout.write(`\n[1] schema migration\n`);
// Force migration by exercising any table.
db().select().from(fileChunks).all();
const tableRow = db()
  .run(sql`SELECT name FROM sqlite_master WHERE type='table' AND name='file_chunks'`);
assert(tableRow !== undefined, "file_chunks table created on first db()");
const pathIdx = db()
  .run(sql`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_fc_path'`);
assert(pathIdx !== undefined, "idx_fc_path index present");
const hashIdx = db()
  .run(sql`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_fc_hash'`);
assert(hashIdx !== undefined, "idx_fc_hash index present");

process.stdout.write(`\n[2] store round-trip\n`);
const store = new SqliteFileChunksStore();
await store.replaceForFile("src/a.ts", "sha-a", ["h1", "h2", "h3"]);
await store.replaceForFile("src/b.ts", "sha-b", ["h2", "h4"]); // h2 shared
assert((await store.count()) === 5, "count = 5 across both files");
assert((await store.getHashesForFile("src/a.ts")).length === 3, "a.ts has 3 hashes");
assert((await store.getHashesForFile("src/b.ts")).length === 2, "b.ts has 2 hashes");

const attribs = await store.getFilesForHashes(["h1", "h2", "h99"]);
assert(attribs.get("h1")?.length === 1 && attribs.get("h1")?.[0] === "src/a.ts", "h1 → a.ts only");
assert(
  attribs.get("h2")?.sort().join(",") === ["src/a.ts", "src/b.ts"].sort().join(","),
  "h2 → both files",
);
assert(!attribs.has("h99"), "missing hash absent from result map");

// Replace overwrites: shrink a.ts to ["h1"], orphans h2 and h3.
await store.replaceForFile("src/a.ts", "sha-a2", ["h1"]);
assert((await store.getHashesForFile("src/a.ts")).length === 1, "a.ts shrunk to 1 hash");
assert((await store.count()) === 3, "count drops from 5 → 3 after replace");

// Stage matching chunks so pruneOrphans has something to drop.
db()
  .insert(chunks)
  .values([
    {
      chunkHash: "h1",
      filePath: "src/a.ts",
      fileSha: "sha-a2",
      language: "typescript",
      symbolPathJson: "[]",
      startLine: 1,
      endLine: 1,
      content: "// h1",
      createdAt: new Date(),
    },
    {
      chunkHash: "h2",
      filePath: "src/b.ts",
      fileSha: "sha-b",
      language: "typescript",
      symbolPathJson: "[]",
      startLine: 1,
      endLine: 1,
      content: "// h2",
      createdAt: new Date(),
    },
    {
      chunkHash: "h3",
      filePath: "orphaned",
      fileSha: "x",
      language: "typescript",
      symbolPathJson: "[]",
      startLine: 1,
      endLine: 1,
      content: "// h3",
      createdAt: new Date(),
    },
  ])
  .onConflictDoNothing()
  .run();
const pruneRes = await store.pruneOrphans();
assert(pruneRes.chunksPruned === 1, `pruneOrphans dropped 1 orphan chunk (got ${pruneRes.chunksPruned})`);

await store.deleteForFile("src/b.ts");
assert((await store.getHashesForFile("src/b.ts")).length === 0, "b.ts cleared after deleteForFile");

process.stdout.write(`\n[3] backfill idempotency\n`);
const initialCount = await store.count();
const r1 = await store.backfillFromChunksIfNeeded();
assert(r1 === 0, `backfill returns 0 when junction already populated (got ${r1})`);
const marker1 = db()
  .select({ k: indexMeta.key })
  .from(indexMeta)
  .where(sql`${indexMeta.key} = 'file_chunks_backfilled_at'`)
  .get();
assert(marker1 !== undefined, "backfill marker recorded in index_meta");
const r2 = await store.backfillFromChunksIfNeeded();
assert(r2 === 0, "second backfill call is a no-op");
assert((await store.count()) === initialCount, "store row count unchanged after second backfill");

if (existsSync(TMP_DB)) unlinkSync(TMP_DB);

if (failed > 0) {
  process.stdout.write(`\n${failed} assertion(s) failed\n`);
  process.exit(1);
}
process.stdout.write(`\nall assertions passed\n`);
