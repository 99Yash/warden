# PRD — Warden as MCP tool-provider for OpenCode

> Canonical longform. Mirrored as a GitHub issue on `99Yash/warden` (label
> `ready-for-agent`). Foundation/analysis: [`opencode-mcp-foundation.md`](./opencode-mcp-foundation.md).

## Problem Statement

Warden is currently a self-contained review engine: its own Opus boss loop, its
own worker dispatch, its own prompt fleet, its own provider fallback, its own
observability, and a local-only cache. That loop is the least differentiated
part of the stack and the most expensive to keep current — model churn,
provider fallback, tool/permission plumbing, session management. Meanwhile the
parts that actually make Warden trustworthy are trapped inside it: the
deterministic detector corpus, external-authority (OSV) verification, the repo
index, the machine-checkable citation/evidence gates, and the eval harness that
measures recall and precision.

Because method and runner are one artifact, Warden cannot be embedded in CI or
driven by another agent runtime without dragging the whole loop along. The
developer is forced to choose between Warden-the-CLI and a general agent
runtime, when what they want is the second powered by Warden's ground truth.
Separately, the embedding index lives on one machine, so CI either re-embeds
from scratch or reviews with only cheap signals — making CI review slow,
expensive, or shallow.

## Solution

Split Warden into **methodology + deterministic tool-provider**, and let
**OpenCode execute the review**.

- Warden ships an **MCP server** (`warden mcp`) exposing its deterministic
  capabilities as tools. OpenCode connects to it as a local stdio MCP server.
- OpenCode runs the review lanes as agents — **up** (structural search),
  **down** (invariant proof), **surface** (floor sweep), and **judge**
  (synthesis) — with per-agent models and permissions, using Warden tools plus
  its own read/grep/bash tools.
- Warden's **mandatory post-pass** (evidence/source verification, lane and
  added-line scoping, priority order, volume cap, confidence→kind) runs
  **outside the model**, so it cannot be skipped.
- The canonical output stays the **`CommentSet`**, so every existing and future
  surface keeps the same contract.
- The embedding index becomes **exportable/importable**, so CI can restore a
  shared index instead of re-embedding.
- Warden remains usable by **any MCP client**; OpenCode is the first, not a
  hard dependency.

## User Stories

1. As a developer, I want to run `warden mcp` so that any MCP-capable agent
   runtime can use Warden's deterministic review capabilities.
2. As a developer, I want to connect Warden to OpenCode as a local MCP server
   so that my review agent has access to Warden's detectors without adopting
   Warden's own loop.
3. As a developer, I want the MCP server to expose its tools with clear
   descriptions so that an agent can discover and call them without bespoke
   configuration.
4. As a developer, I want a tool that returns the review target (changed files
   after pruning) plus the deterministic findings so that the agent starts from
   the same ground truth regardless of runtime.
5. As a developer, I want the deterministic findings to carry verified
   evidence and sources so that the agent can reason over facts, not guesses.
6. As a developer, I want a tool that resolves library type definitions so
   that agents can cite real API shapes rather than invent them.
7. As a developer, I want a tool that searches the repo index semantically so
   that agents can pull relevant context beyond the diff.
8. As a developer, I want a tool that builds a claimed-intent digest from a PR
   description and referenced design docs so that intent-relative invariants
   can be reviewed.
9. As a developer, I want tool results to be size-bounded so that a large
   det-priors bundle cannot blow the agent's context window.
10. As a developer, I want tool result schemas to be versioned so that a
    runtime upgrade does not silently break an agent.
11. As a developer, I want tool failures to degrade gracefully so that one
    unavailable detector does not fail the whole review.
12. As a developer, I want the review lanes to be the method's motions — up,
    down, surface, and judge — so that search and verification use the right
    tools instead of one closed checklist.
13. As a developer, I want the method docs and lane prompts to have a single
    source of truth so that the methodology does not drift between Warden and
    the runtime.
14. As a developer, I want a deterministic generation step from Warden's method
    into OpenCode agent definitions so that drift is detected mechanically.
15. As a developer, I want to configure per-agent models so that strong models
    run up/down/judge and cheap models run surface and triage.
16. As a developer, I want read-only agents where the lane should not mutate
    the repo so that review cannot corrupt the working tree.
