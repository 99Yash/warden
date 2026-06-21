# to-issues

Lightweight backlog of follow-ups not yet promoted to ADRs or milestone plans.
One file per issue. Triaged out of the 2026-06-21 alfred PR#235 dogfood
head-to-head (warden 2 findings — one FP — vs an OpenAI staff-engineer-prompt
harness's 5). See memories `project_warden_pr235_openai_headhead` and
`project_warden_recall_is_agency_gap` for origin.

All six are mirrored as GitHub issues on `99Yash/warden` (filed 2026-06-21).
The markdown files stay the canonical longform; the GH issues are the trackable
surface.

| Issue | GH | Severity | Needs ADR? |
| --- | --- | --- | --- |
| [openai-worker-false-clean](./openai-worker-false-clean.md) | [#29](https://github.com/99Yash/warden/issues/29) | high (correctness) | no |
| [intent-context-for-review](./intent-context-for-review.md) | [#30](https://github.com/99Yash/warden/issues/30) | high (recall) | yes — lever B |
| [lane-discipline-cross-file-evidence](./lane-discipline-cross-file-evidence.md) | [#31](https://github.com/99Yash/warden/issues/31) | medium (recall) | yes — lever C |
| [review-observability](./review-observability.md) | [#32](https://github.com/99Yash/warden/issues/32) | medium (tooling) | ✅ ADR-0048 (locked, shipping) |
| [resume-from-review-run](./resume-from-review-run.md) | [#33](https://github.com/99Yash/warden/issues/33) | medium (cost + iteration) | designed in ADR-0048 §8; impl ADR pending |
| [prune-transparency-large-generated-drops](./prune-transparency-large-generated-drops.md) | [#34](https://github.com/99Yash/warden/issues/34) | low | no |

**Shipped already this session (not issues):** precise prune of generated
Drizzle `_snapshot.json` / `_journal.json` (the $11→$0.93 driver); the
`diligent` worker-prompt variant + `alfred-pr235-misses` eval fixture (lever A,
awaiting an eval run).
