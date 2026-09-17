# `run_det_priors` MCP tool + versioned bundle

**GitHub:** [#40](https://github.com/99Yash/warden/issues/40)

**Parent:** PRD — Warden as MCP tool-provider for OpenCode (#38).

## What to build

Expose Warden's Phase 1 (deterministic runners + context selection) as an MCP
tool, returning the review target and findings in a versioned, size-bounded
result. Prefactor first: extract a CLI-agnostic review-bundle serializer out of
the current det-priors path so both the CLI and the MCP server consume one
shape. The result must carry the pruned changed-file set, a findings summary
preserving evidence/sources and category/tier mapping, handles for retrieved
context, and degraded entries — without shipping an unbounded raw diff or chunk
payload into the agent's context.

## Acceptance criteria

- [ ] The tool accepts a review-target input (repo root + base/head or diff) and
      returns pruned changed files, findings, context handles, and degraded
      entries, with a schema version.
- [ ] Result size is bounded by a documented rule; the bound is asserted in a
      smoke test.
- [ ] Findings preserve `evidence` and `sources[]` and the existing category
      and tier mapping.
- [ ] An unavailable runner produces a degraded result, not a tool error.
- [ ] A deterministic smoke test runs the tool against a fixture diff and
      asserts the serialized shape and size bound.
- [ ] The serialization seam is shared with the existing CLI path (no duplicate
      bundle logic).

## Blocked by

- `to-issues/opencode-mcp-01-mcp-server-skeleton.md`
