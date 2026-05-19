// We deliberately narrow from `ai`'s `LanguageModel` (which is
// `LanguageModelV3 | GatewayLanguageModelId` to allow string gateway ids) to
// ai-retry's `LanguageModel` alias (`LanguageModelV3`). The provider factory
// always returns a model instance at runtime; the narrower type is what both
// `streamText` (a supertype consumer) and `createRetryable` (which generics
// strictly over `LanguageModelV3`) want.
import type { LanguageModel } from "ai-retry";
import { anthropicProvider, googleProvider } from "./provider.js";

/**
 * Boss model. Used by the M14 review harness as the single planning brain
 * across the 5-round `dispatch_worker` tool-use loop, and previously by the
 * M4/M8 formatter/synthesizer (both retired for review-mode under ADR-0030).
 * Opus 4.6 for the 1M context window + cross-file planning the harness
 * relies on; 4.7's 1.4× premium is deferred to a future deep-tier milestone
 * (ADR-0029 / m15-plan.md). Per ADR-0006 + vision.md §3 worker tiering.
 */
export function getBossModel(): LanguageModel {
  return anthropicProvider()("claude-opus-4-6");
}

/**
 * Apex-tier model for opt-in deep security analysis (M18 / ADR-0029).
 * Deliberately separate from the default-review boss tier so `warden review`
 * does not silently inherit the deep tier's higher cost.
 */
export function getApexModel(): LanguageModel {
  return anthropicProvider()("claude-opus-4-7");
}

/**
 * Strong-tier worker model. Same SKU as the boss in v0 — separated as a
 * function so future tuning (e.g. switching grader to a different SKU)
 * doesn't require touching every callsite.
 */
export function getWorkerStrongModel(): LanguageModel {
  return anthropicProvider()("claude-sonnet-4-6");
}

/**
 * Cheap-tier worker model for pattern-matching tasks (contract checks,
 * best-practices) that don't need deep reasoning. Per ADR-0006.
 */
export function getWorkerCheapModel(): LanguageModel {
  return anthropicProvider()("claude-haiku-4-5-20251001");
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
