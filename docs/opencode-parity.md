# OpenCode parity — tracer-bullet eval + gate

Slice #43 / ADR-0053. The OpenCode down lane (`warden opencode-review`)
ships, but nothing measured it. This doc describes the runner that scores
the driven path on the same fixtures as the M15 harness, the parity gate
it is judged by, and the go/no-go that result gates.

## How to run

Real-PR fixtures need the sibling checkouts. Set them explicitly: from a
worktree (`.claude/worktrees/<name>`), the default `../<repo>` path does
not resolve, and the alfred fixtures then fall back to sparse for both
configs. The runner prints a `WARNING` line when that happens.

```
export WARDEN_EVAL_ALFRED_REPO=/path/to/alfred
export WARDEN_EVAL_WARDEN_REPO=/path/to/warden
```

Tracer (one sample, proves the wiring without deciding anything):

```
pnpm --filter @warden/cli eval:parity --samples 1 --max-cost <usd>
```

Gate decision (three samples, the only run that can grant a GO):

```
pnpm --filter @warden/cli eval:parity --samples 3 --max-cost <usd>
```

Usage errors exit 2 before any preflight or spend: an unknown config name
in `--config`, `--compare`, or `--parity`; the same name twice in
`--parity`; `--parity` with `--config`; and a `--max-cost` value that is
missing, negative, or not a number.

`eval:parity` is `eval --parity programmatic-dispatch-multi opencode-down`:
the reference is the production default harness config, the candidate is
the driven lane. A bare `pnpm eval` never touches the OpenCode runtime —
`opencode-down` lives in `OPENCODE_CONFIGS`, not `ALL_CONFIGS`, so a bare
run cannot start paying for OpenCode sessions.

## How a fixture becomes a two-commit repo

`resolveDiff({ baseRef })` diffs `<base>...HEAD`, so each fixture becomes
a real git repo (`scripts/eval/fixture-repo.mts`): a head tree, then
`git apply -R`, commit `base`, then `git apply`, commit `head`. The head
tree is a full post-PR tree (`git archive`, no worktree registration in
the source repo) when the fixture's `meta.json` resolves, else the sparse
post-image plus the `package.json` stub. Binary sections (`GIT binary
patch`, no full index) are excluded from both applies — the prune drops
binary files anyway. The candidate and the reference run the same fixture
set in the same invocation, scored by the existing scorer and threshold.

The scorecard records the tree each sample reviewed, per fixture and per
config: `archive <repo>@<commit>` (candidate), `worktree <repo>@<commit>`
(reference), or `sparse (<reason>)`. It also records the requested
candidate model and the model the OpenCode session reports.

## The parity table

| Criterion | Rule | Why |
| --- | --- | --- |
| P0 same fixtures | both aggregates cover the same fixture-name set, and every row of both has the requested sample count | otherwise the comparison is meaningless; a stopped run leaves a short row |
| P1 real-PR recall | `candidate.realCaught ≥ reference.realCaught` | the lane must not lose real bugs |
| P2 synthetic recall | `candidate.syntheticCaught ≥ reference.syntheticCaught` | the lane must not lose plants |
| P3 precision traps | `candidate.falsePositiveTrapHits === 0` | known traps must not reappear |
| P4 clean zero-hit | every sample of every clean candidate row has `unlabeledComments === 0` | clean fixtures stay clean in every sample, not only in the median |
| P5 cost | criterion (d) passes AND every candidate sample has `costMeasured: true` | the ceiling cannot bound unmeasured spend |
| P6 lane health | every sample of every candidate row (clean rows included) has `dispatchCount ≥ 1` and `error === null` | the lane ran on every sample; a failed lane on a clean fixture publishes `comments: []` and must not score as clean |
| P7 reference health | no reference sample has an `error`, and every substantive reference row has `medianDispatches ≥ 1` | a failed reference makes P1/P2 vacuous |
| P8 gate run | `samples ≥ 3`, no `--fixture`/`--fixture-regex`, and not `stoppedAtCostCeiling` | a tracer (N<3, filtered, or stopped) is evidence, not a gate |

