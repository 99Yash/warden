/**
 * M16 smoke 2/4 — reconcileFiles() round-trip (ADR-0032).
 *
 *  1. Create three files → reconcile with the full set → assert file_chunks
 *     rows exist for each file and orphan-prune is a no-op.
 *  2. Edit file 1 → reconcile with only the changed file → assert the old
 *     chunks of file 1 are removed from file_chunks AND from chunks
 *     (reference-counted prune drops the orphan).
 *  3. Delete file 2 → reconcile with `removed: [file2]` → assert file 2's
 *     junction rows are gone AND file 2's merkle leaf is gone.
 *  4. The atomic commit keeps merkle in sync (reconcile updates the leaf
 *     even though the smoke never calls upsertNodes()).
 *
 * Uses a stub Chunker + stub EmbeddingProvider so the smoke runs without
 * Voyage credentials.
 */

import { createHash } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const TMP_DB = resolve(tmpdir(), `warden-m16-reconcile-${process.pid}.sqlite`);
process.env["WARDEN_CACHE_PATH"] = TMP_DB;
if (existsSync(TMP_DB)) unlinkSync(TMP_DB);

const { db, chunks, embeddings, merkle, sql } = await import("@warden/db");
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

// Stub chunker: one chunk per line. Lets the smoke control chunk identity
// directly via the source text without depending on tree-sitter.
const stubChunker = {
  supportedLanguages: () => ["typescript"] as const,
  detectLanguage: (_path: string) => "typescript" as const,
  async chunk(filePath: string, fileContent: string, fileSha: string) {
    const lines = fileContent.split("\n").filter((l) => l.length > 0);
    return lines.map((line, i) => ({
      chunkHash: sha(`${line}`),
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

// Stub provider: returns deterministic vectors and zero cost.
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

const chunkStore = new SqliteChunkStore();
const embeddingStore = new SqliteEmbeddingStore();
const fileChunksStore = new SqliteFileChunksStore();
const merkleStore = new SqliteMerkleStore();

function fileEntry(path: string, content: string) {
  return { path, content, fileSha: sha(content), loc: content.split("\n").length };
}

process.stdout.write(`\n[1] initial reconcile (3 files)\n`);
const fileA = fileEntry("src/a.ts", "alpha\nbravo\ncharlie");
const fileB = fileEntry("src/b.ts", "delta\necho");
const fileC = fileEntry("src/c.ts", "foxtrot");

const r1 = await reconcileFiles({
  files: [fileA, fileB, fileC],
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
});
assert(r1.refreshed.length === 3, `refreshed all 3 files (got ${r1.refreshed.length})`);
assert(r1.chunksSeen === 6, `chunksSeen = 6 (got ${r1.chunksSeen})`);
assert(r1.newlyEmbedded === 6, `newlyEmbedded = 6 (got ${r1.newlyEmbedded})`);
assert(r1.chunksPruned === 0, `no orphan chunks after initial reconcile (got ${r1.chunksPruned})`);
assert(
  (await fileChunksStore.getHashesForFile("src/a.ts")).length === 3,
  "a.ts has 3 junction rows",
);
assert(
  (await fileChunksStore.getHashesForFile("src/c.ts")).length === 1,
  "c.ts has 1 junction row",
);
assert((await merkleStore.getAllFileHashes()).size === 3, "merkle has 3 leaves");

process.stdout.write(`\n[2] edit file 1 → reconcile drops stale chunks\n`);
const oldAHashes = await fileChunksStore.getHashesForFile("src/a.ts");
const fileAEdited = fileEntry("src/a.ts", "alpha\nbravo\nzulu");
const r2 = await reconcileFiles({
  files: [fileAEdited],
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
});
assert(r2.refreshed[0] === "src/a.ts", "refreshed only the edited file");
const newAHashes = await fileChunksStore.getHashesForFile("src/a.ts");
assert(newAHashes.length === 3, "a.ts still has 3 chunks after edit");
const charlieHash = sha("charlie");
assert(!newAHashes.includes(charlieHash), "charlie chunk removed from a.ts junction");
assert(oldAHashes.includes(charlieHash), "(sanity) charlie chunk was on a.ts pre-edit");
const charlieRow = db()
  .select({ c: chunks.chunkHash })
  .from(chunks)
  .where(sql`${chunks.chunkHash} = ${charlieHash}`)
  .get();
assert(!charlieRow, "orphan chunk content pruned from chunks table");
const charlieEmbedding = db()
  .select({ c: embeddings.chunkHash })
  .from(embeddings)
  .where(sql`${embeddings.chunkHash} = ${charlieHash}`)
  .get();
assert(!charlieEmbedding, "orphan chunk's embedding cascade-deleted");

process.stdout.write(`\n[3] delete file 2 → reconcile prunes its rows\n`);
const r3 = await reconcileFiles({
  files: [],
  removed: ["src/b.ts"],
  repoRoot: ".",
  chunker: stubChunker,
  chunkStore,
  embeddingStore,
  merkleStore,
  fileChunksStore,
  provider: stubProvider,
  lockedModelId: "voyage-code-3",
  lockedModelVersion: "dim=4;type=document",
});
assert(r3.removed.length === 1, "removed one file");
assert((await fileChunksStore.getHashesForFile("src/b.ts")).length === 0, "b.ts junction empty");
const bMerkle = db()
  .select({ p: merkle.nodePath })
  .from(merkle)
  .where(sql`${merkle.nodePath} = 'src/b.ts'`)
  .get();
assert(!bMerkle, "b.ts merkle leaf removed");
assert(r3.chunksPruned >= 2, `at least 2 orphan chunks pruned from b.ts (got ${r3.chunksPruned})`);

process.stdout.write(`\n[4] merkle stays in sync after refresh\n`);
const aLeaf = db()
  .select({ h: merkle.hash })
  .from(merkle)
  .where(sql`${merkle.nodePath} = 'src/a.ts'`)
  .get();
assert(aLeaf?.h === fileAEdited.fileSha, "merkle leaf for a.ts matches edited content sha");

if (existsSync(TMP_DB)) unlinkSync(TMP_DB);

if (failed > 0) {
  process.stdout.write(`\n${failed} assertion(s) failed\n`);
  process.exit(1);
}
process.stdout.write(`\nall assertions passed\n`);
