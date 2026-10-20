# structural-repetition-lane-name (warden `259117d`, "feat(cli): run the up lane only on --lane up (default off)")

ADR-0052 eval leg (i), repetition/registry axis. `diff.patch` is the whole
commit (`259117d~1..259117d`). `meta.json` checks out `259117d`, so the lane
can grep the full post-image tree (the `LANE_SPECS` registry in
`packages/cli/src/opencode/materialize.ts` is unchanged and out of the diff).

The fact: "lane name → lane spec". Its owner is `LANE_SPECS`
(`materialize.ts:132`). This commit adds three more homes of the same fact:

1. `packages/cli/scripts/eval/run.mts:464` maps `config.opencodeLane === "up"`
   to `UP_LANE_SPEC` by hand (the labeled line).
2. `packages/cli/scripts/eval/types.ts:38` restates the lane union as
   `opencodeLane?: "down" | "up"`.
3. `packages/cli/src/index.ts:260` and `:411` write `--lane <down|up>` and a
   second `LANE_SPECS.find(...)` lookup.

The homes still agree for the two lanes of today, so the category is `dedup`.
The change it de-risks: a third lane needs edits in the eval, and the eval
runs the down lane for it in silence (the conditional falls through to no
`lane`). The fix reaches tier 3 (one lookup) plus tier 1 (`LaneSpec["lane"]`
derives the union), so a correct finding is an assertion.

Why it is genuine: the later fix `93989dc` ("refactor(cli): map a lane name to
its spec in one place", PR #103 review fix 3) adds `laneSpecFor(name)` as the
one lookup, makes the eval call it and fail on an unknown lane, and changes
`opencodeLane` to `lane?: LaneSpec["lane"]`. Its message names this defect:
"A third lane would need a code change in the eval, and the eval would run the
down lane for it in silence."

Anchor note: the lane can also anchor the finding on `types.ts:38` or
`index.ts:411`. The scorer matches one path, so those anchors read as a miss,
the same anchor problem as `m14-closeout`'s `price-table-duplication`.

```yaml
id: lane-name-to-spec-mapped-outside-registry
path: packages/cli/scripts/eval/run.mts
line: 464
category: dedup
description: [structural] repetition/registry. The eval maps opencodeLane === "up" to UP_LANE_SPEC by hand, types.ts:38 restates the lane union, and index.ts:411 adds a second LANE_SPECS.find lookup; LANE_SPECS (materialize.ts:132) is the owner. A third lane silently runs as the down lane in the eval. Fixed by 93989dc (laneSpecFor + lane?: LaneSpec["lane"]).
```
