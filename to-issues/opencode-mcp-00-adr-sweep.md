# ADR sweep: lock Warden-as-tool-provider + re-scope the ADRs the pivot breaks

**GitHub:** [#49](https://github.com/99Yash/warden/issues/49)

**Parent:** PRD — Warden as MCP tool-provider for OpenCode (#38).

**Doc-only. No runtime code.** Analysis: [`docs/opencode-mcp-foundation.md`](../docs/opencode-mcp-foundation.md)
§9. Canonical PRD: [`docs/prd-opencode-mcp.md`](../docs/prd-opencode-mcp.md) → Implementation
Decisions → ADR actions.

## What to build

The pivot is fully planned (#38–#48) but zero implementation exists. This slice
lands the decision record before any slice ships code on top of it.

**New ADR — "Warden as methodology + deterministic tool-provider; OpenCode as
execution engine."** Locks: Warden keeps the method and the deterministic
invariants while OpenCode runs the agentic lanes and owns the model calls; the
seam is MCP (stdio), chosen over the OpenCode plugin `tool` hook for
engine-agnosticism; "remote SQLite" means the CI index cache only; it is not a
rewrite — Phase 1 (det priors) and Phase 3 (verify + hard rules) stay in Warden
and only Phase 2 (boss loop + worker dispatch) moves out; Warden owns the
canonical `CommentSet` and review trace as the state authority; deterministic
gates are not MCP tools, because a model can decline to call a tool.

**Amend / reopen.** ADR-0030 (Phase 2 leaves Warden), ADR-0005 / ADR-0017 (lane
model calls + provider fallback become the runtime's), ADR-0048 (observability
re-homing), ADR-0039 (the hosted surface may shrink to detector + verifier).

**Re-scope.** ADR-0051 (Lever C) and ADR-0052 (Lever D) are largely "add a lane
to Warden's boss loop". With OpenCode owning the loop, the lanes move and only
the deterministic tells (jscpd reuse, `as`/`!` scan, cycle detection) stay in
`runDetPriors()`. Settling this determines how much of the current harness
survives — foundation §8 Q1. Recall levers B/C/D (#30, #31, #37) file through
this sweep, not as separate slices.

**De-defer.** ADR-0016 #3 (`warden index export/import`) waited on "a concrete
consumer"; CI is that consumer. The exporter/importer implementations already
exist — only the CLI verbs are missing (#45).

## Acceptance criteria

- [ ] New ADR lands in `decisions.md` — decision-table row + full entry, at the
      next free number (0050 is skipped, 0052 is the current max → **0053**).
- [ ] Every ADR in the amend table carries an explicit amendment note. None is
      left silently contradicted.
- [ ] ADR-0051/0052 explicitly split: which half moves to the runtime, which
      stays in Warden.
- [ ] ADR-0016 #3 marked de-deferred and cross-linked to #45.
- [ ] `CONTEXT.md` gains the new nouns (lane / motion / post-pass / state
      authority) in existing vocabulary — no invented terminology.
- [ ] `docs/milestones.md` records the pivot status so M18+ deferrals are not
      read as "this is still the plan".
- [ ] `to-issues/README.md` blocker column reconciles slice #39 with this ticket.
- [ ] Zero runtime code changes.

## Blocked by

None — can start immediately.