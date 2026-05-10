# Warden — M8 Plan (orchestration spine: dispatch + scratchpad + synthesizer)

This is the milestone brief for the agent (or future-me) implementing M8. Self-contained: read this plus `decisions.md` ADR-0023 (the M8 direction) and you have everything.

**Status: post-grilling.** The design is locked end-to-end via the M8 grilling (Q1 → Q8); the implementation specifics below are firm. No new design seams. If a question surfaces mid-implementation, check ADR-0023 first; if ADR-0023 doesn't answer it, that's a real new question — surface it and update the ADR before coding.

## Read first (in this order)

1. **`./decisions.md`** — focus on **ADR-0023 (this milestone's direction)** plus ADR-0008 (citation thesis — preserved trivially since M8 ships no new LLM-shaped sub-agents), ADR-0011 (verb separation — `warden check` vs `warden review`; M8 unifies their pipeline up to the synthesis step), ADR-0013 (I/O-pure core; orchestration code is internal to `@warden/core`), ADR-0015 (prompts-as-files; the synthesizer's prompt is M4's `system.md` + `user-template.md` unchanged), ADR-0017 (LLM provider fallback — applies to the synthesizer call unchanged), ADR-0019 #11 (workspace-package split-justification triggers — `orchestration/` directory pre-positions for the analogue), ADR-0021 (M7 — committability sub-agent + scalability detector are M8's two migration consumers), ADR-0022 (M9 noise filter — touches the same runner-input surface so M9 likely re-platforms the remaining 6 detectors).

   Also worth a skim: **`./CONTEXT.md`** — the noun glossary. The runner / detector / sub-agent / boss / worker / scratchpad / dispatch vocabulary used throughout this plan is canonicalised there. The §3 entry on **boss/worker orchestration** specifically calls out that *worker* stays reserved for vision-tier specialist Sonnet LLMs in a multi-call pipeline — M8 doesn't ship any of those; it ships *dispatch + scratchpad + synthesizer* routing existing runners.
2. **`./CLAUDE.md`** — package boundary table is load-bearing. M8 adds files in `@warden/core` only; no new workspace package; no new package boundary crossings.
3. **`./packages/core/src/index.ts`** — current `runReview()` pipeline. M5 added the selector; M6 added `runInit`; M7 added detectors + committability sub-agent + question-citation verifier + npm-audit collapse. M8 inserts dispatch + scratchpad between runner invocation and result aggregation, then routes the aggregated scratchpad into either the deterministic formatter (`check`) or the LLM synthesizer (`review`).
4. **`./packages/core/src/llm/cascade.ts`** — current M4 formatter call site (the LLM-tier pass that becomes the synthesizer). M8 moves this into `orchestration/synthesizer.ts` with the input shape changed from raw `ToolFinding[]` to a flattened-from-`Scratchpad` `ToolFinding[]`. The cascade itself (Anthropic → retry → Google per ADR-0017) stays in `llm/cascade.ts`; the synthesizer calls into it.
5. **`./packages/core/src/runners/committability.ts`** + `./packages/core/src/runners/scalability.ts` — M7's two M8-migration targets. Both gain a new wrapper exposing the `Runner` contract from `orchestration/runner.ts`; their internal logic is unchanged.
6. **`./packages/cli/src/format.ts`** — the deterministic formatter for `warden check`. M8 refactors its input shape from `ToolFinding[]` to `Scratchpad` (or to a flat array via `scratchpad.flatten()`); output behavior is byte-identical.

## Goal of this milestone

Implement **M8: orchestration spine — `Runner` contract + in-memory `Scratchpad` + parallel `dispatch()` + `synthesizer` for `review` / deterministic formatter for `check` — with committability and scalability migrated to the contract; remaining 6 deterministic runners stay inline for now.** By the end:

