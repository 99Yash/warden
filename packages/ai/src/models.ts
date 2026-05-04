import type { LanguageModel } from "ai";
import { anthropicProvider } from "./provider.js";

/**
 * Strong-tier model used for the boss / synthesizer / grader pass and for
 * specialist workers that need deep reasoning (correctness, security).
 * Per ADR-0006 + vision.md §3 worker tiering.
 */
export function getBossModel(): LanguageModel {
  return anthropicProvider()("claude-sonnet-4-6");
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
