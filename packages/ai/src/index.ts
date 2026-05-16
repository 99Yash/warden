export * from "./provider.js";
export * from "./models.js";
export * from "./embeddings/index.js";
export {
  transformSchemaForGemini,
  type GeminiSchemaPair,
} from "./schema-adapters/gemini.js";

// Re-export the AI SDK primitives `@warden/core` consumes. Per the package
// boundary table in CLAUDE.md, `core` is forbidden from importing `ai`
// directly — every AI SDK touchpoint flows through `@warden/ai`.
export { Output, stepCountIs, streamText, generateText, tool } from "ai";
export type { ToolSet } from "ai";
// LanguageModel is narrowed to ai-retry's alias (`LanguageModelV3`) so it can
// flow into both `streamText` (a supertype consumer) and `createRetryable`
// (strictly generic over `LanguageModelV3`). `ai`'s wider union with gateway
// strings isn't used anywhere in Warden's call graph.
export type { LanguageModel } from "ai-retry";

// ai-retry surface, re-exported so `@warden/core` can build retryable models
// without taking a direct dep (same boundary rule as `ai` itself). The
// experimental `condition().action()` API is opted into deliberately — it's
// what ADR-0017's cascade is expressed in.
export { getModelKey, isErrorAttempt, isResultAttempt } from "ai-retry";
export {
  aborted,
  createRetryable,
  error,
  finishReason,
  httpStatus,
  result,
  schemaInvalid,
  timeout,
} from "ai-retry/experimental/language-model";
export type {
  Retries,
  Retry,
  RetryAttempt,
  RetryContext,
  Retryable,
  RetryableModelOptions,
  SuccessContext,
} from "ai-retry";