17. As a developer, I want the method's "fund up first, earn down selectively"
    sequencing preserved by the orchestration so that review is not anchored by
    local nits.
18. As a developer, I want a mandatory post-pass that verifies every evidence
    and source snippet so that unverifiable claims never reach the output.
19. As a developer, I want the post-pass to keep comments anchored to added
    diff lines so that out-of-diff comments are dropped deterministically.
20. As a developer, I want lane discipline enforced outside the model so that
    a finding cannot smuggle in out-of-lane evidence except where the method
    permits it.
21. As a developer, I want priority ordering, volume cap, and
    confidence→kind degradation applied deterministically so that output
    quality does not depend on model temperament.
22. As a developer, I want `sourced` vs `reasoned` provenance legible on every
    comment so that an auditable review is possible.
23. As a developer, I want the `CommentSet` to remain the canonical output so
    that the CLI, JSON, PR comments, and the dashboard all consume one schema.
24. As a developer, I want a durable review-run identity and a persisted
    review trace so that I can audit how a review was produced.
25. As a developer, I want a single declared source of truth for review state
    (Warden's run record vs the runtime's session DB) so that two records of the
    same review cannot diverge.
26. As a developer, I want `warden index export` so that I can produce a
    portable index archive.
27. As a developer, I want `warden index import` so that a fresh machine or CI
    run can restore the index without re-embedding.
28. As a developer, I want the index archive keyed to the locked embedding
    model so that incompatible vector spaces are never mixed.
29. As a developer, I want a cache miss to degrade to cheap signals so that a
    CI review still runs when no archive is available.
30. As a developer, I want to run a review in CI against a PR so that every PR
    gets Warden's ground truth without a human invoking it.
31. As a developer, I want a hard cost ceiling for a CI review so that a
    runaway run cannot repeat the past over-spend incident.
32. As a developer, I want CI diff/base resolution to feed the review target
    deterministically so that the same diff produces the same review target.
33. As a developer, I want review output posted to the PR so that findings
    reach the reviewer where they work.
34. As a developer, I want provider keys supplied via CI secrets so that no
    credential is stored in the repo or the index.
35. As a maintainer, I want the existing eval fixtures to score the new path so
    that recall and precision are measured, not assumed.
36. As a maintainer, I want a parity gate versus the current harness before the
    new path becomes the default so that we do not ship a regression.
37. As a maintainer, I want a precision gate on the known false-positive
    fixtures so that the reasoned lane does not regress precision for recall.
38. As a maintainer, I want a cost gate on eval runs so that calibration stays
    affordable.
39. As a maintainer, I want the deterministic engine to stay unchanged so that
    the pivot does not become a rewrite.
40. As a maintainer, I want the ADRs this pivot reopens to be amended or
    superseded explicitly so that the decision record stays honest.
41. As a maintainer, I want observability to be re-homed deliberately so that
    trace coverage does not silently disappear when model calls move to the
    runtime.
42. As a maintainer, I want the MCP seam to stay thin over existing core
    functions so that there is exactly one new integration surface to test.

## Implementation Decisions

**Architecture split.** Warden keeps Phase 1 (det priors: deterministic runners
plus context selection) and Phase 3 (verify: evidence/source verification, lane
and added-line scoping, hard rules, `CommentSet` shaping). Phase 2 (the boss
loop and worker dispatch) moves to OpenCode as agents. This preserves the
I/O-pure core invariant; MCP is a wrapper client of the core, like the CLI.

**New workspace package for the server.** A new `@warden/mcp` package owns the
MCP transport, tool descriptors, and result schemas. The `warden` binary gains a
`warden mcp` subcommand that launches it. Adding the server must not pull MCP or
transport dependencies into `@warden/core`.

**Tool surface (model-invoked).** `run_det_priors` (review target + findings +
retrieved context + degraded), `search_index` (semantic retrieval), and
`lookup_type_def` (symbol resolution with a pre-shaped citation). `build_intent`
(claimed-intent digest) is included only if Lever B survives the pivot. Tool
names are unprefixed in Warden; the runtime prefixes them with the server name.

**Tool result discipline.** Results are size-bounded: the det-priors tool
returns the pruned changed-file set, a findings summary, and handles the agent
can use to read specifics, rather than an unbounded bundle. Tool result schemas
are explicitly versioned, and tool errors return degraded results rather than
throwing across the transport.

