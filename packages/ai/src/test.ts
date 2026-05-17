/**
 * Test helpers for downstream smokes. Re-exports the AI SDK's
 * `MockLanguageModelV3` so workspace-level test code (`packages/cli/scripts/*.mts`)
 * can construct stub models without taking a direct `ai` dependency.
 * Not for production use — the parent `@warden/ai/index.ts` deliberately
 * does not re-export this surface so production consumers stay tool-agnostic.
 */

export { MockLanguageModelV3 } from "ai/test";
