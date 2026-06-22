# Warden — Reasoned-Lane Plan (core-agent precision/recall)

> **Status, 2026-06-17:** Direction grilled, not yet implemented. Sequences the
> core-agent-performance critical path under [ADR-0044](./decisions.md) (sourced
> vs reasoned findings), [ADR-0015](./decisions.md) (no second LLM, reaffirmed),
> and the existing M15 `review-eval` harness. **Scope is the reasoned lane only.**
> react-doctor default-on + the det-prior surfacing fork ([ADR-0046](./decisions.md))
> are a **separate** follow-on plan — see Non-Goals.

## Goal

Make Warden's `reasoned` findings (LLM judgment about the diff's own code) good
enough to ship asserted by default — without a second adjudicating LLM. The
M14 harness already emits reasoned assertions; ADR-0044 ratifies that and demotes
the universal citation gate. This plan is the **precision work that earns the
demotion**: drive the false-positive rate down far enough, and measured on the
eval, that flipping `reasonedFindingMode` default-on is defensible.

The wedge is dogfood evidence: alfred PR#131 produced 8 false positives across
12 findings. The `alfred-pr131-falsepos` fixture encodes all 8 as `expect: absent`
precision traps, split along their actual fault lines:

- **4 off-hunk traps** — comments anchored to lines outside the PR's added hunks.
  A deterministic anchoring gap, not a reasoning failure.
- **4 soundness traps** — the flagged line exists, but a second piece of code
  (caller-normalized input, callee guard, control-flow invariant) refutes the
  claim. The worker asserted without reading the refuting code.

## Decisions

1. **Honor ADR-0044 §6: no second LLM.** The reasoned-precision control is
   deterministic (confidence → degrade-to-question) plus a rigorous _single_
   worker pass. A second adjudicating LLM is the DeepSec two-agent pattern both
   ADR-0044 §6 and ADR-0015 reject. The older `reasoned_fp_root_cause` memory's
   "reopen ADR-0015 for a refutation pass" is **demoted to an eval-gated
   contingency** (Decision 7), not a planned step.

2. **The single pass must carry the weight a second pass would have.** Because
   we forgo a refutation LLM, the worker cannot be left to _choose_ whether to
   verify. Refuting context is **fed deterministically**, and self-refutation is
   **mandatory and structured** in the prompt.

3. **Off-hunk anchoring is deterministic — and already enforced.** A comment is
   dropped when its `[lineStart, lineEnd]` does **not** overlap ≥1 added line in
   its target file's diff hunks. Anchor = overlap ≥1 added line; zero overlap →
   drop (not degrade — a mis-anchored comment is noise, not an uncertain
   finding). **This already exists**: `scopeCommentsToDiff()` in
   `review-harness/harness.ts` runs unconditionally over every boss comment
   using the _pruned_ `ChangedFile[]`, before the harness returns. The keyed
   Step-0 baseline reproduces 0/8 traps precisely because the 4 off-hunk traps
   are already killed there. A second drop in `applyHardRules()` over the _raw_
   diff was implemented (commit 62a584c) and reverted: pruning is a subset
   filter, so the raw-diff pass can only keep a superset of what the harness
   already kept — a no-op on the m14-review path, and an actively wrong re-scope
   if it ever reached check / m18-security comments (deterministic + vuln
   summaries legitimately anchored at `package.json:1`). Step 1 is therefore a
   no-build: the off-hunk class is closed by the existing harness scope.

4. **Reasoned-soundness precision = 1-hop deterministic context + mandatory
   self-refute + deterministic degrade.** All within one worker call:
   - **1-hop callee/caller injection.** The harness statically resolves, for the
     changed symbols only, the definitions of functions the changed lines call
     and functions that call changed exports (via M5 `import_graph` /
     `TsCompilerParser`). Capped count + lines-per-def; falls back to undefined
     when unresolved. 1-hop only — every soundness trap is 1-hop; transitive
     spikes tokens for no fixture evidence.
   - **Mandatory structured self-refutation** in each reasoned worker prompt:
     per candidate finding — state the claim → state what would refute it →
     check the injected callee/caller/invariant → emit an **assertion only if
     unrefuted**, else emit a **question**.
   - **Confidence → degrade-to-question** post-pass (ADR-0044 §6) as the
     deterministic net: low-confidence reasoned findings degrade rather than
     assert; they never silently drop.

