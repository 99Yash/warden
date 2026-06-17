// We deliberately narrow from `ai`'s `LanguageModel` (which is
// `LanguageModelV3 | GatewayLanguageModelId` to allow string gateway ids) to
// ai-retry's `LanguageModel` alias (`LanguageModelV3`). The provider factory
// always returns a model instance at runtime; the narrower type is what both
// `streamText` (a supertype consumer) and `createRetryable` (which generics
// strictly over `LanguageModelV3`) want.
import type { LanguageModel } from "ai-retry";
import { isProviderConfigured, requireAnyProviderApiKey } from "@warden/env";
import { anthropicProvider, googleProvider, openaiProvider } from "./provider.js";

export type LlmProviderId = "anthropic" | "openai" | "google";
export type ReviewCostTier = "opus" | "sonnet" | "haiku";
export type LlmJsonValue = null | string | number | boolean | LlmJsonObject | LlmJsonValue[];
export interface LlmJsonObject {
  [key: string]: LlmJsonValue | undefined;
}
export type LlmProviderOptions = Record<string, LlmJsonObject>;

export interface LlmModelPrice {
  /** USD per 1M uncached input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
  /** USD per 1M cached input tokens, when the provider reports them. */
  cachedInput: number;
}

export interface ResolvedLlmModel {
  provider: LlmProviderId;
  modelId: string;
  label: string;
  pricePerMillionTokens: LlmModelPrice;
  providerOptions?: LlmProviderOptions;
}

const ANTHROPIC_OPUS_4_8 = {
  provider: "anthropic",
  modelId: "claude-opus-4-8",
  label: "claude-opus-4-8",
  pricePerMillionTokens: { input: 5, output: 25, cachedInput: 0.5 },
} satisfies ResolvedLlmModel;

const ANTHROPIC_SONNET_4_6 = {
  provider: "anthropic",
  modelId: "claude-sonnet-4-6",
  label: "claude-sonnet-4-6",
  pricePerMillionTokens: { input: 3, output: 15, cachedInput: 0.3 },
} satisfies ResolvedLlmModel;

const ANTHROPIC_HAIKU_4_5 = {
  provider: "anthropic",
  modelId: "claude-haiku-4-5-20251001",
  label: "claude-haiku-4-5",
  pricePerMillionTokens: { input: 1, output: 5, cachedInput: 0.1 },
} satisfies ResolvedLlmModel;

const OPENAI_GPT_5_5 = {
  provider: "openai",
  modelId: "gpt-5.5",
  label: "gpt-5.5 xhigh",
  pricePerMillionTokens: { input: 5, output: 30, cachedInput: 0.5 },
  providerOptions: { openai: { reasoningEffort: "xhigh" } },
} satisfies ResolvedLlmModel;

const OPENAI_GPT_5_4_MINI = {
  provider: "openai",
  modelId: "gpt-5.4-mini",
  label: "gpt-5.4-mini xhigh",
  pricePerMillionTokens: { input: 0.75, output: 4.5, cachedInput: 0.075 },
  providerOptions: { openai: { reasoningEffort: "xhigh" } },
} satisfies ResolvedLlmModel;

/**
 * Boss model. Used by the M14 review harness as the single planning brain
 * across the `dispatch_worker` tool-use loop. Default role policy:
 * Anthropic key present -> Claude Opus 4.8 boss; otherwise OpenAI key
 * present -> GPT-5.5 boss.
 */
export function getBossModel(): LanguageModel {
  return modelFromInfo(getBossModelInfo());
}

/**
 * Apex-tier model for opt-in deep security analysis (M18 / ADR-0029).
 * Deliberately separate from the default-review boss tier so `warden review`
 * does not silently inherit the deep tier's higher cost.
 */
export function getApexModel(): LanguageModel {
  return modelFromInfo(getApexModelInfo());
}

/**
 * Strong-tier worker model. OpenAI is preferred when configured because
 * GPT-5.4 mini is the intended cost/performance worker default; Anthropic
 * Sonnet remains the no-OpenAI fallback.
 */