**Non-discretionary post-pass.** Verification, scoping, and hard rules are not
MCP tools. They execute outside the model's control — preferably as an OpenCode
plugin hook intercepting the terminal submit; if that interception cannot be
guaranteed, as a driver step after the review session returns. The post-pass is
invoked against whatever findings the lanes produced and emits the canonical
`CommentSet`.

**Methodology contract.** The top-level lanes are the three motions from the
structural-review method plus the judge. The six existing concerns layer inside
the motions as focus prompts. Warden's method docs and lane prompts are the
single source of truth; a deterministic materialization step emits the runtime
agent definitions, and a drift check runs in CI.

**Models and permissions.** Per-agent configuration lives in the runtime:
strong models for up/down/judge, cheap models for surface and triage; agents
that only investigate are read-only. Warden's model-tier intent is preserved as
guidance, not as hardcoded provider getters.

**State authority.** Warden owns the canonical `CommentSet` and the persisted
review trace/run record; the runtime's session database is execution telemetry.
The trace records, per finding, the producing lane, supporting tool calls,
provenance (`sourced`/`reasoned`), and which deterministic transform changed or
dropped it — without recording model prose.

**Index portability.** `warden index export` writes a portable archive
(content-addressed rows plus a manifest carrying the locked model and the repo
Merkle root); `warden index import` restores it in merge or replace mode. CI
keys the archive by repo and locked model. A miss falls back to cheap signals
via the existing index-health gates. A remote SQLite store behind the existing
asynchronous storage interfaces is explicitly a later alternative, not this
PRD's scope.

**CI runner.** CI invokes the runtime with the Warden MCP server and lane
agents, restores the index archive first, resolves the diff/base, enforces a
hard cost ceiling, and posts the resulting `CommentSet` to the PR. Keys come
from CI secrets.

**ADR actions.** Add a new ADR locking methodology/tool-provider plus the state
authority rule. Amend/reopen the ADRs the pivot changes (the boss-loop harness
ADR, the AI SDK and provider-fallback ADRs for lane calls, the observability
ADR) and de-defer the index export/import ADR item. Re-scope the structural and
cross-lane ADRs so their lanes live in the runtime and only their deterministic
tells stay in Warden.

## Testing Decisions

Good tests here exercise external behavior: MCP tool contracts (request in,
result shape out) and whole-review quality (findings in, scored output). They do
not assert internal function calls or prompt text.

- **MCP request-handler seam (new, highest).** Test `warden mcp` by speaking the
  protocol — list tools, call each tool with representative inputs, assert the
  result envelope, size bound, version field, and degraded behavior on failure.
  Prior art: OpenCode's own stdio MCP lifecycle fixture.
- **Eval harness (reused).** Score the new runtime path through the existing
  review-eval suites: the `*-misses-*` fixtures for recall, the
  `*-falsepos-*` and clean fixtures for precision, with the config-comparison
  and threshold-scorer machinery already present. This is the parity gate.
- **Smoke scripts (reused).** Add `smoke-*.mts` coverage for index
  export/import round-trip (including locked-model mismatch), det-priors bundle
  serialization and size bounding, and post-pass independence from the
  boss-loop harness. Follow the repo's existing smoke-script convention rather
  than introducing a test framework.

## Out of Scope

- Rewriting the deterministic engine, detectors, or the `CommentSet` schema.
- Replacing deterministic detection with LLM judgment.
- The hosted dashboard and multi-tenant API (a separate, later phase).
- Any remote persistence beyond the CI index cache (no shared team index, no
  hosted primary store, no remote run state).
- Multi-language detector support beyond the current scope.
- Implementing the structural/cross-lane lanes inside Warden's own harness;
  only their deterministic tells stay in Warden.
- A Warden-internal deep-security harness; it follows the same lane pattern
  later if pursued.

## Further Notes

- The pivot is deliberately not a rewrite: the deterministic phases and eval
  harness are the assets; the boss loop is the seam.
- Engine-agnosticism is a first-class outcome — MCP keeps Warden usable by other
  MCP clients — which argues for stable, versioned tool schemas.
- Open questions the slice pass must resolve: whether `build_intent` ships in
  this PRD or with a later Lever B slice; the exact host for the mandatory
  post-pass; how prompt materialization drift is checked; and how observability
  is re-homed when model calls leave Warden.