5. **Measure before, between, and after — the eval gates every step.** Item (1)
   "fix eval fixtures" is already done (real-PR worktree materialization, the
   `alfred-pr131` fixture, the `reasoned-assertions` config arm). The true
   entry condition is a **measurement gate**: reproduce the FPs on the shipped
   default first. A keyed `reasoned-assertions` run currently shows **0/8 traps
   reproducing** and ~1 comment total — until traps reproduce, there is nothing
   to drive down.

6. **The flip is the flag _and_ the honest schema, together.** Flipping
   `reasonedFindingMode` default-on while leaving worker self-quotes wearing
   `type: "tool"` ships the exact lie ADR-0044 exists to kill. Step 3 lands the
   flag default _and_ the `evidence`/`sources[]` split, per-claim-type gate,
   `sourced`/`reasoned` derived adjective, Tier-1 redefinition ("never drops"),
   and the review trace — one concentrated change, eval-gated.

7. **Second-LLM refutation is a contingency, not a step.** If the eval after
   Steps 1–2 still shows confident-wrong FPs (the `reasoning-section` class — a
   boolean misread with the code already visible, which neither context
   injection nor confidence-degrade catches), _that evidence_ opens a fresh ADR
   to reopen ADR-0015. It is not built speculatively.

## Steps (ordered)

### Step 0 — Establish a reproducing precision baseline _(measurement gate)_

- Run `baseline` (shipped `legacy-sources-required` default — what produced the
  dogfood FPs) **and** `reasoned-assertions` against `alfred-pr131` at **N≥5**.
- Inspect raw comments, not just trap-match counts (the matcher is
  `path` + `line±5` + `claim_includes`; it can miss reproduced FPs).
- **Gate:** promote `alfred-pr131` to load-bearing only when **≥3 of the 8 traps
  reproduce** on at least one config. If fewer reproduce, the first work is
  _fixture fidelity_ — widen the trap matcher and/or re-capture the dogfood diff
  context — **not** worker precision. There is no measurable problem otherwise.
- Loci: `packages/cli/scripts/eval/{run.mts,score.mts,configs/index.ts}`,
  `fixtures/real-prs/alfred-pr131-falsepos-9349d565/`.

### Step 1 — Deterministic off-hunk anchoring drop _(already closed — no build)_

- **Resolved by consolidation, not a new rule.** The off-hunk class is already
  killed by `scopeCommentsToDiff()` in `review-harness/harness.ts:181`, which
  drops any boss comment overlapping zero added lines in the _pruned_
  `ChangedFile[]` before the harness returns. Context lines just outside a hunk
  stay legitimate (overlap with ≥1 added line is the test, not that _every_
  cited line be added) — that policy already lives in `overlapsAddedLine()`.
- A duplicate drop in `applyHardRules()` over the _raw_ diff was shipped in
  commit 62a584c and reverted: it was a no-op on the m14-review path (pruned ⊆
  raw, so it kept everything the harness already kept) and would have wrongly
  re-scoped check / m18-security comments had it ever applied. Coverage for the
  anchoring behavior is `smoke:m14-diff-scope`; the redundant
  `smoke:reasoned-anchoring` was removed with the module.
- Net effect on the plan: re-running Step 0 already isolates a _pure soundness_
  signal — the off-hunk traps were never in the residual. Proceed to Step 2.
- The eval-env bootstrap (`loadWardenRuntime` in `run.mts`) shipped in the same
  commit is unrelated and **kept** — without it the eval self-skips on a missing
  key when run from `packages/cli`.

### Step 2 — Reasoned-claim soundness _(targets the 4 soundness traps)_

- **2.1 — 1-hop callee/caller injection** in `workers/run-worker.ts` +
  `workers/file-snippet.ts`. Resolve via M5 `import_graph` / `TsCompilerParser`;
  cap defs + lines/def; inject into the worker snippet as labeled context blocks
  distinct from the diff snippet.
