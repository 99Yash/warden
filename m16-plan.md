# Warden — M16 Plan (init/review alignment — file→chunks junction + reference-counted prune + incremental refresh at review time)

This is the milestone brief for the agent (or future-me) implementing M16. Self-contained: read this plus `decisions.md` ADR-0032 and you have everything.

M16 lines up the two main agents — `warden review` (M14/M15) and `warden init` (M6) — across document updates. The user's framing: "let's make sure that the review and init are completely lined up, and then we can think about deep security later on." The production-RAG ideas read by the user (Arpit Bhayani's _Production RAG: Document Management & Indexing Strategies_) name the failure modes M16 fixes — chunk identity, content-hash-gated re-embed, delete semantics, doc registry, alias swap. M6 got _some_ of that right (content-addressing on `chunk_hash`, locked-model isolation on embeddings) and _some_ of it wrong (edits leak old chunks; deletes never prune; review surfaces stale state but refuses to refresh; `chunks.file_path` is first-writer-wins, not authoritative). M16 ships the four-fix bundle without touching the public `CommentSet` API or the worker tier. Deep-security (now M17, preserved at `m17-plan.md`) ships after M16 dogfood validates the alignment.

## Read first (in this order)

1. **`./decisions.md`** — focus on **ADR-0032** (the M16 design commit). Also: **ADR-0019** (M6 — the index layer M16 extends: locked-model concept, three-phase init UX, content-addressed storage); **ADR-0016** (storage discipline — content-addressed, model-versioned, portable interfaces — M16 adds one new store + the registry concept stays inside the same envelope); **ADR-0013** (I/O-pure core — `reconcileFiles()` performs file reads + writes against `.warden/cache.sqlite` but no stdout / TTY assumptions; matches the existing `init/index.ts` envelope); **ADR-0030** (M14 — `det-priors.ts` is the entry point M16 modifies to wire implicit refresh); **ADR-0017** (multi-provider cascade — `reconcileFiles()` runs Voyage HTTP outside the SQLite transaction; same retry shape applies in `@warden/ai/src/embeddings/voyage.ts`); **ADR-0008** (citation thesis — M16 strengthens citation accuracy by routing chunk → file attribution through the authoritative junction).
2. **`./CONTEXT.md`** — §4 indexing entries (`chunk` / `embedding` / `locked-model index` / `Merkle tree` / `content-addressed` / `import_graph` / `.warden/cache.sqlite`); §5 runners (no changes — M16 is below the runner layer); §6 architecture invariants (`I/O-pure core` — `reconcileFiles()` lives inside the existing envelope); §8 deferred concepts (alias/shadow index + retrieval observability + daemon `JobRunner` — M16 explicitly defers these). The new entries M16 lands: **`file_chunks`**, **`reconcileFiles`**, **incremental refresh**, **refresh budget**, **orphan prune**, **document registry** (alias for `file_chunks`).
3. **`./CLAUDE.md`** — package boundary table; the env table (M16 adds `WARDEN_REVIEW_REFRESH_MAX_USD` row); milestone status list (M16 inserts ahead of the deep-security entry — now relabeled M17).
4. **`./packages/db/src/schema/chunks.ts`** + **`./packages/db/src/schema/embeddings.ts`** + **`./packages/db/src/schema/merkle.ts`** + **`./packages/db/src/schema/index-meta.ts`** — current schema files. M16 mirrors the pattern with `file-chunks.ts`. The chunks file's "first-writer-wins" comment is the bug we're fixing — leave it in place; the comment becomes accurate again once `chunks.file_path` is downgraded to a backfill source-of-truth annotation.
5. **`./packages/core/src/indexing/interfaces.ts`** — current store interfaces (`ChunkStore`, `EmbeddingStore`, `MerkleStore`, `JobRunner`, `IndexExporter`, `IndexImporter`). M16 adds `FileChunksStore`, and adds `deleteNode()` to `MerkleStore` for deletion reconciliation.
6. **`./packages/core/src/indexing/meta.ts`** + **`./packages/core/src/indexing/chunk-store.ts`** + **`./packages/core/src/indexing/embedding-store.ts`** + **`./packages/core/src/indexing/merkle-store.ts`** — pattern for the new `SqliteFileChunksStore`. Same Drizzle idioms, same chunked batch insert, same `onConflictDoUpdate` shape where applicable. M16 also adds `META_KEYS.FILE_CHUNKS_BACKFILLED_AT`.
7. **`./packages/core/src/init/index.ts`** — current `runInit()` monolithic walk → chunk → embed. M16 thins this out: it becomes a wrapper over `reconcileFiles()`. Walk Phase 1 stays; Phase 2 (chunk) + Phase 3 (embed) move into `reconcile.ts`. Emit events survive verbatim.
8. **`./packages/core/src/init/walk.ts`** — `walkRepo()` is unchanged. Both `runInit()` and `det-priors.ts` already call it; M16 reuses both call sites.
9. **`./packages/core/src/init/estimate.ts`** — `estimateInit()` heuristic. M16 reuses the LOC-based USD math for the per-file pre-flight cost gate inside `reconcileFiles()`.
10. **`./packages/core/src/context/signals/semantic.ts`** — current chunk → file attribution via `record.filePath`. M16 reroutes through the new `FileChunksStore` join; the `SemanticHit` shape stays unchanged, but a single chunk shared across files now emits one max-aggregated hit per file.
11. **`./packages/core/src/review-harness/det-priors.ts`** — the entry point for implicit refresh. After `walkRepo()` + `computeBannerState()` + `merkleStore.diff()`, when `mode === "review"` and the diff is non-empty, call `reconcileFiles({ files: stale, removed, maxUsdBudget: env.WARDEN_REVIEW_REFRESH_MAX_USD ?? 0.25 })`. Banner state recomputation after refresh stays valid (the new file_sha entries reflect the just-reconciled tree).
12. **`./packages/core/src/banner/index.ts`** — `computeBannerState()` reads merkle.diff() for stale detection. M16 doesn't change banner logic; the implicit refresh just _changes_ what the next banner read returns (stale → no-banner after a successful refresh).
13. **`./packages/env/src/index.ts`** + **`./.env.example`** — `wardenEnv()` adds optional `WARDEN_REVIEW_REFRESH_MAX_USD` (numeric string `0.0+`, default `0.25` at the consumer), and `.env.example` documents the knob per the env-var rule in CLAUDE.md.
14. **`./packages/cli/scripts/smoke-m6-*.mts`** + **`./packages/cli/scripts/smoke-m14-*.mts`** — pattern reference for `smoke-m16-*.mts`. Real-token assertions where feasible; deterministic-facet assertions for the schema migration + backfill path; tmp-repo fixtures for the reconcile-on-edit and reconcile-on-delete paths.
15. **`./CLAUDE.md` "Database" section** — `pnpm db:generate` → `pnpm db:migrate` workflow. M16 ships one migration. **Never `db:push`** (CLAUDE.md rule).

