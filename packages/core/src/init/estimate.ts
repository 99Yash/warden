import { voyageModelMeta } from "@warden/ai";

/**
 * Pre-flight estimate constants (ADR-0019 #5 — Phase 2 panel). Re-tune
 * from dogfood data, never sprinkle these magic numbers across the init
 * pipeline. Numbers below are first-iteration guesses; ADR-0019 explicitly
 * flags them as updatable from the first dogfood run.
 */
export const ESTIMATE_CONSTANTS = {
  /** Average LOC per chunk per `code-chunk` defaults. */
  LOC_PER_CHUNK: 30,
  /** Average tokens per chunk (~chars/4 heuristic for code; chunk default = 1500 bytes ≈ 375 tokens). */
  TOKENS_PER_CHUNK: 375,
  /** Voyage seconds per batched request, observed average. */
  SECONDS_PER_BATCH: 1.0,
  /** ADR-0019 #4: 4 concurrent Voyage batches. */
  CONCURRENCY: 4,
  /** Voyage's max inputs per batch. */
  BATCH_SIZE: 128,
} as const;

export interface EstimateInput {
  totalLoc: number;
  fileCount: number;
  /** Number of chunks already cached for the locked model — subtracted from work. */
  alreadyCachedChunks: number;
  modelId: string;
}

export interface EstimateResult {
  estimatedChunks: number;
  estimatedNewChunks: number;
  estimatedTokens: number;
  estimatedUsd: number;
  estimatedSeconds: number;
}

export function estimateInit(input: EstimateInput): EstimateResult {
  const meta = voyageModelMeta(input.modelId);
  const totalChunks = Math.max(0, Math.ceil(input.totalLoc / ESTIMATE_CONSTANTS.LOC_PER_CHUNK));
  const newChunks = Math.max(0, totalChunks - input.alreadyCachedChunks);
  const tokens = newChunks * ESTIMATE_CONSTANTS.TOKENS_PER_CHUNK;
  const usd = (tokens / 1_000_000) * meta.usdPerMTokens;
  // Effective throughput = concurrency × batch / seconds-per-batch.
  const itemsPerSec =
    (ESTIMATE_CONSTANTS.CONCURRENCY * ESTIMATE_CONSTANTS.BATCH_SIZE) /
    ESTIMATE_CONSTANTS.SECONDS_PER_BATCH;
  const seconds = newChunks === 0 ? 0 : Math.max(1, Math.round(newChunks / itemsPerSec));
  return {
    estimatedChunks: totalChunks,
    estimatedNewChunks: newChunks,
    estimatedTokens: tokens,
    estimatedUsd: Number(usd.toFixed(2)),
    estimatedSeconds: seconds,
  };
}
