# OpenCode lane config + prompt materialization

**GitHub:** [#42](https://github.com/99Yash/warden/issues/42)

**Parent:** PRD — Warden as MCP tool-provider for OpenCode (#38).

## What to build

Materialize Warden's methodology into OpenCode agent definitions. Start with a
single `down` / correctness lane: it connects to the Warden MCP server, uses
`run_det_priors` and `lookup_type_def`, investigates with OpenCode's own tools,
and returns reasoned findings. Warden's method documents and lane prompts are
the single source of truth; a deterministic assembly step produces the runtime
agent config, and a drift check fails when the two diverge. Configure per-agent
model tier and read-only permissions.

## Acceptance criteria

- [ ] A generation/assembly step produces the lane agent definition from
      Warden's method source; the source remains canonical.
- [ ] A drift check fails when the materialized config diverges from source.
- [ ] The `down`/correctness agent runs against the Warden MCP server, calls
      det-priors/lookup, and produces findings in the expected shape.
- [ ] Per-agent model tier and read-only permissions are configured and
      documented.
- [ ] The agent's findings feed the mandatory post-pass (slice 3) and yield a
      `CommentSet`.

## Blocked by

- `to-issues/opencode-mcp-02-run-det-priors-tool.md`
- `to-issues/opencode-mcp-03-mandatory-post-pass.md`
