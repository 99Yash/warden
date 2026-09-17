# Structural `up` lane + deterministic tell-collector

**GitHub:** [#46](https://github.com/99Yash/warden/issues/46)

**Parent:** PRD — Warden as MCP tool-provider for OpenCode (#38).

## What to build

Realize the up-direction structural pass under the new split: only its
deterministic tells stay in Warden, as a det-priors extension; the lane itself
runs as an OpenCode agent. The tell-collector emits structural **candidates**
(not findings) for the greppable axes — repetition, loose representation,
wrong dependency direction — reusing existing duplication/cycle machinery. The
`up` agent runs the axis pointers, applies the admission gates and enforcement
ladder, and returns reasoned findings whose evidence is the multi-home set,
which requires permitting corroborating out-of-lane sources for structural
findings only. This reshapes the structural/cross-lane ADR work rather than
implementing it in Warden's own harness.

## Acceptance criteria

- [ ] Det priors gain a structural tell-collector emitting candidates with axis
      tags (not findings); a smoke test asserts candidate shape.
- [ ] An OpenCode `up` agent consumes candidates, runs the pointers, applies the
      admission gates and the enforcement ladder, and returns reasoned findings.
- [ ] Structural findings may cite corroborating out-of-lane sources while
      behavioral lanes keep strict lane discipline.
- [ ] The eval gate from the structural ADR is met: recall fixtures, per-axis
      false-positive traps, clean-fixture zero-hit, and a ladder-fidelity check.
- [ ] Cost stays within the eval cost gate (per-axis gating if needed).

## Blocked by

- `to-issues/opencode-mcp-05-tracer-bullet-eval.md`
- `to-issues/opencode-mcp-06-search-index-tool.md`
