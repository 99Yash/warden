# MCP server skeleton + `lookup_type_def`

**GitHub:** [#39](https://github.com/99Yash/warden/issues/39)

**Parent:** PRD — Warden as MCP tool-provider for OpenCode (#38).

## What to build

A new workspace package that hosts Warden's MCP server, plus a `warden mcp`
subcommand that launches it over stdio. It registers exactly one tool —
`lookup_type_def` — backed by the existing type-definition resolver, to prove
the transport, tool discovery, result schema, and OpenCode connection
end-to-end. Tool result schemas carry a version field and tool failures return
a structured degraded/not-found result rather than throwing across the
transport. Adding the package must not pull transport or MCP dependencies into
the review engine.

## Acceptance criteria

- [ ] `warden mcp` starts a stdio MCP server; `tools/list` returns
      `lookup_type_def` with a valid JSON input schema.
- [ ] `tools/call` for a known symbol returns a pre-shaped suggested source;
      a missing symbol returns a structured not-found reason; neither throws.
- [ ] Tool result envelopes carry an explicit schema version.
- [ ] A smoke test speaks the MCP protocol against the spawned server and
      asserts discovery + the success and not-found envelopes.
- [ ] The documented OpenCode `mcp` config connects to the server and lists the
      tool, verified against a running OpenCode instance.
- [ ] The engine package gains no MCP/transport dependency.

## Blocked by

#49 — the doc-only ADR sweep (methodology/tool-provider + state authority). The
slice file originally read "None", which contradicted `to-issues/README.md`
claiming the sweep precedes slice 1; #49 settles that.
