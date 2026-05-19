import { configuredEmbeddingProvider, requireProviderApiKey } from "@warden/env";
import type { EmbeddingProvider } from "./interfaces.js";
import { VoyageProvider } from "./voyage.js";
import { CURRENT_DEFAULT } from "./voyage-models.js";

export type {
  EmbedInputType,
  EmbedRequest,
  EmbedResponse,
  EmbeddingProvider,
} from "./interfaces.js";
export { VoyageProvider } from "./voyage.js";
export {
  CURRENT_DEFAULT,
  VOYAGE_MAX_BATCH_SIZE,
  VOYAGE_MODELS,
  voyageModelMeta,
  type VoyageModelMeta,
} from "./voyage-models.js";

let _provider: EmbeddingProvider | undefined;

/**
 * Returns the singleton embedding provider for the current process. Throws
 * if `VOYAGE_API_KEY` is unset — same shape as `getBossModel()` does for
 * Anthropic. Verbs that touch the index (`init`, `review`) call this; the
 * deterministic-only `check` verb never does, so users without the key can
 * still run `check` without surprise.
 */
export function getEmbeddingProvider(): EmbeddingProvider {
  if (_provider) return _provider;
  const provider = configuredEmbeddingProvider();
  if (provider !== "voyage") {
    throw new Error(`Unsupported embedding provider "${provider}" in this Warden build.`);
  }
  const apiKey = requireProviderApiKey("voyage", "warden init");
  _provider = new VoyageProvider({ apiKey, modelId: CURRENT_DEFAULT });
  return _provider;
}

/** Test-only reset hook. Not exported via the package barrel for consumers. */
export function _resetEmbeddingProviderForTest(): void {
  _provider = undefined;
}
