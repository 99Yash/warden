import type { LlmModelPrice, LlmPriceRates } from "./models.js";

/** Token counts of one model request, in the AI SDK 6 shape. */
export interface RequestTokenCounts {
  /** Total input tokens, cache reads and cache writes included. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Cache-read part of `inputTokens`. */
  readonly cachedInputTokens?: number | undefined;
  /** Cache-write part of `inputTokens`. */
  readonly cacheWriteInputTokens?: number | undefined;
}

/**
 * The rates that apply to one request with `inputTokens` total input. The
 * highest long-context tier whose threshold the request is MORE than wins;
 * a request at or below every threshold pays the base rates.
 */
export function ratesForRequest(price: LlmModelPrice, inputTokens: number): LlmPriceRates {
  let rates: LlmPriceRates = price;
  let threshold = -1;
  for (const tier of price.contextTiers ?? []) {
    if (inputTokens > tier.aboveInputTokens && tier.aboveInputTokens > threshold) {
      rates = tier.rates;
      threshold = tier.aboveInputTokens;
    }
  }
  return rates;
}

/**
 * USD cost of ONE model request. Price each request (tool-loop step) on its
 * own: a long-context tier depends on the prompt size of that request, so
 * a sum over steps must not pick the tier.
 *
 * `inputTokens` is the TOTAL input (AI SDK 6), so the cache parts come out
 * first and each token is billed once: uncached at `input`, cache reads at
 * `cachedInput`, cache writes at `cacheWriteInput`. The uncached part equals
 * the SDK's `inputTokenDetails.noCacheTokens` for every installed provider.
 */
export function requestCostUsd(price: LlmModelPrice, usage: RequestTokenCounts): number {
  const rates = ratesForRequest(price, usage.inputTokens);
  const cacheRead = usage.cachedInputTokens ?? 0;
  const cacheWrite = usage.cacheWriteInputTokens ?? 0;
  const noCache = Math.max(0, usage.inputTokens - cacheRead - cacheWrite);
  return (
    (noCache / 1_000_000) * rates.input +
    (cacheRead / 1_000_000) * rates.cachedInput +
    (cacheWrite / 1_000_000) * rates.cacheWriteInput +
    (usage.outputTokens / 1_000_000) * rates.output
  );
}
