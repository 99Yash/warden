# Mandatory post-pass outside the model

**GitHub:** [#41](https://github.com/99Yash/warden/issues/41)

**Parent:** PRD — Warden as MCP tool-provider for OpenCode (#38).

## What to build

Run Warden's Phase 3 — evidence/source verification, lane and added-line
scoping, priority ordering, volume cap, and confidence→kind degradation — as a
step the model cannot skip, consuming whatever findings the runtime lanes
produced and emitting the canonical `CommentSet`. This is deliberately **not**
an MCP tool (a model may decline to call a tool). Preferred host: an OpenCode
plugin hook intercepting the terminal submit; fallback: a review-driver step
that runs after the session returns. Confirm which host actually guarantees
interception before building.

## Acceptance criteria

- [x] The post-pass is not exposed as an MCP tool.
- [x] Given lane output, it drops unverifiable evidence/sources, drops comments
      not anchored to added diff lines, applies priority order + volume cap +
      confidence→kind, and returns a canonical `CommentSet`.
- [x] It is invocable independently of the current boss-loop harness.
- [x] The interception host is verified and documented (plugin hook or driver),
      including what happens when a lane returns no findings.
- [x] Smoke tests cover independence from the harness and the drop/degrade
      behavior on crafted input.

Met by slice #41 (`runPostPass()` + `warden post-pass`, ADR-0053 amendment
2026-10-08): host verified as the driver step; lane-health rules cover the
no-findings cases; `smoke:mcp-post-pass` covers the drop/degrade behavior,
harness independence, and the no-post-pass-tool MCP surface.

## Blocked by

- `to-issues/opencode-mcp-02-run-det-priors-tool.md`
