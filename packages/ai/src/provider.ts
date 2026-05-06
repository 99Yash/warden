import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { wardenEnv } from "@warden/env";

let _anthropic: ReturnType<typeof createAnthropic> | undefined;
let _google: ReturnType<typeof createGoogleGenerativeAI> | undefined;

/**
 * Lazily-instantiated Anthropic provider singleton. Primary LLM provider
 * per ADR-0006; ADR-0017 layers a Google fallback on top via the cascade.
 */
export function anthropicProvider(): ReturnType<typeof createAnthropic> {
  if (!_anthropic) {
    _anthropic = createAnthropic({ apiKey: wardenEnv().ANTHROPIC_API_KEY });
  }
  return _anthropic;
}

/**
 * Lazily-instantiated Google Generative AI provider singleton (ADR-0017
 * fallback). Returns `undefined` when `GOOGLE_GENERATIVE_AI_API_KEY` is
 * unset — callers treat that as "no fallback configured" and the cascade
 * proceeds to hard fail.
 */
export function googleProvider(): ReturnType<typeof createGoogleGenerativeAI> | undefined {
  const apiKey = wardenEnv().GOOGLE_GENERATIVE_AI_API_KEY;
  if (!apiKey) return undefined;
  if (!_google) {
    _google = createGoogleGenerativeAI({ apiKey });
  }
  return _google;
}
