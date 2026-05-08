/**
 * Hardcoded Voyage SKU registry (ADR-0019 #7). Bumping `CURRENT_DEFAULT` is
 * ADR-worthy because it changes the locked-model semantics for fresh repos
 * and triggers D-soft / D-aged states for repos already locked on the prior
 * SKU. Stale `defaultSince` dates corrupt the D-aged 6-month math; pin
 * honestly and re-stamp on every bump.
 */

export interface VoyageModelMeta {
  /** ISO date when this SKU became Warden's default. */
  defaultSince: string;
  /** ISO date when Voyage announced EOL; `null` while live. */
  deprecatedAfter: string | null;
  /** Embedding dimensionality (1024 for voyage-code-3). */
  outputDim: number;
  /** Per-input token cap. */
  maxInputTokens: number;
  /** USD price per million input tokens (used by the pre-flight estimate). */
  usdPerMTokens: number;
}

export const VOYAGE_MODELS: Record<string, VoyageModelMeta> = {
  "voyage-code-3": {
    defaultSince: "2026-02-01",
    deprecatedAfter: null,
    outputDim: 1024,
    maxInputTokens: 32_000,
    usdPerMTokens: 0.18,
  },
};

/** Current Warden default. Touching this value is an ADR. */
export const CURRENT_DEFAULT = "voyage-code-3";

/** Voyage's per-request cap on `inputs`. */
export const VOYAGE_MAX_BATCH_SIZE = 128;

export function voyageModelMeta(modelId: string): VoyageModelMeta {
  const meta = VOYAGE_MODELS[modelId];
  if (!meta) {
    throw new Error(
      `Unknown Voyage SKU: ${modelId}. Add it to VOYAGE_MODELS in @warden/ai/embeddings/voyage-models.ts.`,
    );
  }
  return meta;
}