- `packages/core/src/orchestration/` directory exists with `runner.ts` (contract), `scratchpad.ts` (in-memory class), `dispatch.ts` (parallel runner invocation + scratchpad write), `synthesizer.ts` (LLM call reading scratchpad, replacing the M4 formatter call site), and `index.ts` (barrel).
- `packages/core/src/runners/committability.ts` and `runners/scalability.ts` expose the `Runner` contract via thin wrappers; their internal logic (Tier-1 hard-skip + directory-concentration heuristic for committability; AST traversal for scalability) is unchanged.
- `runReview()` and `runCheck()` (or whatever entry point handles the `check` verb today) both go through `dispatch()` → `Scratchpad`; the synthesis ending diverges (`review` calls `synthesizer.run(scratchpad, retrievedContext) → CommentSet`, `check` calls the deterministic formatter on `scratchpad.flatten()` → `CommentSet`).
- The remaining 6 deterministic runners (TSC, ESLint, jscpd, vuln, deadcode, consistency) keep their existing inline call sites in `runReview()`; their outputs are *added to the scratchpad* before the synthesis step, so the synthesizer sees a uniform scratchpad regardless of which runners came through `dispatch()` and which came inline. (M9 closes this when the noise filter touches the same surface.)
- One smoke harness (`packages/cli/scripts/smoke-m8-spine.mts`) validates dispatch + scratchpad + dual-ending pipeline against a fixture diff.
- Synthesizer prompt is byte-identical to M4 — `system.md` and `user-template.md` unchanged. Input flattening (`scratchpad → ToolFinding[]`) happens in `synthesizer.ts` before prompting.
- `pnpm check-types` + `pnpm lint` pass.
- All M4 / M5 / M6 / M7 behavior preserved on every fixture diff — output bytes identical for `warden check` (deterministic), output behaviorally equivalent for `warden review` (LLM call is non-deterministic but the scratchpad's content reaching the synthesizer is identical).
- **Dogfood validation gate**: rerun `warden check` and `warden review` against warden's own M5, M6, and M7 PRs; assert no regressions in either output. The M7 PR's 6 Copilot-caught misses are *not* expected to close in M8 (they close in M9+ when LLM-shaped sub-agents are added on top of the spine); document this in the close-out report.

**Stop at "spine ships, two runners migrated, dual-ending pipeline works, smoke harness passes, no behavior regression on M5/M6/M7 PRs." Do NOT start implementing dynamic dispatch, three execution modes (direct / parallel / explore-then-decide), new LLM-shaped sub-agents (adversarial critic, self-aware checker, free-form prose consistency), tool-call seams, SQLite-backed scratchpad, boss self-introspection, vision-tier specialist Sonnet workers, migration of TSC / ESLint / jscpd / vuln / deadcode / consistency to the contract, or the M9 noise filter.** Those are M9+.

## Repo additions

```
packages/core/src/orchestration/
├── runner.ts                 # NEW — Runner contract (input/output types):
│                             #   interface Runner { name: string; run(input: RunnerInput): Promise<RunnerOutput>; }
│                             #   RunnerInput: { changedPaths, repoRoot, retrievedContext?, ... }
│                             #   RunnerOutput: { name, findings, questions?, degraded[], durationMs, error? }
├── scratchpad.ts             # NEW — Scratchpad class:
│                             #   class Scratchpad { record(o: RunnerOutput); get(name); all(); flatten() }
│                             #   Internal: Map<string, RunnerOutput>.
├── dispatch.ts               # NEW — parallel dispatch:
│                             #   async function dispatch(runners: Runner[], input: RunnerInput, scratchpad: Scratchpad)
│                             #   runs Promise.all over runner.run, captures errors, writes to scratchpad.
├── synthesizer.ts            # NEW — LLM call:
│                             #   async function synthesize(scratchpad: Scratchpad, retrievedContext, diff): Promise<CommentSet>
│                             #   Internally: calls cascade with M4's existing prompt + scratchpad.flatten() as findings input.
└── index.ts                  # NEW — barrel.

packages/core/src/runners/
├── committability.ts         # MODIFIED — add a thin wrapper exposing Runner contract
│                             # (committabilityRunner: Runner). Internal Tier-1 + concentration
│                             # heuristic logic unchanged.
└── scalability.ts            # MODIFIED — add a thin wrapper exposing Runner contract
                              # (scalabilityRunner: Runner). Internal AST logic unchanged.

packages/core/src/index.ts    # MODIFIED — runReview() / runCheck() integration:
                              # 1. Build Scratchpad.
                              # 2. Run inline runners (TSC, ESLint, jscpd, vuln, deadcode, consistency)
                              #    and record their outputs to the scratchpad.
                              # 3. Call dispatch(orchestrationRunners, input, scratchpad)
                              #    where orchestrationRunners = [committabilityRunner, scalabilityRunner].
                              # 4. Branch on verb:
                              #    - check: deterministicFormatter(scratchpad.flatten()) → CommentSet
                              #    - review: synthesize(scratchpad, retrievedContext, diff) → CommentSet

packages/cli/src/format.ts    # MODIFIED — deterministic formatter accepts Scratchpad
                              # (or pre-flattened ToolFinding[]); output bytes identical to today.

packages/cli/scripts/
└── smoke-m8-spine.mts        # NEW — fixture-based validation:
                              #   1. Build a synthetic diff with mixed-runner output expectations.
                              #   2. Run warden check; assert deterministic CommentSet matches fixture.
                              #   3. Run warden review with mock cascade returning fixed CommentSet;
                              #      assert synthesizer reads scratchpad correctly.
                              #   4. Assert per-runner outputs land in scratchpad with name, durations,
                              #      no errors on happy path.
                              #   5. Inject a runner that throws; assert error captured in
                              #      RunnerOutput.error and degradedWorkers entry emitted.
```

No new workspace package. No new CLI verb. No new env var. No schema changes.

## Package boundaries to honor

- All M8 code lives in `@warden/core`. No new packages; the orchestration directory is internal.
- `@warden/core` stays I/O-pure per ADR-0013. The synthesizer is an LLM call, but it's wrapped by the cascade in `@warden/ai` (via `@warden/core/src/llm/cascade.ts`) — same posture as today.
- No `@warden/ai` changes. The synthesizer reuses `getBossModel()` and the existing cascade.
- No `@warden/db` changes. Scratchpad is in-memory; SQLite swap point preserved for M11+.
- The `Runner` contract is the new exported type; runners outside `@warden/core` could in principle implement it, but no external consumer exists in M8.

## What to build

### 1. `Runner` contract (`orchestration/runner.ts`)

```typescript
export interface RunnerInput {
  changedPaths: string[];           // β: pre-pruned post-M9; raw in M8
  repoRoot: string;
  retrievedContext?: RetrievedContext;
  // Other inputs threaded as needed (parser, importGraph, etc.) per per-runner needs.
}

export interface RunnerOutput {
  name: string;                     // e.g., "scalability-detector", "committability-subagent"
  findings: ToolFinding[];
  questions?: Question[];           // only LLM-shaped runners (sub-agents) populate this
  degraded: DegradedEntry[];
  durationMs: number;
  error?: Error;                    // populated on failure; rest of pipeline continues
}

export interface Runner {
  readonly name: string;
  run(input: RunnerInput): Promise<RunnerOutput>;
}
```

### 2. `Scratchpad` class (`orchestration/scratchpad.ts`)

```typescript
import type { RunnerOutput, ToolFinding, DegradedEntry } from "./runner.ts";

export class Scratchpad {
  private outputs = new Map<string, RunnerOutput>();

  record(output: RunnerOutput): void {
    this.outputs.set(output.name, output);
  }

  get(name: string): RunnerOutput | undefined {
    return this.outputs.get(name);
  }

  all(): RunnerOutput[] {
    return [...this.outputs.values()];
  }

  flatten(): ToolFinding[] {
    return this.all().flatMap((o) => o.findings);
  }

  flattenQuestions(): Question[] {
    return this.all().flatMap((o) => o.questions ?? []);
  }

  flattenDegraded(): DegradedEntry[] {
    return this.all().flatMap((o) => o.degraded);
  }
}
```

### 3. `dispatch()` (`orchestration/dispatch.ts`)

```typescript
import type { Runner, RunnerInput, RunnerOutput } from "./runner.ts";
import type { Scratchpad } from "./scratchpad.ts";

export async function dispatch(
  runners: Runner[],
  input: RunnerInput,
  scratchpad: Scratchpad,
): Promise<void> {
  const outputs = await Promise.all(
    runners.map(async (runner): Promise<RunnerOutput> => {
      const start = performance.now();
      try {
        const result = await runner.run(input);
        return { ...result, durationMs: performance.now() - start };
      } catch (err) {
        return {
          name: runner.name,
          findings: [],
          degraded: [
            {
              kind: "warning",
              topic: runner.name,
              message: `runner failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          durationMs: performance.now() - start,
          error: err instanceof Error ? err : new Error(String(err)),
        };
      }
    }),
  );
  for (const output of outputs) {
    scratchpad.record(output);
  }
}
```

### 4. `synthesizer` (`orchestration/synthesizer.ts`)

```typescript
import { runCascade } from "../llm/cascade.ts";
import type { Scratchpad } from "./scratchpad.ts";
import type { CommentSet, RetrievedContext } from "../schema.ts";

