import { createHash } from "node:crypto";
import { CURRENT_DEFAULT, getEmbeddingProvider, type EmbeddingProvider } from "@warden/ai";
import { CodeChunkAdapter, type ChunkRecord, type Chunker } from "../context/chunker.js";
import {
  CURRENT_FORMAT_VERSION,
  SqliteChunkStore,
  SqliteEmbeddingStore,
  SqliteMerkleStore,
  SyncJobRunner,
  readLockedModel,
  taskIdFor,
  writeFormatVersion,
  writeLockedModel,
  writeRepoMerkleRoot,
  type ChunkStore,
  type EmbeddingStore,
  type JobRunner,
  type MerkleNode,
  type MerkleStore,
  type Task,
} from "../indexing/index.js";
import { ensureGitignore } from "./ensure-gitignore.js";
import { estimateInit, ESTIMATE_CONSTANTS, type EstimateResult } from "./estimate.js";
import { walkRepo, type WalkedFile } from "./walk.js";

/**
 * `warden init` orchestration (ADR-0019 #5). Three phases (walk → chunk →
 * embed); the CLI render layer surfaces them as a phase log. Core stays
 * I/O-pure-ish — file reads happen in `walk.ts` and the gitignore writer
 * is bounded to a known path. Stdout-shaped progress flows through the
 * `emit` callback per ADR-0013.
 */

export type InitEvent =
  | { type: "phase-start"; phase: "walk" | "chunk" | "embed" }
  | { type: "walk-complete"; fileCount: number; totalLoc: number; usedFallback: boolean }
  | { type: "estimate"; estimate: EstimateResult; abortedForCost: boolean }
  | { type: "chunk-progress"; processedFiles: number; totalFiles: number; chunkCount: number }
  | { type: "chunk-complete"; chunkCount: number; cachedHits: number }
  | {
      type: "embed-progress";
      completed: number;
      total: number;
      promptTokensSoFar: number;
      elapsedMs: number;
    }
  | {
      type: "embed-complete";
      newlyEmbedded: number;
      cachedHits: number;
      failed: number;
      promptTokens: number;
      durationMs: number;
    }
  | { type: "soft-notice"; reason: string }
  | { type: "phase-degraded"; reason: string }
  | { type: "complete"; durationMs: number; summary: InitSummary };

export type InitListener = (event: InitEvent) => void;

export interface InitSummary {
  files: number;
  chunks: number;
  cachedChunks: number;
  newlyEmbedded: number;
  failedEmbeds: number;
  promptTokens: number;
  estimatedUsd: number;
  durationMs: number;
  /** True when `--dry-run` skipped Phase 3. */
  dryRun: boolean;
  /** True when `--max-cost` aborted Phase 3. */
  abortedForCost: boolean;
  /** True when `--rebuild` swapped the locked model. */
  rebuilt: boolean;
}

export interface InitOptions {
  rebuild?: boolean;
  dryRun?: boolean;
  /** Abort Phase 3 if the estimate exceeds this USD value. */
  maxCostUsd?: number;
}

export interface InitInput {
  repoRoot: string;
  options?: InitOptions;
  emit?: InitListener;
  /** Test seam — defaults wire up real impls. */
  chunker?: Chunker;
  chunkStore?: ChunkStore;
  embeddingStore?: EmbeddingStore;
  merkleStore?: MerkleStore;
  jobRunner?: JobRunner;
  embeddingProvider?: EmbeddingProvider;
}

