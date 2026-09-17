# `search_index` MCP tool

**GitHub:** [#44](https://github.com/99Yash/warden/issues/44)

**Parent:** PRD — Warden as MCP tool-provider for OpenCode (#38).

## What to build

Expose Warden's semantic index retrieval as an MCP tool so runtime agents can
pull relevant context beyond the diff. The tool resolves the index, runs the
existing selector, and returns ranked context candidates with their evidence,
size-bounded. A missing, stale, or model-mismatched index degrades to a
structured result using the existing index-health gates rather than erroring.

## Acceptance criteria

- [ ] The tool returns ranked context candidates with evidence for a query.
- [ ] Missing/stale/model-aged index states return a structured degraded result
      (reusing the existing health gates), never a transport error.
- [ ] Results are size-bounded by a documented rule and asserted in a smoke
      test.
- [ ] The tool works against an index produced by `warden index export/import`
      (slice 7) as well as a locally built one.
- [ ] A smoke test builds a fixture index and asserts ranked, bounded output.

## Blocked by

- `to-issues/opencode-mcp-01-mcp-server-skeleton.md`
