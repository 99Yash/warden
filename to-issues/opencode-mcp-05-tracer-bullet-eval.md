# Tracer-bullet eval + parity gate

**GitHub:** [#43](https://github.com/99Yash/warden/issues/43)

**Parent:** PRD — Warden as MCP tool-provider for OpenCode (#38).

## What to build

Score the new OpenCode path through the existing review-eval harness and gate it
against the current harness. The runner drives the runtime on the existing
fixtures — the `*-misses-*` set for recall, the `*-falsepos-*` and clean
fixtures for precision — applies the existing threshold scorer and cost gate,
and records a written parity threshold that must be met before the new path can
become a default. This is the acceptance test for the whole pivot.

## Acceptance criteria

- [ ] A runner executes the new path on the recall and precision fixture sets.
- [ ] Results are compared against the current harness configs and a parity
      threshold is recorded (recall, precision, and clean-fixture zero-hit).
- [ ] The existing cost gate applies to each eval run.
- [ ] A scorecard artifact records the result and is referenced from the PRD.
- [ ] A documented go/no-go states which slice(s) the outcome blocks.

## Blocked by

- `to-issues/opencode-mcp-04-opencode-lane-config.md`
