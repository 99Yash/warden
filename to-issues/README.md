# to-issues

Lightweight backlog of follow-ups not yet promoted to ADRs or milestone plans.
One file per issue. Triaged out of the 2026-06-21 alfred PR#235 dogfood
head-to-head (warden 2 findings — one FP — vs an OpenAI staff-engineer-prompt
harness's 5). See memories `project_warden_pr235_openai_headhead` and
`project_warden_recall_is_agency_gap` for origin.

| Issue | Severity | Needs ADR? |
| --- | --- | --- |
| [openai-worker-false-clean](./openai-worker-false-clean.md) | high (correctness) | no |
| [intent-context-for-review](./intent-context-for-review.md) | high (recall) | yes — lever B |
| [lane-discipline-cross-file-evidence](./lane-discipline-cross-file-evidence.md) | medium (recall) | yes — lever C |
| [review-observability](./review-observability.md) | medium (tooling) | maybe |
| [prune-transparency-large-generated-drops](./prune-transparency-large-generated-drops.md) | low | no |

**Shipped already this session (not issues):** precise prune of generated
Drizzle `_snapshot.json` / `_journal.json` (the $11→$0.93 driver); the
`diligent` worker-prompt variant + `alfred-pr235-misses` eval fixture (lever A,
awaiting an eval run).
