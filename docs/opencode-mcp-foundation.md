# Warden as MCP tool-provider for OpenCode — foundation

> **Status:** idea-stage foundation. No code. This is the input to a PRD / a
> `to-issues` slice pass — not a ratified plan. Where it disagrees with
> `decisions.md`, `decisions.md` wins, and the disagreement is flagged in §9.
>
> **Origin:** 2026-09 session. Started from "add CI-embedding + remote SQLite to
> Warden"; converged on a larger reframing after the alfred/OpenCode handoff
> (`/private/var/.../handoff-ai-code-review-2026-09-12.md`).

---

## 0. Locked decisions (this session)

1. **Warden = methodology + deterministic tools. OpenCode = execution engine.**
   Warden keeps the review *method* and the deterministic *invariants*; OpenCode
   runs the agentic lanes, owns the model calls, and supplies the PR/CI surface.
2. **The seam is MCP.** Warden ships an MCP server (`warden mcp`); OpenCode
   connects to it as a local stdio server. Chosen over the OpenCode plugin
   `tool` hook for engine-agnosticism (MCP works with any MCP client).
3. **"Remote SQLite" means the CI index cache only.** No shared team index, no
   hosted primary store, no moving run-state remote. The index is the expensive
   artifact CI must not re-embed; everything else stays local.
4. **No rewrite.** Warden's Phase 1 (det priors) and Phase 3 (verify + hard
   rules) survive; only Phase 2 (boss loop + worker dispatch) is supplanted.

---

## 1. Thesis

Warden was built to be an I/O-pure review engine (`review(ReviewInput) →
CommentSet`, ADR-0013) with a deterministic-first spine and an Opus boss
orchestrating cheap/strong workers (ADR-0030). The boss/worker loop is the
least differentiated part of that stack, and it is the part a general agent
runtime (OpenCode) does better: parallel subagents, per-agent models and
permissions, tool-driven investigation, sessions, and a PR surface.

The parts that are actually warden's value are the ones OpenCode cannot supply:
a deterministic detector corpus, external-authority verification (OSV), a
repo index, a citation/evidence discipline with machine-checkable gates, and an
eval harness that measures recall and precision. Those are the *methodology*.

So the move is: **stop owning the loop; own the method and the ground truth.**
Warden becomes a methodology + tool provider; OpenCode becomes the thing that
runs it. This is engine-agnostic (MCP) and preserves the tested code.

---

## 2. What Warden already is (mapped to the split)

| Layer | Today | Under the split |
| --- | --- | --- |
| Phase 1 — det priors (`runDetPriors()`) | 9 deterministic runners + selector, reused by `warden check` | **Stays Warden**, exposed as an MCP tool |
| Phase 2 — boss loop + workers (ADR-0030) | Opus `streamText` + `dispatch_worker` + 6 concerns | **Moves to OpenCode** (agents/lanes) |
| Phase 3 — verify + hard rules | `verifyCitations`, `scopeCommentsToDiff`, `applyHardRules`, `applyConfidenceFloor` | **Stays Warden**, run outside the model's discretion |
| Output contract | `CommentSet` / `Comment` (evidence + sources, sourced/reasoned) | **Stays Warden** (the canonical schema) |
| Repo index | chunk/embed/merkle + semantic selector, `.warden/cache.sqlite` | **Stays Warden**, now shareable to CI |
| Observability (ADR-0048) | OTEL bootstrap in `@warden/ai`; wraps warden's `streamText` sites | **Needs re-homing** — the calls move to OpenCode |
| Eval harness | fixtures + configs + threshold scorer, `*-misses-*` / `*-falsepos-*` | **Stays Warden** — the parity gate for the whole pivot |

The current harness (`packages/core/src/review-harness/`) is where the split
lands. Phase 1 and Phase 3 are already separable; Phase 2 is the seam.

---

## 3. The methodology is now floor / up / down (not just six concerns)

