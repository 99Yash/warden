# Feed stated intent (PR description / ADR) into review as adjudication context — lever B

> **GRADUATED → ADR-0049** (2026-06-24, decisions.md). This file is now a pointer;
> the design lives in the ADR. **Delete when ADR-0049 lands in code.**

ADR-0049 carries the full design. In brief:

- **Acquire** intent via a deterministic cascade — resolved-PR `gh pr view`
  (matched by the diff's head+base or an explicit `--pr`/URL, never bare
  "current branch") → referenced docs → commit subjects over the diff's
  **merge-base commit set**.
- **Compress** to a claimed-intent digest via a **summarizer routing policy**
  over the existing cheap review tier (Anthropic/OpenAI only in v0;
  deterministic-excerpt fallback; Google only via a future explicit
  `routing.intentSummarizer` knob, never the default LLM fallback chain).
- **Inject** the digest (inject-don't-discover, ADR-0047 §2); **trust** it as a
  hypothesis to verify against code — code is authority, intent never enters
  `sources[]`.
- **Eval gate** (four legs, before default-on): digest fidelity + recall on
  PR#235 prose-only labels + precision (no PR#131 regression) + stale /
  future-work FP traps.

Bound: ADR-0050 (init-time repo-intent digest), ADR-0051 (Lever C).

**Correction to the original sketch (now superseded):** the boss does **not**
already have intent — `diffBase.description` (ADR-0046) is a range label
("vs main"), not intent; no intent text flows anywhere today.

## Refs

- memories `project_warden_recall_is_agency_gap`, `project_warden_context_selection`
- ADR-0049 (this design), ADR-0046 (`diffBase.description`), ADR-0044 (citation demotion)
- fixture `alfred-pr235-misses-a99d732f` labels tagged `[intent]`