export async function runInit(input: InitInput): Promise<InitSummary> {
  const startedAt = Date.now();
  const opts = input.options ?? {};
  const emit = input.emit ?? (() => undefined);
  const chunker = input.chunker ?? new CodeChunkAdapter();
  const chunkStore = input.chunkStore ?? new SqliteChunkStore();
  const embeddingStore = input.embeddingStore ?? new SqliteEmbeddingStore();
  const merkleStore = input.merkleStore ?? new SqliteMerkleStore();
  const jobRunner = input.jobRunner ?? new SyncJobRunner({ concurrency: ESTIMATE_CONSTANTS.CONCURRENCY });

  // Gitignore first — runs before any other write so a fresh repo gets the
  // entry on its very first interaction with Warden.
  const gitignore = await ensureGitignore(input.repoRoot);
  if (gitignore.added) {
    emit({ type: "phase-degraded", reason: "gitignore: added .warden/ entry" });
  }

  // Embedding provider needed up front for `--rebuild` semantics + as the
  // engine for Phase 3. Skipped on `--dry-run` where we never call Voyage.
  let provider: EmbeddingProvider | null = null;
  if (!opts.dryRun) {
    provider = input.embeddingProvider ?? getEmbeddingProvider();
  }

  // Locked-model determination. First init writes the lock; --rebuild
  // swaps it; otherwise existing lock wins.
  const existingLock = await readLockedModel();
  let lockedModelId: string;
  let lockedModelVersion: string;
  let rebuilt = false;
  if (opts.rebuild) {
    rebuilt = true;
    if (existingLock) {
      const removed = await embeddingStore.deleteByModel(existingLock.modelId, existingLock.modelVersion);
      if (removed > 0) {
        emit({
          type: "phase-degraded",
          reason: `rebuild: dropped ${removed} embeddings under ${existingLock.modelId}@${existingLock.modelVersion}`,
        });
      }
    }
    if (provider) {
      lockedModelId = provider.modelId();
      lockedModelVersion = provider.modelVersion("document");
    } else {
      // `--rebuild --dry-run` is allowed: estimate against current default.
      lockedModelId = CURRENT_DEFAULT;
      lockedModelVersion = `dim=1024;type=document`;
    }
  } else if (existingLock) {
    lockedModelId = existingLock.modelId;
    lockedModelVersion = existingLock.modelVersion;
    if (provider && lockedModelId !== provider.modelId()) {
      // D-soft notice: a newer SKU is available but the index stays on the
      // locked one (ADR-0019 #6 + #7). Surfaced once per init, never in
      // degradedWorkers.
      emit({
        type: "soft-notice",
        reason: `Newer Voyage SKU available (${provider.modelId()}). Index stays on ${lockedModelId} — run \`warden init --rebuild\` to upgrade.`,
      });
    }
  } else {
    lockedModelId = provider?.modelId() ?? CURRENT_DEFAULT;
    lockedModelVersion = provider?.modelVersion("document") ?? `dim=1024;type=document`;
  }

  // Phase 1: walk.
  emit({ type: "phase-start", phase: "walk" });
  const walked = await walkRepo(input.repoRoot);
  if (walked.usedFallback) {
    emit({
      type: "phase-degraded",
      reason: "walk: git unavailable; used recursive fs walk with hardcoded skips",
    });
  }
  const totalLoc = sumLoc(walked.files);
  emit({
    type: "walk-complete",
    fileCount: walked.files.size,
    totalLoc,
    usedFallback: walked.usedFallback,
  });

  // Phase 2: chunk. Cache hit-rate is unknown until we compute hashes, so
  // estimate uses 0 cached for accuracy on first run; subsequent runs will
  // re-estimate after the chunk pass below by re-running `estimateInit`.
  const cachedChunkCountBefore = await chunkStore.count();
  const initialEstimate = estimateInit({
    totalLoc,
    fileCount: walked.files.size,
    alreadyCachedChunks: cachedChunkCountBefore,
    modelId: lockedModelId,
  });

  // Cost gate: bail before any chunking work if the estimate already
  // exceeds the budget.
  if (
    typeof opts.maxCostUsd === "number" &&
    initialEstimate.estimatedUsd > opts.maxCostUsd &&
    !opts.dryRun
  ) {
    emit({ type: "estimate", estimate: initialEstimate, abortedForCost: true });
    return finishSummary({
      startedAt,
      walked,
      cachedChunks: cachedChunkCountBefore,
      chunks: 0,
      newlyEmbedded: 0,
      failedEmbeds: 0,
      promptTokens: 0,
      estimatedUsd: initialEstimate.estimatedUsd,
      dryRun: false,
      abortedForCost: true,
      rebuilt,
    });
  }
  emit({ type: "estimate", estimate: initialEstimate, abortedForCost: false });

  emit({ type: "phase-start", phase: "chunk" });
  const allChunks: ChunkRecord[] = [];
  const merkleNodes: MerkleNode[] = [];
  let processedFiles = 0;
  for (const file of walked.files.values()) {
    try {
      const chunks = await chunker.chunk(file.path, file.content, file.fileSha);
      if (chunks.length > 0) {
        allChunks.push(...chunks);
      }
    } catch (err) {
      emit({
        type: "phase-degraded",
        reason: `chunk: ${file.path} failed (${err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120)})`,
      });
    }
    merkleNodes.push({ nodePath: file.path, hash: file.fileSha, kind: "file" });
    processedFiles++;
    if (processedFiles % 50 === 0 || processedFiles === walked.files.size) {
      emit({
        type: "chunk-progress",
        processedFiles,
        totalFiles: walked.files.size,
        chunkCount: allChunks.length,
      });
    }
  }

  await chunkStore.upsertMany(allChunks);
  await merkleStore.upsertNodes(merkleNodes);

  emit({ type: "chunk-complete", chunkCount: allChunks.length, cachedHits: 0 });

  // Persist the repo Merkle root so `review` can detect drift via
  // `MerkleStore.diff()`. Root is the sha256 of the sorted concatenation
  // of `path:hash` lines — deterministic and cheap.
  const repoRoot = computeRepoMerkleRoot(merkleNodes);
  await writeRepoMerkleRoot(repoRoot);
  await writeFormatVersion(CURRENT_FORMAT_VERSION);

  // Dry-run: skip Phase 3.
  if (opts.dryRun) {
    emit({
      type: "complete",
      durationMs: Date.now() - startedAt,
      summary: finishSummary({
        startedAt,
        walked,
        cachedChunks: cachedChunkCountBefore,
        chunks: allChunks.length,
        newlyEmbedded: 0,
        failedEmbeds: 0,
        promptTokens: 0,
        estimatedUsd: initialEstimate.estimatedUsd,
        dryRun: true,
        abortedForCost: false,
        rebuilt,
      }),
    });
    return finishSummary({
      startedAt,
      walked,
      cachedChunks: cachedChunkCountBefore,
      chunks: allChunks.length,
      newlyEmbedded: 0,
      failedEmbeds: 0,
      promptTokens: 0,
      estimatedUsd: initialEstimate.estimatedUsd,
      dryRun: true,
      abortedForCost: false,
      rebuilt,
    });
  }

  if (!provider) {
    throw new Error(
      "init: embedding provider missing for Phase 3 — pass `embeddingProvider` or set VOYAGE_API_KEY",
    );
  }

  // Phase 3: embed only chunks that lack a row under the locked model.
  emit({ type: "phase-start", phase: "embed" });
  const allHashes = uniqueChunkHashes(allChunks);
  const present = await embeddingStore.whichExist(allHashes, lockedModelId, lockedModelVersion);
  const missingHashes = allHashes.filter((h) => !present.has(h));

  // Re-estimate with cache hits factored in for an honest cost number.
  const refinedEstimate = estimateInit({
    totalLoc,
    fileCount: walked.files.size,
    alreadyCachedChunks: allHashes.length - missingHashes.length,
    modelId: lockedModelId,
  });
  if (
    typeof opts.maxCostUsd === "number" &&
    refinedEstimate.estimatedUsd > opts.maxCostUsd
  ) {
    emit({ type: "estimate", estimate: refinedEstimate, abortedForCost: true });
    return finishSummary({
      startedAt,
      walked,
      cachedChunks: cachedChunkCountBefore,
      chunks: allChunks.length,
      newlyEmbedded: 0,
      failedEmbeds: 0,
      promptTokens: 0,
      estimatedUsd: refinedEstimate.estimatedUsd,
      dryRun: false,
      abortedForCost: true,
      rebuilt,
    });
  }

  let newlyEmbedded = 0;
  let failedEmbeds = 0;
  let promptTokens = 0;

  if (missingHashes.length > 0) {
    const hashToContent = new Map<string, string>();
    for (const c of allChunks) {
      if (!hashToContent.has(c.chunkHash)) hashToContent.set(c.chunkHash, c.content);
    }
    const batches = chunkArray(missingHashes, provider.maxBatchSize());
    const tasks: Task<{ batchIdx: number; chunkHashes: string[] }, EmbedTaskOutput>[] = batches.map(
      (batch, idx) => {
        const taskInput = { batchIdx: idx, chunkHashes: batch };
        return {
          taskId: taskIdFor("embed_chunk", {
            modelId: lockedModelId,
            modelVersion: lockedModelVersion,
            chunkHashes: [...batch].sort(),
          }),
          taskKind: "embed_chunk",
          input: taskInput,
          run: async () => {
            const inputs = batch.map((h) => hashToContent.get(h) ?? "");
            const response = await provider.embed({ inputs, inputType: "document" });
            const records = batch.map((chunkHash, i) => ({
              chunkHash,
              modelId: response.modelId,
              modelVersion: response.modelVersion,
              vector: response.vectors[i] ?? new Float32Array(0),
            }));
            await embeddingStore.upsertMany(records);
            return { embedded: records.length, promptTokens: response.promptTokens };
          },
        };
      },
    );

    const result = await jobRunner.run<{ batchIdx: number; chunkHashes: string[] }, EmbedTaskOutput>(
      tasks,
      {
        tokensFor: (out) => out.promptTokens,
        onProgress: (p) =>
          emit({
            type: "embed-progress",
            completed: p.completed,
            total: p.total,
            promptTokensSoFar: p.promptTokensSoFar,
            elapsedMs: p.elapsedMs,
          }),
      },
    );

    for (const out of result.outputs) {
      newlyEmbedded += out.embedded;
      promptTokens += out.promptTokens;
    }
    failedEmbeds = result.failed.length;
    for (const fail of result.failed) {
      emit({
        type: "phase-degraded",
        reason: `embed: task ${fail.taskId.slice(0, 8)} failed (${fail.error.slice(0, 120)})`,
      });
    }
  }

  // Persist the locked model on first init (or on --rebuild). A re-run with
  // the same lock is a cheap upsert — keeps `embedding_locked_at` truthful
  // for D-aged math reading the registry's `defaultSince`.
  if (!existingLock || rebuilt) {
    await writeLockedModel(lockedModelId, lockedModelVersion);
  }

  emit({
    type: "embed-complete",
    newlyEmbedded,
    cachedHits: allHashes.length - missingHashes.length,
    failed: failedEmbeds,
    promptTokens,
    durationMs: Date.now() - startedAt,
  });

  const summary = finishSummary({
    startedAt,
    walked,
    cachedChunks: cachedChunkCountBefore,
    chunks: allChunks.length,
    newlyEmbedded,
    failedEmbeds,
    promptTokens,
    estimatedUsd: refinedEstimate.estimatedUsd,
    dryRun: false,
    abortedForCost: false,
    rebuilt,
  });
  emit({ type: "complete", durationMs: summary.durationMs, summary });
  return summary;
}

