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

Usage errors exit 2 before any preflight or spend: an unknown flag or a
stray argument (`--maxcost 0`); a flag whose value is missing or starts
with `--` (`--samples --max-cost 0`); an unknown config name in
`--config`, `--compare`, or `--parity`; the same name twice in
`--parity`; `--parity` with `--config` or `--compare`; a `--parity`
reference that is an OpenCode config or a candidate that is not one (the
roles reversed); a `--max-cost` value that is negative or not a number;
and a `--samples` value that is not an integer ≥ 1. A typo therefore
cannot silently restore the default ceiling.

`eval:parity` is `eval --parity programmatic-dispatch-multi opencode-down`:
the reference is the production default harness config, the candidate is
the driven lane. A bare `pnpm eval` never touches the OpenCode runtime —
`opencode-down` lives in `LANE_CONFIGS`, not `ALL_CONFIGS`, so a bare
run cannot start paying for OpenCode sessions. `LANE_CONFIGS` also holds
`claude-code-down`, the same lane run by `claude -p` on a Claude
subscription login (see Results). It is not a `--parity` candidate:
`claude -p` reports the session model without an effort variant, so P6
would fail every sample. Run it with `--config`.

### Operator notes

- No zero-cost live tracer exists. OpenCode v2.0.25 rejects the free
  model `opencode/muse-spark-1.3-contributor-free` on the driven
  `run --server` path with "OpenCode's free tier can only be used from
  within OpenCode". Each such sample is a measured $0 failed lane, so P6
  fails on every sample. Do not plan a free-model tracer; budget a paid
  one.

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

The sparse writer (shared with the harness reference) writes no extra
trailing blank line. It also omits the final newline of a file whose
section ends with `\ No newline at end of file`. For the harness, this
changes the EOF newline of those sparse files (in the real-PR sparse
fallback: `.sql`, `.json`, `pnpm-lock.yaml`, `.gitignore`). No scored
line moves.

The scorecard records the tree each sample reviewed, per fixture and per
config: `archive <repo>@<commit>` (candidate), `worktree <repo>@<commit>`
(reference), or `sparse (<reason>)`. `<repo>` is the logical name from
the fixture's `meta.json` (for example `alfred@<sha>`), never a local
path, so a committed scorecard holds no machine paths. It also records
the requested candidate model and the model the OpenCode session
reports, both as `<providerID>/<id>#<variant>`.

## The parity table

| Criterion | Rule | Why |
| --- | --- | --- |
| P0 same fixtures | a reference ran; both aggregates cover the same fixture-name set; every row of both has the requested sample count; and each fixture has the same tree kind in both configs (`archive X@c` and `worktree X@c` are the same real tree, else `sparse`) | otherwise the comparison is meaningless; a stopped run leaves a short row, and a reference `worktree add` failure reviews a sparse tree against the candidate's real tree |
| P1 real-PR recall | `candidate.realCaught ≥ reference.realCaught`; prints "no reference" (not a PASS) when the reference never ran | the lane must not lose real bugs |
| P2 synthetic recall | `candidate.syntheticCaught ≥ reference.syntheticCaught`; prints "no reference" (not a PASS) when the reference never ran | the lane must not lose plants |
| P3 precision traps | `candidate.falsePositiveTrapHits === 0` | known traps must not reappear |
| P4 clean zero-hit | every sample of every clean candidate row has `unlabeledComments === 0` | clean fixtures stay clean in every sample, not only in the median |
| P5 cost | criterion (d) passes AND every candidate sample has `costMeasured: true` | the ceiling cannot bound unmeasured spend |
| P6 lane health | at least one candidate sample ran, and every sample of every candidate row (clean rows included) has `dispatchCount ≥ 1`, `error === null`, and a session model equal to the requested model when the session reports one (exact string, both `<providerID>/<id>#<variant>`) | the lane ran on every sample with the requested model and variant; a failed lane on a clean fixture publishes `comments: []` and must not score as clean; an absent session model is P5's concern |
| P7 reference health | a reference ran, no reference sample has an `error`, and every substantive reference row has `medianDispatches ≥ 1` | a failed or absent reference makes P1/P2 vacuous |
| P8 gate run | `samples ≥ 3`, no `--fixture`/`--fixture-regex`, and `stopReason` is `null`; the detail line names the stop reason (`cost-ceiling` or `unmeasured-spend`) | a tracer (N<3, filtered, or stopped) is evidence, not a gate |