- **2.2 — Mandatory structured self-refutation** in the reasoned worker prompts
  (`prompts/workers/correctness-system.md` first; then `scalability`,
  `consistency`, `security`). Per-candidate refute step per Decision 4.
- **2.3 — Confidence → degrade-to-question** post-pass in
  `packages/core/src/confidence.ts`, wired into `applyHardRules()`. `reasoned`
  is derived = "no external/deterministic source present" (no schema change yet;
  works on the existing seam). Tier-1 reasoned still degrades, never drops.
- Built + measured on the existing `reasonedFindingMode: 'allow-empty-sources'`
  seam — **no public schema change in this step.**
- **Gate:** on `alfred-pr131` the soundness-trap reproduction goes to ~0 while
  `*-misses-*` recall does **not** regress; clean-control stays 0; FP-trap-hits
  stays 0. Escalate to Decision 7 only if confident-wrong FPs survive.

### Step 3 — ADR-0044 flip: default-on + honest schema _(one concentrated change)_

- Flip `BOSS_LOOP_DEFAULTS.reasonedFindingMode` →
  `allow-empty-sources` in `boss-loop.ts`.
- Land the ADR-0044 migration: `evidence` field split from `sources[]` (mandatory
  locator vs optional external citation); per-claim-type source gate;
  `sourced`/`reasoned` as derived properties; Tier-1 "never drops"; review trace
  read-model from `ReviewScratchpad` → `reviewRuns` table + `CommentSet.metadata`
  summary.
- Touches: public `Comment` schema, `WorkerFindingSchema`, all 6 worker prompts,
  `to-comment.ts`, the substring-verifier, the renderer, `CONTEXT.md §2`, and the
  ADR-0008/0021 amendment sweep named in ADR-0044 §Ripple.
- **Gate (the flip's justification):** full-suite `--compare programmatic-dispatch-multi reasoned-assertions`
  must show **recall ↑ on `*-misses-*`** with **precision not worse** (criteria
  c = clean 0, f = FP-traps 0, d = cost). If recall doesn't move on real misses,
  the gate demotion isn't worth the ADR-0008 reopening — do not flip.

## Eval framing (per ADR-0044 §Caveats + tutorial `06-evals`)

- The split mirrors the tutorial's **deterministic-eval** (Steps 0–1, exact
  scoring) vs **llm-as-a-judge** (deliberately _not_ used — the rejected
  second-LLM pattern).
- Recall arm = `*-misses-*` fixtures (`m6-misses`, `alfred-pr14-misses`).
  Precision arm = `alfred-pr131-falsepos` traps + clean-controls.
- Every step re-runs the relevant arm; no step ships on assumed improvement.
- Prompts stay versioned files (ADR-0015 prompts-as-data); self-refutation is a
  prompt delta auditable via `rg "<!-- dogfood:"`.

## Explicit Non-Goals

- **react-doctor default-on + det-prior surfacing fork (ADR-0046).** RD findings
  are **sourced**, orthogonal to this reasoned-lane work; the surfacing fork
  (boss-curated vs direct-surface vs hybrid) is its own design decision. Separate
  ADR + grill. `WARDEN_REACT_DOCTOR` stays **off** until that plan lands.
- **No second adjudicating LLM** (Decision 1 / 7).
- **No transitive context injection** (1-hop only, Decision 4).
- **No dashboard rendering** of the review trace (ADR-0039 Phase 4).
- **No new detector** from the dogfood-backlog (UI-state-reachability,
  refactor-lost-behavior) — those are recall detectors on their own slots.

## Acceptance Checks

- Step 0: a keyed scorecard recording trap reproduction on `baseline` +
  `reasoned-assertions`; fixture promoted or fidelity-fixed.
- Step 1: unit smoke proving an off-hunk comment is dropped and an on-hunk
  comment with adjacent context survives; re-baselined trap count drops by ~4.
- Step 2: `alfred-pr131` soundness traps → ~0, `*-misses-*` recall non-regressed,
  clean 0, FP-traps 0.
- Step 3: `--compare` scorecard clears recall-↑/precision-not-worse; public
  schema migration green across `pnpm check-types` + the M14 smokes; `CONTEXT.md`
  - ADR sweep landed in the same change.
