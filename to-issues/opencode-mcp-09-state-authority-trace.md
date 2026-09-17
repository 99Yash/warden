# State authority + review-trace bridge

**GitHub:** [#47](https://github.com/99Yash/warden/issues/47)

**Parent:** PRD — Warden as MCP tool-provider for OpenCode (#38).

## What to build

Declare and implement the single source of truth for review state: Warden owns
the canonical `CommentSet` and the persisted review trace / run record; the
runtime's session database is execution telemetry. Bridge the runtime's events
(or capture from the driver) into Warden's review trace so that per-finding
provenance survives the hop: producing lane, supporting tool calls, provenance
(`sourced`/`reasoned`), and which deterministic transform changed or dropped it
— without recording model prose. Re-home the observability decision (the
current OTEL wrapping no longer surrounds the model calls).

## Acceptance criteria

- [ ] The state-authority rule is documented where reviewers will find it.
- [ ] A run identity is minted once per review and persisted with the trace.
- [ ] The trace records, per finding, producing lane, provenance, tool calls,
      and the deterministic transforms applied — and no model prose.
- [ ] The trace is populated whether the review runs via the driver or the
      runtime's event stream.
- [ ] A smoke test round-trips a run record and asserts the trace shape.

## Blocked by

- `to-issues/opencode-mcp-05-tracer-bullet-eval.md`
