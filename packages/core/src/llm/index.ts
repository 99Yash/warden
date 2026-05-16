// M14 (ADR-0030): the M4 formatter + its schema/cascade/cache/prompt-
// loader retired in the close-out commit. The boss-loop at
// `review-harness/boss-loop.ts` is the new LLM entry point for review
// mode and reimplements the cascade + structured-output discipline
// inline; check mode never invokes the LLM per ADR-0011.
//
// What survives here:
//   - `FormatterEvent` / `FormatterListener` — streaming-event contract
//     the renderer subscribes to; consumed by both the boss-loop and
//     `runReviewHarness()` callers.
//   - `verifyCitations()` (via `./verify-citations.ts`) — Phase 3 of the
//     M14 harness; re-exported from the package barrel directly.
//   - `tools/` — `lookupTypeDef` + tool factories used by M14 workers
//     and exported from the package barrel directly.
export type { FormatterEvent, FormatterListener } from "./events.js";
