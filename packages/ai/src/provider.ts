import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import {
  configuredLlmFallbackProviders,
  providerApiKey,
  requireProviderApiKey,
} from "@warden/env";

let _anthropic: ReturnType<typeof createAnthropic> | undefined;
let _google: ReturnType<typeof createGoogleGenerativeAI> | undefined;
let _openai: ReturnType<typeof createOpenAI> | undefined;

/**
 * Lazily-instantiated Anthropic provider singleton. Primary LLM provider
 * per ADR-0006; ADR-0017 layers a Google fallback on top via the cascade.
 */
export function anthropicProvider(): ReturnType<typeof createAnthropic> {
  if (!_anthropic) {
    _anthropic = createAnthropic({
      apiKey: requireProviderApiKey("anthropic", "warden review / warden security"),
    });
  }
  return _anthropic;
}

/**
 * Lazily-instantiated OpenAI provider singleton. Used by the default mixed
 * role policy for lower-cost review workers and as the boss fallback when
 * Anthropic is not configured.
 */
export function openaiProvider(): ReturnType<typeof createOpenAI> {
  if (!_openai) {
    _openai = createOpenAI({
      apiKey: requireProviderApiKey("openai", "warden review / warden security"),
    });
  }
  return _openai;
}

/**
 * Lazily-instantiated Google Generative AI provider singleton (ADR-0017
 * fallback). Returns `undefined` when `GOOGLE_GENERATIVE_AI_API_KEY` is
 * unset — callers treat that as "no fallback configured" and the cascade
 * proceeds to hard fail.
 */
export function googleProvider(): ReturnType<typeof createGoogleGenerativeAI> | undefined {
  if (!configuredLlmFallbackProviders().includes("google")) return undefined;
  const apiKey = providerApiKey("google");
  if (!apiKey) return undefined;
  if (!_google) {
    _google = createGoogleGenerativeAI({ apiKey });
  }
  return _google;
}