Ties pass (parity, not superiority). P3, P4, and P6 use any-sample
semantics: one bad sample in three fails. A tracer always reads
`NOT MET (… P8-gate-run)`, while P0–P7 still report their own PASS/FAIL —
that is the tracer evidence. The `PARITY:` line, the `.md`, and the
`.json` all come from one verdict. `checkThreshold` criteria (a)–(f)
are unchanged. For the candidate, `dispatchCount` is 1 when the lane
envelope's status is `ok`, else 0 — criterion (e) reads "the lane ran".

## The cost gate

Three layers. They fail closed for the candidate only (see the paragraph
after the list):

- The existing criterion (d): total cost stays under budget.
- `--max-cost <usd>` (default `4`): one budget for the cumulative measured
  spend across every sample of **both** configs. In `--parity` mode the
  candidate runs first, then the reference: the candidate cost is the
  unknown, the harness cost is known. The ceiling is checked before each
  sample, so a run can exceed it by at most one sample's cost. When it is
  reached, the run stops launching samples, still scores and writes what
  ran, marks the scorecard `stoppedAtCostCeiling: true`, and exits 1.
- Unmeasured spend stops the run at once: a sample with
  `costMeasured: false` names the sample and stops, because the ceiling
  cannot bound spend it never saw. A candidate sample is measured when no
  `opencode run` was spawned (a fixture build failure, an empty scope, or
  an MCP warmup failure: a known $0 — the sample keeps its error, P6 fails
  on it, and the run continues), or when the session usage was read and
  shows `cost > 0` or all token counts 0 (no model work, so no spend). A
  free or unpriced model that did work reports `cost 0` with tokens > 0:
  that is unmeasured, so a free-model tracer stops after one sample.

The reference does not fail closed. A harness sample reports
`CommentSet.metadata.costUsd`, and a harness throw after spend reports $0.
That spend never reaches the ceiling. The harness is the reference, not
the gated path, so this is a known gap, not a gate input.

Cost source: the OpenCode session total from the serve API
(`GET /api/session/<id>` before the serve child is killed); the harness
reference cost is `CommentSet.metadata.costUsd`. The two are priced by
different code (OpenCode vs warden's catalog).

## Go/no-go

- **GO** = every parity criterion P0–P8 passes: the full fixture set, a
  complete run, N ≥ 3, and a healthy reference. A GO allows a
  later decision to make the OpenCode path the default (an ADR-0053
  amendment, not this slice) and allows #48 (CI runner) to ship it as
  the CI review path.
- **NO-GO** = any criterion fails. It **blocks #48** from shipping the
  OpenCode path as CI review, and it blocks a default switch.
- A NO-GO does **not** block #46 (structural up lane) or #47 (state
  authority + trace bridge): #46 is the recall remedy this gate
  measures, and #47 is path-agnostic plumbing. Both need this runner to
  exist, not to pass. This reads ADR-0053's "Eval parity (#43) gates the
  CI runner + structural lane + trace bridge" as "lands after #43", and
  the ADR row's wording is an operator follow-up, not part of this
  slice.
- An **N=1 tracer** result is evidence, not a gate decision; it can show
  a NO-GO early but cannot grant a GO.

## Residuals

- The candidate is **one lane** (down). Surface, up, and judge are not
  shipped. Synthetic plants whose category is outside the down charter
  (committability, leverage, consistency) are expected misses until
  those lanes land.
- Sparse fixtures give the lane only the diff hunks, not a full tree;
  the harness reference has the same limit.
- Binary sections are excluded from the fixture repo.
- Real-PR fixtures need the sibling checkouts
  (`WARDEN_EVAL_<REPO>_REPO`); without them they fall back to sparse,
  for both configs.
- Cost source: the OpenCode session total from the serve API; the
  harness reference cost is `CommentSet.metadata.costUsd`. The two are
  priced by different code (OpenCode vs warden's catalog).
- Labels match on file + line ±5 + category (+ `claim_includes`): a lane
  that picks a different `category` for a real bug scores a miss.

## Results

Pending an operator run (live, paid — the implementer ships the runner,
the gate, and this doc; the operator runs the tracer). The scorecard
lands under `packages/cli/scripts/eval/results/opencode-parity/`.