## Goal of this milestone

Land ADR-0032's design in a single coherent slice:

- **One new SQLite table.** `file_chunks (file_path TEXT, chunk_hash TEXT, file_sha TEXT, indexed_at INTEGER, PRIMARY KEY (file_path, chunk_hash))` with indexes on both PK columns.
- **One new store interface + SQLite impl.** `FileChunksStore` with methods `replaceForFile()`, `deleteForFile()`, `getFilesForHashes()`, `getHashesForFile()`, `count()`, `pruneOrphans()` (the ref-counted prune; reaches across to `chunks` + `embeddings`) and `backfillFromChunksIfNeeded()`.
- **One MerkleStore deletion method.** `deleteNode()` deletes one stored file row so `removed[]` stops leaking deleted paths.
- **One new orchestration file.** `packages/core/src/init/reconcile.ts` exports `reconcileFiles({files, removed, ...}) → ReconcileSummary`. ~250–400 LoC.
- **One new env knob.** `WARDEN_REVIEW_REFRESH_MAX_USD`, default `0.25`. Validated in `@warden/env`.
- **One env docs update.** `packages/env/src/index.ts`, `.env.example`, and the CLAUDE.md env table all document `WARDEN_REVIEW_REFRESH_MAX_USD`. Plus the M16 entry in the milestone list and the M15+ deferred-items reorder (deep-security relabeled M17).
- **One file rename.** `git mv m16-plan.md m17-plan.md` (already done in the same PR as ADR-0032).
- **One auto-backfill path.** First `reconcileFiles()` invocation against a pre-M16 index runs the one-shot migration query + records the run in `index_meta`.
- **One `semantic.ts` change.** Attribution rerouted through `FileChunksStore.getFilesForHashes()`.
- **`runInit()` becomes a thin wrapper** over `reconcileFiles()` with all-walked-files as input and merkle-diff's removed[] as the removed input.
- **`pnpm check-types` + `pnpm lint` pass.**
- **All M6/M14/M15 behavior preserved** (no regression in `warden init` UX, no regression in `warden review` output for clean indexes, no regression in semantic signal precision for unedited files).

**Stop at "schema migration + FileChunksStore + reconcileFiles + det-priors wiring + auto-backfill + semantic.ts re-attribution + smoke + close-out." Do NOT start:** alias/shadow index for `--rebuild` (own ADR); retrieval observability surface (own ADR; deferred until dogfood evidence demands it); background daemon / watch-mode (`warden patrol` deferred per ADR-0011); multi-vector / hybrid retrieval; dropping vestigial `chunks.file_path` + `chunks.file_sha` (own cleanup ADR — keep them for the backfill source-of-truth window); `WARDEN_REVIEW_REFRESH_MAX_FILES` belt-and-suspenders knob alongside the USD cap (single knob keeps env table from growing redundantly); a `warden refresh` verb (env opt-out via `WARDEN_REVIEW_REFRESH_MAX_USD=0` is sufficient discoverability for the dogfood loop); migration tooling for production indexes that fail the auto-backfill heuristic (manual `warden init --rebuild` escape hatch); chunk-level fingerprinting beyond what content-addressing already gives (the existing `chunk_hash = sha256(content)` PK + `embeddingStore.whichExist()` pre-check is the equivalent gate). Those are later milestones.

## Repo additions

```
packages/db/src/schema/
└── file-chunks.ts                   # NEW — junction table schema.
                                     #   PK (file_path, chunk_hash).
                                     #   Indexes on both PK columns.

packages/db/src/schemas.ts           # MODIFIED — re-export file_chunks.

packages/core/src/indexing/
├── interfaces.ts                    # MODIFIED — add FileChunksStore + add
│                                    #   MerkleStore.deleteNode().
├── meta.ts                          # MODIFIED — add FILE_CHUNKS_BACKFILLED_AT.
├── file-chunks-store.ts             # NEW — SqliteFileChunksStore impl.
└── index.ts                         # MODIFIED — barrel re-exports.

packages/core/src/init/
├── reconcile.ts                     # NEW — reconcileFiles() primitive.
│                                    #   ~250–350 LoC.
└── index.ts                         # MODIFIED — runInit() becomes a thin
                                     #   wrapper over reconcileFiles().

packages/core/src/context/signals/
└── semantic.ts                      # MODIFIED — attribution via FileChunksStore.

packages/core/src/review-harness/
└── det-priors.ts                    # MODIFIED — implicit refresh wiring
                                     #   after walkRepo + merkle.diff.

packages/env/src/index.ts            # MODIFIED — add WARDEN_REVIEW_REFRESH_MAX_USD.
.env.example                         # MODIFIED — document the same env knob.

packages/cli/scripts/
├── smoke-m16-junction.mts           # NEW — file_chunks schema + store smoke.
├── smoke-m16-reconcile.mts          # NEW — reconcileFiles() round-trip:
│                                    #   create → edit → delete fixture.
├── smoke-m16-incremental-refresh.mts # NEW — review-mode refresh path:
│                                    #   stale-within-cap + over-cap.
└── smoke-m16-backfill.mts           # NEW — pre-M16 index → first invoke
                                     #   triggers backfill; index_meta records it.

packages/cli/package.json            # MODIFIED — smoke:m16 chains the four.

CONTEXT.md                           # MODIFIED — new glossary entries.
CLAUDE.md                            # MODIFIED — env table row + milestone list.
m17-plan.md                          # ALREADY-RENAMED — was m16-plan.md (deep-security);
                                     #   renumber note appended.
m16-plan.md                          # THIS FILE.
.warden/cache.sqlite                 # SCHEMA EVOLVES (one migration applied).
```

## What to build

### 1. `file_chunks` schema (`packages/db/src/schema/file-chunks.ts`)

Mirror the existing pattern (`chunks.ts`, `embeddings.ts`):