Warden's recent ADRs absorbed the sibling alfred method wholesale:
`docs/reference/structural-review.md` defines **three review motions** —
*surface* (floor verification), *up* (structural search), *down* (invariant
proof) — with the six structural axes, the enforcement ladder, and the
admission gates (`docs/reference/structural-review-profiles.md` carries the
profile registry). ADR-0051 (Lever C, cross-lane corroboration) and ADR-0052
(Lever D, structural pass) build these into warden's own harness.

Two consequences for the foundation:

1. **The top-level lane taxonomy is the three motions, not the six concerns.**
   Alfred's campaign runs `up` / `down` / `sweep` + a judge — the same three.
   The six concerns (correctness / scalability / consistency / security /
   committability / leverage) become *focus areas inside* a motion, not peers
   of it. OpenCode agents should be shaped as motions (with concern prompts
   layered), which also reconciles warden and alfred.
2. **Most of ADR-0051/0052 as *written* is warden-internal harness work that
   this pivot may obsolete.** Lever D's two-pass discovery→confirmation, the
   `<structural-candidates>` splice, the structural worker, the `WARDEN_REVIEW_STRUCTURAL`
   gate — all are "add a lane to warden's boss loop." If OpenCode owns the
   loop, the *lane* moves to OpenCode and only the *deterministic tells*
   (Pass 1: jscpd reuse, `as`/`!` scan, cycle detection) stay in
   `runDetPriors()`. Same for ADR-0049's intent digest: the digest builder
   stays a Warden tool; intent-as-adjudication-context becomes an OpenCode
   agent input.

This should be decided explicitly (see §8, Q1) because it changes whether
ADR-0051/0052 get implemented in warden at all.

---

## 4. The four contracts

### 4.1 Tool contract (MCP)

Server: `warden mcp`, stdio. OpenCode config:

```jsonc
{ "mcp": { "warden": { "type": "local", "command": ["npx", "-y", "warden", "mcp"] } } }
```

Tools register prefixed (`warden_toolname`), are context-injected, and can be
enabled per agent via OpenCode's `tools` globs.

**Model-invoked tools (investigation support):**

| Tool | Backed by | Purpose |
| --- | --- | --- |
| `run_det_priors` | `runDetPriors()` | the review target + deterministic findings + retrieved context + degraded |
| `search_index` | semantic selector | repo-wide semantic retrieval (needs a loaded index) |
| `lookup_type_def` | ADR-0026 resolver | `.d.ts` symbol resolution with a pre-shaped citation |
| `build_intent` | ADR-0049 | PR/ADR/commit intent digest (if Lever B survives the pivot) |

**Mandatory post-pass — NOT tools:**

- evidence/source verification (ADR-0044/0047)
- lane / added-line scoping (`commentInLane`, `scopeCommentsToDiff`)
- priority order, volume cap, confidence→kind (`applyHardRules`, ADR-0044)
- `CommentSet` shaping

Rationale: a model can choose not to call a tool. Deterministic gates must not
be discretionary. The post-pass runs as a driver step after the session
returns (`warden post-pass` / `runPostPass`, ADR-0053 amendment 2026-10-08) —
a plugin hook cannot guarantee interception: v2 has no session-end hook, and
its `tool` `execute.after` hook (the v1 `tool.execute.after` name is stale)
fires for MCP tools but cannot force the model to call a submit tool.

**Open design points:** the det-priors bundle can be large — decide whether the
tool returns paths + summary and the agent reads files (context-safe) or a full
bundle (convenient, risks context blow-up). Tool result schemas are a public
API and should be versioned.

### 4.2 Methodology contract (agents / lanes)

- **Motions:** `up` (structural search), `down` (invariant proof), `surface`
  (floor sweep), `judge` (synthesis + adjudication). One OpenCode agent each
  (plus subagents for fan-out).
- **Prompts:** the method (`docs/reference/structural-review.md` + the worker
  concern prompts) is the single source of truth, versioned in warden, and
  *materialized* into OpenCode agent prompts. Drift between the two is a real
  risk and needs a generation/check step.
