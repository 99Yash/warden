# OpenCode parity — tracer-bullet eval + gate

Slice #43 / ADR-0053. The OpenCode down lane (`warden opencode-review`)
ships, but nothing measured it. This doc describes the runner that scores
the driven path on the same fixtures as the M15 harness, the parity gate
it is judged by, and the go/no-go that result gates.

## How to run

Tracer (one sample, proves the wiring without deciding anything):

```
pnpm --filter @warden/cli eval:parity --samples 1 --max-cost <usd>
```

Gate decision (three samples, the only run that can grant a GO):

```
pnpm --filter @warden/cli eval:parity --samples 3 --max-cost <usd>
```

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

## The parity table

| Criterion | Rule | Why |
| --- | --- | --- |
| P0 same fixtures | both aggregates cover the same fixture-name set | otherwise the comparison is meaningless |
| P1 real-PR recall | `candidate.realCaught ≥ reference.realCaught` | the lane must not lose real bugs |
| P2 synthetic recall | `candidate.syntheticCaught ≥ reference.syntheticCaught` | the lane must not lose plants |
| P3 precision traps | `candidate.falsePositiveTrapHits === 0` | known traps must not reappear |
| P4 clean zero-hit | `candidate.cleanFixtureUnlabeled === 0` | clean fixtures stay clean |
| P5 cost | criterion (d) passes AND every candidate sample has `costMeasured: true` | the ceiling cannot bound unmeasured spend |
| P6 lane health | every substantive candidate row has `medianDispatches ≥ 1` and `hadError === false` | the lane ran and stayed clean |

Ties pass (parity, not superiority). `checkThreshold` criteria (a)–(f)
are unchanged. For the candidate, `dispatchCount` is 1 when the lane
envelope's status is `ok`, else 0 — criterion (e) reads "the lane ran".

## The cost gate

Three layers, all fail closed:

- The existing criterion (d): total cost stays under budget.
- `--max-cost <usd>` (default `4`): cumulative measured spend across
  every sample of every config. Checked before each sample; when reached,
  the run stops launching samples, still scores and writes what ran,
  marks the scorecard `stoppedAtCostCeiling: true`, and exits 1.
- Unmeasured spend stops the run at once: a sample with
  `costMeasured: false` names the sample and stops, because the ceiling
  cannot bound spend it never saw.

Cost source: the OpenCode session total from the serve API
(`GET /api/session/<id>` before the serve child is killed); the harness
reference cost is `CommentSet.metadata.costUsd`. The two are priced by
different code (OpenCode vs warden's catalog).

## Go/no-go

- **GO** = every parity criterion P0–P6 passes at **N=3**. A GO allows a
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
