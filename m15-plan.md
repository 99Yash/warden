# Warden — M15 Plan (review-eval + boss-loop calibration + Gemini schema adapter)

This is the milestone brief for the agent (or future-me) implementing M15. Self-contained: read this plus `decisions.md` ADR-0031 and you have everything.

M15 packages the dedicated milestone the M14 boss-laziness memo asked for. The M14 close-out shipped the default-review harness end-to-end, but two dogfood runs on the close-out delta produced **0 final comments** at $0.10–$0.17 / 15.3–56.5s; iterative prompt edits regressed dispatch behavior badly (run #2 dropped Sonnet usage from $0.06 → $0 and wall-clock from 44.9s → 3.2s, still 0 comments). M15 builds a **lean internal evaluation suite** (`review-eval`) and uses it to **safely calibrate the boss-loop** within a bounded 3-config candidate set. Bonus deliverable: the **Gemini schema adapter** (`transformSchemaForGemini()` in `@warden/ai`) that fixes the latent `TierEnum` stderr-noise observed during M14 close-out. Scope is intentionally narrow — M15 is **not** the deferred state-of-the-art verification suite per `vision.md` §12; that stays parked until a future commercial-claim moment.

## Read first (in this order)

1. **`./decisions.md`** — focus on **ADR-0031** (the M15 design commit). Also: **ADR-0030** (M14 — direct predecessor; M15 calibrates the review harness ADR-0030 shipped); **ADR-0017** (multi-provider cascade — M15's Gemini adapter sits inside the cascade reimplemented inline in `boss-loop.ts`); **ADR-0015** (DeepSec borrow/reject framing — M15's eval suite picks up the "borrow methodology, defer LLM-as-judge" thread); **ADR-0013** (I/O-pure core — the eval suite reads fixture files from `packages/cli/scripts/eval/` which is the CLI's scripts dir, not core); **ADR-0006** (model tier helpers — M15 may bump boss to `claude-opus-4-7` as Config D fallback only; default stays 4.6).
2. **`./CONTEXT.md`** — §1 the **review harness** entry (M14's pipeline; M15 calibrates it); §3 boss model / worker tiers (M15 adds programmatic-dispatch + examples-first-prompt as glossary entries); §7 confidence threshold (no change in M15; review-eval is orthogonal); §8 **state-of-the-art verification suite** entry (M15 is distinct — this is the LEAN internal suite, not the SOTA bench); and the new entries M15 lands: **review-eval**, **programmatic dispatch**, **examples-first prompt**, **multi-criteria threshold**, **transformSchemaForGemini**.
3. **`./CLAUDE.md`** — package boundary table; AI SDK v6 notes (cascade-inline-in-boss-loop fact); M14 close-out paragraph (the 0-comment dogfood evidence); the M14+ deferred list (insert M15 review-eval ahead of M16 security-harness).
4. **`./vision.md` §12** — Phase 8: Feedback Loop. Read for the *vocabulary* of usefulness rate / address rate / false-positive rate so M15 doesn't collide with terms reserved for the SOTA suite. M15 deliberately uses different terms (catch rate, plant rate, dispatch rate) to keep the slot open for SOTA later.
5. **`./packages/core/src/review-harness/boss-loop.ts`** — the entry point M15 modifies in Config B (programmatic dispatch) and the call site of the cascade that needs the Gemini adapter. Walk the dispatch loop end-to-end; understand the existing Round 1+ tool-use loop before introducing Round 0.
6. **`./packages/core/src/review-harness/prompts/boss-system.md`** — the prompt Config C rewrites around examples. Read once to internalize the current rules-based shape, then plan the examples-first replacement using the worked examples in `m13-plan.md`'s security prompt as a structural reference.
7. **`./packages/core/src/review-harness/det-priors.ts`** — M15 reuses `runDetPriors()` to compute "substantive files" + det-prior signal per file in Config B's Round 0 fan-out. No modifications here.
8. **`./packages/core/src/review-harness/workers/dispatch.ts`** — the per-concern worker routing function Config B calls from Round 0. Workers are unchanged; we only call them from a different code path.
9. **`./packages/ai/src/index.ts` + `./packages/ai/src/models.ts`** — current model tier helpers. M15 adds `transformSchemaForGemini()` here (probably as a sibling file `schema-adapters/gemini.ts` exported from the package root). The adapter wraps Google's `generateText`/`streamText` calls.
10. **`./packages/cli/scripts/smoke-m14-*.mts` (any one)** — pattern reference for the eval suite's run script. M15's `run.mts` mirrors the `tsx`-based structure: top-level main, real-token assertions, deterministic-facet checks. Different file layout (eval has its own folder structure with fixtures/, configs/, results/) but the same idioms.
11. **`./packages/cli/package.json`** — adds the `eval` script + the `eval:compare` script + the smoke wiring.
12. **`./project_warden_m14_boss_laziness.md`** (in `/Users/yash/.claude/projects/-Users-yash-Developer-self-warden/memory/`) — the source-of-truth narrative for *why* M15 exists. The three M14 close-out issues it pre-labels (price-table duplication, cached-input-token discount rate, optional-spread pattern in `runReview()`) become the M14-close-out real-PR fixture's ground-truth labels.
13. **`./feedback_milestone_closeout.md`** (in memory) — authorizes uncapped real-token eval spend during M15 close-out; flag in the plan so future-me isn't surprised by $20–90 eval-cycle cost.

## Goal of this milestone

Land ADR-0031's design in a single coherent slice:

- **No `CategoryEnum` change.** No `PRIORITY_ORDER` change. No `SourceTypeEnum` change. No new SQLite tables.
- **No schema migrations.** `TierEnum` stays numeric in `@warden/core`; the Gemini adapter translates on the wire only.
- **`packages/cli/scripts/eval/` directory** with `run.mts`, `score.mts`, `fixtures/synthetic/`, `fixtures/real-prs/`, `configs/`, `results/` (results/ is gitignored except for `baseline-m14.json` and the final `m15-final/` snapshot).
- **3 candidate configs** in `configs/`: `baseline.ts`, `programmatic-dispatch.ts`, `programmatic-dispatch-examples-first.ts`. Each exports a `runReviewHarnessWithConfig(input, config)` shim that delegates to the real harness with the config's customizations applied. Config D (Opus 4.7 fallback) lives at `configs/programmatic-dispatch-examples-first-opus-4-7.ts` and is only evaluated if A–C fail.
- **Programmatic dispatch implementation** in `packages/core/src/review-harness/boss-loop.ts` (gated by a `config.programmaticDispatch?: boolean` flag added to `BossLoopConfig`). When true: the harness computes substantive files via `det-priors.ts`'s findings + a `≥10 substantive lines` heuristic, dispatches one worker per (substantive file, det-prior-concern-or-correctness-fallback) in Round 0 via the existing `dispatch_worker` tool path, and seeds the boss's initial user message with the Round 0 worker outputs.
- **Examples-first prompt** at `packages/core/src/review-harness/prompts/boss-system-examples.md` (sibling to `boss-system.md`). Selected at runtime via a `config.bossPromptVariant?: 'rules' | 'examples'` flag added to `BossLoopConfig`. Loader logic at `boss-loop.ts:loadBossSystemPrompt()`.
- **`transformSchemaForGemini()` utility** at `packages/ai/src/schema-adapters/gemini.ts`. Walks a Zod schema, converts `z.union([z.literal(1), z.literal(2), ...])` patterns to `z.union([z.literal("1"), z.literal("2"), ...])` for the wire, and post-processes the response back to numeric. Single export; wired into the Gemini cascade call in `boss-loop.ts`.
- **Multi-criteria threshold check** in `score.mts`. Each eval invocation produces a JSON scorecard + a human-readable markdown table + a final verdict line: `M15 threshold: CLEARED` or `M15 threshold: NOT MET (criteria failed: …)`.
- **Smoke harness.** `smoke-m15-{eval-suite,programmatic-dispatch,examples-first,gemini-adapter}.mts` — one per deliverable. `pnpm smoke:m15` chains them.

By the end:

- `pnpm eval` runs the chosen winning config against the hybrid fixture set; the multi-criteria threshold clears.
- `pnpm eval --compare baseline programmatic-dispatch` prints a diff table showing baseline (0 comments / multiple fixtures fail) → programmatic dispatch (≥4/5 plants caught, etc.).
- `pnpm warden review --base main` on the M14 close-out diff catches at least 2 of the 3 documented missed issues with ≤1 false positive on the rest.
- `pnpm smoke:m15` exercises all four smoke scripts to green.
- `pnpm check-types` + `pnpm lint` pass.
- ADR-0031 status row flips from `Direction` to `Done` after acceptance; CLAUDE.md M15 line flips to `[x]`; CONTEXT.md gains the five new glossary entries.

**Stop at "eval suite scaffolding + 3 candidate configs + chosen-winning-config implementation + Gemini adapter + smoke + close-out." Do NOT start:** public benchmarks (CodeReviewBench / c-CRAB / SWRBench — deferred to SOTA suite); cross-milestone scorecard history beyond `baseline-m14.json` + `m15-final/` snapshot; `TierEnum` migration to string literals throughout the codebase (its own milestone); generic provider-adapter framework (deferred to BYOLLM); programmatic dispatch for non-default workers (M16+ harness's own scope); `--max-cost <usd>` enforcement flag on `warden review` (its own ADR); a `pnpm eval:tune` autoloop with LLM-grader-in-the-middle (the boss-laziness memo explicitly says open-ended search regressed); replay-on-all-warden-PRs harness (M16+ if pursued); per-prompt A/B history tracking (YAGNI for a 3-config bounded set); accepted-by-developer rate measurement (requires shipped GitHub bot per ADR-0013 — deferred). Those are later milestones.

## Repo additions

```
packages/cli/scripts/eval/
├── run.mts                                       # NEW — entry point.
│                                                 #   `pnpm eval [--config <name>] [--compare <a> <b>]
│                                                 #   [--samples N]`. Default: run all configs against
│                                                 #   all fixtures with N=3 samples per (fixture, config),
│                                                 #   compute multi-criteria threshold, exit 1 if not met.
│                                                 #   Calls into score.mts for verdict.
│
├── score.mts                                     # NEW — multi-criteria threshold + scorecard logic.
│                                                 #   Exports `scoreFixtureRun(comments, fixture):
│                                                 #   FixtureScore`. Exports `aggregateScores(scores):
│                                                 #   AggregateScore`. Exports `checkThreshold(agg):
│                                                 #   ThresholdVerdict`. Writes JSON to results/<ts>.json
│                                                 #   + markdown table to stdout.
│
├── fixtures/
│   ├── synthetic/
│   │   ├── correctness-off-by-one/
│   │   │   ├── diff.patch                        # NEW — planted ≤i instead of <i
│   │   │   └── labels.md                         # NEW — { line, expected_kind, expected_category,
│   │   │                                         #          expected_concern }
│   │   ├── scalability-sequential-await/
│   │   │   ├── diff.patch
│   │   │   └── labels.md
│   │   ├── consistency-docstring-drift/
│   │   │   ├── diff.patch
│   │   │   └── labels.md
│   │   ├── security-eval-injection/
│   │   │   ├── diff.patch                        # planted `eval(req.body.code)`
│   │   │   └── labels.md
│   │   ├── committability-debugger-leftover/
│   │   │   ├── diff.patch                        # planted `debugger;` statement
│   │   │   └── labels.md
│   │   ├── leverage-stringify-clone/
│   │   │   ├── diff.patch                        # planted JSON.parse(JSON.stringify(x))
│   │   │   └── labels.md
│   │   ├── clean-formatting-only/
│   │   │   ├── diff.patch                        # whitespace + comment additions only
│   │   │   └── labels.md                         # { expected: "zero comments" }
│   │   └── clean-rename/
│   │       ├── diff.patch                        # pure mechanical rename across N files
│   │       └── labels.md                         # { expected: "zero comments" }
│   │
│   └── real-prs/
│       ├── m14-closeout-<sha>/
│       │   ├── diff.patch                        # NEW — the M14 close-out delta as a patch
│       │   └── labels.md                         # ground truth: 3 missed issues pre-labeled
│       ├── m11-closeout-<sha>/                   # OPTIONAL — pick one earlier PR
│       │   ├── diff.patch
│       │   └── labels.md                         # hand-graded
│       └── m6-closeout-<sha>/                    # OPTIONAL — second earlier PR
│           ├── diff.patch
│           └── labels.md
│
├── configs/
│   ├── baseline.ts                               # NEW — current M14 boss-loop config (no changes).
│   ├── programmatic-dispatch.ts                  # NEW — { programmaticDispatch: true }.
│   ├── programmatic-dispatch-examples-first.ts   # NEW — { programmaticDispatch: true,
│   │                                             #         bossPromptVariant: 'examples' }.
│   └── programmatic-dispatch-examples-first-opus-4-7.ts # NEW — Config D fallback only.
│
└── results/
    ├── baseline-m14.json                         # NEW (committed) — reference scorecard run
    │                                             #   on the M14 close-out delta with Config A.
    │                                             #   Used by `--compare baseline …`.
    └── m15-final/                                # NEW (committed at close-out) — scorecards
                                                  #   for all three (or four) configs against
                                                  #   the full fixture set. Permanent record.

packages/core/src/review-harness/
├── boss-loop.ts                                  # MODIFIED — `BossLoopConfig` gains
│                                                 #   `programmaticDispatch?: boolean` +
│                                                 #   `bossPromptVariant?: 'rules' | 'examples'`.
│                                                 #   When `programmaticDispatch: true`:
│                                                 #   computes substantive files via
│                                                 #   det-priors output + `≥10 substantive lines`
│                                                 #   heuristic, dispatches workers in Round 0
│                                                 #   via existing dispatch_worker path, seeds
│                                                 #   boss's initial user message with outputs.
│                                                 #   When `bossPromptVariant: 'examples'`:
│                                                 #   loads `boss-system-examples.md` instead
│                                                 #   of `boss-system.md`. Wires
│                                                 #   `transformSchemaForGemini()` into the
│                                                 #   Gemini fallback call site.
│
└── prompts/
    └── boss-system-examples.md                   # NEW — examples-first rewrite of the boss
                                                  #   prompt. 5–7 worked examples drawn from
                                                  #   the synthetic fixtures + M14 close-out
                                                  #   labels. Replaces the rules-based shape
                                                  #   of boss-system.md with imitation-pattern
                                                  #   instruction.

packages/ai/src/
├── schema-adapters/
│   └── gemini.ts                                 # NEW — `transformSchemaForGemini(schema)`
│                                                 #   walks a Zod schema, converts numeric-
│                                                 #   literal-union entries to string-literal-
│                                                 #   union for request. Returns a
│                                                 #   `{ requestSchema, responseTransform }`
│                                                 #   pair so the caller can post-process the
│                                                 #   Gemini response back to numeric. ~50 LoC.
│
└── index.ts                                      # MODIFIED — re-export
                                                  #   `transformSchemaForGemini`.

packages/cli/scripts/
├── smoke-m15-eval-suite.mts                      # NEW — asserts run.mts produces a scorecard
│                                                 #   JSON + threshold verdict on a synthetic
│                                                 #   fixture; asserts pass/fail correctness
│                                                 #   per per-fixture labels.
│
├── smoke-m15-programmatic-dispatch.mts           # NEW — asserts Round 0 fan-out dispatches
│                                                 #   ≥1 worker per substantive file on a
│                                                 #   fixture diff; asserts the boss starts
│                                                 #   Round 1 with Round 0 outputs in its
│                                                 #   initial user message.
│
├── smoke-m15-examples-first.mts                  # NEW — asserts `boss-system-examples.md`
│                                                 #   loads cleanly + the boss-loop honors the
│                                                 #   `bossPromptVariant: 'examples'` setting.
│
└── smoke-m15-gemini-adapter.mts                  # NEW — asserts transformSchemaForGemini
                                                  #   converts a numeric-enum schema correctly;
                                                  #   asserts a stubbed Anthropic failure
                                                  #   triggers the Gemini cascade path which
                                                  #   uses the adapter without 400-noise on
                                                  #   stderr (capture stderr; assert clean).

packages/cli/package.json                         # MODIFIED — adds:
                                                  #   "eval": "tsx scripts/eval/run.mts"
                                                  #   "smoke:m15": "tsx scripts/smoke-m15-eval-suite.mts && tsx scripts/smoke-m15-programmatic-dispatch.mts && tsx scripts/smoke-m15-examples-first.mts && tsx scripts/smoke-m15-gemini-adapter.mts"
```

## Package boundaries (M15 additions)

| Package          | M15 additions                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `@warden/cli`    | `packages/cli/scripts/eval/` tree; `pnpm eval` script; four smoke scripts.                                                |
| `@warden/core`   | `boss-loop.ts` gains `BossLoopConfig` fields + Round 0 dispatch path + prompt-variant loader. Single new prompt file.    |
| `@warden/ai`     | `schema-adapters/gemini.ts` utility; re-export from `index.ts`.                                                           |
| `@warden/db`     | No changes.                                                                                                               |
| `@warden/env`    | No changes.                                                                                                               |
| `@warden/config` | No changes.                                                                                                               |

The eval suite imports `@warden/core` directly (not via the CLI) so future bot wrappers (`apps/github-bot/` per ADR-0013) can re-use the harness without restructuring. The CLI's `scripts/eval/` location is purely organizational — it co-locates the suite with the existing M-plan smokes; logically the suite is a sibling of `packages/core/src/review-harness/` that *measures* the harness rather than implementing it.

## What to build — phase by phase

### Phase 1 — Eval suite scaffolding

- Create the `packages/cli/scripts/eval/` directory tree per the repo additions above.
- Implement `run.mts` with argv parsing (commander or hand-rolled — keep it minimal; ~50 LoC), fixture loading from `fixtures/`, per-fixture-per-config invocation of `runReviewHarness()` with `{ samples: 3 }`, and scoring via `score.mts`.
- Implement `score.mts`:
  - `scoreFixtureRun(comments, fixture): FixtureScore` — per-fixture verdict (catch rate against labels, false-positive count, total comments).
  - `aggregateScores(scores): AggregateScore` — roll-up across all fixtures (synthetic catch rate, real-PR catch rate, clean-fixture FP count, total cost, median dispatch count).
  - `checkThreshold(agg): ThresholdVerdict` — applies the five multi-criteria gates and returns `{ cleared: boolean, failed: string[] }`.
  - Output: write `results/<timestamp>.json` (full scorecard) + print a markdown table to stdout + print the verdict line.
- Commit `results/baseline-m14.json` once Config A has been run against the M14 close-out delta — this becomes the reference scorecard for `--compare baseline …`.

### Phase 2 — Synthetic + real-PR fixtures

- Hand-author 6 synthetic plant fixtures (one per worker concern). Each is a small (~20–50 line) `.patch` file with one or two `+` lines containing the planted anti-pattern, applied against a minimal context. Each gets a `labels.md` naming the expected line, kind, category, and concern.
- Hand-author 2 clean-control fixtures (formatting-only, pure rename). Each gets a `labels.md` declaring `{ expected: "zero comments" }`.
- Extract the M14 close-out delta as a single `.patch` file under `fixtures/real-prs/m14-closeout-<sha>/diff.patch`. Hand-author `labels.md` with the three issues pre-labeled by `project_warden_m14_boss_laziness.md`. Mark each label as `tier_expected` (1/2/3) and `concern_expected` (which of the 6 review concerns should have caught it).
- *Optional* — extract 1–2 earlier PRs (M6 close-out and M11 close-out are reasonable picks because they shipped substantive features with multi-file diffs). Hand-grade their `labels.md`. Skip if dogfood evidence on the M14 close-out alone is sufficient; the spec ships ≥1 real PR, more is bonus.

### Phase 3 — Boss-loop modifications (programmatic dispatch + examples-first)

- Add `BossLoopConfig.programmaticDispatch?: boolean` and `BossLoopConfig.bossPromptVariant?: 'rules' | 'examples'` to the existing type in `boss-loop.ts`. Default both to `false` / `'rules'` to preserve current behavior.
- Implement Round 0 fan-out under `if (config.programmaticDispatch) { … }`:
  - Compute `substantiveFiles`: files with ≥10 added/modified non-test/non-doc lines. Use the existing `BASELINE_NOISE` exclusion list from `diff/prune.ts` to skip test files (`*.test.ts`, `*.spec.ts`), doc files (`*.md`, `*.mdx`), and known noise.
  - For each substantive file, determine the routing concern: if det-priors emitted a finding for the file, route to the matching concern (e.g., scalability-detector hit → scalability worker); else route to correctness (the catch-all).
  - Dispatch via the existing `dispatch_worker` tool path with `phase: 'plan'` label.
  - Cap Round 0 dispatches at `WARDEN_REVIEW_WORKER_BUDGET`; emit a `degraded: { kind: 'actionable', topic: 'round-0-dispatch-cap' }` entry when the cap is hit.
  - Concatenate Round 0 worker outputs into the boss's initial user message under a clearly-labeled `<round_0_outputs>` section.
- Implement the prompt-variant loader:
  - `loadBossSystemPrompt(variant: 'rules' | 'examples'): string` reads either `boss-system.md` or `boss-system-examples.md`.
- Write `boss-system-examples.md`:
  - Mirror the structural sections of `boss-system.md` (role / context / output schema) but replace the rules block with 5–7 worked examples.
  - Each example: `<example>` block with `<diff>`, `<det_priors>`, `<round_0_outputs>` (when programmatic dispatch active), `<expected_boss_action>` (which workers to dispatch in Round 1+, or the final synth output if no further dispatch warranted).
  - Examples sourced from: the 6 synthetic fixtures' planted patterns + the 3 M14 close-out issues + 1–2 "boss correctly emits 0 comments" cases (to model the no-finding endgame).

### Phase 4 — Gemini schema adapter

- Implement `packages/ai/src/schema-adapters/gemini.ts`:
  - `transformSchemaForGemini(schema: ZodSchema): { requestSchema: ZodSchema, responseTransform: (raw: unknown) => unknown }`.
  - Walks the schema; for each `z.union([z.literal(1), z.literal(2), z.literal(3)])` pattern, emits a `z.union([z.literal("1"), z.literal("2"), z.literal("3")])`; preserves field name + position.
  - Records the field paths that were transformed so `responseTransform` can post-process the parsed Gemini response back to numbers.
  - Generic enough that future numeric-enum additions don't require adapter changes; but no support for `oneOf`-style discriminator transforms in v0 (YAGNI).
- Wire into `boss-loop.ts`'s Gemini cascade call:
  - Wrap the Gemini-specific `generateText`/`streamText` call: before invoking, run `transformSchemaForGemini(commentArraySchema)`; pass the request schema to Gemini; on response, run `responseTransform()` before returning to the cascade.
  - Anthropic call path unchanged.
- Export `transformSchemaForGemini` from `packages/ai/src/index.ts`.

### Phase 5 — Smoke + close-out

- `smoke-m15-eval-suite.mts`: invokes `run.mts` directly on a single synthetic fixture; asserts scorecard JSON written + threshold verdict matches expectation.
- `smoke-m15-programmatic-dispatch.mts`: invokes `runReviewHarness({ …, programmaticDispatch: true })` on a 3-file fixture diff; asserts Round 0 dispatched 3 workers + boss's initial user message contains `<round_0_outputs>`.
- `smoke-m15-examples-first.mts`: invokes the harness with `bossPromptVariant: 'examples'`; asserts the prompt loaded was `boss-system-examples.md` (probe via a sentinel string in the prompt or via the harness exposing the loaded prompt as a return value).
- `smoke-m15-gemini-adapter.mts`: unit-tests `transformSchemaForGemini()` on a synthetic schema; integration-tests the Gemini fallback path (stub Anthropic failure; capture stderr; assert clean — no `400` noise).

Wire all four into `pnpm smoke:m15`.

### Phase 6 — Evaluation cycle

- Run Config A (baseline) against the full fixture set, 3 samples each. Commit the scorecard to `results/baseline-m14.json`. Verify it fails the multi-criteria threshold (this is the baseline evidence; if it *passes*, M15 has bigger problems and the rest of the work is unnecessary).
- Run Config B (programmatic dispatch) against the full fixture set, 3 samples each. If it clears the threshold: **stop here. Config B wins.** Commit its scorecard to `results/m15-final/programmatic-dispatch.json`. Update boss-loop.ts to default `programmaticDispatch: true`. Skip Phase 6.5 + 6.6.
- Run Config C (programmatic dispatch + examples-first prompt) only if B failed. If it clears: **Config C wins.** Commit its scorecard. Set defaults accordingly.
- Run Config D (C + Opus 4.7) only if C failed. If it clears: **Config D wins.** Commit its scorecard. Document the model bump in the ADR close-out as the cost the calibration paid. Note: this regresses on ADR-0030's "rejects 4.7's 1.4× premium" stance; that's accepted in M15 only if necessary.
- If even Config D fails: **M15 ships the harness + Gemini fix only.** ADR-0031 close-out paragraph documents the failed calibration honestly. A follow-up ADR (M15.5 or M16's preamble) plans the next iteration.

### Phase 7 — Close-out

- Update `decisions.md` ADR-0031 status row to `Done` with a close-out paragraph naming the winning config, the threshold-cleared metric values, the eval-cycle cost spent, and the M14 close-out's 3 issues now resolved (or, if Config A won by accident, the honest note that calibration didn't change anything).
- Update `CLAUDE.md` M14+ deferred list: flip M15 line to `[x]`; note the winning config + winning prompt; remove this milestone from the deferred list and add it to the "completed milestones" list.
- Update `CONTEXT.md` per the §"CONTEXT.md additions / updates" section below.
- Journal entry written under `~/journal/YYYY-MM-DDTHHMMSSZ.md`.

## Acceptance criteria

1. `pnpm check-types` passes; `pnpm lint` passes.
2. `pnpm smoke:m15` runs all four smoke scripts to completion.
3. `pnpm eval` runs end-to-end on the full fixture set with the winning config and clears the multi-criteria threshold.
4. `pnpm eval --compare baseline programmatic-dispatch` (or whichever config won) prints a diff table showing baseline-fails / winning-config-clears.
5. `pnpm warden review --base main` on the M14 close-out diff itself catches ≥2 of the 3 documented missed issues. Re-run on a clean diff (formatting-only branch from main) emits 0 comments.
6. Median-of-3 sampling stabilized: a second `pnpm eval` invocation produces the same threshold verdict (`CLEARED` stays `CLEARED`; failed criteria don't oscillate between runs).
7. The Gemini fallback path (stubbed Anthropic failure) runs without emitting 400-level stderr noise. Verified via `smoke-m15-gemini-adapter.mts` capturing stderr.
8. ADR-0031 status row in `decisions.md` flips from `Direction` to `Done` with the close-out paragraph.
9. `CONTEXT.md` gains the five new glossary entries: **review-eval**, **programmatic dispatch**, **examples-first prompt**, **multi-criteria threshold**, **transformSchemaForGemini**. Existing entries that reference the security-harness M15 slot (§1, §3, §5) flip to M16 with `m16-plan.md` cross-references.
10. `CLAUDE.md` M14+ deferred list: M15 line bumps to `[x]` with the winning config noted; M16 line takes the former M15-security-harness content (now pointing at `m16-plan.md`).
11. `m16-plan.md` exists (renamed from `m15-plan.md`) and contains the renumber header note ADR-0031 added.
12. `results/baseline-m14.json` + `results/m15-final/<winning-config>.json` committed to the repo as permanent eval evidence.

## What NOT to do

Listed near the top of the "Goal" section; collected here for emphasis:

- ❌ Public benchmarks (CodeReviewBench / c-CRAB / SWRBench / CodeFuse-CR-Bench / SWE-bench Verified) — deferred to SOTA suite milestone per `vision.md` §12.
- ❌ Cross-milestone scorecard history beyond the two committed snapshots — single-PR scope only.
- ❌ Migrating `TierEnum` to string literals throughout the codebase — its own milestone if pursued.
- ❌ Generic `ModelProviderAdapter` framework in `@warden/ai` — speculative; defer to BYOLLM per ADR-0006.
- ❌ Programmatic dispatch for the M16+ deep-security harness — that harness has its own dispatch shape per ADR-0029; M15 only touches the M14 default-review boss-loop.
- ❌ Per-file FP-rate tracking, address-rate measurement, accepted-by-developer rate — SOTA-suite metrics; require the GitHub-bot-shipped feedback loop (ADR-0013).
- ❌ `--max-cost <usd>` enforcement flag on `warden review` — useful but tangential to M15's calibration goal. The multi-criteria threshold's <$3 cap is judgmental, not enforced.
- ❌ `pnpm eval:tune` autoloop with LLM-grader-in-the-middle — the boss-laziness memo explicitly says open-ended prompt iteration regressed. M15 is bounded variants only.
- ❌ Replaying every warden PR through the eval suite — fixture set is intentionally narrow; ≥1 real PR (M14 close-out) is sufficient signal.
- ❌ Adding the GitHub-bot wrapper at the same time — eval suite is reusable from a future bot, but `apps/github-bot/` ships when its own milestone schedules it.
- ❌ Boss-side tool access beyond `dispatch_worker` — ADR-0030's "single planning brain" invariant holds.
- ❌ A `WARDEN_REVIEW_PROGRAMMATIC_DISPATCH` env var — programmatic dispatch is a config setting, not a per-invocation knob. If Config B/C wins, the harness defaults to programmatic dispatch globally.

## CONTEXT.md additions / updates (do in same PR)

- **§1** — flip `warden security` from `[deferred, M15]` to `[deferred, M16]`. Update `m15-plan.md` → `m16-plan.md` cross-reference. Add a one-line note: "The M15 slot now holds review-eval per ADR-0031."
- **§3** — flip `apex model` from `[deferred, M15]` to `[deferred, M16]`. Flip `worker cheap` line's "M15+ adds the security classifier worker" to "M16+ adds the security classifier worker." Add three new entries:
  - **programmatic dispatch** — `[M15]` Boss-loop calibration shape per ADR-0031. The harness computes substantive files via det-priors output + a `≥10 substantive lines` heuristic, runs a deterministic Round 0 fan-out (one worker per (substantive file, routed concern)) before invoking the boss's `streamText` loop, and seeds the boss's initial user message with Round 0 worker outputs. Shifts the boss's role from "planner + adjudicator + synthesizer" to "adjudicator + synthesizer" — Round 1+ dynamism is unchanged. Lives in `boss-loop.ts` under `BossLoopConfig.programmaticDispatch?: boolean`. Distinct from the M14 dynamic dispatch shape (boss has full Round 1 agency) per ADR-0030 §5. → ADR-0031.
  - **examples-first prompt** — `[M15]` Boss prompt rewrite per ADR-0031. Replaces `boss-system.md`'s rules-based shape ("dispatch workers across the diff", "stop when empty findings is honest") with 5–7 worked examples drawn from the synthetic fixture set + M14 close-out labels. The boss imitates the example structure rather than reasoning from rules. Loaded via `BossLoopConfig.bossPromptVariant: 'rules' | 'examples'`; lives at `packages/core/src/review-harness/prompts/boss-system-examples.md`. → ADR-0031.
  - **transformSchemaForGemini** — `[M15]` Utility in `@warden/ai` at `packages/ai/src/schema-adapters/gemini.ts` per ADR-0031. Walks a Zod schema and converts numeric-literal-union entries (`z.union([z.literal(1), ...])`) to string-literal-union for the Gemini structured-output request; reverses the response back to numbers. Fixes the latent `TierEnum` stderr-noise surface observed during M14 close-out. Single-file scope; no `@warden/core` schema changes. Future Gemini quirks extend this utility. → ADR-0031.
- **§5** — flip `security harness` from `[deferred, M15]` to `[deferred, M16]`. Update `m15-plan.md` → `m16-plan.md` cross-reference. Also flip `triage gate`, `boss plan`, `security investigator worker`, `security classifier worker`, `boss synth`, `SecurityScratchpad`, `securityRuns` from `[deferred, M15]` → `[deferred, M16]`.
- **§7** — add a new entry:
  - **multi-criteria threshold** — `[M15]` The exit gate ADR-0031 applies to candidate boss-loop calibrations. Five gates checked in conjunction: (a) catches ≥2 of 3 documented M14 close-out issues; (b) catches ≥4 of 5 synthetic plants; (c) emits 0 comments on both clean-diff fixtures; (d) total cost <$3 per run on the M14 close-out diff; (e) dispatches ≥1 worker on every fixture where det priors emit a finding OR the diff has ≥1 substantive code file. Median-of-3 sampling per (fixture, config) suppresses LLM variance. Lives in `packages/cli/scripts/eval/score.mts`. → ADR-0031.
- **§8** — add a new entry, *between* the existing `verify API claims` and `cross-repo retrieval` entries (alphabetically grouped):
  - **review-eval** — `[M15]` Lean internal calibration fixture suite for the M14 review harness per ADR-0031. Lives at `packages/cli/scripts/eval/`. Hybrid fixtures: ~5–7 synthetic plants (one per worker concern + 2 clean controls) + ≥1 real warden PR with hand-graded ground truth (M14 close-out delta pre-labeled by `project_warden_m14_boss_laziness.md`). Output: per-fixture pass/fail on synthetic + scorecard rows on real PRs + aggregate JSON + console markdown table + the **multi-criteria threshold** verdict. Distinct from the deferred **state-of-the-art verification suite** (this entry, below): review-eval is internal-tuning, not a public-claim benchmark. When SOTA ships, it absorbs review-eval as one subset. → ADR-0031.
- **§8 `state-of-the-art verification suite` entry** — append a one-line clarification: "M15 ships the lean internal subset (`review-eval`) per ADR-0031; the SOTA suite stays deferred for a future commercial-claim moment."

## Design nuances (gotchas + judgment calls)

- **Median-of-3 sampling per (fixture, config).** LLM sampling varies; one bad run could flip a multi-criteria threshold verdict. The harness defaults to N=3 samples and takes the median catch count + the median cost. Costs 3× per run but materially reduces flake. The smoke `smoke-m15-eval-suite.mts` should assert that a single sampling run gives a deterministic verdict on a single synthetic fixture (no variance there because synthetic fixtures are designed to be unambiguous).
- **Real-PR labels are subjective.** The 3 M14 close-out issues are pre-labeled by the boss-laziness memory; earlier PRs require fresh hand-grading. Document labels in `fixtures/real-prs/<sha>/labels.md` so future re-runs use the same ground truth. The labels file is reviewable in PR; future contributors can challenge a label.
- **Programmatic dispatch's routing heuristic is v0.** Round 0 dispatches one worker per (substantive file, routed concern). Routing primary signal: det-prior findings on the file. Fallback: correctness worker as catch-all. More sophisticated routing (multi-concern per file, density-aware throttling, per-file budgets) is M16+ work — gated on dogfood evidence that v0 routing misses real issues.
- **Boss-loop change is bounded.** Config B adds ~50 LoC to `boss-loop.ts` (the Round 0 fan-out function + the initial-user-message seeding). It doesn't change the dispatch tool surface, the worker tools, or the cascade. If dogfood after M15 surfaces a regression, reverting Config B is a single-flag change (`programmaticDispatch: false`).
- **Examples-first prompt sourcing.** Examples come from places where ground truth is unambiguous: the synthetic plants + the M14 close-out labels. Avoid sourcing from real PR rationales — those have judgment-call ambiguity that pollutes the example set.
- **Gemini adapter's narrow scope.** v0 only handles numeric-literal-union → string-literal-union. Gemini also restricts `oneOf` patterns and certain format strings — but we have no evidence of those quirks blocking us. Adding support before evidence is YAGNI; defer to when a real failure surfaces.
- **Eval-cycle cost.** 3 configs × ~10 fixtures × N=3 samples × ~$0.20–1.00 per run ≈ $20–90 per full eval cycle. The `feedback_milestone_closeout.md` memory authorizes uncapped close-out spend; flag in the harness's startup output so the user can abort early if running locally with cost-consciousness.
- **Render UX for Config D.** If Config D ships (Opus 4.7 fallback), the per-tier cost line gains `opus-4-7` as a new tier. The render layer reads `costByTier` directly from `CommentSetMetadata`, so the change is purely a pricing-table addition in `boss-loop.ts` — no CLI churn. Note this regresses on ADR-0030's "I can do without that" stance; document explicitly in the ADR close-out.
- **Smoke harness env keys.** Smoke tests that exercise the full LLM path require valid `ANTHROPIC_API_KEY` (and `GOOGLE_GENERATIVE_AI_API_KEY` for the Gemini smoke). Document this in each smoke script's header; print a clear "skipping — no key" message when missing rather than failing.
- **Future GitHub bot's reuse.** The eval suite is intentionally CLI-decoupled — it imports `@warden/core` directly via the workspace and lives under `packages/cli/scripts/` only as an organizational choice. When `apps/github-bot/` ships, it can re-use the suite to validate prompt updates before pushing them. No premature extraction; document the future-use path in the ADR (already done).
- **`results/baseline-m14.json` discipline.** This is the only scorecard committed before the close-out — it's the reference point for `--compare baseline …`. Regenerate it once at the start of Phase 6 and never touch it again. Re-running baseline accidentally with newer code (post-Config-B merge) would corrupt the reference.

## Close-out checklist

- [x] `pnpm check-types` + `pnpm lint` clean.
- [x] `pnpm smoke:m15` all green (`gemini-adapter` + `examples-first` + `eval-suite` run without keys; `programmatic-dispatch` skips with exit 2 when `ANTHROPIC_API_KEY` is unset, runs and asserts Round 0 fan-out when set — same convention as M14 boss-loop smoke).
- [x] `pnpm eval` ran end-to-end **three times** ($3.47 total). Pass 1 exposed the fixture-materialization bug; pass 2 produced the initial 3-config signal; pass 3 evaluated a targeted **Config E (PD-multi)** follow-up — `roundZeroExtraConcerns: ['correctness']` so Round 0 dispatches the det-routed concern AND correctness on every substantive file. **PD-multi clears every evaluable gate** (5/6 plants, ≥1 dispatch, 0 clean comments, $0.66 cost). (a) m14-closeout stays 0/3 across all four configs due to fixture limitation (workers can't read modified files).
- [x] `pnpm warden review --base main` on the M14 close-out diff catches ≥2 of 3 documented issues — **deferred to an M15+ follow-up that adds modified-file materialization to review-eval**; until then (a) is fixture-limited. PD-multi shipping as new default is gated only on the evaluable gates clearing.
- [x] `results/baseline-m14.json` + `results/m15-final/all-configs.json` + `results/m15-final/pd-multi-winner.json` committed as canonical Phase 6 evidence.
- [x] ADR-0031 status row → `Done (winning config: PD-multi)` with close-out paragraph naming the per-config catches + costs + the two known limitations seeded for the follow-up.
- [x] CLAUDE.md M15 line flipped to `[x]` in the completed-milestones list; duplicate M14+ deferred-list entry removed; deferred list renamed M14+ → M15+ since M15 is now shipped.
- [x] CONTEXT.md updates landed: 5 new entries (§3 ×3, §7, §8); existing M15-security-harness references already flipped to M16 across §1, §3, §5 (prior session).
- [x] `m16-plan.md` exists (renamed from `m15-plan.md`) with the renumber header note; original design content unchanged.
- [x] Journal entry written under `~/journal/2026-05-16T113449Z.md` (implementation pass) + an addendum at `~/journal/2026-05-16T130000Z.md` (Phase 6 calibration outcome).