- **Models + permissions:** per-agent in OpenCode — read-only workers, distinct
  judge, model tiering (strong for up/down/judge, cheap for surface/sw-driven
  triage). Warden's ADR-0006 tier intent survives; the actual model set becomes
  OpenCode's.
- **Fan-out:** OpenCode `task` subagents (`subagent_depth` default 1). Warden's
  per-tier concurrency cap (ADR-0033) becomes an OpenCode/limit concern.
- **Sequencing:** the method says "fund up first; earn down selectively."
  OpenCode orchestration must reproduce that order, or the synthesis loses the
  method's central discipline.

### 4.3 State + output contract

- **`CommentSet` is canonical**, including the `evidence` / `sources[]` split
  and `sourced` vs `reasoned` (ADR-0044). Every lane returns findings in that
  shape or in a shape trivially mapped to it.
- **Review identity + trace (ADR-0048)** — declare authority: Warden owns the
  canonical `CommentSet` and the persisted review trace (`reviewRuns`);
  OpenCode's session DB is execution telemetry. Same rule the handoff sets for
  alfred's `.campaign/`.
- **Index** — Warden-owned (`.warden/cache.sqlite`); shared to CI via §4.4.
- **Per-finding provenance** must survive the hop: which lane produced it, what
  tool calls backed it, what the post-pass dropped. This is what makes the
  review auditable across an external engine.

### 4.4 Distribution + CI contract

- Warden ships `warden mcp` (tool provider) and `warden index export|import`.
- OpenCode is the runtime in CI (`opencode run --format json`, or `serve` +
  API), configured with the warden MCP server and the lane agents.
- **Cost cap is mandatory, not optional.** Warden computes cost post-hoc today;
  CI needs a hard budget (ADR-0038 intensity profiles + a spend ceiling).
- **Diff/base resolution** in CI (`GITHUB_BASE_REF` / merge-base) feeds
  `run_det_priors` — the ADR-0046 `DiffRange` work is the structured input.
- **Keys** via CI secrets; OpenCode's provider config replaces warden's
  ADR-0017 cascade for the lanes.

---

## 5. CI index cache (`warden index export|import`)

ADR-0016 #3 designed a portable archive (content-addressed rows + manifest with
the locked model + repo Merkle root) and explicitly named "a CI cache artifact."
The implementations already exist (`SqliteIndexExporter` / `SqliteIndexImporter`
in `packages/core/src/indexing/`); only the CLI verb is missing. This use case
is the "concrete consumer" the deferral was waiting for.

Shape: `warden index export` locally → Actions cache/artifact keyed by
`(repo, locked model id@version)` → `warden index import` in CI before the
review. A miss degrades cleanly to cheap signals (the M6 banner/gates). A
libSQL/Turso store behind the already-async store interfaces is the alternative,
but for cache-only an artifact is fewer moving parts and keeps local-first true.

---

## 6. Workstreams (issue candidates)

Each is a vertical, demoable slice. Ordering and dependencies in §7.

| # | Workstream | Notes |
| --- | --- | --- |
| W1 | `warden mcp` skeleton + first tool | stdio server, tool registration, versioned schemas; start with `lookup_type_def` (smallest) |
| W2 | `run_det_priors` MCP tool | serialize the Phase 1 bundle; decide size discipline |
| W3 | `search_index` MCP tool | needs an index loaded; pairs with W7 |
| W4 | Mandatory post-pass integration | verify + scope + hard rules outside the model (plugin `tool.execute.after` or driver) |
| W5 | OpenCode lane config | motions → agents, prompt materialization, per-agent tools/models/permissions |
| W6 | End-to-end tracer bullet | one `down`/correctness lane through W2+W4, scored on an existing fixture |
| W7 | CI index cache | `warden index export/import` verbs + recipe |
| W8 | CI runner | GitHub Action / `opencode run` + cost cap + PR output + cached index |
| W9 | Eval integration | run existing `*-misses-*` / `*-falsepos-*` / clean fixtures through the new path; parity gate |
| W10 | State authority + trace bridge | `reviewRuns` ← OpenCode events; re-home ADR-0048 observability |
| W11 | Structural (`up`) lane, reshaped from ADR-0052 | tell-collector stays in det priors; lane moves to OpenCode |

