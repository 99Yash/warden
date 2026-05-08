/**
 * `EmbeddingProvider` abstraction for the M6 embedding-backed selector
 * (ADR-0019 #1). Mirrors the LLM dispatcher pattern in `models.ts`:
 * provider construction lives behind `getEmbeddingProvider()`, callers
 * never import the underlying SDK directly.
 *
 * The `inputType` distinction (`document` for corpus-side, `query` for
 * diff-side) tracks Voyage's API contract — query embeddings are not
 * cached, but the version handle stays honest so future `EmbeddingStore`
 * impls can refuse cross-type lookups if they need to.
 */

export type EmbedInputType = "document" | "query";

export interface EmbedRequest {
  inputs: string[];
  inputType: EmbedInputType;
}

export interface EmbedResponse {
  vectors: Float32Array[];
  /** Provider-echoed model SKU, e.g. `"voyage-code-3"`. */
  modelId: string;
  /** Warden-side handle: `"dim=1024;type=document"` etc. Used for cache keying. */
  modelVersion: string;
  /** Cost-accounting echo from the provider (totalTokens for the request). */
  promptTokens: number;
}

export interface EmbeddingProvider {
  /** Current SKU. Provider returns this value in `EmbedResponse.modelId`. */
  modelId(): string;
  /** Stable cache-key handle — bake `inputType` in so query/corpus rows never collide. */
  modelVersion(inputType: EmbedInputType): string;
  embed(req: EmbedRequest): Promise<EmbedResponse>;
  /** Provider's max inputs per request (Voyage caps at 128). */
  maxBatchSize(): number;
  /** Provider's per-input token limit. */
  maxInputTokens(): number;
}
