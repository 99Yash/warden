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

How it is scored:

- `lane-roster-drift-as-question` (present, `kind: question`) is caught only
  by a question-kind comment at the anchor. It measures that the candidate
  surfaces at the right kind.
- `lane-roster-drift-as-assertion` (absent, `kind: assertion`, no category) is
  the leg (iv) gate: any assertion-kind comment at the anchor is a trap hit,
  scored under gate (f) (max over samples). Silence passes the gate, as the
  ADR allows ("or is suppressed").

```yaml
id: lane-roster-drift-as-question
path: packages/cli/src/opencode/materialize.ts
line: 132
kind: question
category: consistency
description: [structural] [ladder] LANE_SPECS now lists the up lane, but docs/reference/lanes/down.md:10-11 tells the down model the up lane "does not exist yet". Only a test (the down-prompt sha256 pin, tier 4) or a convention (tier 5) can hold prose and code together, so the finding must be a question.
```

```yaml
id: lane-roster-drift-as-assertion
expect: absent
path: packages/cli/src/opencode/materialize.ts
line: 132
kind: assertion
description: [structural] [ladder] Leg (iv) gate. An assertion-kind comment at LANE_SPECS means the lane rated a tier 4-5 closure as tier 1-3. Silence or a question passes.
```