```ts
import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * file_chunks junction table — the authoritative file→chunks mapping
 * introduced by M16 (ADR-0032). Replaces chunks.file_path's first-writer-
 * wins approximation as the source of truth for "which chunks belong to
 * file X?"
 *
 * - Many-to-many: one row per (file_path, chunk_hash) pair. A single chunk
 *   appearing in two files produces two rows.
 * - `file_sha` reflects the version of the file that contained this chunk
 *   at last reconcile — used by reconcileFiles() to decide whether a file
 *   needs re-chunking.
 * - Composite PK (file_path, chunk_hash) deduplicates without effort.
 * - Indexes on both PK columns to support the two hot queries:
 *   (a) "what chunks belong to file X?" (file_path index)
 *   (b) "what files use this chunk?" (chunk_hash index — semantic.ts)
 */
export const fileChunks = sqliteTable(
  "file_chunks",
  {
    filePath: text("file_path").notNull(),
    chunkHash: text("chunk_hash").notNull(),
    fileSha: text("file_sha").notNull(),
    indexedAt: integer("indexed_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.filePath, t.chunkHash] }),
    pathIdx: index("idx_fc_path").on(t.filePath),
    hashIdx: index("idx_fc_hash").on(t.chunkHash),
  }),
);

export type FileChunksRow = typeof fileChunks.$inferSelect;
export type NewFileChunksRow = typeof fileChunks.$inferInsert;
```

Add to `packages/db/src/schemas.ts`:

```ts
export * from "./schema/file-chunks.js";
```

Run `pnpm db:generate` to produce the migration; commit the generated SQL alongside the schema file.

Add to `packages/core/src/indexing/meta.ts`:

```ts
FILE_CHUNKS_BACKFILLED_AT: "file_chunks_backfilled_at",
```

### 2. `FileChunksStore` interface + SQLite impl

Add to `packages/core/src/indexing/interfaces.ts`:

```ts
export interface FileChunksStore {
  /**
   * Replace all junction rows for `file_path`. Atomic on better-sqlite3.
   *  - DELETE existing rows for `file_path`
   *  - INSERT new rows mapping `file_path` to each `chunk_hash`
   *  - `file_sha` stored on every row reflects the version that produced them
   * Idempotent (same input → same end state).
   */
  replaceForFile(filePath: string, fileSha: string, chunkHashes: string[]): Promise<void>;
  /**
   * Delete every row whose `file_path` matches. Used on file removal.
   * Caller invokes `pruneOrphans()` separately to collect orphan chunks.
   */
  deleteForFile(filePath: string): Promise<void>;
  /**
   * Reverse lookup. Used by semantic.ts to attribute retrieved chunks to
   * the current file(s) that own them.
   */
  getFilesForHashes(chunkHashes: string[]): Promise<Map<string, string[]>>;
  /**
   * Forward lookup. Used by reconcileFiles() to compute the file's pre-
   * reconcile chunk set + by tests/diagnostics.
   */
  getHashesForFile(filePath: string): Promise<string[]>;
  /** Total row count. Drives the backfill heuristic + diagnostics. */
  count(): Promise<number>;
  /**
   * Reference-counted prune: delete chunks not present in any file_chunks
   * row, then delete embeddings not present in chunks. Single transaction.
   * Cheap O(N) full-table scans at warden's scale; called once per
   * reconcileFiles() invocation at the end of the loops.
   */
  pruneOrphans(): Promise<{ chunksPruned: number; embeddingsPruned: number }>;
  /**
   * One-shot auto-backfill from chunks.file_path / chunks.file_sha. Runs
   * exactly once per index (gated by index_meta.file_chunks_backfilled_at).
   * Returns row count inserted; 0 if already backfilled or chunks table empty.
   */
  backfillFromChunksIfNeeded(): Promise<number>;
}

export interface MerkleStore {
  // existing methods...
  /** Delete one stored node, used by reconcileFiles() for removed files. */
  deleteNode(nodePath: string): Promise<void>;
}
```

Implementation at `packages/core/src/indexing/file-chunks-store.ts`:

```ts
import { chunks, db, embeddings, eq, fileChunks, inArray, indexMeta, sql } from "@warden/db";
import type { FileChunksStore } from "./interfaces.js";
import { META_KEYS } from "./meta.js";

export class SqliteFileChunksStore implements FileChunksStore {
  async replaceForFile(filePath: string, fileSha: string, chunkHashes: string[]): Promise<void> {
    const conn = db();
    conn.transaction(() => {
      conn.delete(fileChunks).where(eq(fileChunks.filePath, filePath)).run();
      if (chunkHashes.length === 0) return;
      const now = new Date();
      // Chunked insert; SQLite cap on parameters is 999 / row count is fine.
      const BATCH = 500;
      for (let i = 0; i < chunkHashes.length; i += BATCH) {
        const slice = chunkHashes.slice(i, i + BATCH);
        conn
          .insert(fileChunks)
          .values(slice.map((h) => ({ filePath, chunkHash: h, fileSha, indexedAt: now })))
          .onConflictDoNothing()
          .run();
      }
    })();
  }

  async deleteForFile(filePath: string): Promise<void> {
    db().delete(fileChunks).where(eq(fileChunks.filePath, filePath)).run();
  }

  async getFilesForHashes(chunkHashes: string[]): Promise<Map<string, string[]>> {
    if (chunkHashes.length === 0) return new Map();
    const out = new Map<string, string[]>();
    const BATCH = 500;
    for (let i = 0; i < chunkHashes.length; i += BATCH) {
      const slice = chunkHashes.slice(i, i + BATCH);
      const rows = db()
        .select({ chunkHash: fileChunks.chunkHash, filePath: fileChunks.filePath })
        .from(fileChunks)
        .where(inArray(fileChunks.chunkHash, slice))
        .all();
      for (const r of rows) {
        const arr = out.get(r.chunkHash) ?? [];
        arr.push(r.filePath);
        out.set(r.chunkHash, arr);
      }
    }
    return out;
  }

  async getHashesForFile(filePath: string): Promise<string[]> {
    const rows = db()
      .select({ chunkHash: fileChunks.chunkHash })
      .from(fileChunks)
      .where(eq(fileChunks.filePath, filePath))
      .all();
    return rows.map((r) => r.chunkHash);
  }

  async count(): Promise<number> {
    const row = db()
      .select({ c: sql<number>`count(*)` })
      .from(fileChunks)
      .get();
    return row?.c ?? 0;
  }

  async pruneOrphans(): Promise<{ chunksPruned: number; embeddingsPruned: number }> {
    const conn = db();
    let chunksPruned = 0;
    let embeddingsPruned = 0;
    conn.transaction(() => {
      // Orphan chunks: not present in any file_chunks row.
      const chunkRes = conn.run(
        sql`DELETE FROM chunks WHERE chunk_hash NOT IN (SELECT chunk_hash FROM file_chunks)`,
      );
      chunksPruned = chunkRes.changes;
      // Orphan embeddings: not present in chunks (cascade follows naturally).
      const embRes = conn.run(
        sql`DELETE FROM embeddings WHERE chunk_hash NOT IN (SELECT chunk_hash FROM chunks)`,
      );
      embeddingsPruned = embRes.changes;
    })();
    return { chunksPruned, embeddingsPruned };
  }

  async backfillFromChunksIfNeeded(): Promise<number> {
    const conn = db();
    // Idempotency: index_meta row gates the run.
    const existing = conn
      .select({ k: indexMeta.key, v: indexMeta.value })
      .from(indexMeta)
      .where(eq(indexMeta.key, META_KEYS.FILE_CHUNKS_BACKFILLED_AT))
      .get();
    if (existing) return 0;
    const chunkCount =
      conn
        .select({ c: sql<number>`count(*)` })
        .from(chunks)
        .get()?.c ?? 0;
    const fileChunkCount = await this.count();
    if (chunkCount === 0 || fileChunkCount > 0) {
      // Either nothing to backfill or someone already populated by other means;
      // still mark as backfilled so the runtime stops checking on next call.
      conn
        .insert(indexMeta)
        .values({ key: META_KEYS.FILE_CHUNKS_BACKFILLED_AT, value: new Date().toISOString() })
        .onConflictDoNothing()
        .run();
      return 0;
    }
    const before = fileChunkCount;
    conn.transaction(() => {
      conn.run(
        sql`INSERT OR IGNORE INTO file_chunks (file_path, chunk_hash, file_sha, indexed_at)
            SELECT file_path, chunk_hash, file_sha, created_at FROM chunks`,
      );
      conn
        .insert(indexMeta)
        .values({ key: META_KEYS.FILE_CHUNKS_BACKFILLED_AT, value: new Date().toISOString() })
        .onConflictDoNothing()
        .run();
    })();
    const after = await this.count();
    return after - before;
  }
}
```

