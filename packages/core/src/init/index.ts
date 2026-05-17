import { CURRENT_DEFAULT, getEmbeddingProvider, type EmbeddingProvider } from "@warden/ai";
import { CodeChunkAdapter, type Chunker } from "../context/chunker.js";
import {
  CURRENT_FORMAT_VERSION,
  SqliteChunkStore,
  SqliteEmbeddingStore,
  SqliteFileChunksStore,
  SqliteMerkleStore,
  computeRepoMerkleRoot,
  readLockedModel,
  writeFormatVersion,
  writeLockedModel,
  writeRepoMerkleRoot,
  type ChunkStore,
  type EmbeddingStore,
  type FileChunksStore,
  type MerkleNode,
  type MerkleStore,
} from "../indexing/index.js";
import { ensureGitignore } from "./ensure-gitignore.js";
import { estimateInit, type EstimateResult } from "./estimate.js";
import { reconcileFiles, type ReconcileEvent } from "./reconcile.js";
import { walkRepo, type WalkedFile } from "./walk.js";

/**
 * `warden init` orchestration (ADR-0019 #5; ADR-0032). Phase 1 walks the
 * repo and locks the embedding model; Phase 2 + 3 are delegated to the
 * shared `reconcileFiles()` primitive so init and review go through the
 * same chunk-and-embed path. The CLI renderer consumes the same `InitEvent`
 * shape it always has — the wrapper translates reconcile's per-file event
 * stream into the existing phase log.
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
  fileChunksStore?: FileChunksStore;
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
  const fileChunksStore = input.fileChunksStore ?? new SqliteFileChunksStore();

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

  // Pre-flight estimate. First run treats every chunk as uncached so the
  // panel renders honest worst-case before reconcile starts.
  const cachedChunkCountBefore = await chunkStore.count();
  const initialEstimate = estimateInit({
    totalLoc,
    fileCount: walked.files.size,
    alreadyCachedChunks: cachedChunkCountBefore,
    modelId: lockedModelId,
  });

  // Cost gate: bail before any chunking work if the estimate already
  // exceeds the budget. Matches pre-M16 behavior.
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

  // Dry-run keeps the M6 walk-only behavior — no chunker, no Voyage. We
  // still emit chunk/embed phase markers so the renderer's three-phase
  // log finishes cleanly.
  if (opts.dryRun) {
    emit({ type: "phase-start", phase: "chunk" });
    emit({ type: "chunk-complete", chunkCount: 0, cachedHits: 0 });
    emit({ type: "phase-start", phase: "embed" });
    emit({
      type: "embed-complete",
      newlyEmbedded: 0,
      cachedHits: 0,
      failed: 0,
      promptTokens: 0,
      durationMs: 0,
    });
    const summary = finishSummary({
      startedAt,
      walked,
      cachedChunks: cachedChunkCountBefore,
      chunks: 0,
      newlyEmbedded: 0,
      failedEmbeds: 0,
      promptTokens: 0,
      estimatedUsd: initialEstimate.estimatedUsd,
      dryRun: true,
      abortedForCost: false,
      rebuilt,
    });
    emit({ type: "complete", durationMs: summary.durationMs, summary });
    return summary;
  }

  if (!provider) {
    throw new Error(
      "init: embedding provider missing for Phase 3 — pass `embeddingProvider` or set VOYAGE_API_KEY",
    );
  }

  // Compute the removed[] set from the merkle store before reconcile —
  // any path stored under merkle that's no longer walked is a delete.
  const storedHashes = await merkleStore.getAllFileHashes();
  const currentPaths = new Set(walked.files.keys());
  const removed: string[] = [];
  for (const path of storedHashes.keys()) {
    if (!currentPaths.has(path)) removed.push(path);
  }

  // Phase 2 + 3 collapse into reconcileFiles(). The wrapper translates
  // per-file reconcile events into the existing chunk/embed phase log.
  emit({ type: "phase-start", phase: "chunk" });
  let embedPhaseStarted = false;
  let embedStartedAt = 0;
  let filesObserved = 0;
  let promptTokensSoFar = 0;
  const totalFilesToReconcile = walked.files.size;

  const translateReconcileEvent = (ev: ReconcileEvent): void => {
    if (
      ev.type !== "file-refreshed" &&
      ev.type !== "file-skipped-budget" &&
      ev.type !== "file-removed"
    ) {
      return;
    }
    if (!embedPhaseStarted) {
      // Chunking really is fast — flip to embed phase on the first per-file
      // signal so the spinner reflects the slow work.
      emit({ type: "chunk-complete", chunkCount: 0, cachedHits: 0 });
      emit({ type: "phase-start", phase: "embed" });
      embedPhaseStarted = true;
      embedStartedAt = Date.now();
    }
    filesObserved++;
    if (ev.type === "file-refreshed") {
      promptTokensSoFar += ev.promptTokens;
    }
    if (filesObserved % 5 === 0 || filesObserved === totalFilesToReconcile) {
      emit({
        type: "embed-progress",
        completed: filesObserved,
        total: totalFilesToReconcile,
        promptTokensSoFar,
        elapsedMs: Date.now() - embedStartedAt,
      });
    }
  };

  const reconcile = await reconcileFiles({
    files: Array.from(walked.files.values()),
    removed,
    repoRoot: input.repoRoot,
    chunker,
    chunkStore,
    embeddingStore,
    merkleStore,
    fileChunksStore,
    provider,
    lockedModelId,
    lockedModelVersion,
    maxUsdBudget: opts.maxCostUsd,
    emit: translateReconcileEvent,
  });

  if (!embedPhaseStarted) {
    // Nothing to refresh — emit terminal events so the renderer closes
    // both phases cleanly.
    emit({ type: "chunk-complete", chunkCount: reconcile.chunksSeen, cachedHits: 0 });
    emit({ type: "phase-start", phase: "embed" });
  }
  emit({
    type: "embed-complete",
    newlyEmbedded: reconcile.newlyEmbedded,
    cachedHits: reconcile.cachedEmbeddings,
    failed: reconcile.failedEmbeds,
    promptTokens: reconcile.promptTokens,
    durationMs: reconcile.durationMs,
  });

  // Forward reconcile's degraded entries (skip-over-budget, backfill,
  // failed-embed batches) through the existing phase-degraded channel.
  for (const entry of reconcile.degraded) {
    emit({ type: "phase-degraded", reason: entry.message });
  }

  // Persist the locked model on first init (or on --rebuild). A re-run with
  // the same lock is a cheap upsert — keeps `embedding_locked_at` truthful
  // for D-aged math reading the registry's `defaultSince`.
  if (!existingLock || rebuilt) {
    await writeLockedModel(lockedModelId, lockedModelVersion);
  }

  // Persist the repo Merkle root + format version. The per-file merkle
  // leaves were already committed inside reconcileFiles()'s atomic write.
  const allNodes: MerkleNode[] = [];
  for (const file of walked.files.values()) {
    allNodes.push({ nodePath: file.path, hash: file.fileSha, kind: "file" });
  }
  await writeRepoMerkleRoot(computeRepoMerkleRoot(allNodes));
  await writeFormatVersion(CURRENT_FORMAT_VERSION);

  const abortedForCost =
    reconcile.skippedOverBudget.length > 0 && opts.maxCostUsd !== undefined;

  const summary = finishSummary({
    startedAt,
    walked,
    cachedChunks: cachedChunkCountBefore,
    chunks: reconcile.chunksSeen,
    newlyEmbedded: reconcile.newlyEmbedded,
    failedEmbeds: reconcile.failedEmbeds,
    promptTokens: reconcile.promptTokens,
    estimatedUsd: initialEstimate.estimatedUsd,
    dryRun: false,
    abortedForCost,
    rebuilt,
  });
  emit({ type: "complete", durationMs: summary.durationMs, summary });
  return summary;
}

function sumLoc(files: Map<string, WalkedFile>): number {
  let total = 0;
  for (const f of files.values()) total += f.loc;
  return total;
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
export {
  reconcileFiles,
  type ReconcileEvent,
  type ReconcileInput,
  type ReconcileSummary,
} from "./reconcile.js";
