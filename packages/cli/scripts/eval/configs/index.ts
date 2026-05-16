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

export const ALL_CONFIGS: EvalConfig[] = [
  baseline,
  programmaticDispatch,
  programmaticDispatchExamplesFirst,
  programmaticDispatchMulti,
];