Re-export from `packages/core/src/indexing/index.ts`.

### 3. `reconcileFiles()` primitive (`packages/core/src/init/reconcile.ts`)

Public shape:

```ts
import type { EmbeddingProvider } from "@warden/ai";
import type {
  ChunkStore,
  EmbeddingStore,
  FileChunksStore,
  MerkleStore,
} from "../indexing/index.js";
import type { Chunker } from "../context/chunker.js";
import type { WalkedFile } from "./walk.js";
import type { DegradedEntry } from "../schema.js";

export type ReconcileEvent =
  | { type: "backfilled"; rowCount: number }
  | { type: "file-start"; path: string; index: number; total: number }
  | { type: "file-skipped-budget"; path: string; estimatedUsd: number; budgetRemaining: number }
  | { type: "file-refreshed"; path: string; newChunks: number; reusedChunks: number; promptTokens: number; usd: number }
  | { type: "file-removed"; path: string }
  | { type: "orphans-pruned"; chunksPruned: number; embeddingsPruned: number }
  | { type: "complete"; summary: ReconcileSummary };

export interface ReconcileSummary {
  refreshed: string[];
  removed: string[];
  skippedOverBudget: string[];
  /** Unique chunks seen while reconciling refreshed files. */
  chunksSeen: number;
  /** Missing embeddings written in this invocation. */
  newlyEmbedded: number;
  /** Embeddings already present under the locked model. */
  cachedEmbeddings: number;
  /** Embedding batches that failed after provider retry/cascade. */
  failedEmbeds: number;
  promptTokens: number;
  /** Pre-flight estimate for the refreshed/skipped work. */
  estimatedUsd: number;
  /** Actual provider spend from Voyage token usage. */
  costUsd: number;
  durationMs: number;
  degraded: DegradedEntry[];
  /** True when this invocation triggered the one-shot backfill. */
  backfilled: boolean;
  backfilledRowCount: number;
  /** From pruneOrphans(); cumulative across the call. */
  chunksPruned: number;
  embeddingsPruned: number;
}

export interface ReconcileInput {
  files: WalkedFile[];           // files to ensure are current
  removed: string[];             // paths to delete entirely
  repoRoot: string;
  chunker: Chunker;
  chunkStore: ChunkStore;
  embeddingStore: EmbeddingStore;
  merkleStore: MerkleStore;
  fileChunksStore: FileChunksStore;
  provider: EmbeddingProvider;
  lockedModelId: string;
  lockedModelVersion: string;
  /** Optional USD cap. Unset = unbounded (init mode). Review passes 0.25. */
  maxUsdBudget?: number;
  emit?: (e: ReconcileEvent) => void;
}

export async function reconcileFiles(input: ReconcileInput): Promise<ReconcileSummary> {
  // 0. One-shot backfill (idempotent; no-op when already done).
  const backfilledRowCount = await input.fileChunksStore.backfillFromChunksIfNeeded();
  if (backfilledRowCount > 0) {
    input.emit?.({ type: "backfilled", rowCount: backfilledRowCount });
  }

  // 1. Per-file: HTTP outside transaction, atomic DB inside.
  const refreshed: string[] = [];
  const skippedOverBudget: string[] = [];
  let remainingBudget = input.maxUsdBudget ?? Number.POSITIVE_INFINITY;
  const startedAt = Date.now();
  let totalPromptTokens = 0;
  let totalEstimatedUsd = 0;
  let totalActualUsd = 0;
  let chunksSeen = 0;
  let newlyEmbedded = 0;
  let cachedEmbeddings = 0;
  let failedEmbeds = 0;

  for (let i = 0; i < input.files.length; i++) {
    const file = input.files[i];
    input.emit?.({ type: "file-start", path: file.path, index: i + 1, total: input.files.length });

    // 1a. Chunk file content.
    const chunksNew = await input.chunker.chunk(file.path, file.content, file.fileSha);
    const newHashes = uniqueHashes(chunksNew);

    // 1b. Identify missing chunks (re-uses content-addressed cache).
    const existing = await input.embeddingStore.whichExist(
      newHashes,
      input.lockedModelId,
      input.lockedModelVersion,
    );
    const missing = newHashes.filter((h) => !existing.has(h));

    // 1c. Pre-flight estimate against remaining budget.
    const estimatedUsd = estimateChunkBatchUsd(chunksNew, missing, input.lockedModelId);
    totalEstimatedUsd += estimatedUsd;
    if (estimatedUsd > remainingBudget) {
      skippedOverBudget.push(file.path);
      input.emit?.({
        type: "file-skipped-budget",
        path: file.path,
        estimatedUsd,
        budgetRemaining: remainingBudget,
      });
      continue;
    }

    // 1d. HTTP: embed missing chunks via Voyage. No DB writes yet.
    let newEmbeddings: { chunkHash: string; modelId: string; modelVersion: string; vector: Float32Array }[] = [];
    let actualUsd = 0;
    let promptTokens = 0;
    if (missing.length > 0) {
      const hashToContent = new Map<string, string>();
      for (const c of chunksNew) if (!hashToContent.has(c.chunkHash)) hashToContent.set(c.chunkHash, c.content);
      const batches = chunkArray(missing, input.provider.maxBatchSize());
      for (const batch of batches) {
        const inputs = batch.map((h) => hashToContent.get(h) ?? "");
        let resp;
        try {
          resp = await input.provider.embed({ inputs, inputType: "document" });
        } catch {
          failedEmbeds++;
          throw;
        }
        for (let j = 0; j < batch.length; j++) {
          newEmbeddings.push({
            chunkHash: batch[j],
            modelId: resp.modelId,
            modelVersion: resp.modelVersion,
            vector: resp.vectors[j] ?? new Float32Array(0),
          });
        }
        promptTokens += resp.promptTokens;
        actualUsd += usdFromTokens(resp.promptTokens, input.lockedModelId);
      }
    }

    remainingBudget -= actualUsd;
    totalPromptTokens += promptTokens;
    totalActualUsd += actualUsd;
    chunksSeen += newHashes.length;
    newlyEmbedded += missing.length;
    cachedEmbeddings += newHashes.length - missing.length;

    // 1e. Atomic DB write: chunks + file_chunks + embeddings + merkle.
    // Implement as one better-sqlite3 transaction in reconcile.ts, not as
    // four independent store calls. The stores still provide read/test seams;
    // the write commit owns the crash-safety guarantee ADR-0032 depends on.
    await commitFileReconcile({
      chunks: chunksNew,
      embeddings: newEmbeddings,
      filePath: file.path,
      fileSha: file.fileSha,
      chunkHashes: newHashes,
    });

    refreshed.push(file.path);
    input.emit?.({
      type: "file-refreshed",
      path: file.path,
      newChunks: missing.length,
      reusedChunks: newHashes.length - missing.length,
      promptTokens,
      usd: actualUsd,
    });
  }

  // 2. Per-removed-file: cheap deletes; no HTTP, no budget.
  const removedActual: string[] = [];
  for (const path of input.removed) {
    // Same atomic envelope as refreshed files; no HTTP and no budget.
    await commitFileRemoval({ path });
    removedActual.push(path);
    input.emit?.({ type: "file-removed", path });
  }

  // 3. Batched orphan prune at the end. One full-table scan; ~10ms at scale.
  const { chunksPruned, embeddingsPruned } = await input.fileChunksStore.pruneOrphans();
  if (chunksPruned > 0 || embeddingsPruned > 0) {
    input.emit?.({ type: "orphans-pruned", chunksPruned, embeddingsPruned });
  }

  // 4. Build the degraded entries the caller (init or det-priors) surfaces.
  const degraded: DegradedEntry[] = [];
  if (skippedOverBudget.length > 0 && input.maxUsdBudget !== undefined) {
    degraded.push({
      kind: "actionable",
      topic: "context",
      message: `context: refresh capped at $${input.maxUsdBudget.toFixed(2)} — ${skippedOverBudget.length} file${skippedOverBudget.length === 1 ? "" : "s"} skipped; run \`warden init\` for a full refresh`,
    });
  }
  if (backfilledRowCount > 0) {
    degraded.push({
      kind: "info",
      topic: "context",
      message: `context: migrated ${backfilledRowCount} rows to file_chunks (one-shot; M16 schema)`,
    });
  }

  const summary: ReconcileSummary = {
    refreshed,
    removed: removedActual,
    skippedOverBudget,
    promptTokens: totalPromptTokens,
    estimatedUsd: totalEstimatedUsd,
    costUsd: totalActualUsd,
    chunksSeen,
    newlyEmbedded,
    cachedEmbeddings,
    failedEmbeds,
    durationMs: Date.now() - startedAt,
    degraded,
    backfilled: backfilledRowCount > 0,
    backfilledRowCount,
    chunksPruned,
    embeddingsPruned,
  };
  input.emit?.({ type: "complete", summary });
  return summary;
}
```

Implementation notes:

- The per-file ordering — chunk → whichExist → estimate → embed → DB writes — is the ordering ADR-0032 §3 names. Embed-outside-tx; DB-write-in-tx. HTTP failure leaves the file at its pre-call state; DB failure rolls back to the same state.
- `commitFileReconcile()` and `commitFileRemoval()` are private SQLite helpers inside `reconcile.ts` that use one `db().transaction(() => {...})()` around the cross-table write. They may use the same schema tables as the store impls directly; the store interfaces remain the read/test seam, but the commit helper owns the cross-store crash-safety guarantee.
- `runInit --dry-run` does not call `reconcileFiles()`; it keeps the old walk + estimate + early return behavior. `reconcileFiles()` receives a real provider because it is a write path, not an estimator.
- `pruneOrphans()` runs once at the end. Per-file orphan-prune would re-scan the chunks table N times — wasteful at warden's scale.
- The `maxUsdBudget` accountant uses actual cost (from Voyage responses) for the running budget, not the estimate. The estimate is only used for the per-file go/no-go decision pre-Voyage. Honest accountant.
- `estimateChunkBatchUsd()` reuses `estimate.ts`'s LOC→USD heuristic adapted to chunk batches; same per-model pricing table.
- `usdFromTokens()` consumes `resp.promptTokens` + the locked-model pricing from `VOYAGE_MODELS`. Pre-existing math.

### 4. `runInit()` thin-wrapper rewrite

`runInit()` in `packages/core/src/init/index.ts` becomes:

```ts
export async function runInit(input: InitInput): Promise<InitSummary> {
  const startedAt = Date.now();
  const opts = input.options ?? {};
  const emit = input.emit ?? (() => undefined);
  // … (gitignore + locked-model resolution + Phase 1 walk unchanged) …

  // Preserve M6 dry-run behavior: estimate and return before provider or
  // reconcile writes are required.
  if (opts.dryRun) {
    // existing dry-run summary path, unchanged externally
  }

  // Compute the removed set.
  const storedHashes = await merkleStore.getAllFileHashes();
  const currentPaths = new Set(walked.files.keys());
  const removed: string[] = [];
  for (const path of storedHashes.keys()) if (!currentPaths.has(path)) removed.push(path);

  // Phase 2 + 3 collapse into reconcileFiles().
  emit({ type: "phase-start", phase: "chunk" });
  const reconcile = await reconcileFiles({
    files: Array.from(walked.files.values()),
    removed,
    repoRoot: input.repoRoot,
    chunker: input.chunker ?? new CodeChunkAdapter(),
    chunkStore,
    embeddingStore,
    merkleStore,
    fileChunksStore: input.fileChunksStore ?? new SqliteFileChunksStore(),
    provider,
    lockedModelId,
    lockedModelVersion,
    maxUsdBudget: opts.maxCostUsd, // unset = unbounded
    emit: (ev) => {
      // Translate ReconcileEvent → InitEvent for existing listener shape.
      if (ev.type === "file-refreshed") {
        emit({
          type: "embed-progress",
          completed: /* derived */,
          total: walked.files.size,
          promptTokensSoFar: /* running */,
          elapsedMs: Date.now() - startedAt,
        });
      }
      // … forward other events as needed …
    },
  });

  if (!existingLock || rebuilt) await writeLockedModel(lockedModelId, lockedModelVersion);
  await writeRepoMerkleRoot(computeRepoMerkleRootFromWalk(walked.files));
  await writeFormatVersion(CURRENT_FORMAT_VERSION);

  const summary: InitSummary = {
    files: walked.files.size,
    chunks: reconcile.chunksSeen,
    cachedChunks: reconcile.cachedEmbeddings,
    newlyEmbedded: reconcile.newlyEmbedded,
    failedEmbeds: reconcile.failedEmbeds,
    promptTokens: reconcile.promptTokens,
    estimatedUsd: reconcile.estimatedUsd,
    durationMs: Date.now() - startedAt,
    dryRun: opts.dryRun ?? false,
    abortedForCost: reconcile.skippedOverBudget.length > 0 && opts.maxCostUsd !== undefined,
    rebuilt,
  };
  emit({ type: "complete", durationMs: summary.durationMs, summary });
  return summary;
}
```

The `InitEvent` discriminated union stays unchanged externally; the CLI render layer at `packages/cli/src/render.ts` reads the same shape. `reconcileFiles()`'s event stream gets mapped to the existing `InitEvent` types so the three-phase progress UX survives byte-identical.

### 5. `det-priors.ts` implicit-refresh wiring

After the existing `walkRepo()` + `computeBannerState()` block in `det-priors.ts:139–155`, add:

```ts
if (input.mode === "review" && bannerState.kind === "stale") {
  try {
    const refreshBudget = wardenEnv().WARDEN_REVIEW_REFRESH_MAX_USD ?? 0.25;
    if (refreshBudget === 0) {
      // Existing M6 stale banner remains the only surface; no provider needed.
    } else {
      const merkleStore = new SqliteMerkleStore();
      const diff = await merkleStore.diff(currentHashes);
      const staleFiles: WalkedFile[] = [];
      for (const path of [...diff.changed, ...diff.added]) {
        const wf = walk.files.get(path);
        if (wf) staleFiles.push(wf);
      }
      if (staleFiles.length > 0 || diff.removed.length > 0) {
        const locked = await readLockedModel();
        const provider = getEmbeddingProvider();
        const reconcile = await reconcileFiles({
          files: staleFiles,
          removed: diff.removed,
          repoRoot: input.repoRoot,
          chunker: new CodeChunkAdapter(),
          chunkStore: new SqliteChunkStore(),
          embeddingStore: new SqliteEmbeddingStore(),
          merkleStore,
          fileChunksStore: new SqliteFileChunksStore(),
          provider,
          lockedModelId: locked?.modelId ?? CURRENT_DEFAULT,
          lockedModelVersion: locked?.modelVersion ?? `dim=1024;type=document`,
          maxUsdBudget: refreshBudget,
        });
        environmentalDegraded.push(...reconcile.degraded);
        // Recompute banner — if we refreshed everything, banner clears.
        bannerState = await computeBannerState({
          repoRoot: input.repoRoot,
          currentDefault: CURRENT_DEFAULT,
          currentHashes,
        });
      }
    }
  } catch (err) {
    environmentalDegraded.push({
      kind: "warning",
      topic: "context",
      message: `context: incremental refresh failed (${formatErr(err)}) — running against possibly-stale index`,
    });
  }
}
```

Wrap in a try/catch so refresh failures degrade cleanly to "review continues against possibly-stale index" rather than blocking the review.

### 6. `semantic.ts` re-attribution

Current:

```ts
const records = await input.chunkStore.getManyByHash(aboveThreshold.map((r) => r.chunkHash));
for (const r of aboveThreshold) {
  const record = records.get(r.chunkHash);
  if (!record) continue;
  const hit: SemanticHit = {
    chunkHash: r.chunkHash,
    similarity: r.similarity,
    startLine: record.startLine,
    endLine: record.endLine,
  };
  const existing = hitsByFile.get(record.filePath);
  if (!existing || existing.similarity < hit.similarity) hitsByFile.set(record.filePath, hit);
}
```

New:

```ts
const hashes = aboveThreshold.map((r) => r.chunkHash);
const records = await input.chunkStore.getManyByHash(hashes);
const attributions = await input.fileChunksStore.getFilesForHashes(hashes);
for (const r of aboveThreshold) {
  const record = records.get(r.chunkHash);
  if (!record) continue;
  const files = attributions.get(r.chunkHash) ?? (record ? [record.filePath] : []); // fallback to chunks.file_path for the backfill window
  for (const filePath of files) {
    const hit: SemanticHit = {
      chunkHash: r.chunkHash,
      similarity: r.similarity,
      startLine: record.startLine,
      endLine: record.endLine,
    };
    const existing = hitsByFile.get(filePath);
    if (!existing || existing.similarity < hit.similarity) hitsByFile.set(filePath, hit);
  }
}
```

`SemanticSignalInput` adds an optional `fileChunksStore: FileChunksStore` field; default initialized via `new SqliteFileChunksStore()` if absent.

### 7. `@warden/env` adds `WARDEN_REVIEW_REFRESH_MAX_USD`

In `packages/env/src/index.ts`:

```ts
WARDEN_REVIEW_REFRESH_MAX_USD: z
  .string()
  .optional()
  .transform((v) => (v === undefined || v === "" ? undefined : Number(v)))
  .refine((v) => v === undefined || (Number.isFinite(v) && v >= 0), {
    message: "WARDEN_REVIEW_REFRESH_MAX_USD must be a non-negative number",
  }),