Ties pass (parity, not superiority). P3, P4, and P6 use any-sample
semantics: one bad sample in three fails. A tracer always reads
`NOT MET (… P8-gate-run)`, while P0–P7 still report their own PASS/FAIL —
that is the tracer evidence. This is also true for a stopped run. The
candidate runs first, so when the run stops in the candidate (the
ceiling, or unmeasured spend), the reference never runs: P0 and P7
fail, P1 and P2 print "no reference", P3–P6 report on the candidate
samples that ran, and P8 names the stop reason. A run that stops before
the first candidate sample also fails P6 (no lane ran). To get P1/P2
evidence, the tracer's `--max-cost` must cover both configs.
`checkParity` is the one verdict owner: the `PARITY:` line, the `.md`,
and the `.json` all come from its verdict. `checkThreshold` criteria (a)–(f)
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
  ran, marks the scorecard `stopReason: "cost-ceiling"`, and exits 1.
- Unmeasured spend stops the run at once: a sample with
  `costMeasured: false` names the sample and stops, because the ceiling
  cannot bound spend it never saw. The scorecard then reads
  `stopReason: "unmeasured-spend"`: the remedy is to fix the usage read,
  not to raise `--max-cost`. A candidate sample is measured when no
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

### Tracer on Claude Code, 2026-10-09 (not a gate run)

The operator chose not to pay for the full OpenCode tracer and not to
run a reference. The run used the eval-only `claude-code-down` config
(`scripts/eval/claude-code-lane.mts`): the same `warden-down.md` prompt,
the same warden MCP tools, `evaluateLane`, and `runPostPass`, but run by
`claude -p` on the operator's Claude subscription login. Thus this result
is evidence about the down-lane method on another MCP client. It does
not decide the OpenCode go/no-go.

```
pnpm --filter @warden/cli eval --config claude-code-down --samples 1 --max-cost 10
```

Scorecard:
`results/opencode-parity/2026-10-09T06-43-53-982Z-claude-code-down.json`.
The command writes `results/<timestamp>.json` (gitignored). The operator
moved that file by hand. It is a lane-only scorecard (no parity block,
no `.md`). The run used the uncommitted tree just before `a53ff65`.
`--max-cost` bounds the notional cost here (`total_cost_usd` is the API
price equivalent; no money moves on a subscription login).

| fixture | caught | comments | notional $ |
| --- | --- | --- | --- |
| `clean-formatting-only` (expects 0) | 0/0 | 0 | 0.0429 |
| `clean-rename` (expects 0) | 0/0 | 0 | 0.0481 |
| `committability-debugger-leftover` | 0/1 | 0 | 0.0610 |
| `consistency-docstring-drift` | 0/1 | 1 | 0.0671 |
| `correctness-off-by-one` | 1/1 | 1 | 0.0550 |
| `leverage-stringify-clone` | 0/1 | 0 | 0.0456 |
| `scalability-sequential-await` | 0/1 | 1 | 0.0669 |
| `security-eval-injection` | 0/1 | 0 | 0.0508 |
| `alfred-pr131-falsepos-9349d565` | 0/0, traps 0/8 | 3 | 2.0430 |
| `alfred-pr14-misses-1ff9057` | 1/3 | 1 | 2.7617 |
| `alfred-pr235-misses-a99d732f` | 1/5 | 2 | 1.4852 |
| `m14-closeout-89bf988` | 0/3 | 1 | 0.4944 |
| `m6-misses-2d4dc0b` | 0/4 | 4 | 0.7334 |

- All 13 lanes ended `ok`, with no sample error. The session model was
  `claude-opus-5-5` on every sample (requested `claude-opus-5-5#high`).
- Synthetic 1/6, real-PR 2/15, false-positive traps 0/8, clean fixtures
  0 comments. Total notional cost $7.96: synthetic fixtures cost about
  $0.05 each, real PRs $0.49–2.76 each.
- Every comment has category `correctness`, as the down charter says.
  The committability, leverage, scalability, consistency, and security
  plants are outside that charter (see Residuals).
- `security-eval-injection` published no comment. The prompt tells the
  lane not to restate det-prior findings, and the lane `CommentSet` does
  not carry det-priors. Thus a det-prior-only bug does not reach the
  published output. This is a known gap, not fixed in this slice.
- The real PRs produced correctness findings that have no label (for
  example 4 on `m6-misses-2d4dc0b`). A comment with no label is not
  proof of a false positive.
- Real-PR 2/15 undercounts by one. On `alfred-pr235-misses-a99d732f`,
  comment `W-27e09cfd5d` finds the `pinned-demanding-never-wired` bug,
  but it is anchored at `attention.ts:125`, and the label is at
  `read.ts:167`. Labels match on file and line ±5, so it scored as a
  miss plus an unlabeled comment.
- On `correctness-off-by-one`, the Claude Code lane cost $0.0550 in this
  scorecard. The operator also saw $0.1427 for the OpenCode lane (an
  earlier one-fixture tracer through the `warden-dev` gateway) and
  $0.1311 for an earlier Claude Code run. Those two runs are not
  committed.
