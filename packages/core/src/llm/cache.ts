import { createHash } from "node:crypto";
import { createId, db, eq, llmReviewCache } from "@warden/db";
import type { LlmOutput } from "./schema.js";

/**
 * Content-addressed cache for LLM formatter outputs (ADR-0007 / vision.md §9
 * "review history"; M4 grilling Q10 / O2). Keyed on a hash of every input
 * that affects output — re-running an identical review is a no-op.
 *
 * No TTL: content addressing handles freshness. Any input change produces a
 * different cache key; identical inputs produce identical outputs.
 */

export interface CacheKeyInputs {
  modelId: string;
  systemPromptHash: string;
  userTemplateHash: string;
  /** Stable comment ids passed to the LLM, sorted for hash determinism. */
  inputCommentIds: string[];
  diffHash: string;
}

export interface CachedLlmReview {
  payload: LlmOutput;
  provider: "anthropic" | "google";
  modelId: string;
  durationMs: number;
}

export function computeCacheKey(inputs: CacheKeyInputs): string {
  const ids = [...inputs.inputCommentIds].sort().join(",");
  const material = [
    inputs.modelId,
    inputs.systemPromptHash,
    inputs.userTemplateHash,
    ids,
    inputs.diffHash,
  ].join("\n");
  return createHash("sha256").update(material).digest("hex");
}

export function hashString(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function getLlmCached(cacheKey: string): CachedLlmReview | undefined {
  const row = db()
    .select({
      provider: llmReviewCache.provider,
      modelId: llmReviewCache.modelId,
      payload: llmReviewCache.payload,
      durationMs: llmReviewCache.durationMs,
    })
    .from(llmReviewCache)
    .where(eq(llmReviewCache.cacheKey, cacheKey))
    .get();
  if (!row) return undefined;
  return {
    payload: row.payload as unknown as LlmOutput,
    provider: row.provider,
    modelId: row.modelId,
    durationMs: row.durationMs,
  };
}

export function putLlmCached(args: {
  cacheKey: string;
  provider: "anthropic" | "google";
  modelId: string;
  payload: LlmOutput;
  durationMs: number;
}): void {
  db()
    .insert(llmReviewCache)
    .values({
      id: createId("llm"),
      cacheKey: args.cacheKey,
      provider: args.provider,
      modelId: args.modelId,
      payload: args.payload as unknown as Record<string, unknown>,
      durationMs: args.durationMs,
    })
    .onConflictDoUpdate({
      target: llmReviewCache.cacheKey,
      set: {
        provider: args.provider,
        modelId: args.modelId,
        payload: args.payload as unknown as Record<string, unknown>,
        durationMs: args.durationMs,
        updatedAt: new Date(),
      },
    })
    .run();
}
