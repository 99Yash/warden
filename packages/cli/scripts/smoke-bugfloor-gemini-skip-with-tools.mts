/**
 * Smoke for the ADR-0017 2026-05-17 "tools + structured-output exception"
 * amendment. Tool-using `streamText` call sites in the M14 review harness
 * (workers + boss-loop) must NOT fall back to Gemini on Anthropic failure,
 * because Gemini's structured-output API rejects requests that combine
 * `tools[]` with `responseMimeType: 'application/json'` (the `Output.object`
 * setting). The cascade for those call sites is **Anthropic primary +
 * 1× transient retry, hard-fail otherwise** — the second half of ADR-0017's
 * original 4-step cascade is skipped.
 *
 * Exercises the worker path via `callWorker()` (exported as a test seam)
 * with a stub primary that always throws. The policy is encoded as the
 * absence of fallback wiring (compile-time deletion); this smoke asserts
 * the failure shape that wiring-deletion produces. Boss-loop smoke is
 * intentionally skipped per the amendment ("the policy is identical at
 * both sites, the worker smoke proves it, and the boss path remains
 * unobserved in dogfood").
 *
 * Asserts:
 *   (a) The stub primary's `doStream` is invoked exactly once — i.e., no
 *       second-attempt against a Gemini fallback model.
 *   (b) `result.ok === false` (primary failure surfaced cleanly, not
 *       swallowed) and `result.error` contains the literal sentinel
 *       "Gemini fallback skipped (tools required)".
 *   (c) `result.error` opens with "anthropic <tier> failed (...)" — the
 *       error names the failing provider tier so the runWorker degraded
 *       entry reads correctly to a user.
 *
 * Does NOT make any real HTTP request. Runs offline.
 *
 * Usage: pnpm --filter @warden/cli smoke:bugfloor-gemini-skip-with-tools
 */

import { MockLanguageModelV3 } from "@warden/ai/test";
import { callWorker } from "@warden/core/review-harness/workers/run-worker";

let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) {
    process.stdout.write(`  ✓ ${msg}\n`);
  } else {
    process.stdout.write(`  ✗ ${msg}\n`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Stub a primary that always throws — simulates a sustained Anthropic outage.
// ---------------------------------------------------------------------------

process.stdout.write(`\n[1] callWorker with throwing stub primary (sonnet tier)\n`);

let doStreamCallCount = 0;
const stubPrimary = new MockLanguageModelV3({
  provider: "stub-anthropic",
  modelId: "stub-fail-sonnet",
  doStream: async () => {
    doStreamCallCount++;
    throw new Error("simulated 5xx — anthropic unreachable");
  },
});

const result = await callWorker({
  tier: "sonnet",
  primary: stubPrimary,
  systemPrompt: "You are a stub worker. Do not call tools.",
  userPrompt: "stub prompt",
  tools: {},
  timeoutMs: 5000,
});

// (a) — no fallback attempt means the primary is the only model the worker
// touched. AI SDK v6 wraps the model in a single retry attempt per
// `tryProvider()` (no `createRetryable` wrap at the worker level), so a
// single throw = one observed invocation.
assert(
  doStreamCallCount === 1,
  `primary invoked exactly once (got ${doStreamCallCount}) — proves no Gemini fallback attempt`,
);

// (b) — primary failure surfaced, error names the policy sentinel.
assert(result.ok === false, `result.ok is false (primary failure propagated)`);
const errorMessage = result.ok === false ? result.error : "";
assert(
  errorMessage.includes("Gemini fallback skipped (tools required)"),
  `error message contains policy sentinel (got: ${truncate(errorMessage, 200)})`,
);

// (c) — error names the failing provider tier.
assert(
  errorMessage.startsWith("anthropic sonnet failed ("),
  `error opens with "anthropic sonnet failed (" (got: ${truncate(errorMessage, 80)})`,
);

// ---------------------------------------------------------------------------
// Second exercise: haiku tier — same policy, different label substitution.
// ---------------------------------------------------------------------------

process.stdout.write(`\n[2] callWorker with throwing stub primary (haiku tier)\n`);

let haikuCallCount = 0;
const stubHaiku = new MockLanguageModelV3({
  provider: "stub-anthropic",
  modelId: "stub-fail-haiku",
  doStream: async () => {
    haikuCallCount++;
    throw new Error("simulated rate-limit — anthropic 429");
  },
});

const result2 = await callWorker({
  tier: "haiku",
  primary: stubHaiku,
  systemPrompt: "You are a stub worker.",
  userPrompt: "stub prompt",
  tools: {},
  timeoutMs: 5000,
});

assert(haikuCallCount === 1, `haiku primary invoked exactly once (got ${haikuCallCount})`);
assert(result2.ok === false, `haiku result.ok is false`);
const errorMessage2 = result2.ok === false ? result2.error : "";
assert(
  errorMessage2.includes("Gemini fallback skipped (tools required)"),
  `haiku error contains policy sentinel`,
);
assert(
  errorMessage2.startsWith("anthropic haiku failed ("),
  `haiku error opens with "anthropic haiku failed (" (got: ${truncate(errorMessage2, 80)})`,
);

// ---------------------------------------------------------------------------

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

if (failed > 0) {
  process.stdout.write(`\n${failed} assertion(s) failed\n`);
  process.exit(1);
}
process.stdout.write(`\nall assertions passed\n`);
