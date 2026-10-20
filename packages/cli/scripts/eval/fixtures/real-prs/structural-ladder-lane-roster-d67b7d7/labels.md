# structural-ladder-lane-roster (warden `d67b7d7`, "feat(cli): add the up lane charter and spec (ADR-0052 Lever D)")

ADR-0052 eval leg (iv), the ladder-fidelity precondition. `diff.patch` is only
the `packages/cli/src/opencode/materialize.ts` section of `d67b7d7`: it adds
`UP_LANE_SPEC` and puts it in `LANE_SPECS`. The commit's other files (the up
charter and the two generated lane files) are present in both the base and
the head of the fixture repo. `meta.json` checks out `d67b7d7`, so the lane can
grep `docs/reference/lanes/down.md`.

The candidate: the fact "which review lanes exist" has two homes that now
disagree. `LANE_SPECS` (`materialize.ts:132`) lists the down lane and the up
lane. The down lane charter, `docs/reference/lanes/down.md:10-11`, tells the
down model: "The **up** lane (structural search, #46) does not exist yet". It
is a real drift: PR #103 lists that sentence under "Not in this PR" and keeps
it on purpose, because `smoke:opencode-lanes` pins the bytes of the generated
down prompt.

Why only tier 4–5 can hold it: the second home is prose that a model reads.
No type, runtime validator, or single owner can make a sentence in a charter
agree with a TypeScript array. The sha256 pin of the down prompt is a test
(tier 4): it stops a silent edit of the prose, but it does not detect that the
prose and `LANE_SPECS` disagree. The only remaining closure is the convention
"update the charter when the roster changes" (tier 5). So an up-lane finding
here must post as a `question` (confidence below 0.7), or not post. It must not
post as an `assertion`.

The diff holds a second drift of the same kind. The new `UP_LANE_SPEC` doc
comment (`materialize.ts:101-108`) says the driver runs the up lane "only on
`--lane up` (`warden opencode-review`) or the eval config `opencode-up`". At
`d67b7d7` neither exists: `259117d` adds them one commit later. It is also a
prose home that disagrees with the code, so it has the same tier 4-5 limit.

Every `consistency` candidate in this diff is a drift between prose (a doc
comment or a charter sentence) and code. The only changed file is
`materialize.ts`. Thus the labels match any `consistency` comment on that
file, not only one at `LANE_SPECS`.

How it is scored:

- `lane-roster-drift-as-question` (present, `kind: question`,
  `category: consistency`, path only) is caught by a question-kind
  `consistency` comment on `materialize.ts`. It measures that a prose-vs-code
  drift surfaces at the right kind.
- `lane-roster-drift-as-assertion` (absent, `kind: assertion`,
  `category: consistency`, path only) is the leg (iv) gate: an
  assertion-kind `consistency` comment on `materialize.ts` is a trap hit,
  scored under gate (f) (max over samples). Silence passes the gate, as the
  ADR allows ("or is suppressed"). A `dedup` or `clarity` assertion on the
  file does not hit it.

Fixed 2026-10-20 after the first run: the labels had `line: 132`. The up
lane posted the doc comment drift (`materialize.ts:102-109`) as an assertion
at confidence 0.72, and the gate did not see it, because the comment was out
of the ±5 line range.

```yaml
id: lane-roster-drift-as-question
path: packages/cli/src/opencode/materialize.ts
kind: question
category: consistency
description: [structural] [ladder] A prose home disagrees with the code: docs/reference/lanes/down.md:10-11 says the up lane "does not exist yet" while LANE_SPECS lists it, or the UP_LANE_SPEC doc comment names --lane up and opencode-up, which do not exist at d67b7d7. Only a test (tier 4) or a convention (tier 5) can hold prose and code together, so the finding must be a question.
```

```yaml
id: lane-roster-drift-as-assertion
expect: absent
path: packages/cli/src/opencode/materialize.ts
kind: assertion
category: consistency
description: [structural] [ladder] Leg (iv) gate. A consistency assertion on materialize.ts means the lane rated a tier 4-5 prose-vs-code closure as tier 1-3. Silence or a question passes.
```
