# Let a finding cite an unchanged out-of-diff consumer as corroborating evidence — lever C

**Severity:** medium (recall). **Needs an ADR** (precision risk).

## Problem

Lane discipline drops any finding whose `sources[].path` is outside the
dispatched (in-diff) file set. That is correct for scope control, but it also
kills a real bug class: a defect in changed code whose *proof* lives in an
unchanged caller.

alfred PR#235, recurrence-reversed: `scoreAttentionForItems` (in-diff,
`attention.ts`) assigns recurrence by input order, but the proof that this is
wrong is that consumers feed it newest-first — and one consumer,
`me/routes.ts:493`, is **unchanged and not in the diff**. A worker can
`readFile` it for context, but if the finding anchors on that line it is
dropped; if it anchors only in-lane it loses the evidence that makes it
convincing.

## Proposal sketch

Allow a finding to carry **one in-lane anchor** (the changed line, which keeps
diff-scoping intact) **plus** out-of-lane `sources[]` marked as corroborating
context. Keep the rule "every finding must have ≥1 in-lane source"; relax only
"every source must be in-lane." The verifier still substring-checks all sources
(in- and out-of-lane) against their files, so this does not weaken citation.

## Tension to resolve

- Precision/scope creep: out-of-lane sourcing is an attack surface for
  noise. Gate it (e.g. only when the in-lane anchor is a changed symbol's
  definition and the out-of-lane source is a confirmed caller of it).
- Interaction with the `diligent` variant: the preamble already has workers
  read callers for context; this change lets that context survive into the
  finding instead of being discarded.

## Refs

- `packages/core/src/review-harness/tools/dispatch-worker.ts` (`isOutOfLane`)
- memory `project_warden_recall_is_agency_gap`
- fixture `alfred-pr235-misses-a99d732f` label `recurrence-reversed-for-newest-first` tagged `[lane]`
