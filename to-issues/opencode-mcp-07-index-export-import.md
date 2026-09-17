# `warden index export/import` verbs + CI cache recipe

**GitHub:** [#45](https://github.com/99Yash/warden/issues/45)

**Parent:** PRD — Warden as MCP tool-provider for OpenCode (#38).

## What to build

Wire the already-implemented portable index exporter/importer to CLI verbs:
`warden index export <path>` writes a portable archive (content-addressed rows
plus a manifest carrying the locked embedding model and the repo Merkle root),
and `warden index import <path>` restores it in merge or replace mode. Document
the CI cache recipe: export locally, store keyed by repo + locked model,
restore in CI before the review. A locked-model mismatch must be handled
explicitly rather than mixing vector spaces. This slice is independent of the
MCP seam.

## Acceptance criteria

- [ ] `warden index export` writes a portable archive; `warden index import`
      restores it in merge and replace modes.
- [ ] The archive manifest carries the locked model and repo Merkle root; a
      mismatched locked model is surfaced explicitly (no silent mixing).
- [ ] Round-trip smoke: export → import → semantic search returns usable
      results; a second smoke covers the mismatch path.
- [ ] A documented CI cache key/recipe exists and is compatible with the CI
      runner (slice 10).
- [ ] No new remote dependency is introduced (artifact-based, local-first).

## Blocked by

None — can start immediately.
