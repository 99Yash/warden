// M14 (ADR-0030): the M8 orchestration spine retired for review-mode in
// the close-out commit. `Scratchpad`, `dispatch`, `synthesize`, and
// `deterministicSynthesize` are no longer exported; their consumers now
// live inside `packages/core/src/review-harness/` (Phase 1 reuses
// `Runner` directly; Phase 2 is the boss-loop; Phase 3 is the existing
// `verifyCitations` post-pass).
//
// The `Runner` contract survives because two surviving deterministic
// detectors (`scalabilityRunner` in `runners/scalability.ts` and
// `leverageRunner` in `runners/leverage.ts`) implement it, and it remains
// the right shape for future Phase 1 additions.
export type { Runner, RunnerInput, RunnerOutput } from "./runner.js";

// Per-tier dispatch concurrency cap (ADR-0033) for the review harness.
// The class is intentionally exported from `orchestration/` rather than
// `review-harness/` because M17's deep-security harness will inherit it
// directly — same pattern as `Runner`, which survived the M14 close-out
// for the same reason.
export { Semaphore } from "./semaphore.js";