**Prefactoring to consider first** (make the change easy): extract a
CLI-agnostic review-bundle serializer out of `det-priors.ts`; confirm the
Phase 3 functions (`verifyCitations`, `scopeCommentsToDiff`, `applyHardRules`)
are callable independently of `runReviewHarness` (they appear to be).

---

## 7. Smallest tracer bullet

`warden mcp` exposing `run_det_priors`, one OpenCode `down`/correctness agent
that consumes it, and the mandatory post-pass running after the agent returns.
Score it on `packages/cli/scripts/eval/fixtures/real-prs/alfred-pr235-misses-*`
(recall) and `alfred-pr131-falsepos-*` (precision). Demoable, verifiable, and it
proves every seam in the contract before the lane set is designed.

---

## 8. Open questions / risks

1. **Do ADR-0051/0052 get implemented in warden, or do their lanes move to
   OpenCode?** This is the first thing to settle; it determines how much of the
   current harness survives.
2. **Prompt drift** between warden's method docs and materialized OpenCode
   agent configs — generate or validate?
3. **Det-priors bundle size vs context budget.** Return-shape decision.
4. **Where the mandatory post-pass actually runs.** Verify OpenCode's
   `tool.execute.after` can intercept the terminal submit reliably; otherwise
   the driver runs it.
5. **Observability re-homing** (ADR-0048): warden spans no longer wrap the lane
   calls. Bridge OpenCode events into `reviewRuns`, or move observability.
6. **Cost control.** No warden hard cap today; CI needs one. Whose budget?
7. **Model/permission split.** Which OpenCode agents are read-only; which can
   `bash`; which models per motion.
8. **MCP tool concurrency / process lifetime.** The stdio server holds the
   index; how it reloads on cache import.
9. **Engine-agnosticism claim.** MCP makes warden usable by any MCP client —
   is that a goal (Claude Code etc.), and does it change schema stability?
10. **Cross-engine determinism.** The same diff must produce the same review
    target regardless of runtime; `run_det_priors` is the anchor.

---

## 9. ADR actions

- **New ADR** — "Warden as methodology/tool-provider; OpenCode as execution
  engine" (locks decisions 1–4, the contracts, and the state-authority rule).
- **Amend / reopen** — ADR-0030 (Phase 2 leaves warden), ADR-0005/0017 (lane
  model calls + fallback become OpenCode's), ADR-0048 (observability), ADR-0039
  (the hosted surface may shrink to detector+verifier or stay).
- **Re-scope** — ADR-0051 / ADR-0052 (lanes move vs stay — §8 Q1).
- **De-defer** — ADR-0016 #3 (`warden index export/import`).

---

## 10. Non-goals

- Rewriting `@warden/core`'s deterministic engine or schema.
- Replacing the detector corpus with LLM judgment.
- Hosted dashboard / multi-tenant API (ADR-0039 Phase 4) in this pass.
- Remote SQLite beyond the CI index cache.
- Multi-language detectors (ADR-0008 scope unchanged).

---

## 11. Provenance

- Session decisions 2026-09; alfred/OpenCode handoff 2026-09-12.
- OpenCode MCP support verified in source: `packages/core/src/config/mcp.ts`
  (local/remote + timeouts), `packages/web/src/content/docs/mcp-servers.mdx`
  (config, `servername_toolname`, per-agent gating), `packages/opencode/test/mcp/*`,
  `packages/schema/src/mcp-event.ts`.
- Warden seams verified: `packages/core/src/indexing/interfaces.ts` (async store
  interfaces), `packages/core/src/index.ts` (exports), `SqliteIndexExporter` /
  `SqliteIndexImporter` exist; no CLI verb yet.
