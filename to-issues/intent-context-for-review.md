# Feed stated intent (PR description / ADR) into review as adjudication context — lever B

**Severity:** high (recall). **Needs an ADR.**

## Problem

Some of the highest-value bugs are _intent-relative invariant violations_ —
the code is internally plausible and only wrong against a contract stated
outside the code. On alfred PR#235 these were the two findings warden could
**not** have caught regardless of prompt quality:

- `pinnedDemanding` accepted but no caller passes it → violates the "security
  pins stay" invariant stated in ADR-0064 / the PR description.
- recurrence assigned by input order → violates the "recurrence decays repeats"
  guarantee, also stated in prose, not code.

The OpenAI harness caught both because it was given the PR description, the
ADR, and recent journals, plus a "review code against stated intent" stance.
Warden's boss and workers see only the diff + the files they `readFile` — never
the PR's stated purpose. So they cannot check code-vs-contract; they can only
check code-vs-code.

## Proposal sketch

Plumb an optional **intent block** into the boss (and into worker context)
sourced from, in priority order: the PR/MR description (when run in a CI/bot
context), a linked ADR id found in the commit message or diff, and/or the most
recent design-doc/journal touching the changed area. The boss already has
`diffBase.description` (ADR-0046); extend that into a richer, optional
`reviewIntent` the workers can consult. The diligent preamble already tells
workers to "review code against stated intent" — but today there is no intent
to read.

## Tension to resolve in the ADR

- Citation discipline: an intent-relative finding cites the violated invariant
  (prose) + the in-diff code. Decide how prose sources fit the
  evidence/sources model (ties into ADR-0044 reasoned-lane / citation demotion).
- Trust: a stale or aspirational PR description is not ground truth (cf.
  `project_warden_stale_doccomment_fp`). Treat intent as a _hypothesis to
  verify against code_, not as fact.

## Refs

- memories `project_warden_recall_is_agency_gap`, `project_warden_context_selection`
- ADR-0046 (`diffBase.description`), ADR-0044 (citation demotion)
- fixture `alfred-pr235-misses-a99d732f` labels tagged `[intent]`
