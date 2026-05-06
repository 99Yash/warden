export * from "./provider.js";
export * from "./models.js";

// Re-export the AI SDK primitives `@warden/core` consumes. Per the package
// boundary table in CLAUDE.md, `core` is forbidden from importing `ai`
// directly — every AI SDK touchpoint flows through `@warden/ai`.
export { Output, streamText, generateText } from "ai";
export type { LanguageModel } from "ai";
