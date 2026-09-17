# CI runner: Action + cost cap + PR output + cached index

**GitHub:** [#48](https://github.com/99Yash/warden/issues/48)

**Parent:** PRD — Warden as MCP tool-provider for OpenCode (#38).

## What to build

Make reviews run in CI on any repo. A CI entrypoint restores the index archive
from cache, runs the runtime with the Warden MCP server and lane agents,
resolves the PR diff/base deterministically, enforces a hard cost ceiling, and
posts the resulting `CommentSet` to the pull request. Provider keys come from CI
secrets and are never persisted. A cache miss degrades to cheap signals rather
than failing. Ship it as a GitHub Action (with the underlying command usable by
any CI).

## Acceptance criteria

- [ ] CI restores the index archive using the documented cache key before the
      review; a miss degrades gracefully.
- [ ] A hard cost ceiling is enforced and surfaced in the run output.
- [ ] Diff/base resolution for the PR feeds the review target deterministically.
- [ ] The `CommentSet` is posted to the PR.
- [ ] Keys come from CI secrets; nothing secret is written to the repo or index.
- [ ] A real test PR run is documented end-to-end.

## Blocked by

- `to-issues/opencode-mcp-05-tracer-bullet-eval.md`
- `to-issues/opencode-mcp-07-index-export-import.md`
