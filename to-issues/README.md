# to-issues

Lightweight backlog of follow-ups not yet promoted to ADRs or milestone plans.
One file per issue. Triaged out of the 2026-06-21 alfred PR#235 dogfood
head-to-head (warden 2 findings — one FP — vs an OpenAI staff-engineer-prompt
harness's 5). See memories `project_warden_pr235_openai_headhead` and
`project_warden_recall_is_agency_gap` for origin.

The original six are mirrored as GitHub issues on `99Yash/warden` (filed
2026-06-21). Later recall levers follow the same canonical-file + trackable-GH
issue pattern.
The markdown files stay the canonical longform; the GH issues are the trackable
surface.

| Issue                                                                                     | GH                                                | Severity                  | Needs ADR?                                |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------- | ----------------------------------------- |
| [openai-worker-false-clean](./openai-worker-false-clean.md)                               | [#29](https://github.com/99Yash/warden/issues/29) | high (correctness)        | no                                        |
| [intent-context-for-review](./intent-context-for-review.md)                               | [#30](https://github.com/99Yash/warden/issues/30) | high (recall)             | yes — lever B                             |
| [lane-discipline-cross-file-evidence](./lane-discipline-cross-file-evidence.md)           | [#31](https://github.com/99Yash/warden/issues/31) | medium (recall)           | yes — lever C                             |
| [structural-ceiling-pass](./structural-ceiling-pass.md)                                   | [#37](https://github.com/99Yash/warden/issues/37) | high (recall + precision) | proposed ADR-0052 — lever D               |
| [review-observability](./review-observability.md)                                         | [#32](https://github.com/99Yash/warden/issues/32) | medium (tooling)          | ✅ ADR-0048 (locked, shipping)            |
| [resume-from-review-run](./resume-from-review-run.md)                                     | [#33](https://github.com/99Yash/warden/issues/33) | medium (cost + iteration) | designed in ADR-0048 §8; impl ADR pending |
| [prune-transparency-large-generated-drops](./prune-transparency-large-generated-drops.md) | [#34](https://github.com/99Yash/warden/issues/34) | low                       | no                                        |

**Shipped already this session (not issues):** precise prune of generated
Drizzle `_snapshot.json` / `_journal.json` (the $11→$0.93 driver); the
`diligent` worker-prompt variant + `alfred-pr235-misses` eval fixture (lever A,
awaiting an eval run).

---

## OpenCode MCP pivot — PRD [#38](https://github.com/99Yash/warden/issues/38)

Warden becomes the methodology + deterministic tool-provider; OpenCode runs the
review via MCP. Canonical PRD: [`docs/prd-opencode-mcp.md`](../docs/prd-opencode-mcp.md);
foundation: [`docs/opencode-mcp-foundation.md`](../docs/opencode-mcp-foundation.md).

A doc-only prerequisite precedes slice 1: the new ADR + the
amend/reopen/re-scope sweep (ADR-0030, ADR-0005/0017, ADR-0048, ADR-0039,
ADR-0051/0052, ADR-0016 export/import) listed in the PRD's Implementation
Decisions. File the remaining recall levers (B/C/D) through that ADR sweep, not
as separate slices here.

| Slice | GH | Blocked by |
| --- | --- | --- |
| [MCP server skeleton + `lookup_type_def`](./opencode-mcp-01-mcp-server-skeleton.md) | [#39](https://github.com/99Yash/warden/issues/39) | — |
| [`run_det_priors` MCP tool + versioned bundle](./opencode-mcp-02-run-det-priors-tool.md) | [#40](https://github.com/99Yash/warden/issues/40) | #39 |
| [Mandatory post-pass outside the model](./opencode-mcp-03-mandatory-post-pass.md) | [#41](https://github.com/99Yash/warden/issues/41) | #40 |
| [OpenCode lane config + prompt materialization](./opencode-mcp-04-opencode-lane-config.md) | [#42](https://github.com/99Yash/warden/issues/42) | #40, #41 |
| [Tracer-bullet eval + parity gate](./opencode-mcp-05-tracer-bullet-eval.md) | [#43](https://github.com/99Yash/warden/issues/43) | #42 |
| [`search_index` MCP tool](./opencode-mcp-06-search-index-tool.md) | [#44](https://github.com/99Yash/warden/issues/44) | #39 |
| [`warden index export/import` verbs + CI cache recipe](./opencode-mcp-07-index-export-import.md) | [#45](https://github.com/99Yash/warden/issues/45) | — |
| [Structural `up` lane + deterministic tell-collector](./opencode-mcp-08-structural-up-lane.md) | [#46](https://github.com/99Yash/warden/issues/46) | #43, #44 |
| [State authority + review-trace bridge](./opencode-mcp-09-state-authority-trace.md) | [#47](https://github.com/99Yash/warden/issues/47) | #43 |
| [CI runner: Action + cost cap + PR output + cached index](./opencode-mcp-10-ci-runner.md) | [#48](https://github.com/99Yash/warden/issues/48) | #43, #45 |