```

Default `0.25` is applied at the call site in `det-priors.ts`, not at the env layer (matches the existing `WARDEN_REVIEW_BOSS_ROUNDS` pattern of "env optional, default at the consumer").

Add the same knob to `.env.example`:

```dotenv
# Optional — M16 review-time index refresh budget (ADR-0032).
# Set to 0 to disable implicit refresh and keep the existing stale-index banner.
WARDEN_REVIEW_REFRESH_MAX_USD=
```

### 8. Smoke harness

- `smoke-m16-junction.mts` — schema migration runs cleanly; `SqliteFileChunksStore` round-trips through all six methods; backfill is idempotent (second call returns 0 / surfaces no degraded entry).
- `smoke-m16-reconcile.mts` — tmp-repo fixture: write 3 files → run reconcile → assert 3 file_chunks rows × N chunks per file. Edit file 1 → reconcile → assert old chunks of file 1 are pruned (orphan ref-count reaches 0). Delete file 2 → reconcile with `removed: [file2]` → assert file 2's chunks gone.
- `smoke-m16-incremental-refresh.mts` — tmp-repo fixture with a real diff against a stale index; `runReviewHarness()` triggers the implicit refresh; degraded entries match expected; over-cap variant surfaces the actionable message.
- `smoke-m16-backfill.mts` — pre-populate `chunks` only (no `file_chunks`) → run reconcile → assert backfill query ran + `index_meta.file_chunks_backfilled_at` row exists + second invocation does NOT re-run (idempotent gate).

Wire `smoke:m16` in `packages/cli/package.json`:

```json
"smoke:m16": "tsx scripts/smoke-m16-junction.mts && tsx scripts/smoke-m16-reconcile.mts && tsx scripts/smoke-m16-incremental-refresh.mts && tsx scripts/smoke-m16-backfill.mts"
```

### 9. CLAUDE.md updates

Env table: add row for `WARDEN_REVIEW_REFRESH_MAX_USD` between `WARDEN_REVIEW_WORKER_BUDGET` and the M16 row. Suggested wording:

> Optional. Numeric `0.0+`. Default `0.25`. USD cap applied by `det-priors.ts` when `warden review` triggers `reconcileFiles()` over stale files. Pre-flight estimate via `estimate.ts` LOC heuristic; over-budget files are skipped and surfaced as one actionable `degradedWorkers` entry pointing at `warden init`. Set to `0` to opt out of implicit refresh entirely (review runs against possibly-stale embeddings). Deletes are unconditional and free of Voyage cost. → ADR-0032.

Milestone status list:

- Insert new `M16 — init/review alignment` entry between M15 and M17.
- Relabel the existing deep-security entry M16 → M17.

### 10. CONTEXT.md updates

§4 Indexing — add new entries:

- **`file_chunks`** — Authoritative file→chunks junction table introduced in M16 (ADR-0032). PK `(file_path, chunk_hash)`; carries `file_sha` + `indexed_at`. Indexes on both PK columns support the two hot queries: "which chunks belong to file X?" (`reconcileFiles()`) and "which files use this chunk?" (`semantic.ts` attribution). Replaces `chunks.file_path` as the source of truth — the latter survives as a backfill annotation only. → ADR-0032.
- **`document registry`** — Conceptual name (from the production-RAG framing) for what `file_chunks` implements. Used in M16 docs only; not a code symbol.

§4 Indexing — modify existing entries:

- `chunk` / `ChunkRecord` — note the `chunks.file_path` field is no longer authoritative; `file_chunks` is.
- `Merkle tree` / `merkle store` — note that `removed[]` from `diff()` is now read by `reconcileFiles()`; deletions previously leaked.

§4 Indexing — add reconciliation entries:

- **`reconcileFiles`** — Shared orchestration primitive at `packages/core/src/init/reconcile.ts` (ADR-0032). Input: `{ files, removed, maxUsdBudget?, ... stores }`. Embeds outside the SQLite transaction; per-file atomic writes; batched orphan prune at the call boundary. Both `runInit()` (full repo) and `det-priors.ts` (stale subset) call it with different scopes. → ADR-0032.
- **`incremental refresh`** — The implicit refresh triggered by `warden review`'s det-priors phase when `merkleStore.diff()` reports changes (within `WARDEN_REVIEW_REFRESH_MAX_USD` budget). Distinct from `warden init` which runs the full reconcile. Both invoke `reconcileFiles()`. → ADR-0032.
- **`refresh budget`** — Numeric USD cap on `reconcileFiles()` invocations from the review path. `WARDEN_REVIEW_REFRESH_MAX_USD` env knob, default `0.25`. Over-budget files are skipped and surfaced as one actionable `degradedWorkers` entry. Deletes are unconditional + free. → ADR-0032.
- **`orphan prune`** — Reference-counted cleanup pass at the end of every `reconcileFiles()` invocation. Drops `chunks` rows with no remaining `file_chunks` reference + cascades to drop their embeddings. Single transaction; one full-table scan. → ADR-0032.

§8 Deferred concepts — flip these from "deferred, listed in M15+" to "shipped in M16":

- (Move the "incremental refresh at review time" / "stale chunks on edit + delete" surface from the M15+ deferred list to the milestone status as M16.)

§8 Deferred concepts — keep deferred:

- **`alias-swap index`** — `[deferred, ADR-0032 §8 NOT-in]` The blog's "build new index overnight, validate, atomically swap alias" pattern. Real value when SKU bumps cascade; defer until the second SKU bump surfaces a concrete pain.
- **`retrieval observability`** — `[deferred, ADR-0032 §8 NOT-in]` Per-review chunk-hashes + similarities + signal provenance log table. Solves "retrieval problems disguising as LLM problems." Defer until dogfood surfaces a concrete debug case.
- **`warden patrol`** — Already deferred per ADR-0011; M16 explicitly defers the background daemon shape too.

## Acceptance criteria

1. `pnpm db:generate` produces one new migration for `file_chunks`; `pnpm db:migrate` applies cleanly to a fresh `.warden/cache.sqlite`.
2. `warden init` on a fresh repo: walk → chunk → embed paths run identically to M6 output (smoke-m6-init parity). File counts, chunk counts, USD estimate all match a baseline within ±5%.
3. `warden init` on a pre-M16 index (file_chunks empty + chunks non-empty): triggers the one-shot backfill; `index_meta.file_chunks_backfilled_at` row appears; degraded entry surfaces; second invocation does not re-run the backfill.
4. `reconcileFiles()` with `removed: [X]`: file X's `file_chunks` rows are deleted; orphan chunks of file X are pruned (unless some other file references them); orphan embeddings cascade.
5. `reconcileFiles()` with edits to file Y: old `file_chunks` rows for Y are deleted; new ones inserted; orphan chunks from Y's old `file_sha` are pruned (when they're not still in some other file).
6. A simulated process error during the per-file DB commit rolls back `chunks` + `file_chunks` + `embeddings` + `merkle` together; no torn cross-table state remains.
7. `warden review` against a working tree with 5 files changed since last init: implicit refresh runs; degraded entries are quiet (no over-cap message); semantic signal returns hits attributed to the _current_ file content.
8. `warden review` against a working tree with 200 files changed: over-cap path triggers; degraded entry surfaces with the actionable wording; review continues to completion.
9. `WARDEN_REVIEW_REFRESH_MAX_USD=0 warden review`: implicit refresh skipped entirely; banner state remains "stale" with the existing M6 message; no new M16 degraded entry and no Voyage provider is required.
10. `semantic.ts` attribution for chunks present in two files: emits two `SemanticHit`s, one per file_path.
11. `pnpm smoke:m16` runs all four scripts to green; `pnpm check-types` + `pnpm lint` pass; M14/M15 smokes still pass.
12. ADR-0032 status row flips from `Direction` to `Done` after acceptance; CLAUDE.md M16 line flips to `[x]`; CONTEXT.md gains the new glossary entries; `.env.example` documents `WARDEN_REVIEW_REFRESH_MAX_USD`.

## Close-out checklist

- [ ] Schema migration generated + applied locally.
- [ ] `FileChunksStore` interface + SQLite impl + tests via smoke.
- [ ] `MerkleStore.deleteNode()` + `META_KEYS.FILE_CHUNKS_BACKFILLED_AT` shipped.
- [ ] `reconcileFiles()` primitive lands at `packages/core/src/init/reconcile.ts`.
- [ ] Cross-table per-file commit is wrapped in one SQLite transaction.
- [ ] `runInit()` thinned to wrapper; existing `InitEvent` stream survives byte-identical from the renderer's perspective.
- [ ] `det-priors.ts` implicit-refresh path lands; try/catch around the refresh call to degrade cleanly on failure.
- [ ] `semantic.ts` attribution rerouted through `FileChunksStore.getFilesForHashes()`.
- [ ] `WARDEN_REVIEW_REFRESH_MAX_USD` added to `@warden/env` and `.env.example`.
- [ ] Four smoke scripts shipped; `smoke:m16` chain runs to green.
- [ ] Dogfood pass: `warden init` on the warden repo → `warden review --base main` on a 5-file edit → confirm semantic signal attributes to current line numbers.
- [ ] Dogfood pass: edit a file → delete a different file → `warden review` → confirm refresh fires + delete prunes + over-cap message does NOT fire.
- [ ] ADR-0032 status row updated to `Done`.
- [ ] CLAUDE.md M16 row flipped to `[x]`; M17 entry confirmed accurate post-rename.
- [ ] CONTEXT.md glossary additions land.
- [ ] Memory entry: record this milestone's surprise (what was harder/easier than expected) in `~/.claude/projects/-Users-yash-Developer-self-warden/memory/` if anything non-obvious surfaced.

## Design nuances captured during planning (2026-05-16 grilling pass)

These are non-obvious refinements from the Q1 → Q9 grilling. Worth knowing before code, not after.

- **The user's "embedding closes midway" concern.** Orphan chunks lingering after a mid-flight Voyage failure are _not_ a footgun under the embed-first-then-transaction ordering. If embed fails: no DB writes → file stays at pre-call state. If transaction fails: rollback → file stays at pre-call state. There is no scenario where the file ends up in a _worse_ state than before the call. The plan's per-file ordering is load-bearing for this guarantee — do not invert it.
- **`chunks.file_path` is _intentionally_ kept after M16.** Vestigial column. Pre-M16 indexes rely on it for the one-shot backfill; post-backfill, it's unused. Future cleanup ADR may drop the column when the backfill source-of-truth window expires (e.g., after two milestones with no observed pre-M16 indexes in the dogfood loop). Don't preemptively drop it in M16.
- **Per-file cross-table transaction wrapping is required.** The user's "embedding closes midway" concern is only fully answered if the post-embed DB commit is one atomic unit across `chunks`, `file_chunks`, `embeddings`, and `merkle`. Store methods can keep their own transactions for standalone calls, but `reconcileFiles()` must use a private `db().transaction(() => {...})()` commit helper for the cross-table write. Do not regress this back to four independent writes.
- **`maxUsdBudget` is per-call, not per-file.** A single file's pre-flight estimate alone can exceed the budget; that file is skipped and the _full_ remaining budget is available for subsequent files. The cumulative remaining-budget accountant uses _actual_ Voyage cost (from `resp.promptTokens`), not the estimate, for the running total.
- **Backfill is approximate by design.** `chunks.file_path` is first-writer-wins; the backfill copies that approximation into `file_chunks`. The first subsequent `warden init` overwrites approximations as it walks. Within one full init cycle, the index is authoritative. The transient approximation period is acceptable per the dogfood-quality v0 bar — _flag this in the close-out narrative_ so future readers don't read more rigor into the backfill than is there.
- **The four-config eval suite (M15) is the dogfood baseline for M16.** Run `pnpm eval --config pd-multi` before and after M16 lands to confirm review-mode behavior is unchanged on the synthetic-plant fixture set. Implicit refresh on the synthetic fixtures triggers nothing (no merkle delta), so the suite is robust to M16 changes — but verify, don't assume.
- **`merkleStore.diff()` is the canonical stale signal.** `det-priors.ts` already computes it for banner state. M16 reuses the same call site; do not introduce a sibling "what's stale" computation. The merkle diff's `added` array is the "newly tracked file" case (e.g., user creates a new TS file mid-feature); reconcile handles it identically to `changed`.
- **Lockfile changes don't trigger refresh.** `merkle` tracks file shas at the working-tree level; lockfile edits cause merkle deltas, but lockfiles aren't chunked or embedded (the chunker skips them via the existing `code-chunk` filters). Reconcile sees them in `staleFiles` but the chunker returns 0 chunks → 0 missing → 0 cost. Quietly handled.
- **The "soft-skip when over-cap" message is actionable, not warning.** ADR-0032 §4 chose `kind: "actionable"` because the user _can_ run `warden init` to fix it. If a future surface shows users ignore actionable entries, downgrade to "info" but flag the change in a follow-up ADR.
- **Implicit refresh is review-only, not check-only.** `warden check` is deterministic-only per ADR-0011 — no LLM, no embeddings, no Voyage cost. M16 explicitly does NOT wire reconcile into `runCheck()`. If a future surface (e.g., pre-commit hook on check) demands fresh embeddings, that's a separate ADR.
- **The semantic.ts fallback to `record.filePath` covers the backfill window.** Between schema migration and first reconcile, `file_chunks` has approximate rows (from the backfill); semantic queries hit a chunk that _might_ not have a junction row yet (e.g., a never-written-to chunk). Fall back to `record.filePath` in that case — equivalent to pre-M16 behavior. Once first reconcile completes, the fallback path stops firing.