interface EmbedTaskOutput {
  embedded: number;
  promptTokens: number;
}

function uniqueChunkHashes(chunks: ChunkRecord[]): string[] {
  const set = new Set<string>();
  for (const c of chunks) set.add(c.chunkHash);
  return Array.from(set);
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  if (size <= 0) return [arr];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function sumLoc(files: Map<string, WalkedFile>): number {
  let total = 0;
  for (const f of files.values()) total += f.loc;
  return total;
}

function computeRepoMerkleRoot(nodes: MerkleNode[]): string {
  const sorted = [...nodes].sort((a, b) => a.nodePath.localeCompare(b.nodePath));
  const h = createHash("sha256");
  for (const n of sorted) {
    h.update(`${n.kind}:${n.nodePath}:${n.hash}\n`, "utf8");
  }
  return h.digest("hex");
}

function finishSummary(args: {
  startedAt: number;
  walked: { files: Map<string, WalkedFile> };
  cachedChunks: number;
  chunks: number;
  newlyEmbedded: number;
  failedEmbeds: number;
  promptTokens: number;
  estimatedUsd: number;
  dryRun: boolean;
  abortedForCost: boolean;
  rebuilt: boolean;
}): InitSummary {
  return {
    files: args.walked.files.size,
    chunks: args.chunks,
    cachedChunks: args.cachedChunks,
    newlyEmbedded: args.newlyEmbedded,
    failedEmbeds: args.failedEmbeds,
    promptTokens: args.promptTokens,
    estimatedUsd: args.estimatedUsd,
    durationMs: Date.now() - args.startedAt,
    dryRun: args.dryRun,
    abortedForCost: args.abortedForCost,
    rebuilt: args.rebuilt,
  };
}

export { ensureGitignore } from "./ensure-gitignore.js";
export { walkRepo, type WalkedFile, type WalkResult } from "./walk.js";
export { estimateInit, ESTIMATE_CONSTANTS, type EstimateInput, type EstimateResult } from "./estimate.js";
