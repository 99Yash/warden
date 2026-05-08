# Warden — M6 Plan (hosted embedding-backed selector + content-addressed indexing storage)

This is the milestone brief for the agent (or future-me) implementing M6. Self-contained: read this plus `decisions.md` ADR-0019 (and ADR-0016 + ADR-0018 as background) and you have everything.

## Read first (in this order)

1. **`./decisions.md`** — focus on **ADR-0019 (this milestone's direction)** plus ADR-0008 (citation thesis), ADR-0012 (review priority), ADR-0013 (I/O-pure core), ADR-0014 (one-shot non-interactive CLI), ADR-0016 (storage discipline), ADR-0017 (LLM provider fallback — same posture for embedding fallbacks once BYOEmbedder ships), and ADR-0018 (M5 — the existing context selector M6 extends).
2. **`./CLAUDE.md`** — package boundary table is load-bearing. M6 adds files in `@warden/core`, `@warden/db`, `@warden/ai`, `@warden/cli`. No new workspace package.
3. **`./packages/core/src/index.ts`** — current `review()` pipeline. M5 left `RetrievedContext` populated via `candidatesToRetrievedContext()`; M6 extends `Reason` and the prompt-assembly path additively. Selector composition lives in `packages/core/src/context/`.
4. **`./packages/db/src/schema/external-knowledge.ts`** + sibling `import-graph.ts` / `file-state.ts` — schema-file convention. M6 adds five new files mirroring this shape.
5. **`./packages/ai/src/`** — current LLM dispatcher pattern (`models.ts`, `provider.ts`). M6's `embeddings/` directory mirrors this layout.
6. **`./m5-plan.md`** — for tone, structure, and the "design nuances captured during planning" pattern. M6 carries forward several of those nuances.
7. The "Design nuances captured during planning" section at the bottom of this doc — non-obvious refinements from the grilling. Worth reading before writing code, not after.

## Goal of this milestone

Implement **M6: hosted embedding-backed selector + content-addressed indexing storage**. By the end:

- `warden init` builds a Voyage-embedded chunk index for any TS/JS/Python/Rust/Go/Java codebase via `code-chunk` + Voyage `voyage-code-3`. Three-phase progress UI (walk → chunk → embed) with pre-flight estimate, observed-throughput ETA, idempotent re-runs, Ctrl-C-safe resume.
- `warden review` adds a new `{ kind: "semantic" }` reason variant on top of M5's four cheap signals. Diff is embedded once via Voyage `type=query`; top-50 chunks above similarity 0.5 contribute to per-file scores via max-aggregation; semantic weight is `0.9 × max_chunk_similarity` (intensity-scaled).
- Limitation banner gradient (A/B/C/D-soft/D-aged/D-deprecated) reflects index state per ADR-0019 decision 7.
- Voyage SKU bumps don't auto-rebuild — locked-model concept (decision 6) is sticky; user runs `warden init --rebuild` to upgrade.
- Five new tables in `@warden/db`: `chunks`, `embeddings`, `merkle`, `jobs`, `index_meta`. Generated via `pnpm db:generate` and applied via `pnpm db:migrate`.
- Storage interfaces (`ChunkStore`, `EmbeddingStore`, `MerkleStore`, `JobRunner`, `IndexExporter`, `IndexImporter`) live in `packages/core/src/indexing/` with one SQLite default impl each. `IndexExporter` + `IndexImporter` are interface-ready but no CLI verb wires them up yet.
- Embedding provider abstraction in `packages/ai/src/embeddings/` with one Voyage impl. `EmbeddingProvider` interface is shaped for future BYO impls.
- `ensureGitignore(repoRoot)` runs at the top of `init`, `review`, and `check` — appends `.warden/` to `.gitignore` (idempotent). Surfaces in `degradedWorkers` on first add.
- README's "Data flow" section mirrors the local-vs-remote table from this plan so users see what crosses the wire before installing.
- `pnpm check-types` passes.
- All M4/M5 behavior preserved (no regression in TSC/ESLint/vuln/jscpd/cheap-signals/LLM flow).

**Stop at "selector v2 + locked-model + warden init + banner + storage interfaces + embedding provider work end-to-end on Alfred / milkpod / blair." Do NOT start implementing cross-repo retrieval, the `leverage` category, the custom-code SAST worker, full `warden index export/import` CLI verbs, BYOEmbedder, async/daemon `JobRunner`, or `node_modules`/`.d.ts` chunking.** Those are M7+.

## Repo additions

```
packages/core/src/indexing/
├── interfaces.ts             # ChunkStore, EmbeddingStore, MerkleStore, JobRunner,
│                             # IndexExporter, IndexImporter — pure types, no Drizzle.
├── chunk-store.ts            # SQLite impl via @warden/db
├── embedding-store.ts        # SQLite impl (handles vector blob serialization)
├── merkle-store.ts           # SQLite impl (file-level Merkle tree)
├── job-runner.ts             # Sync default impl (concurrency-limited promise pool)
├── exporter.ts               # IndexExporter SQLite impl (interface-ready, no CLI consumer)
├── importer.ts               # IndexImporter SQLite impl (interface-ready, no CLI consumer)
├── meta.ts                   # Locked-model + repo_merkle_root + format_version helpers
└── index.ts                  # Barrel re-exports

packages/core/src/context/
├── chunker.ts                # NEW — Chunker interface + CodeChunkAdapter (wraps `code-chunk`)
└── signals/
    └── semantic.ts           # NEW — semantic signal: embed diff, search EmbeddingStore, emit reasons

packages/core/src/init/
├── index.ts                  # NEW — init() orchestration: walk → chunk → embed
├── walk.ts                   # NEW — file enumeration via git ls-files (skips node_modules etc.)
├── estimate.ts               # NEW — pre-flight LOC-based estimate (constants in one file)
└── ensure-gitignore.ts       # NEW — auto-add .warden/ to .gitignore (idempotent)

packages/core/src/banner/
└── index.ts                  # NEW — banner state computation (state space A/B/C/D-*)

packages/db/src/schema/
├── chunks.ts                 # NEW (M6) — chunk metadata + content
├── embeddings.ts             # NEW (M6) — vectors keyed by (chunk_hash, model_id, model_version)
├── merkle.ts                 # NEW (M6) — file/dir hashes for change detection
├── jobs.ts                   # NEW (M6) — JobRunner SQLite-backed task table
└── index-meta.ts             # NEW (M6) — locked-model row + format_version + repo_merkle_root

packages/ai/src/embeddings/
├── interfaces.ts             # NEW — EmbeddingProvider interface
├── voyage.ts                 # NEW — VoyageProvider impl
├── voyage-models.ts          # NEW — VOYAGE_MODELS registry + CURRENT_DEFAULT
└── index.ts                  # NEW — barrel + getEmbeddingProvider() factory

packages/cli/src/commands/
├── init.ts                   # NEW — `warden init` argv parsing + delegating to core/init
└── (review.ts / check.ts)    # MODIFIED — call ensureGitignore() before pipeline

packages/cli/src/render.ts    # MODIFIED — three-phase progress UI for init,
                              # banner rendering for review

packages/env/src/index.ts     # MODIFIED — VOYAGE_API_KEY required when init/review run
```

No new workspace package (Q11). Whether `@warden/context` or `@warden/index` ever exists is M7+'s call when the documented split triggers fire.

## Package boundaries to honor

- All M6 code lives in `@warden/core`, `@warden/db`, `@warden/ai`, `@warden/cli`. No new workspace package.
- `@warden/core` stays I/O-pure per ADR-0013 in spirit. `init/walk.ts` reads files (it has to — that's the walk phase). `init/ensure-gitignore.ts` writes one file at a known path (deterministic; not stdout). `core/banner/` returns metadata objects; the *render* of the banner is `@warden/cli`'s job.
- `@warden/ai` adds embeddings alongside LLM dispatch. `EmbeddingProvider` interface mirrors `LanguageModel` shape. Voyage SDK (or `@ai-sdk/voyage` if compatible — verify at impl time) is added to `@warden/ai`'s `dependencies`. `@warden/core` never imports Voyage SDK directly — always through `@warden/ai`.
- `@warden/db` gets five new schema files. Re-export from `packages/db/src/schemas.ts`. `pnpm db:generate` produces a single migration. **Never `db:push`** outside local exploration (CLAUDE.md rule).
- `@warden/env` validates `VOYAGE_API_KEY` as required when `init` or `review` is the active verb (mirrors `ANTHROPIC_API_KEY` handling). `check` does not require it (deterministic-only verb; doesn't touch the index).
- `code-chunk` is added to `@warden/core` `dependencies`. Pin exact version (e.g., `"code-chunk": "0.1.14"`).

## What to build

### 1. `EmbeddingProvider` interface + Voyage impl (`packages/ai/src/embeddings/`)

Public shape:

```ts
// interfaces.ts
export interface EmbedRequest {
  inputs: string[];
  inputType: "document" | "query";
}

export interface EmbedResponse {
  vectors: Float32Array[];
  modelId: string;          // echoed from provider, e.g. "voyage-code-3"
  modelVersion: string;     // shape we control: "dim=1024;type=document"
  promptTokens: number;     // cost accounting
}

export interface EmbeddingProvider {
  modelId(): string;            // current SKU
  modelVersion(inputType: "document" | "query"): string;
  embed(req: EmbedRequest): Promise<EmbedResponse>;
  /** Voyage's max inputs per request, or our chosen cap. */
  maxBatchSize(): number;
  /** Voyage's per-input token limit. */
  maxInputTokens(): number;
}

// voyage-models.ts
export type VoyageModelMeta = {
  defaultSince: string;        // ISO date when this SKU became Warden's default
  deprecatedAfter: string | null;  // ISO date if Voyage announces EOL
  outputDim: number;           // 1024 for voyage-code-3
  maxInputTokens: number;      // 32_000 for voyage-code-3
};

export const VOYAGE_MODELS: Record<string, VoyageModelMeta> = {
  "voyage-code-3": {
    defaultSince: "2025-02-01",
    deprecatedAfter: null,
    outputDim: 1024,
    maxInputTokens: 32_000,
  },
};

export const CURRENT_DEFAULT = "voyage-code-3";
```

`VoyageProvider` impl:

- Use Voyage's official Node SDK if mature, or `@ai-sdk/voyage` if it exposes embeddings. **Verify at impl time** — read `node_modules/.pnpm/*/node_modules/<pkg>/dist/*.d.ts` to inspect actual API. Do not guess from training data.
- Batch inputs per `maxBatchSize()` (Voyage's max is 128). Input-token guards via cheap `chars/4` heuristic; if a chunk is over `maxInputTokens()`, log it to `degradedWorkers` and skip (shouldn't happen — `code-chunk` chunks are bounded).
- Retry policy mirrors ADR-0017 in spirit: 1s backoff, ≤3 retries on HTTP 429/5xx/network. Hard fail on auth/quota errors after retries exhausted.
- `modelVersion("document")` returns `"dim=1024;type=document"`; `modelVersion("query")` returns `"dim=1024;type=query"`. Distinct on purpose — query embeddings are not cached but the version handle stays honest.

`getEmbeddingProvider()` factory in `embeddings/index.ts` reads `VOYAGE_API_KEY` via `wardenEnv()` and constructs `VoyageProvider`. Fails fast if the key is unset — same shape as `getBossModel()` does for Anthropic. Mirrors LLM dispatcher pattern.

### 2. Chunker interface + `code-chunk` adapter (`packages/core/src/context/chunker.ts`)

Public shape:

```ts
export interface ChunkRecord {
  /** sha256(content) — content-addressed primary key. */
  chunkHash: string;
  /** Repo-relative POSIX path. */
  filePath: string;
  /** SHA of the file's content this chunk was extracted from. */
  fileSha: string;
  /** code-chunk's detected language (typescript|javascript|python|rust|go|java). */
  language: string;
  /** Best-effort symbol path: ["ClassFoo", "method bar"]. May be empty. */
  symbolPath: string[];
  startLine: number;
  endLine: number;
  /** Raw chunk content; what gets sent to Voyage. */
  content: string;
}

export interface Chunker {
  chunk(filePath: string, fileContent: string, fileSha: string): Promise<ChunkRecord[]>;
  supportedLanguages(): readonly string[];
  detectLanguage(filePath: string): string | null;  // null = unsupported, skip
}
```

`CodeChunkAdapter` impl:

- Wraps `code-chunk`'s `chunk(filepath, code, options)` API.
- WASM tree-sitter backend (`web-tree-sitter`) for cross-platform reliability — native bindings can ship later via config. Verify: `code-chunk`'s default backend selection at impl time.
- `chunkHash = sha256(record.content)`. No whitespace normalization — Q4's locked-in choice.
- `fileSha` is computed by the caller (`init/walk.ts` does this once per file and passes it through).
- Files in unsupported languages return `[]`. They still appear in M5 cheap-signals (paths-only same-folder, etc.) — they just don't contribute semantic hits.
- Per-file chunk count cap: if AST yields >100 chunks for a single file, log to `degradedWorkers` and fall back to `[]` (something pathological). Prevents a single generated file from blowing out the embedding budget.

**No `code-chunk` import outside `chunker.ts`.** Same discipline as M5's `parser.ts` for `typescript`. The fork-to-`@warden/chunker` swap (if/when fork triggers fire) is then a single-file change.

### 3. Cache schemas (`packages/db/src/schema/`)

`chunks.ts`:

```ts
export const chunks = sqliteTable("chunks", {
  chunkHash:  text("chunk_hash").primaryKey(),
  filePath:   text("file_path").notNull(),
  fileSha:    text("file_sha").notNull(),
  language:   text("language").notNull(),
  symbolPath: text("symbol_path_json").notNull(),  // JSON.stringify(string[])
  startLine:  integer("start_line").notNull(),
  endLine:    integer("end_line").notNull(),
  content:    text("content").notNull(),
  createdAt:  integer("created_at", { mode: "timestamp" }).notNull().default(sql`CURRENT_TIMESTAMP`),
});
```

`embeddings.ts`:

```ts
export const embeddings = sqliteTable("embeddings", {
  chunkHash:    text("chunk_hash").notNull(),
  modelId:      text("model_id").notNull(),
  modelVersion: text("model_version").notNull(),
  vector:       blob("vector").notNull(),  // Float32Array → Buffer
  createdAt:    integer("created_at", { mode: "timestamp" }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (t) => ({
  pk: primaryKey({ columns: [t.chunkHash, t.modelId, t.modelVersion] }),
}));
```

`merkle.ts`:

```ts
export const merkle = sqliteTable("merkle", {
  /** Repo-relative POSIX path or directory path. */
  nodePath: text("node_path").primaryKey(),
  /** sha256 of file content (leaf) or aggregate of children (interior). */
  hash: text("hash").notNull(),
  kind: text("kind", { enum: ["file", "dir"] }).notNull(),
  observedAt: integer("observed_at", { mode: "timestamp" }).notNull().default(sql`CURRENT_TIMESTAMP`),
});
```

`jobs.ts`:

```ts
export const jobs = sqliteTable("jobs", {
  /** Content-addressed task id: sha256(taskKind + ':' + sortedInputsJson). */
  taskId: text("task_id").primaryKey(),
  taskKind: text("task_kind").notNull(),  // "embed_chunk" for v0
  inputsJson: text("inputs_json").notNull(),
  status: text("status", { enum: ["pending", "in_progress", "done", "failed"] }).notNull(),
  errorMessage: text("error_message"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`CURRENT_TIMESTAMP`),
  completedAt: integer("completed_at", { mode: "timestamp" }),
});
```

`index-meta.ts`:

```ts
export const indexMeta = sqliteTable("index_meta", {
  key:   text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`CURRENT_TIMESTAMP`),
});
```

Documented keys (constants in `core/indexing/meta.ts`):
- `embedding_model_id` → `"voyage-code-3"`
- `embedding_model_version` → `"dim=1024;type=document"`
- `embedding_locked_at` → ISO date string
- `format_version` → `"1"`
- `repo_merkle_root` → current root hash

Re-export all five from `packages/db/src/schemas.ts`. Run `pnpm db:generate` — produces a `*.sql` file in `packages/db/src/migrations/`. Run `pnpm db:migrate` to apply locally.

### 4. Storage interfaces + SQLite impls (`packages/core/src/indexing/`)

`interfaces.ts` — pure types, no Drizzle imports:

```ts
export interface ChunkStore {
  upsert(chunk: ChunkRecord): Promise<void>;
  getByHash(chunkHash: string): Promise<ChunkRecord | null>;
  getByFile(filePath: string, fileSha: string): Promise<ChunkRecord[]>;
  count(): Promise<number>;
}

export interface EmbeddingStore {
  upsert(record: {
    chunkHash: string;
    modelId: string;
    modelVersion: string;
    vector: Float32Array;
  }): Promise<void>;
  getByHash(chunkHash: string, modelId: string, modelVersion: string): Promise<Float32Array | null>;
  /** Cosine-similarity search; returns [{chunkHash, similarity}] sorted desc, capped at topK. */
  search(query: Float32Array, modelId: string, modelVersion: string, topK: number): Promise<{ chunkHash: string; similarity: number }[]>;
  count(modelId: string, modelVersion: string): Promise<number>;
}

export interface MerkleStore {
  upsertNode(node: { nodePath: string; hash: string; kind: "file" | "dir" }): Promise<void>;
  getRoot(): Promise<string | null>;
  /** Returns paths whose stored hash differs from the supplied set. */
  diff(currentHashes: Map<string, string>): Promise<{ changed: string[]; missing: string[]; new: string[] }>;
}

export interface JobRunner {
  /** Run a batch of tasks with concurrency limit. Idempotent: tasks already 'done' are no-ops. */
  run<TInput, TOutput>(tasks: Task<TInput, TOutput>[]): Promise<TOutput[]>;
  /** Resume in-progress tasks from a previous interrupted run. */
  pending(taskKind: string): Promise<Task<unknown, unknown>[]>;
}

export interface IndexExporter {
  /** Stream every chunk + embedding + merkle row + manifest to a writable stream. */
  exportAll(stream: NodeJS.WritableStream): Promise<{ counts: { chunks: number; embeddings: number; merkleNodes: number } }>;
}

export interface IndexImporter {
  importAll(stream: NodeJS.ReadableStream, opts: { mode: "merge" | "replace" }): Promise<{ counts: { chunks: number; embeddings: number; merkleNodes: number } }>;
}
```

SQLite impls (`chunk-store.ts`, `embedding-store.ts`, `merkle-store.ts`, `job-runner.ts`, `exporter.ts`, `importer.ts`):

- All read/write through `@warden/db`'s `db()` accessor.
- `EmbeddingStore.search()`: SQLite has no native vector search. Load all embeddings for `(modelId, modelVersion)` into memory, compute cosine similarity in JS, sort, slice. Acceptable for v0 (5k-file repo = ~50k embeddings = ~200MB resident in memory — borderline, but cold-start is once per review). If memory pressure shows up in dogfood, load in chunks and stream-compute. Don't pre-optimize.
- `MerkleStore.diff()`: take the current file→hash map (from `init/walk.ts`'s pass), compare against stored rows, return `{ changed, missing, new }`. The banner consults this.
- `JobRunner` default impl: SQLite-backed task table for crash recovery. `run()` upserts pending tasks, executes via concurrency-limited promise pool (4 in-flight by default, hardcoded), marks done/failed. `pending()` returns tasks that are `pending` or `in_progress` from a prior interrupted run — re-running picks them up via content-addressed `taskId`.
- `IndexExporter.exportAll()` / `IndexImporter.importAll()`: implement against a streaming JSONL+manifest format mentally (per Q8's deferred CLI design), but **don't expose CLI verbs**. The interfaces are callable; no argv plumbing in M6.

### 5. Locked-model meta helpers (`packages/core/src/indexing/meta.ts`)

```ts
export const META_KEYS = {
  EMBEDDING_MODEL_ID: "embedding_model_id",
  EMBEDDING_MODEL_VERSION: "embedding_model_version",
  EMBEDDING_LOCKED_AT: "embedding_locked_at",
  FORMAT_VERSION: "format_version",
  REPO_MERKLE_ROOT: "repo_merkle_root",
} as const;

export async function readLockedModel(): Promise<{ modelId: string; modelVersion: string; lockedAt: Date } | null>;
export async function writeLockedModel(modelId: string, modelVersion: string): Promise<void>;
export async function readRepoMerkleRoot(): Promise<string | null>;
export async function writeRepoMerkleRoot(root: string): Promise<void>;
export async function readFormatVersion(): Promise<number>;
export async function writeFormatVersion(version: number): Promise<void>;
```

`format_version` is `1` for M6. Bumping requires explicit migration logic (not implicit). ADR-worthy when bumped.

### 6. `warden init` orchestration (`packages/core/src/init/`)

`walk.ts`:

- Use `git ls-files` for tracked files (skips `.gitignore`d paths automatically — including `node_modules`).
- For each file: compute `fileSha = sha256(fileContent)`.
- Return `Map<filePath, { content: string; fileSha: string; loc: number }>`.
- If `git` is unavailable (rare; pristine CI containers), fall back to `fs.readdirSync` recursive with hardcoded skip list (`node_modules`, `.git`, `dist`, `build`, `.turbo`, `.next`). Surface in `degradedWorkers`.

`estimate.ts`:

```ts
export const ESTIMATE_CONSTANTS = {
  /** Avg LOC per chunk based on `code-chunk` defaults. Re-tune from dogfood data. */
  LOC_PER_CHUNK: 30,
  /** Avg tokens per chunk (~chars/4 for code). */
  TOKENS_PER_CHUNK: 375,
  /** Voyage seconds per batched request, observed average. */
  SECONDS_PER_BATCH: 1.0,
  /** Per ADR-0019 decision 4: 4 concurrent Voyage batches. */
  CONCURRENCY: 4,
  /** Voyage's max inputs per batch. */
  BATCH_SIZE: 128,
  /** Voyage pricing per 1M tokens (USD), pinned to model_id. */
  USD_PER_M_TOKENS: { "voyage-code-3": 0.18 } as Record<string, number>,
};

export function estimateInit(input: {
  totalLoc: number;
  fileCount: number;
  alreadyCachedChunks: number;
  modelId: string;
}): {
  estimatedChunks: number;
  estimatedTokens: number;
  estimatedUsd: number;
  estimatedSeconds: number;
};
```

Constants pinned in one file so re-tuning is easy. ADR-0019's "first dogfood run" updates these.

`index.ts` orchestrates:

1. **Phase 1 — walk.** Call `walk()`. Compute aggregate LOC. Print walk summary.
2. **Pre-flight estimate panel.** Call `estimateInit()`. Print panel:
   ```
   Estimated work:
     Chunking      ~5s          ≈ 12,400 chunks (~30 LOC/chunk)
     Embedding     ~45s         ≈ 4.6M tokens · ≈ $0.83
     Total ETA     ~50s         (first run; subsequent runs near-instant)
   ```
   If `--max-cost` is set and estimate exceeds, abort here with non-zero exit.
3. **Phase 2 — chunk.** Iterate files; for each, call `chunker.chunk()`. Upsert into `ChunkStore`. Track count.
4. **Phase 3 — embed.** Determine which `chunk_hash`es lack an embedding under `(CURRENT_LOCKED_MODEL_ID, CURRENT_LOCKED_MODEL_VERSION)`. Batch into Voyage requests via `JobRunner.run()`. Persist vectors to `EmbeddingStore`. Show observed-throughput ETA every 10 batches.
5. **Update Merkle.** Recompute repo Merkle root from current file hashes; write to `index_meta`.
6. **Lock model on first init.** If `index_meta.embedding_model_id` unset → write `CURRENT_DEFAULT` and current `modelVersion("document")`. Set `embedding_locked_at = now`.
7. **`--rebuild` semantics.** Drop `embeddings` rows for current locked `(modelId, modelVersion)`. Switch locked model to `CURRENT_DEFAULT`. Re-embed all chunks under new model.
8. **`--dry-run` semantics.** Run Phases 1+2 normally; skip Phase 3 entirely. Print estimate panel as the final output.
9. **Completion summary.**
   ```
   ✓ Index ready in 47s
     ─ 1,247 files · 12,408 chunks
     ─ 12,108 cached · 300 newly embedded
     ─ Storage: 6.2 MB embeddings, 0.4 MB chunk metadata, 1.1 MB Merkle
     ─ 3 transient errors retried
   ```

`ensure-gitignore.ts`:

- Read `<repoRoot>/.gitignore` if it exists.
- If no entry matches `^\.warden/?$` (regex over each line), append:
  ```
  
  # warden
  .warden/
  ```
- If file doesn't exist, create with that exact content (no presumption of other entries).
- Returns `{ added: boolean }`. Caller surfaces `"gitignore: added .warden/ entry"` to `degradedWorkers` only on `true`.

Idempotent. Called from `init`, `review`, and `check` — first verb a user runs in a repo gets the entry.

### 7. Banner state computation (`packages/core/src/banner/index.ts`)

```ts
export type BannerState =
  | { kind: "no-banner" }
  | { kind: "no-index" }
  | { kind: "stale"; filesChanged: number }
  | { kind: "model-aged"; indexedModel: string; currentDefault: string; ageDays: number }
  | { kind: "model-deprecated"; indexedModel: string; deprecatedAfter: string };

export type SoftNotice =
  | { kind: "model-soft"; indexedModel: string; currentDefault: string; estimatedRebuildUsd: number };

export async function computeBannerState(input: {
  repoRoot: string;
  currentDefault: string;
}): Promise<BannerState>;

export async function computeSoftNotice(input: {
  repoRoot: string;
  currentDefault: string;
}): Promise<SoftNotice | null>;
```

`computeBannerState()` is called by `review` (NOT by `check`). Returns:
- `no-index` if `chunks` table is empty.
- `stale` if `MerkleStore.diff()` returns any changed/missing/new files.
- `model-deprecated` if locked model's `deprecatedAfter` ≤ now.
- `model-aged` if `(now - VOYAGE_MODELS[CURRENT_DEFAULT].defaultSince) > 6 months` AND locked ≠ current.
- `no-banner` otherwise.

`computeSoftNotice()` is called by `init` only. Returns `model-soft` if locked ≠ `CURRENT_DEFAULT` AND not already triggering `model-aged` / `model-deprecated`. Surfaced as a one-time print in `init` output, never in `degradedWorkers`.

### 8. Selector v2 — semantic signal (`packages/core/src/context/signals/semantic.ts`)

```ts
export interface SemanticSignalInput {
  diff: string;
  embeddingProvider: EmbeddingProvider;
  embeddingStore: EmbeddingStore;
  chunkStore: ChunkStore;
}

export async function semanticSignal(input: SemanticSignalInput): Promise<{
  hits: Map<string /* filePath */, { chunkHash: string; similarity: number; startLine: number; endLine: number }[]>;
  degraded: string[];
}>;
```

Flow:
1. Embed `diff` via `embeddingProvider.embed({ inputs: [diff], inputType: "query" })`.
2. Search `embeddingStore.search(queryVector, lockedModelId, lockedModelVersion, topK=50)`.
3. Drop similarity < 0.5.
4. For each hit, look up chunk metadata via `chunkStore.getByHash()`. Aggregate by `filePath`, retain max similarity per file.
5. Return `Map<filePath, [{ chunkHash, similarity, startLine, endLine }]>`. Caller (selector) converts to `{ kind: "semantic", chunkHash, similarity, evidence: [{ startLine, endLine }] }` reasons.

Failure modes:
- Voyage API failure → return `{ hits: new Map(), degraded: ["context: voyage 5xx, semantic signal disabled this run"] }`. Selector composes M5 cheap-signals only.
- Empty index → return empty hits + `degraded` with `"context: no embeddings yet — run \`warden init\`"`. Cheap-signals carry the review.
- Locked-model mismatch (shouldn't happen — we always use locked for queries): if it does, fail loud with a clear assertion error.

Update `CheapSignalsSelector` (rename to `HybridSelector`? or keep name and add an internal method) to:
1. Run M5 signals (existing behavior).
2. Run `semanticSignal()` in parallel (independent inputs).
3. Merge: each file's `reasons[]` array gets new semantic reason appended if hit.
4. Recompute file scores via updated `MAX_REASON_WEIGHT_SUM = 3.6` and intensity-scaled semantic contribution.

Score formula update:

```ts
function scoreCandidate(reasons: Reason[]): number {
  let weighted = 0;
  for (const reason of uniqueByKind(reasons)) {
    const w = REASON_WEIGHTS[reason.kind];
    if (reason.kind === "semantic") {
      weighted += w * reason.similarity;
    } else {
      weighted += w;
    }
  }
  return weighted / MAX_REASON_WEIGHT_SUM;
}

export const REASON_WEIGHTS = {
  "imported-by": 1.0,
  semantic:      0.9,
  imports:       0.8,
  "symbol-ref":  0.6,
  "same-folder": 0.3,
} as const;

export const MAX_REASON_WEIGHT_SUM = 3.6;
```

`MAX_CONTENT_BEARING` stays 8. Same-folder cap stays 12.

Renaming `CheapSignalsSelector`: defer. Keep the M5 name; the class internally composes both layers. Renaming risks churn in docs and consumer code. If it's ugly enough at impl time to bother, rename in a follow-up commit.

### 9. Pipeline wiring updates (`packages/core/src/index.ts`)

`review()` flow updates:

```ts
// After existing ecosystem detection:
const gitignoreResult = await ensureGitignore(input.repoRoot);
const ensureGitignoreDegradation = gitignoreResult.added ? ["gitignore: added .warden/ entry"] : [];

// Banner state (review only — check skips this):
const bannerState = input.config.mode === "review"
  ? await computeBannerState({ repoRoot: input.repoRoot, currentDefault: CURRENT_DEFAULT })
  : { kind: "no-banner" as const };

// Selector — now needs embedding access for semantic signal:
const selector = input.selector ?? new CheapSignalsSelector({
  db,
  parser: new TsCompilerParser(),
  embeddingProvider: input.config.mode === "review" ? getEmbeddingProvider() : null,
  embeddingStore: input.config.mode === "review" ? new SqliteEmbeddingStore(db) : null,
  chunkStore: input.config.mode === "review" ? new SqliteChunkStore(db) : null,
});

// ...rest of pipeline unchanged from M5 except:
const degraded = [
  ...ensureGitignoreDegradation,
  ...tscResult.degraded,
  // ...existing,
  ...selectorResult.degraded,
  ...bannerStateToDegraded(bannerState),  // banner enters degradedWorkers per Q7
];
```

`bannerStateToDegraded()` translates banner states to structured `degradedWorkers` entries:
```ts
{ kind: "context", state: "no-index" }
{ kind: "context", state: "stale", filesChanged: 3 }
{ kind: "context", state: "model-aged", indexedModel: "voyage-code-3", currentDefault: "voyage-code-3.1", ageDays: 245 }
{ kind: "context", state: "model-deprecated", indexedModel: "voyage-code-2", deprecatedAfter: "2026-12-01" }
```

`check` flow: only adds `ensureGitignoreDegradation`. Banner not computed. Selector not invoked for semantic signal (cheap signals only).

### 10. CLI command — `warden init` (`packages/cli/src/commands/init.ts`)

Argv shape:

```
warden init                     # idempotent; skips work for already-cached chunks
warden init --rebuild           # drop locked-model embeddings, switch to CURRENT_DEFAULT, re-embed
warden init --dry-run           # Phases 1+2 only; print estimate; no API calls
warden init --max-cost 0.50     # abort before Phase 3 if estimate exceeds USD value
```

Delegates to `core/init.run({ repoRoot, options, emit })` where `emit` is a phase-event listener for the render layer. Same pattern M4 used for `formatReview`'s streaming events.

`packages/cli/src/render.ts` gains:
- A three-phase progress component (walk → chunk → embed). Reuses M4's phase-log render where possible.
- Banner rendering for `review` (one yellow-toned dim line above the phase log).
- Soft-notice rendering for `init` (one informational line near the completion summary).

### 11. README data-flow section

Add a "Data flow" section to `README.md` after the "Quickstart" / "Commands" section. Verbatim copy of the local-vs-remote table from Q6 (with light prose framing). Lands when M6 ships, not before.

The table:

| Stays on your machine | Sent over the network |
|---|---|
| Source code (Warden never modifies repo files) | Chunk text → Voyage during `warden init` |
| `.warden/cache.sqlite` (chunks, embeddings, merkle, jobs, M5 caches, M4 cache) | Diff content → Voyage (query-side) during `warden review` |
| API keys (env vars only) | Diff + tool findings + retrieved excerpts → Anthropic (or Google fallback) during `warden review` |
| Tool output (TSC, ESLint, jscpd, npm-audit) | (no telemetry; no call-home) |

Plus a one-paragraph "what this means" framing: chunks of source travel to Voyage to produce embeddings; embeddings come back to local; Voyage doesn't retain inputs per their ToS but the bits do traverse their infrastructure. Diffs go to Anthropic/Google for the LLM review (already true since M4). The `.warden/cache.sqlite` itself stays local. Users with sensitive code should be aware of what crosses the wire before running `warden init`. Local-fallback embedding (Transformers.js) is on the M7+ roadmap for sensitive-code use cases.

## Conventions to enforce from day one (M6-specific)

- **Selector composes paths + reasons; never reads file content for prompt assembly.** Same M5 rule. Semantic signal queries the `EmbeddingStore` (vectors, not files); chunk content is only read by `prompt.ts` when assembling evidence ranges (already M5's pattern).
- **Cache rows are immutable.** Same M5 rule extended: never `UPDATE` an `embeddings` or `chunks` row; always `INSERT OR IGNORE` keyed by content-addressed columns.
- **No `code-chunk` import outside `chunker.ts`.** Same shape as M5's `typescript`/`parser.ts` rule.
- **No Voyage SDK import outside `@warden/ai/embeddings/voyage.ts`.** All Voyage interaction goes through the `EmbeddingProvider` interface.
- **Locked model is sticky.** Incremental embeds always use the locked model. Only `--rebuild` switches it. Reading the locked model is the FIRST thing any embedding-related code does.
- **`format_version` bumps are ADR-worthy.** Single key/value table makes it cheap to read; don't make it cheaper to *change* than it should be.
- **Score weights and thresholds are constants in v1.** No flag plumbing for `topK`, `similarityThreshold`, `MAX_CONTENT_BEARING`, etc. Defer config surface until dogfooding shows defaults are wrong.
- **`warden init` never runs implicitly.** No "if no index, build one automatically" inside `review` — that's Model B (deferred). Banner is the explicit nudge.
- **Estimate constants live in one file** (`init/estimate.ts`). Re-tune from dogfood; never sprinkle magic numbers across the init pipeline.
- **`VOYAGE_MODELS` registry is the single source of truth for SKU metadata.** Adding a new SKU is one entry + (optionally) bumping `CURRENT_DEFAULT`. Stale `defaultSince` dates corrupt D-aged math; pin honestly.

## Acceptance criteria for M6

When all of these pass, M6 is done:

- `pnpm check-types` passes.
- `pnpm lint` (oxlint) passes.
- `pnpm db:generate` produces a migration containing all five new tables; `pnpm db:migrate` applies cleanly to a local `.warden/cache.sqlite`.
- `pnpm warden init` on a TS Turborepo:
  1. Walks files, prints pre-flight estimate panel.
  2. Chunks via `code-chunk`; persists to `chunks` table.
  3. Embeds via Voyage; persists to `embeddings` table under locked model.
  4. Writes `index_meta` rows on first init (locked model + locked_at + format_version + repo_merkle_root).
  5. Subsequent runs are near-instant (cache hits skip Voyage; merkle catches changes).
  6. Ctrl-C mid-Phase-3 followed by re-run resumes correctly (no duplicate embeds, no lost progress).
- `pnpm warden init --rebuild` drops embeddings under current locked model, switches locked model to `CURRENT_DEFAULT`, re-embeds. `embeddings` table now has both old and new model_version rows; old ones unreachable but not deleted.
- `pnpm warden init --dry-run` runs Phases 1+2, prints estimate, skips Phase 3 entirely. Zero Voyage API calls.
- `pnpm warden init --max-cost 0.10` aborts before Phase 3 with non-zero exit when estimate exceeds. `chunks` table populated; `embeddings` not touched.
- `pnpm warden review` on the same repo:
  1. After `init`, banner is silent (state C).
  2. Without `init`, banner fires (state A) with copy `! No index. Run \`warden init\` once for context-aware findings.` Selector falls back to M5 cheap-signals + jscpd.
  3. After edits to a file post-`init`, banner fires (state B) with file count. Review proceeds with cached embeddings for unchanged files; cheap-signals only for changed files.
  4. Selector v2 produces `Reason` arrays containing both M5 reason variants and new `{ kind: "semantic" }` entries when relevant.
  5. LLM prompt includes evidence ranges from semantic hits (max chunk per file) alongside M5's existing evidence assembly.
- `pnpm warden check` is unchanged in behavior. Banner doesn't fire on `check`. `ensureGitignore()` runs and adds the entry on first invocation.
- First Warden invocation in a fresh target repo (any verb) creates/appends `.warden/` to `.gitignore` with a `# warden` comment. `degradedWorkers` reflects on first add only.
- D-soft notice surfaces in `warden init` output when `CURRENT_DEFAULT` is bumped to a new SKU and existing index is on the prior SKU. Not in `degradedWorkers`.
- D-aged banner fires in `warden review` after manually backdating `defaultSince` of `CURRENT_DEFAULT` to >6 months ago in `VOYAGE_MODELS` (smoke-test path). `degradedWorkers` reflects structured entry.
- `IndexExporter.exportAll(stream)` and `IndexImporter.importAll(stream)` both work end-to-end on a populated index. CLI verbs are NOT exposed; tests/scripts directly construct + invoke. Round-trip (export → drop tables → import in `merge` mode) reproduces the same row counts.
- `pnpm warden review` Voyage failure (simulate via temporarily invalid `VOYAGE_API_KEY` mid-run): degrades to M5 cheap-signals + `degradedWorkers` entry; does NOT hard-fail review.
- README has a "Data flow" section with the local-vs-remote table.
- Run on Alfred, milkpod, blair (or any other dogfood Turborepo). Confirm review-quality improvement vs. M5 baseline by reading the comments produced. Subjective — the user is the eval signal per ADR-0001.
- All M4 + M5 acceptance criteria still pass (no regression).

## What NOT to do in this milestone

- **Do not implement cross-repo retrieval, `node_modules` indexing, or `.d.ts` chunking.** All M7+. Vulnerability detection on dependencies stays runtime via M3's npm-audit + OSV path.
- **Do not implement the `leverage` review category.** Depends on cross-repo indexing.
- **Do not ship the custom-code SAST worker (DeepSec-shaped per ADR-0015).** M7+ at earliest.
- **Do not ship `warden index export` / `warden index import` CLI verbs.** Q8 (β) — interfaces only.
- **Do not ship a real async `JobRunner`** (worker pool, daemon, `warden daemon` command). Sync default with concurrency-limited promise pool only.
- **Do not implement Model B/C JobRunner timing** (review-time incremental embed / background subprocess). Model A only.
- **Do not implement BYOEmbedder** (multi-provider support, `--model X` flag, per-user model selection). One impl: Voyage. Future direction noted.
- **Do not implement query-embedding caching.** One Voyage call per review is free.
- **Do not implement per-symbol semantic ranking, multi-vector queries, or hybrid BM25+semantic.** All M7+.
- **Do not implement reranking with a second model** (Cohere-rerank, LLM-rerank, etc.).
- **Do not split `@warden/context` or `@warden/index` into separate packages.** Documented split triggers fire later.
- **Do not auto-rebuild on Voyage SKU bump.** D-soft / D-aged / D-deprecated states surface awareness; user runs `--rebuild` explicitly.
- **Do not introduce interactive prompts** anywhere — `init` cost confirmation is a non-interactive printed estimate; `--max-cost` is the abort flag. Per ADR-0014.
- **Do not introduce telemetry / call-home.** Same posture as M5.
- **Do not introduce a `--watch`, `--background`, or `--silent` flag on `init`.** Reduced-meaning verbs are usability debt (per ADR-0018 nuance #4 generalized).
- **Do not write tests** (per memory: no test culture on personal repos). Smoke scripts under `packages/cli/scripts/smoke-m6-*.mts` if needed for first-time setup verification.
- **Do not introduce tree-sitter as a *parsing* layer for M5's import graph.** That stays on TS Compiler API. `code-chunk`'s tree-sitter is for *chunking*, a separate concern.
- **Do not pre-emptively fork `code-chunk`.** Pin version; documented fork triggers fire later.
- **Do not normalize whitespace in chunk content before hashing.** Whitespace changes are real changes.

If you reach for any of the above, stop and re-read ADR-0019 — those are explicitly deferred.

## Design nuances captured during planning (for blog material)

These are the non-obvious insights from the M6 grilling. Worth preserving here because they're the kind of thing you only see by walking the design tree carefully — not what appears in the final ADR text. Pull into a blog post about implementing context selection's semantic layer in a one-shot CLI without committing to local embeddings.

1. **The locked-model concept is what makes hosted embeddings viable for a CLI.** Without it, every Voyage SKU bump becomes a forced re-embed event ($X cost, Y minutes wait) from the user's perspective — surprise costs erode trust. With it, the index stays internally consistent regardless of what Warden's current default is. Voyage 3 → 3.1 is a non-event unless the user opts in. The asymmetry — locked stays the same, query embeds match locked — is what prevents vector-space mixing while preserving the user's agency. This insight only emerges when you walk the "what happens when Voyage ships 3.1?" branch carefully.

2. **Content-addressing dissolves "cache invalidation" into "change detection."** Same M5 nuance, generalized: a `(chunk_hash, model_id, model_version)`-keyed embedding row is forever-valid for that exact content under that exact setup. Stale rows become unreachable, never wrong. The question shifts from "how do I invalidate?" to "how do I cheaply know the current state?" — and the answer is Merkle for chunks, file SHA for chunk content, registry for SKU drift. Three different change-detection oracles for three different layers; no single mechanism does all jobs.

3. **Hosted embeddings invert ADR-0007's local-first stance, but the storage discipline survives.** ADR-0007 said "local-first; never auto-flips." M6 ships hosted embeddings (chunks travel to Voyage). The reconciliation: data residency was load-bearing for the *cache*, not for the *embedding-generation network call*. Cached artifacts stay local; the network call is a service consumption, not residency. Documenting this distinction in the data-flow section is what keeps the trust property intact even though the literal claim shifts.

4. **`warden init` would have semantic drift if M5 had shipped it (per ADR-0018), but ships cleanly in M6 because its full meaning lands together.** M5 deferring `init` was the right call: a verb that warmed only the import-graph cache would have to expand at M6. Now in M6, `init` does walk + chunk + embed + merkle + lock-model — its complete contract. Future expansion (BYOEmbedder, Merkle-chunk-level, etc.) extends the *body* of init, not its shape. Verbs are commitments; reduced-meaning early versions are usability debt — but the inverse is also true: shipping a verb at the moment its meaning is complete is exactly when verbs earn their keep.

5. **Intensity scaling for semantic, binary for cheap signals — the data shape decides the scoring shape.** M5 scored cheap signals binary (a file either imports another or doesn't) because that's the data shape. Semantic gets intensity scaling because cosine similarity is inherently a calibrated 0–1 number. Forcing semantic to binary throws away calibration; allowing cheap signals to scale invents intensity that doesn't exist in the data. The principle: scoring formula should mirror data shape, not impose uniformity.

6. **The pre-flight estimate is high-value-per-line-of-code.** Five constants in one file (`LOC_PER_CHUNK`, `TOKENS_PER_CHUNK`, `SECONDS_PER_BATCH`, `CONCURRENCY`, `BATCH_SIZE`) plus a multiplication function produces "is this 30 seconds or 30 minutes?" answer before commit. The cost (one panel) is much smaller than the trust value (user knows what they're committing to). High-leverage UX moves often look like this: a small computation with a clear contract surfaced at the right moment.

7. **Banner gradient is honest about uncertainty.** A/B/C are deterministic facts about index state. D-soft / D-aged / D-deprecated are time-shaped advisories. Surfacing them with different visual weight (soft note in `init` only / soft banner in `review` / real banner in `review`) honors the uncertainty rather than collapsing all states into "banner / no banner." The escalation gradient is what prevents user fatigue (no nag on benign state) AND user surprise (real banner when SKU is EOL'd).

8. **Interface-ready vs. CLI-shipped is a useful axis for portability discipline.** ADR-0016 #3 wanted bulk export/import "first-class from day one" to force portability. M6 amends to "interface-ready, CLI deferred to first concrete consumer." The forcing function survives — the storage layer must support streaming export/import via interface methods, which means it can't bake SQLite-specific shortcuts. The user-facing affordance ships when there's a real consumer. Two different things; conflating them is what makes ADRs over-promise.

9. **`code-chunk` is a *consumer-of-other-libraries* posture, not a *build-our-own* trap.** Same logic ADR-0008 used for TSC, ESLint, jscpd, OSV: focused libraries handle their domains; Warden's value is the review-pipeline assembly above them. Recognizing this lets you reach for `code-chunk` without guilt about "but we could write it ourselves" — yes, we could, the source is MIT, but doing so is the same kind of category error as writing our own static analyzer.

10. **The "what crosses the wire" table earns more trust than abstract privacy claims.** Saying "Warden cares about privacy" is words. Listing exactly which bytes go to Voyage and which stay local is bytes. The discipline of writing down what each verb sends (and what it doesn't) is what makes the privacy posture real. Mirror the table to README and the M6 plan; reference it in the ADR. Trust is built by precision.

Each of these came out of walking the M6 design tree question-by-question instead of writing the plan top-down. The point of grilling is that the eventual plan is the *survivor* of decisions, not the *first draft* of them.

## When you're done

- Hand back: a list of any deviations from this plan (with reasons) and confirmation all acceptance criteria pass.
- The next session picks up at M7+ — likely some combination of cross-repo retrieval + `leverage` category + custom-code SAST worker + CLI export/import verbs + BYOEmbedder + async JobRunner. M7+'s first decision is which slice to take next; that's the next grilling's job.

---

## Lessons from M6 → M7 transition

Captured from a 2026-05-08 dogfood run: `pnpm warden init` + `pnpm warden review --stdin` against `../blair` (Next.js / TS / 117 files / 14k LOC / 319 chunks). Voyage account had no payment method, so Phase 3 short-circuited at the API edge — that itself surfaced more behavior than a clean run would have. Each lesson lists what we saw, why it matters, and the smallest fix that resolves it.

1. **There is no runtime schema migration. First `warden init` against any fresh repo dies with `no such table: index_meta`.** `db()` opens the SQLite file but never runs migrations; `pnpm db:migrate` is hardcoded to warden's *own* `.warden/cache.sqlite` via `drizzle.config.ts`. The very first thing a new user hits is the most preventable failure on the entire pipeline. Smallest fix: call `migrate(db, { migrationsFolder })` once on the singleton in `packages/db/src/index.ts`, with the migration JSON bundled into `@warden/db`'s build output. M7 blocker — every dogfood path begins here.

2. **`computeBannerState()` collapses "no chunks" and "chunks but no embeddings" into the same silent state.** Banner only fires `no-index` when `chunkCount === 0`. When chunks exist but Phase 3 failed (Voyage payment, transient outage, Ctrl-C between phases), the banner returns `no-banner` and the user sees nothing. Worse, the semantic signal *does* emit `"context: no embeddings yet — run \`warden init\`"` to `degradedWorkers`, but `renderBannerLine` only matches three prefixes (`no index`, `index stale`, `locked model`) — so even that signal stays buried. Fix: add a `no-embeddings` banner state checking `embeddingStore.count(lockedModel)` after the chunkCount guard, and either align the semantic-signal string to a banner-rendered prefix or have the renderer match `no embeddings` too. Without this, partial-init failures look like clean runs.

3. **Voyage's "no payment method" 429 is treated as a transient HTTP error and burns 3 retries × 3 batches (~30s).** The retry classifier in `voyage.ts` keys on HTTP status, not body. 429 + `{"detail":"You have not yet added your payment method..."}` is permanent for the session — retrying just re-confirms the same answer slowly. Fix: peek at the response body for `payment` / `quota` / `account` markers and short-circuit. Same posture would help the auth-error path.

4. **The embed phase shows a featureless spinner for ~30s before the first `chunk-progress` event.** Cause: `onProgress` only fires when a task *completes*, and the first task takes the full 3-retry-backoff window. The user sees `embed…` and nothing else, then suddenly `1/3 batches` after half a minute — which on a real failed-payment account is indistinguishable from a hang. Fix: emit `embed-progress` once on `phase-start` with `completed: 0, total: <batches>` so the renderer can paint the denominator immediately. Cheap change, big perceived-responsiveness win.

5. **Init summary line conflates the chunk cache with the embedding cache.** `"319 cached · 0 newly embedded"` reads as "319 embeddings already on disk." It actually means "the `chunks` table had 319 rows before this run." When Phase 3 fails wholesale, the summary ships `cached=N, newly=0, failed=M` and looks reassuring. Fix: split `summary.cachedChunks` from `summary.cachedEmbeddings` (we already have `cachedHits` on the `embed-complete` event — just thread it through to the summary), and let the render line mirror the split: `319 chunks (319 cached) · 0 / 319 embeddings · 3 failed`.

6. **The CLI banner prints *after* the phase log + comments, but the source comment in `packages/cli/src/index.ts` says it prints before.** ADR-0019 #7 conceptually wants it pre-phase ("you're about to read findings produced without a fresh index"); the implementation puts it post-everything where users have already read the comments. Fix is one block-move in `runReview()`. Also document the actual placement once decided — the disagreement between comment and code is the kind of thing that confuses the next reader.

7. **`degradedWorkers` is a single flat string array mixing actionable / informational / forensic entries.** A user staring at `osv: dropped 10 unverified advisories (citation discipline), context: cold import-graph build (hashing 117 files), context: cold import-graph build (parsed 117 files in Ts), context: no embeddings yet — run \`warden init\`` has to do prefix archaeology to find the one entry that requires action. The banner-renderer's prefix-match is a brittle workaround for this. M7 should give `degradedWorkers` a discriminated shape: `{ kind: "info" | "actionable" | "warning"; topic: "context" | "osv" | "gitignore" | …; message: string }`. Then the banner is a filter, not a string-startsWith hunt.

8. **`findRepoRoot()` walks to the *highest* ancestor with `package.json`, not the nearest.** Per `packages/db/src/path.ts`. If a developer has any stray `package.json` higher up the tree (a parent monorepo, a tooling sandbox, `~/Developer/package.json` for tools-installs), warden silently writes `.warden/cache.sqlite` there. On blair this happened to land correctly because there's no parent `package.json`, but it's a footgun that could surprise a user once and then never. Fix: prefer "nearest pnpm-workspace.yaml, else nearest .git, else nearest package.json (lowest, not highest), else cwd." Document the precedence in CLAUDE.md.

9. **The pre-flight estimate panel shows the unrefined number; the refined post-`whichExist` estimate is computed but never re-rendered.** First run on blair: panel said `~177.8k tokens · ≈ $0.03`. Second run (after chunks were cached): refined estimate inside `runInit` was `58.1k tokens · ≈ $0.01`, but the panel still rendered the first number. Mostly invisible at $0.03 → $0.01; potentially confusing at $50 → $5 on a big repo. Fix: emit a second `estimate` event after `whichExist` and have the renderer overwrite the panel; or only emit one estimate, post-cache-check, and skip the pre-chunk panel.

10. **The 62-finding-on-package.json:1 vulnerability dump dwarfs the one real comment.** Diff was 13 LOC across 5 files; review surfaced 1 textual finding + 61 npm-audit advisories (most pinned to `package.json:1`, none introduced by the diff). This is M3 behavior leaking into M6 dogfood, but M6 is when it becomes painful — the semantic signal's whole point is making relevant code float to the top, and it's drowned by a transitive-dependency disclosure list. Either scope npm-audit findings to packages whose entries actually appear in the diff (true diff-scoping per ADR-0008), or demote them to a single collapsed `vulnerabilities (61)` summary at the bottom of the output. M7 candidate; don't lose it because it sits "in M3."

11. **`packages/cli/scripts/smoke-m6-init.mts` is missing.** M5 has `smoke-m5-selector.mts` and `smoke-m5-jscpd.mts`; M6 ships nothing equivalent. Every dogfood started with manual `set -a && source .env && set +a && cd ../target && node --import tsx/esm …` plus a one-shot drizzle-migrate script. Smallest fix: a `smoke-m6-init.mts` that takes a target path, applies migrations, runs `runInit({ dryRun: true })`, prints summary, and a sibling `smoke-m6-review.mts` that runs review against a synthesized small diff. This is also where finding 1's runtime-migration fix can be validated before being trusted across all entry points.

12. **`gitignore` patch is the only side effect that lands before `readLockedModel()`** — and `readLockedModel()` is the call that hits the missing table. So a fresh repo gets `.gitignore` modified *and* a `.warden/cache.sqlite` created (empty, no schema), then dies. Re-running `warden init` from there hits the same crash, and the gitignore-already-added path now emits no `degradedWorkers` entry (correct), so users have no signal that *anything* succeeded. Fix is finding 1's runtime migration; secondary fix is moving `ensureGitignore` after the schema-bootstrap step so the side effects are atomic ("either everything happened or nothing did").

13. **Smoke verification on a payment-blocked Voyage account is still useful** — half the issues above (banner gap, summary wording, retry waste, spinner gap, summary-row conflation) only become visible when Phase 3 fails. The acceptance criteria's "run on Alfred / milkpod / blair" instruction implicitly assumed a happy path; the failure paths surfaced more bugs. Generalizing: add a `--simulate-fail-embed` test seam so future milestones can rehearse the failure paths without depending on a particular SaaS account state.

14. **`VoyageProvider.fetchOnce` discards the `model` field Voyage echoes in its response and stores our own `_modelId` instead.** `voyage.ts:166` returns `modelId: this._modelId` — i.e., whatever we *asked* for, not what Voyage *served*. Today this is fine: a curl confirms `voyage-code-3` round-trips identically (request says voyage-code-3, response says voyage-code-3), and the dashboard's confusing "voyage-3.5" label is just Voyage's billing UI rolling code-3 calls under the family name. But the locked-model invariant (ADR-0019 #6 — "Voyage 3 → 3.1 is a non-event unless the user opts in") *only* holds if we'd notice when it broke. If Voyage ever silently aliases voyage-code-3 → voyage-3.5 server-side (deprecation, capacity routing, A/B test), every embedding row gets written under `embedding_model_id="voyage-code-3"` while the vectors are actually from a different model. Vector-space mixing without a banner. Smallest fix: assert `json.model === this._modelId` in `fetchOnce`; on mismatch, either hard-fail (lock invariant comes first) or store Voyage's echo verbatim and emit a `phase-degraded` "voyage served X, we asked for Y — index integrity at risk." Cheap defensive check; the locked-model concept is only worth what its detection oracle is. Reasoning generalizes: any time we "trust but don't verify" what an external service says it did, the invariant we built on top of that trust is one silent change away from being false. Same posture as ADR-0008's citation discipline — claims need verifiable echoes.

These are the M7 punch list. Items 1, 2, and 8 are the order-of-magnitude blockers — every other lesson assumes you've crossed those three first.

### Addendum: validation after Voyage payment was added (same-day)

After adding a payment method, re-running `pnpm warden init` on `../blair` produced:

- 319 chunks → 319 embeddings · 105.2k tokens · 40.4s wall.
- Cost estimate constants from `init/estimate.ts` predicted ≈58.1k tokens; actual was 105.2k. Off by ~1.8×. Re-tune `TOKENS_PER_CHUNK` (currently 375) toward ~330 once we have a couple more dogfood runs to average.
- `pnpm warden review --stdin --verbose --json` on the same f04b91d diff returned `degradedWorkers: []` — semantic signal embedded the query, searched the 319-vector store, and contributed candidates with no fallback firing. End-to-end happy path validated.
- Wall-clock: 62.7s (vs. 56.7s on the failed-Voyage run) — Voyage query embed adds ~6s. Cheap enough to leave on by default.
- Finding 5 (the "319 cached" wording bug) is now visible in vivid form: post-success, the summary still says `"319 cached · 319 newly embedded"`. A fresh re-run would say `"319 cached · 0 newly embedded"` — visually identical to a wholesale-failed run. This is a real ambiguity, not a theoretical one.

So: the M6 happy path works. Items 1–13 above are still M7's job; the validation just confirms the engine is actually doing what it claims when nothing's blocking it.
