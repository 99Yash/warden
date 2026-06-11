/**
 * M15 (ADR-0031) candidate harness configurations.
 *
 * `baseline` — current M14 boss-loop, no overrides. Used as the regression
 * reference (`results/baseline-m14.json`) and the `--compare baseline …`
 * left-hand side. If this clears the multi-criteria threshold accidentally,
 * M15's whole calibration premise is wrong.
 *
 * `programmatic-dispatch` — Round 0 deterministic fan-out ON, rules-based
 * prompt unchanged. First lever against the M14 boss-laziness evidence.
 *
 * `programmatic-dispatch-examples-first` — Round 0 + examples-first prompt
 * variant. Second lever if `programmatic-dispatch` alone doesn't clear.
 *
 * (Config D — Opus 4.7 fallback — is documented in `m15-plan.md` §Phase 6
 * but not represented here; build only if A–C all fail. Adding it requires
 * exposing a model-override seam on `BossLoopConfig` per the handoff
 * notes.)
 */

import type { EvalConfig } from "../types.js";

export const baseline: EvalConfig = {
  name: "baseline",
  description: "Pre-M15 baseline — programmatic dispatch OFF, rules prompt.",
  // Explicit opt-out: post-ADR-0031 close-out, the harness defaults to
  // PD-multi. To use this config as the regression reference for compare
  // against PD/PD-multi, we must explicitly disable programmatic dispatch
  // — otherwise "baseline" would re-shape into PD-multi and the compare
  // becomes meaningless.
  bossLoop: {
    programmaticDispatch: false,
    roundZeroExtraConcerns: [],
  },
};

export const programmaticDispatch: EvalConfig = {
  name: "programmatic-dispatch",
  description:
    "Programmatic Round 0 fan-out ON, single-routed-concern-per-file, rules-based prompt. ADR-0031 Config B.",
  bossLoop: {
    programmaticDispatch: true,
    // Empty extras: this config preserves the original "one worker per
    // routed concern per file" shape Config B was evaluated against. The
    // post-close-out default is `['correctness']` (PD-multi); we override
    // here to keep the historical Config B reproducible.
    roundZeroExtraConcerns: [],
  },
};

export const programmaticDispatchExamplesFirst: EvalConfig = {
  name: "programmatic-dispatch-examples-first",
  description:
    "Programmatic Round 0 + examples-first prompt variant. ADR-0031 Config C.",
  bossLoop: {
    programmaticDispatch: true,
    roundZeroExtraConcerns: [],
    bossPromptVariant: "examples",
  },
};

/**
 * ADR-0031 close-out follow-up (the PD-multi probe). Round 0 dispatches
 * the det-routed concern PLUS a correctness worker on every substantive
 * file. Tests the hypothesis: PD's single-concern-per-file routing was
 * too narrow — by also dispatching correctness universally we recover
 * the breadth baseline gets via boss agency while keeping PD's forced
 * dispatch guarantee. Roughly 2× the worker count of plain PD; cost
 * stays within budget (observed ~$0.04–0.10 per fixture).
 */
export const programmaticDispatchMulti: EvalConfig = {
  name: "programmatic-dispatch-multi",
  description:
    "Programmatic Round 0 + correctness-on-every-file extra dispatch. ADR-0031 follow-up.",
  bossLoop: {
    programmaticDispatch: true,
    roundZeroExtraConcerns: ["correctness"],
  },
};

/**
 * Sentry-Warden prompt-craft borrow probe (M-X, post-ADR-0036).
 *
 * Same harness shape as `programmaticDispatchMulti` (the post-ADR-0031
 * production default — "Config A" in the M-X experiment notes) but with
 * `workerPromptVariant: 'sentry-borrow'`. The loader silently falls back
 * to baseline `<concern>-system.md` for any concern that lacks a
 * `<concern>-system.sentry-borrow.md` file, so this config exercises only
 * the four workers (correctness, scalability, consistency, security) the
 * per-worker fit analysis identified as borrow-eligible; committability
 * and leverage stay on baseline by design.
 *
 * Tests the hypothesis that warden's recall gap on `m6-misses-2d4dc0b`
 * and `alfred-pr14-misses-1ff9057` is prompt-craft-limited (closeable by
 * better worker prompts inside the existing citation discipline) rather
 * than substrate-limited (would need a new `SourceType`) or thinking-
 * limited (would need more boss rounds or apex model).
 */
export const sentryBorrow: EvalConfig = {
  name: "sentry-borrow",
  description:
    "PD-multi + workerPromptVariant='sentry-borrow' — borrows adversarial voice + 7-step investigation + category×trigger table + severity tie-breaker into 4 of 6 worker prompts. Probes whether prompt craft closes the M6/alfred recall gap.",
  bossLoop: {
    programmaticDispatch: true,
    roundZeroExtraConcerns: ["correctness"],
    workerPromptVariant: "sentry-borrow",
  },
};

export const ALL_CONFIGS: EvalConfig[] = [
  baseline,
  programmaticDispatch,
  programmaticDispatchExamplesFirst,
  programmaticDispatchMulti,
  sentryBorrow,
];