export function getWorkerStrongModel(): LanguageModel {
  return modelFromInfo(getWorkerStrongModelInfo());
}

/**
 * Cheap-tier worker model for pattern-matching tasks. For now the OpenAI
 * default deliberately collapses strong/cheap workers onto GPT-5.4 mini;
 * a future CLI model policy can split this further once there are evals.
 */
export function getWorkerCheapModel(): LanguageModel {
  return modelFromInfo(getWorkerCheapModelInfo());
}

export function getBossModelInfo(): ResolvedLlmModel {
  if (isProviderConfigured("anthropic")) return ANTHROPIC_OPUS_4_8;
  if (isProviderConfigured("openai")) return OPENAI_GPT_5_5;
  return throwMissingReviewLlmProvider();
}

export function getApexModelInfo(): ResolvedLlmModel {
  if (isProviderConfigured("anthropic")) return ANTHROPIC_OPUS_4_8;
  if (isProviderConfigured("openai")) return OPENAI_GPT_5_5;
  return throwMissingReviewLlmProvider();
}

export function getWorkerStrongModelInfo(): ResolvedLlmModel {
  if (isProviderConfigured("openai")) return OPENAI_GPT_5_4_MINI;
  if (isProviderConfigured("anthropic")) return ANTHROPIC_SONNET_4_6;
  return throwMissingReviewLlmProvider();
}

export function getWorkerCheapModelInfo(): ResolvedLlmModel {
  if (isProviderConfigured("openai")) return OPENAI_GPT_5_4_MINI;
  if (isProviderConfigured("anthropic")) return ANTHROPIC_HAIKU_4_5;
  return throwMissingReviewLlmProvider();
}

export function getReviewModelPricingByTier(): Record<ReviewCostTier, LlmModelPrice> {
  return {
    opus: getBossModelInfo().pricePerMillionTokens,
    sonnet: getWorkerStrongModelInfo().pricePerMillionTokens,
    haiku: getWorkerCheapModelInfo().pricePerMillionTokens,
  };
}

export function getReviewModelLabelsByTier(): Record<ReviewCostTier, string> {
  return {
    opus: getBossModelInfo().label,
    sonnet: getWorkerStrongModelInfo().label,
    haiku: getWorkerCheapModelInfo().label,
  };
}

/**
 * ADR-0017 fallback dispatchers. Returns the Google-tier counterpart of
 * the corresponding Anthropic getter, or `undefined` when no Google key is
 * configured — caller-side cascade then proceeds to hard fail.
 *
 * Tier mapping is the stable contract; specific Gemini SKUs are
 * point-in-time and revisited on each Google generation ship.
 */
export function getBossFallbackModel(): LanguageModel | undefined {
  const g = googleProvider();
  return g?.("gemini-2.5-pro");
}

export function getApexFallbackModel(): LanguageModel | undefined {
  const g = googleProvider();
  return g?.("gemini-2.5-pro");
}

export function getWorkerStrongFallbackModel(): LanguageModel | undefined {
  const g = googleProvider();
  return g?.("gemini-2.5-pro");
}

export function getWorkerCheapFallbackModel(): LanguageModel | undefined {
  const g = googleProvider();
  return g?.("gemini-2.5-flash");
}

function modelFromInfo(info: ResolvedLlmModel): LanguageModel {
  switch (info.provider) {
    case "anthropic":
      return anthropicProvider()(info.modelId);
    case "openai":
      return openaiProvider()(info.modelId);
    case "google": {
      const g = googleProvider();
      if (!g) {
        throw new Error(`Provider "google" is not configured for ${info.modelId}.`);
      }
      return g(info.modelId);
    }
  }
}

function throwMissingReviewLlmProvider(): never {
  requireAnyProviderApiKey(["anthropic", "openai"], "warden review");
  throw new Error("No supported review LLM provider is configured.");
}