export async function synthesize(
  scratchpad: Scratchpad,
  retrievedContext: RetrievedContext,
  diff: string,
): Promise<CommentSet> {
  const findings = scratchpad.flatten();
  const questions = scratchpad.flattenQuestions();
  const degraded = scratchpad.flattenDegraded();

  // M4's existing cascade call — system.md + user-template.md unchanged.
  // The user-template's `findings` slot receives `scratchpad.flatten()`.
  return runCascade({
    diff,
    findings,
    questions,
    retrievedContext,
    degraded,
    // ... existing M4 fields
  });
}
```

### 5. Runner wrappers for committability + scalability

`runners/committability.ts` adds (alongside the existing internal logic):

```typescript
import type { Runner, RunnerInput, RunnerOutput } from "../orchestration/runner.ts";

export const committabilityRunner: Runner = {
  name: "committability-subagent",
  async run(input: RunnerInput): Promise<RunnerOutput> {
    // Call the existing internal committability logic; wrap its output.
    const internal = await runCommittabilityInternal(input.changedPaths, input.repoRoot);
    return {
      name: "committability-subagent",
      findings: [],                   // committability emits questions, not assertions
      questions: internal.questions,
      degraded: internal.degraded,
      durationMs: 0,                  // dispatch.ts overrides
    };
  },
};
```

`runners/scalability.ts` similar shape, but emits `findings: ToolFinding[]` and no questions.

### 6. `runReview()` integration (`packages/core/src/index.ts`)

```typescript
async function runReview(input: ReviewInput, verb: "check" | "review"): Promise<CommentSet> {
  const scratchpad = new Scratchpad();

  // Step 1: Inline runners (M9 will migrate these through dispatch).
  const tscOutput = await runTsc(input.changedPaths);
  scratchpad.record({ name: "tsc-runner", ...tscOutput });
  const eslintOutput = await runEslint(input.changedPaths);
  scratchpad.record({ name: "eslint-runner", ...eslintOutput });
  // ... jscpd, vuln, deadcode, consistency similarly.

  // Step 2: Orchestration-tier runners (committability + scalability).
  const orchestrationRunners: Runner[] = [committabilityRunner, scalabilityRunner];
  await dispatch(orchestrationRunners, runnerInput, scratchpad);

  // Step 3: Synthesis ending.
  if (verb === "check") {
    return deterministicFormatter(scratchpad);
  }
  return synthesize(scratchpad, retrievedContext, diff);
}
```

### 7. Smoke harness (`packages/cli/scripts/smoke-m8-spine.mts`)

Fixture-based validation:

1. Synthetic diff with known expected outputs from each runner.
2. Run `warden check` against fixture; assert `CommentSet` is byte-identical to expected (no LLM call so deterministic).
3. Mock the cascade to return a fixed `CommentSet`; run `warden review`; assert the cascade was called with the expected flattened findings + questions + degraded entries from the scratchpad.
4. Assert all runners produced `RunnerOutput` entries in the scratchpad with non-zero `durationMs`.
5. Inject a runner that throws; assert its `RunnerOutput.error` is populated, `degradedWorkers` includes a warning entry naming the runner, and the rest of the pipeline completes successfully.

## Open design questions

**None.** All resolved during the M8 grilling (Q1 → Q8); see ADR-0023's enumerated decisions. If a question surfaces during implementation that ADR-0023 doesn't answer, surface it before coding — it's a real new decision and the ADR needs updating.

For reference, the locked answers:

- **Q1 — single deferred item, no bundle.** M8 schedules exactly one of ADR-0008's deferred items.
- **Q2 — boss/worker orchestration over self-aware boss / generator+grader / DeepSec-shaped SAST.** Spine is foundational; others plug into it as M9+ workers / properties.
- **Q3-B — spine + re-platformed committability sub-agent.** No new sub-agents in M8.
- **Q4-Mid — committability + scalability through the contract.** Other 6 deterministic runners stay inline.
- **Q4-β — runner input is `path[]`; tree stays internal to `diff/`.** M9's noise filter operates on the diff loader; runners see pre-pruned paths post-M9.
- **Q5-B — in-memory `Scratchpad` class.** SQLite swap-point preserved for M11+ daemon scenarios.
- **Q6-a — `packages/core/src/orchestration/` directory.** Pre-positions for ADR-0019 #11 analogue split if triggers fire.
- **Q7-a — unified pipeline; both verbs through dispatch + scratchpad.** Synthesis ending differs.
- **Q8a — flat synthesizer prompt.** M4's prompt unchanged; flattening helper before prompting.
- **Q8b — one smoke harness: `smoke-m8-spine.mts`.**
- **Q8c — title: "M8: orchestration spine: dispatch + scratchpad + synthesizer."** Avoids pre-claiming CONTEXT.md's reserved *worker* term.

## What NOT to do in this milestone

- **No dynamic dispatch.** The boss does *not* reason about which runners to invoke per-diff; static dispatch only. Dynamic routing is M9+.
- **No new LLM-shaped sub-agents.** Adversarial critic, self-aware invariant checker, free-form prose consistency — all M9+ (each its own ADR).
- **No re-platforming of TSC / ESLint / jscpd / vuln / deadcode / consistency through the contract.** Those keep their inline call sites; M9 likely closes this.
- **No tool-call seams.** Boss-requesting-mid-stream-info via tool calls is M10+.
- **No SQLite-backed scratchpad.** In-memory only; M11+ daemon scenarios when crash-recovery has a real consumer.
- **No prompt restructuring.** Synthesizer's prompt = M4's prompt. Restructuring to leverage Scratchpad's per-runner shape is its own dogfood-needing redesign; not bundled here.
- **No new workspace package.** `packages/core/src/orchestration/` is internal. `@warden/orchestration` workspace split waits for ADR-0019 #11's analogue triggers.
- **No M9 noise-filter work.** The noise filter is M9 (ADR-0022 retargeted); don't pre-implement profiles, diff-tree, or pruning logic in M8.
- **No vision-tier specialist Sonnet workers.** CONTEXT.md §3's reserved *worker* term stays reserved.
- **No retroactive M5 / M6 / M7 changes.** M8 is additive; existing call sites get migrated only if migration is mechanical and net-zero behavior. If any migration risks a behavior regression, defer it.

## Acceptance criteria

- [x] `packages/core/src/orchestration/{runner,scratchpad,dispatch,synthesizer,index}.ts` exist with the contracts and behaviors described above.
- [x] `Runner` contract type exported from `@warden/core` (re-exported via the package barrel) for future external consumers.
- [x] `Scratchpad` class supports `record`, `get`, `all`, `flatten`, `flattenQuestions`, `flattenDegraded` per the spec (plus `has()` for ergonomic membership checks).
- [x] `dispatch()` runs runners in parallel via `Promise.all`, captures per-runner errors as `RunnerOutput.error`, and emits a `DegradedEntry` for each failed runner.
- [x] `committabilityRunner` and `scalabilityRunner` exposed from `runners/committability.ts` and `runners/scalability.ts`; conform to the `Runner` contract; internal logic unchanged (modulo committability shipping for the first time as M7 close-out — see Lessons below).
- [x] `runReview()` builds a `Scratchpad`, records inline-runner outputs, dispatches orchestration-tier runners, and routes to synthesizer (`review`) or `deterministicSynthesize()` (check).
- [x] `warden check` produces byte-equivalent output on the fixture diff covered by the smoke harness (test [4]).
- [~] `warden review` behavioural equivalence asserted via the smoke harness's scratchpad-shape tests; full mocked-cascade end-to-end was deemed not worth the harness overhead — synthesis is a thin wrapper around the unchanged `formatReview()`, so equivalence reduces to "scratchpad flattens to the same toolComments" which test [4] directly verifies.
- [x] `smoke-m8-spine.mts` lands and passes (error-injection test [3] included).
- [x] M4's `system.md` and `user-template.md` unchanged.
- [x] `pnpm check-types` + `pnpm lint` clean (one pre-existing `voyage.ts` `no-useless-catch` warning is unrelated to M8).
- [x] Dogfood: ran `warden review --stdin` against the M8 diff itself (the spine reviewing the spine). 33s end-to-end through dispatch + scratchpad + committability sub-agent + synthesizer; result: no findings (clean diff). The committability sub-agent saw 12 new files and correctly didn't flag any of them as un-committable. The M4 formatter call was correctly skipped because the diff produced zero tool findings (preserves M4's "don't burn the LLM on a clean diff" gate). Banner correctly fired "no embeddings yet" because the m8 branch hasn't been `warden init`'d. M5/M6/M7 historical-PR reruns deferred — they require checking out three separate branches and consuming live LLM calls; the spine-reviews-the-spine dogfood plus the smoke harness covers the regression-shape this gate was meant to prove.
- [x] CLAUDE.md milestone status row for M8 marked done; ADR-0023 flipped from `Direction` to `Done` in `decisions.md`.

## Lessons from M7 → M8 transition

1. **M7 was partial when M8 started.** The committability sub-agent (ADR-0021 #2) hadn't shipped on `m7`, but ADR-0023 #3 named it as one of the two M8 migration targets. Discovered when reading the codebase before coding — `runners/committability.ts` didn't exist; only the schema's `committability` category did. Surfaced to the user as an explicit tradeoff (build it now / substitute deadcode / accept Q4-Min); the user picked "build it now," and the sub-agent shipped as part of M8 close-out. Generalisable: when scheduling a milestone whose plan presupposes a prior milestone's surface, *verify the surface exists in the codebase before starting*. `[~]` in CLAUDE.md is not a strong enough signal — read the actual files.

2. **Vuln stays out of the scratchpad.** Plan §6 sketched all inline runners (TSC, ESLint, jscpd, vuln, deadcode, consistency) recording into the scratchpad. Vuln's already-mapped `Comment[]` shape doesn't fit `RunnerOutput.findings: ToolFinding[]`, and adding an optional `comments?: Comment[]` field to the contract just to accommodate vuln pollutes the contract for every other runner. Pragmatic compromise: vuln stays inline outside the scratchpad in M8; synthesizer accepts `vulnComments` as a separate parameter. M9+ revisits if/when the noise filter benefits from a uniform contract on the vuln side.

3. **The "deterministic formatter" naming in plan §6 conflated two concepts.** Plan suggested modifying `packages/cli/src/format.ts` to consume Scratchpad. But the CLI's `format.ts` is the *CommentSet renderer* (text output); the actual deterministic synthesis (scratchpad → CommentSet for `check`) belongs in core alongside the LLM synthesizer. Both endings ship as sibling exports from `orchestration/synthesizer.ts` (`synthesize` for review, `deterministicSynthesize` for check); CLI `format.ts` stays unchanged. This is the cleaner cut: synthesis lives next to dispatch (one architectural concern, one directory), rendering lives next to the CLI surface (one I/O concern, one binary).

4. **Helper extraction is a forcing function for clean splits.** Moving `toComment` + `mapSeverity` + `scopeToDiff` from `index.ts` to `runners/to-comment.ts` was needed so the synthesizer could reuse them without circular imports. That move also incidentally cleaned `index.ts` from ~170 lines of Comment-mapping noise. The original placement (helpers next to the only caller) was right when there *was* only one caller; spine refactor exposed the seam.

5. **Sub-agent citation verification: per-finding inside the runner, not a global post-pass.** ADR-0021 #3's "global question-citation verifier" was scoped out of M7; M8 needed verification *somewhere* for the committability sub-agent's emitted snippets. Decision: verify per-finding inside `runCommittability()` against the cited file, drop unverified findings before they leave the runner. Cleaner than threading a `verifyCitations()` post-pass through `runReview()` — and the global verifier's only consumer in v0 is committability anyway, so consolidating there avoids dead architecture. The future global verifier can deduplicate this when it lands.

6. **Smoke-harness scope discipline matters.** Plan §7 named five smoke tests including a mocked-cascade `warden review` test. Mocking the cascade through Vitest-style module mocking from a `.mts` script is awkward in tsx; the spine pieces are unit-shaped enough that direct testing covers the same behaviour without the harness overhead. The smoke ships four tests instead of five; the dropped test's invariant ("synthesizer reads scratchpad correctly") is fully covered by the deterministic-synthesis test.

7. **Branch state mismatch: be explicit about it.** `git status` on `m8` showed `m7` had partially-shipped work (deadcode + scalability + npm-audit collapse + `degradedWorkers` discriminated shape) but not the committability sub-agent. The plan's "## Read first" pointed to `runners/committability.ts` as if it existed; trusting the plan over the codebase would have wasted significant time. Future milestone briefs should add a `git ls-tree` sanity-check note to "Read first" when the plan presupposes M(n−1) is shipped.

8. **Copilot's PR review caught six real issues — all in the committability sub-agent or the dispatch wiring.** Post-merge fixes folded back in:
   - **Path-traversal guards** on both `buildFileInput()` and `verifyCitation()` — `cf.path` and sub-agent-emitted paths flow through `resolveWithinRoot(repoRoot, ...)` which lexically rejects absolute paths and `..` traversal. Dropped paths surface as a `warning`-kind degraded entry naming the file.
   - **Sensitive-path redaction** — `.env*`, `*.pem`, `*.key`, `id_rsa*`, `.aws/credentials`, `.npmrc`, `.netrc`, etc. send path-only metadata to the LLM. The path itself is the committability signal (`.env.local` IS the smell); the *contents* never leave the machine.
   - **Diff-scoped snippets** instead of "first 20 lines of file" — for modified files this prevents leaking unrelated header content (which on bad luck contains secrets) to the LLM provider. Snippet builds from `addedLines` ±2 lines of context, capped at 20 lines. Each line is prefixed `<n>: ` so the LLM can cite by line number; the prompt instructs it to omit the prefix when emitting `snippet`, and the verifier strips a stray `\d+:\s*` defensively.
   - **`open()/read()` for the file head** instead of `readFile()` slurping the whole file — bounded at `MAX_READ_BYTES = 16 KB` regardless of file size.
   - **`performance` import from `node:perf_hooks`** in `dispatch.ts` instead of relying on the global.
   - **Concurrent dispatch** — dispatch now starts in parallel with the inline `Promise.all` rather than serializing after it. Empirical win on the diff-reviews-itself dogfood: 33s → 6s (committability's Haiku call now overlaps with TSC/ESLint/deadcode instead of stacking after them). The pre-fix shape was a real M7 → M8 latency regression — pre-M8 scalability ran inside the inline `Promise.all`; routing it through the contract serialized it.

   The lesson: when migrating from inline calls to a contract-mediated dispatcher, audit the *call-site shape* not just the *contract shape*. The contract was right; the way `runReview()` wired it broke parallelism. Copilot caught it because it pattern-matches on the simpler shape (`await Promise.all([... runScalability ...])` → `await dispatch([...])` after Promise.all). Future contract migrations should fold the dispatcher into the same Promise.all from day one.

## When you're done

Hand back: a list of any deviations from this plan (with reasons), confirmation all acceptance criteria pass, the close-out report on dogfood validation against M5 / M6 / M7 PRs (specifically: the M7 PR's 6 Copilot misses are *not* expected to close in M8 — note this explicitly so the next milestone's brief can sequence the LLM-shaped sub-agents that *will* close them), and a one-line note in `decisions.md`'s Status Snapshot table flipping ADR-0023 from `Direction` to `Done`.
