# Warden — Architectural Decisions

A running record of design decisions for Warden — an AI code review CLI that runs deterministic tools, verifies every external claim through a citable source, and uses an LLM only as a triage and formatting layer. Each entry: the choice, the rationale, alternatives considered, and any caveats.

Companion doc: `vision.md` (the long-form thinking framework, preserved from the original design gist; used as a reference point throughout, but not a spec — most of it is deferred past v0).

---

## Snapshot

| Layer                | Choice                                                                                |
| -------------------- | ------------------------------------------------------------------------------------- |
| Audience (v0)        | Single user (me); CLI/UX/docs held to OSS-quality bar                                 |
| Form factor          | CLI core; wrappers (GitHub Action, VS Code, pre-commit) deferred                      |
| Runtime              | Node (latest LTS)                                                                     |
| Package manager      | pnpm + Turborepo                                                                      |
| Distribution         | npm (`npx warden`, `npm install -g warden`)                                           |
| Workspace shape      | `packages/core` + `packages/cli` + `packages/db`; future `apps/{github-action,vscode}` |
| LLM SDK              | Vercel AI SDK                                                                         |
| Provider (v0)        | Anthropic, single-provider; multi-provider deferred                                   |
| Model — strong tier  | `claude-sonnet-4` (boss, grader, correctness, security)                               |
| Model — cheap tier   | `claude-haiku-4` (contract, best-practices)                                           |
| Persistence          | Drizzle on `better-sqlite3` at `.warden/cache.sqlite` (gitignored)                    |
| v0 ecosystem         | TypeScript / JavaScript only                                                          |
| v0 deterministic set | `tsc --noEmit` + `eslint --format json` + `npm audit --json` + OSV verification       |
| v0 LLM role          | Single triage + formatting call; no boss/worker, no two-LLM grading                   |
| Pattern engine       | ESLint (TS-only); Semgrep deferred to multi-ecosystem milestone                       |
| Output formats       | Pretty CLI (default) + `--json`; PR-comment / SARIF deferred                          |
| CLI verbs            | `warden check` (fast, deterministic only) + `warden review` (full); `patrol` parked  |
| Comment ordering     | Correctness → Clarity → Style → Dedup → Tests (ADR-0012); extended with scalability / consistency / deadcode / committability between correctness and clarity (ADR-0020); orthogonal to severity tier |
| Roadmap (post-v0)    | GitHub PR bot → Slack bot → ClickUp integration (ADR-0013); architecture stays bot-ready |
| CLI UX paradigm      | One-shot non-interactive CLI (ADR-0014); no TUI; interactive triage deferred to a future web app |
| Prior-art posture    | DeepSec study (ADR-0015): borrow pipeline shape + plugin slots; reject free-form findings + 2-agent revalidation; prompts-as-files from M4 |
| Index storage seams  | Content-addressed, model-versioned, interface-shaped stores; bulk export/import primitive; queue decoupled from storage (ADR-0016)        |
| LLM provider posture | Anthropic primary; one-retry on transient; Google Gemini fallback (gemini-2.5-pro/flash matched to sonnet/haiku tiers); hard fail if both fail (ADR-0017)        |
| Context selection (M5) | Cheap-signals selector + jscpd dedup runner; embeddings/Merkle/`warden init`/banner deferred to M6 (ADR-0018) |
| Indexing layer (M6)    | Voyage `voyage-code-3` hosted embeddings + `code-chunk` chunker + locked-model index + selector v2 semantic reason; export/import CLI deferred (ADR-0019) |
| Diff-level noise filter (M9) | Diff-loader pre-runner stage prunes via ecosystem detection + per-ecosystem noise profiles (in-package JSON) + depth-limited tree; M7 ships directory-concentration placeholder (ADR-0022). M9 v0 narrows scope: JS-only profile + tree from `parseUnifiedDiff()` + no overlay (M10) + heuristic dropped + `alwaysNoise.{directories,extensions}`-only schema + Tier-1 baseline as language-agnostic floor (ADR-0025) |
| Orchestration spine (M8) | `Runner` contract + in-memory `Scratchpad` + parallel `dispatch()` + `synthesizer` (replaces M4 formatter); committability + scalability migrated; remaining 6 detectors inline until M9; dynamic dispatch + new LLM-shaped sub-agents + specialist *worker* tier deferred (ADR-0023) |
| Public surface (post-release) | `apps/web/` Astro+Starlight site at `wrdn.beauty`; static `CommentSet` showcase + asciinema casts + JS-animated hero; warden-on-warden fixtures; inline renderer; personal-portfolio-grade; dogfood-gated; ADR-0014 interactive triage app stays separately deferred (ADR-0024) |
| M9 noise filter scope (narrows ADR-0022) | JS-only profile + tree from `parseUnifiedDiff()` (no `git diff --raw`) + no overlay surface (M10's milestone) + drop M7 directory-concentration heuristic + schema reduces to `alwaysNoise.{directories,extensions}` (no `contextDependent`, no `files`, no `version`) + Tier-1 baseline graduates to language-agnostic constant in `diff/prune.ts` (ADR-0025) |

---

## Status snapshot (as of 2026-05-10)

Tracks whether each ADR's decisions are reflected in the shipped code, not whether the ADR has been "approved." `Done` = code matches the decision; `Partial` = some sub-points landed, others still open; `Direction` = forward-looking, near-term constraints met but full surface awaits a future milestone; deferred items inside an ADR are listed under that ADR.

| ADR | Status | Note |
|-----|--------|------|
| 0001 | Done | Single-user / OSS-quality posture upheld; no multi-tenant scaffolding. |
| 0002 | Done | CLI shipped; bot/IDE wrappers explicitly deferred per ADR-0013. |
| 0003 | Done | Node + pnpm + Turborepo as scaffolded. |
| 0004 | Done | `packages/{cli,core,ai,db,env,config}` live; `apps/` empty by design. |
| 0005 | Done | All LLM calls flow through Vercel AI SDK in `@warden/ai`. |
| 0006 | Done | Sonnet/Haiku tiered, Anthropic primary. Multi-provider fallback amended by ADR-0017; BYOLLM still deferred. |
| 0007 | Done | Drizzle on better-sqlite3 at `.warden/cache.sqlite`; sync layer YAGNI as stated. |
| 0008 | Done | All four phases (ecosystem detect → TSC/ESLint → npm-audit/OSV → single-LLM formatter) shipped via M1–M4. M2+ deferred list intact. |
| 0009 | Done | ESLint runner shipped; Semgrep deferred. |
| 0010 | Done | Pretty CLI default + `--json`; PR-comment / SARIF deferred. |
| 0011 | Done | `warden check` + `warden review` shipped; `patrol` reserved. |
| 0012 | Done | Priority order encoded in `PRIORITY_ORDER` (extended by ADR-0020); test-culture detection in place. |
| 0013 | Done (architectural constraint) | `@warden/core` is I/O-pure; bot deployments themselves remain explicit M2+ work. |
| 0014 | Done | One-shot non-interactive CLI; no TUI. |
| 0015 | Direction | M4 prompts-as-files constraint shipped (`packages/core/src/llm/prompts/{system,user-template}.md`). Custom-code SAST worker still deferred. |
| 0016 | Done | Storage interfaces (`ChunkStore` / `EmbeddingStore` / `MerkleStore` / `JobRunner` / `IndexExporter` / `IndexImporter`), content-addressing, model-versioning all live. CLI export/import verbs amended to interface-only by ADR-0019 #8. |
| 0017 | Done | `@warden/core/src/llm/cascade.ts` shipped; Anthropic→retry→Google fallback wired with `degradedWorkers` notice. |
| 0018 | Done | M5 cheap-signals selector + jscpd dedup runner shipped; `import_graph` + `file_state` tables in place. |
| 0019 | Done | Voyage `voyage-code-3` + `code-chunk` + locked-model + banner gradient + Phase 1–3 `warden init` shipped. M7+ deferrals listed in CLAUDE.md still pending. |
| 0020 | Done | Four new categories (`scalability`, `consistency`, `deadcode`, `committability`) added to `CategoryEnum` and `PRIORITY_ORDER`; system prompt slot for question lane in place. |
| 0021 | Partial | See per-point breakdown at the end of the ADR. Engine blockers + most polish landed; committability sub-agent shipped as part of M8 close-out (ADR-0023) — Tier-1 hard-skip + ADR-0022 directory-concentration heuristic + per-finding substring-verified citations live. Consistency detector + global question-citation verifier post-pass still open. ADR-0021 #2's Tier-2 file-count gate is superseded by ADR-0022's directory-concentration heuristic. |
| 0022 | Direction | M7 directory-concentration placeholder shipped (alongside committability sub-agent in M8); full diff-level noise filter at the diff loader scheduled for M9. ADR-0025 narrows the v0 scope (JS-only profile, no overlay, no fallback heuristic). |
| 0023 | Done | Orchestration spine shipped in M8: `Runner` contract + in-memory `Scratchpad` + parallel `dispatch()` + `synthesize()` (review) / `deterministicSynthesize()` (check) live in `packages/core/src/orchestration/`. Migration scope: `scalabilityRunner` + `committabilityRunner` through the contract. Remaining 6 runners (TSC, ESLint, jscpd, vuln, deadcode, consistency) stay inline and record into the scratchpad directly — M9 likely closes when the noise filter touches the same surface. Synthesizer prompt byte-identical to M4. Smoke: `packages/cli/scripts/smoke-m8-spine.mts`. |
| 0024 | Direction | Design locked through grilling pass (Q1 → Q9). Implementation gated on dogfood-loop signal post-M9-or-equivalent + manual `wrdn.beauty` purchase at deploy time. ADR-0014's deferred interactive triage app stays distinct (caveat added at ADR-0014). No code at ADR commit time. |
| 0025 | Direction | M9 grilling pass complete. Narrows ADR-0022 v0 scope along six axes (JS-only profile, tree from `parseUnifiedDiff()`, no overlay, no heuristic, schema = `alwaysNoise.{directories,extensions}`, Tier-1 baseline in `diff/prune.ts`). Overlay loader → M10's own ADR; multi-ecosystem detector + Python/Rust/etc. profiles → M11+. Implementation tracked in rewritten `m9-plan.md`. |

Deferred items called out within ADRs (not yet scheduled): ADR-0008 backlog (sibling-repo scanning, multi-ecosystem, persistent feedback loop, license scanning, IDE/Action wrappers); ADR-0019 M10+ list (BYOEmbedder, cross-repo / `node_modules` / `.d.ts` retrieval, custom-code SAST worker, `warden index export/import` CLI verbs, real async/daemon `JobRunner`, cloud-hosted index, mid-stream key-change handling, retrieval refinements); ADR-0023 deferrals (dynamic dispatch, three execution modes, new LLM-shaped sub-agents — adversarial critic / self-aware checker / free-form prose consistency, tool-call seams, SQLite-backed scratchpad, vision-tier specialist Sonnet workers, re-platforming of the remaining 6 detectors through the contract).

---

## ADR-0001 — Audience: single user for v0, OSS-quality bar

**Decision.** Warden is built for one user (me) running it on personal Turborepo projects (Alfred, milkpod, blair, etc.). v0 ships no team features, no shared backend, no hosted services. The CLI's UX, citation discipline, output formatting, and docs are held to the standard expected of an OSS release — so the project can be open-sourced or productized later without a rewrite.

**Why.** Solo dogfooding makes the feedback loop fast and lets v0 ship without paying any multi-tenant tax (auth, tenancy, billing, hosted storage). But "personal tool" doesn't justify rough edges: the value of an AI reviewer is entirely a function of trust, and trust is built by polish — real citations, no hallucinated CVEs, terse output, sensible defaults. A v0 that's sloppy because "only I'll see it" produces a tool I won't actually use. Mirrors Alfred ADR-0001's "single user, built right" stance.

**Alternatives.** Multi-tenant SaaS day one (rejected — no users, all overhead, distracts from the review-quality work that's the actual moat). Throwaway script (rejected — kills the dogfooding-becomes-product trajectory; also fails the "I want to flex this" criterion).

---

## ADR-0002 — Form factor: CLI core; wrappers deferred

**Decision.** v0 is a single CLI binary distributed via npm. GitHub Action, VS Code extension, pre-commit hook, and Gerrit hook are explicit non-goals for v0. They live as future apps in the same monorepo and consume the CLI's exported review pipeline.

**Why.** The form-factor decision is `vision.md`'s biggest fork. The CLI is the only form that supports every other distribution path — every wrapper *calls* the CLI core. Building any wrapper before the core review logic stabilizes means refactoring twice. The vision puts it plainly: *the CLI is the product; the wrappers are distribution.* Wrappers also defer cleanly because the only state shared between them is the cache file + the JSON output schema, both of which v0 nails down (see ADR-0007, ADR-0010).

**Alternatives.** GitHub App / bot (rejected — needs hosted infra, OAuth, billing; outside v0 scope). VS Code extension first (rejected — IDE-only loop misses CI/PR enforcement, which `vision.md` §16 cites as the empirical adoption point per UReview). Pre-commit only (rejected — slow LLM hooks annoy developers; also doesn't fit the v0 audience well — I want PR-time review, not commit-time gating).

---

## ADR-0003 — Runtime + package manager: Node + pnpm + Turborepo

**Decision.** Node (latest LTS) + pnpm workspaces + Turborepo for task orchestration. Distributed via npm; install path is `npm install -g warden` or `npx warden`.

**Why.** TS-first matches every other personal project. Node + pnpm is the boring, well-trodden distribution path for npm CLIs — `npx warden` is the install story most TS developers expect, no platform-binary-matrix to maintain. Turborepo is overkill for a single CLI but pays off the moment wrappers (`apps/github-action`, `apps/vscode`) land in the same repo, since each wrapper has its own build pipeline and depends on `packages/core`. Mirrors Alfred ADR-0002.

**Alternatives.** Bun + `bun build --compile` for single-binary distribution (rejected — would be the more "flex" answer, but trades npm-install friction for a multi-platform release matrix, and most TS dev workflows don't reach for a static binary; the cost outweighs the cool factor at v0). pnpm + Bun runtime hybrid (rejected — same rough edges Alfred cited). Single-package repo (rejected per ADR-0004).

**Caveat.** If wrappers are still 6+ months away when v0 ships, the workspace structure is wasted complexity. Acceptable cost; the alternative — refactoring out of single-package once wrappers land — is worse.

---

## ADR-0004 — Repo shape: pnpm workspaces from day one

**Decision.** Workspace layout:

```
warden/
├── packages/
│   ├── core/          # Review pipeline: ecosystem detection, tool runners,
│   │                  # OSV verification, LLM formatter, comment schema
│   ├── cli/           # CLI entry (commander or yargs), output rendering,
│   │                  # human-readable formatters
│   └── db/            # Drizzle schema + migrations for cache.sqlite
├── apps/              # (future)
│   ├── github-action/ # (deferred — calls @warden/core)
│   └── vscode/        # (deferred)
└── docs/              # README, decisions.md, vision.md, scaffolding-plan.md
```

`@warden/core` exposes a `review({ diff, repoRoot, config })` function that returns the JSON comment schema. `@warden/cli` is a thin wrapper that parses argv, calls `review()`, formats output. The future `apps/github-action` is the same wrapper plus a "post comments to GitHub" step.

**Why.** Splitting `core` from `cli` means future wrappers are postMessage adapters around an exported function, not CLI-output scrapers. Alfred uses the same shape (`packages/api` is the logic, `apps/server` is the bootstrap). `packages/db` lives separately because Drizzle wants its own `package.json` with `db:generate` / `db:migrate` scripts.

**Alternatives.** Single package (rejected — wrappers are coming, refactoring out is expensive). `packages/cli` as the only package with the action/extension reaching into it (rejected — entangles CLI argv parsing with review logic, making a non-CLI consumer awkward).

**Caveat.** Follow Alfred's TS-source export convention (`"default": "./src/index.ts"` in package.json `exports`) so `pnpm check-types` works on a fresh tree without a prior build. Production builds run via Turborepo.

---

## ADR-0005 — LLM SDK: Vercel AI SDK

**Decision.** All LLM calls go through Vercel AI SDK. Provider config + model dispatcher centralized in `packages/core/src/ai/` — same shape as Alfred's `@alfred/ai` (`provider.ts`, `models.ts`, `stream.ts`).

**Why.** The review pipeline needs every primitive AI SDK provides: tool calling (deterministic checks → LLM bridge), streaming (live CLI output), provider abstraction (so the future multi-provider mode doesn't need a rewrite). Symmetry with Alfred reduces cognitive overhead — one mental model for two projects, same upgrade path on AI SDK v6 conventions.

**Alternatives.** Direct Anthropic SDK (rejected — locks v0 into single-provider-as-architecture, but multi-provider is a stated future goal in `vision.md` §2). LangGraph TS / LangChain (rejected — port of a Python project, lags upstream, far heavier than the review use case warrants; same reasoning Alfred applied in ADR-0006).

---

## ADR-0006 — Default model: Sonnet + Haiku tiered, single provider

**Decision.** Sonnet-class for boss / grader / correctness / security workers; Haiku-class for contract / best-practices workers. Hardcoded for v0 to Anthropic via `ANTHROPIC_API_KEY`. Multi-provider auto-selection (the gist's `REVIEWBOT_API_KEY` + per-provider strong/cheap mapping) is deferred to a future "BYOLLM" milestone.

**Why.** The gist's worker-tiering analysis stands: Sonnet for subtle bugs (race conditions, type narrowing, auth bypass), Haiku for pattern-matching tasks (does this match the integration map?). Hardcoding the provider for v0 keeps the surface tiny — one API key, one billing flow, one set of failure modes to debug. Multi-provider mapping is operational tax that pays off at platform scale, not at "one user, one repo." `vision.md` §2 itself flags this trade-off.

**Alternatives.** Multi-provider with `WARDEN_API_KEY` + auto-detect (rejected for v0 — cost-of-implementation > benefit when there's one user). User-configurable model per role via YAML (deferred — power-user override, not v0). Single Haiku model for everything (rejected — UReview's empirical finding is that downgrading correctness/security models materially degrades catch rate; that's the one place we can't be cheap).

---

## ADR-0007 — Persistence: Drizzle on better-sqlite3, local file

**Decision.** Cache lives at `.warden/cache.sqlite` (gitignored), backed by `better-sqlite3`, schema managed by Drizzle. `packages/db` mirrors Alfred's structure (`drizzle.config.ts`, `db:generate` / `db:migrate` / `db:studio` scripts, schema files in `src/schema/`). Initial tables: `codebase_snapshot`, `dependency_state`, `review_comments`, `feedback`, `external_knowledge` (the four caches from `vision.md` §9, with feedback as a separate table).

**Why.** Drizzle gives type-safe queries, migration tooling, and shared muscle memory with Alfred. Even if v0 only has 5 tables, the lifetime of the schema is years and the cost of being wrong about persistence later (raw SQL → typed ORM migration) is high. better-sqlite3 is the canonical Node SQLite driver — synchronous (no Promise overhead in a CLI), fast, single file. SQLite is the standard pick for local CLI caches: no daemon, no setup, ships with the binary.

**Alternatives.** Raw SQL + prepared statements (rejected — fine for 6 tables but loses type-safety and the migration story; "save 50 lines now, pay later" is a bad trade for a project that wants to be polished). No persistence, re-scan every run (rejected — the gist's auto-derived integration map is incremental by design; rescanning a 1M-LOC sibling on every PR is the explicit anti-pattern called out in §3). LibSQL / Turso (rejected — remote-first, adds network dependency, v0 is local-only).

**Caveat.** This decision **does not** commit to a sync layer. If Warden ever grows team-shared feedback (the natural place sync becomes interesting — pool every developer's "Useful / Not Useful" verdicts so the agent learns from the team, not one user), the architecture is local SQLite + remote Postgres, not Replicache. Replicache solves "same user, multi-device, real-time," which is the wrong shape for "many users, one shared learning corpus." Drizzle covers both stores, so the decision today doesn't constrain that future. **Sync is YAGNI for v0** — no server, no auth, no tenancy.

---

## ADR-0008 — v0 scope: ecosystem detect + TSC/ESLint + npm-audit/OSV + LLM formatter

**Decision.** M1 implements only the deterministic spine of `vision.md`'s pipeline plus a single LLM formatting call. Concretely:

1. **Phase 0 — Ecosystem detection.** TS/JS only. Detect `package.json`, `tsconfig.json`, monorepo shape (`pnpm-workspace.yaml`, `turbo.json`). No Python / Go / Rust / Clojure detection.
2. **Phase 1 — Static analysis.** Run `tsc --noEmit` and `eslint --format json` on the diff scope. Consume structured output as pre-verified facts.
3. **Phase 2 — Dependency / vulnerability.** Run `npm audit --json` on the lockfile diff. For every CVE, verify against [OSV.dev](https://osv.dev) before posting (the gist's hard requirement). Drop any unverified claim.
4. **LLM formatter.** Single Sonnet call: receives the diff + tool findings + verified CVEs, produces the comment list in the JSON schema (ADR-0010). No boss/worker, no separate grader, no two-LLM pipeline.

Output to stdout (pretty + JSON, see ADR-0010). Cache populated for next run (codebase snapshot, dep state, CVE lookups with TTL).

**Why.** This is the smallest cut that delivers the gist's headline value — *tool-verified findings, no hallucinated CVEs, citation-first output* — on the actual stack I run. It produces something I'll use daily. Every additional phase from `vision.md` is non-trivial implementation work and pulling them all into M1 means shipping nothing for months. The risk profile is "v0 lands in weeks, dogfood reveals what M2 should be." The alternative is the canonical scope-creep death spiral.

**Alternatives.** Full pipeline day one (rejected — 17 phases, solo developer, ships nothing in 6 months). LLM-only review (rejected — defeats the citation/no-hallucination thesis; also exactly what `vision.md` calls out as the dominant failure mode). Deterministic-only, no LLM (rejected — loses the LLM's single most useful job: triaging 200 ESLint findings into the 3 that matter for *this* PR).

**Deferred (explicit non-goals for v0; revisit individually):**

- Boss/worker orchestration (ADR-0008 implements one LLM call; orchestration is M2+)
- Two-LLM generator + grader pipeline
- Sibling-repo scanning (`--sibling-repo`)
- Auto-discovered integration map
- Multi-ecosystem support (Python, Go, Rust, Clojure, Java)
- Semgrep-style cross-cutting pattern engine (see ADR-0009)
- Persistent feedback loop / category auto-suppression
- Staleness self-healing
- Confidence scoring + threshold tuning
- License scanning
- IDE / GitHub Action / pre-commit wrappers (see ADR-0002)

The deferred list is the M2+ backlog. Each item gets its own ADR when scheduled.

---

## ADR-0009 — Pattern engine: ESLint, not Semgrep, for v0

**Decision.** Deterministic pattern matching for v0 is delegated to ESLint plugins. If a Warden-specific cross-cutting pattern needs to be encoded (the `vision.md` §3 "deterministic pattern registry" idea), it ships as an ESLint rule in a future `eslint-plugin-warden` package. No Semgrep dependency, no homegrown pattern DSL.

**Why.** Within TS, ESLint is *already* the de facto pattern engine — every TS repo has it configured, the rule-authoring story is mature, the AST it operates on is the same one TSC uses. Reaching for Semgrep is the right move when expanding to Python/Go/Rust later (Semgrep covers all of them with one pattern syntax) but at v0's TS-only scope it's a polyglot dependency with no payoff. The gist's `patterns.yaml` example sketches a custom regex engine — that direction reinvents ESLint for a worse outcome.

**Alternatives.** Semgrep wrapper (deferred to the multi-ecosystem milestone — that's where it wins). Custom regex pattern registry per gist §3 (rejected — duplicates ESLint with less precision). LLM-only pattern matching (rejected — false positives, no determinism, defeats the "deterministic registry produces zero false positives" property the gist explicitly counts on).

**Caveat.** ESLint is great at *file-local* patterns. If Warden hits a real cross-cutting pattern that ESLint can't express — "this regex in any file under `**/baserow/**` plus this lockfile entry" — that's the moment to bring in Semgrep. Don't write custom infrastructure to bridge the gap; jump straight to Semgrep.

---

## ADR-0010 — Output: pretty CLI + JSON; PR-comment / SARIF deferred

**Decision.** v0 ships two output formats:

- **Pretty CLI (default).** Colored severity, `file:line` links, inline citations, terse formatting. Optimized for "I run this in my terminal, I read the output, I act on it." Quiet by default — no preamble, no staleness chatter unless something is genuinely degraded (per `vision.md` §11).
- **`--json`.** Full comment schema from `vision.md` §14: `{ id, file, line_start, line_end, tier, category, claim, explanation, suggested_action, sources[], confidence, ... }`. This is the contract every future wrapper consumes.

GitHub PR-comment format, SARIF, and MCP-server output are non-goals for v0. The JSON schema is designed so the future Action wrapper is a serializer (`comment → GH review comment payload`), not a refactor.

**Why.** Pretty CLI is what makes the tool a daily-driver. JSON from day one lets every wrapper be additive — no breaking changes when the GitHub Action ships in M2+. Skipping PR-comment / SARIF in v0 keeps the work unblocked by "what does GitHub render? what does the SARIF spec require?" — both real research-and-validate tasks worth doing carefully when they matter, not as side-quests.

**Alternatives.** Pretty only (rejected — JSON is needed for any wrapper, and waiting until wrapper time means the schema gets designed under pressure). SARIF as the canonical machine format (deferred — useful for CI tooling and would slot in cleanly via a `--format sarif` later, but adds spec-compliance overhead with no v0 consumer). MCP server output (deferred to the milestone where Warden becomes an MCP server).

---

## ADR-0011 — CLI verbs: `warden check` and `warden review` for v0

**Decision.** v0 exposes two top-level commands:

- **`warden check`** — fast, deterministic-only pass. Runs Phase 0–2 (TSC + ESLint + npm-audit + OSV verification), no LLM call. Suitable for pre-commit / CI gating where speed matters and a fixed-format output is sufficient. Sub-second on small diffs after warm cache.
- **`warden review`** — full pipeline. Same deterministic checks, then the LLM formatter (ADR-0008). Suitable for PR-time deep review. Streamed output; longer latency (seconds, not sub-second).

`warden patrol` is **reserved but not implemented** in v0. It will eventually mean watch-mode (`warden patrol --on-save` for IDE-style background scanning).

**Why.** Verbs are how CLI users navigate; one verb per mode is more discoverable than `warden run --mode=fast`. The pair *check / review* maps cleanly to *fast/local* vs *deep/PR-time* — the same split that justifies why pre-commit hooks and GitHub Apps coexist as distinct adoption points. Holding `patrol` in reserve means the third verb has a real meaning when it ships, not a cargo-cult one. The verb test (short, spellable, strong) is the same test the project name passed.

**Alternatives.** Single verb `warden run` with `--mode` flags (rejected — discoverability is worse, and CLI tools that age well tend to grow into verb-rich UIs, not flag-rich ones — see `git`, `gh`, `kubectl`). All three verbs in v0 with `patrol` as an alias for `check --watch` (rejected — unimplemented commands erode trust; reserve and ship later).

---

## ADR-0012 — Review priority order: correctness → clarity → style → dedup → tests

**Decision.** Warden surfaces findings according to a fixed review-priority hierarchy:

1. **Correctness** — does the code do what it's supposed to do?
2. **Clarity** — will someone else (or future-self) understand what's happening and why?
3. **Style / conventions** — does this match the codebase's existing patterns?
4. **Deduplication** — is this solving a problem already solved elsewhere?
5. **Tests** — do the tests cover the meaningful cases? (Not "are there tests" — meaningful coverage.)

This priority is encoded at three layers of the product:

- **Comment ordering** in CLI and JSON output. Correctness findings appear first regardless of confidence score; style and dedup findings appear last. Within each priority bucket, severity tier (1/2/3) is the secondary sort; confidence is the tertiary sort.
- **LLM formatter system prompt** (ADR-0008's single Sonnet call). The formatter is instructed to evaluate the diff in this order and to suppress lower-priority findings when a higher-priority finding would change the answer — e.g., don't comment on test gaps if correctness is broken; the broken code might disappear in the fix.
- **Category → tier mapping** in the comment schema (`vision.md` §14). `correctness` and `security` always Tier 1; `clarity` defaults to Tier 2; `style` and `dedup` default to Tier 3 (suppressed by default per `vision.md` §15); `tests` is Tier 2 only when *meaningful* coverage is missing, Tier 3 otherwise.

**Why.** A staff-engineer philosophy crystallized this: most reviewers spot style nits or missing tests before asking whether the code is correct, which makes review reactive and shallow. Inverting the order keeps the review honest. The gist's existing tier system (must-fix / should-fix / informational) is about *severity*; this ADR is about *reading order*, which is a distinct axis. A correctness bug and a CVE finding may both be Tier 1, but the bug should be read first — fixing it might invalidate the rest of the review.

This also closes two of `vision.md` §17's anti-patterns: *"the drive-by refactor suggestion"* (priority 4 stuff appearing before priority 1 stuff) and *"developers hate style nits from AI"* (priority 3 stuff drowning priority 1 stuff). Without an enforced order, both failure modes re-emerge by default.

**Alternatives.** Confidence-only ordering (rejected — high-confidence style nits would preempt low-confidence correctness signals, which is exactly the failure mode this rule prevents). Tier-only ordering, no priority axis (rejected — Tier 1 currently mixes correctness bugs and CVE findings; the priority axis disambiguates). User-configurable ordering via flag (rejected for v0 — defaults need to embody opinion, not punt to config; revisit if a real use case emerges).

**Caveat — priority vs severity.** "Tests" being last doesn't mean tests don't matter — it means a missing-test comment shouldn't preempt a correctness comment. Test-coverage findings are still posted (when meaningful gaps exist on a codebase that has tests) and still block at Tier 2. The priority order governs *display order and suppression-on-conflict*, not severity.

**Caveat — test-culture detection.** Before the tests category activates at all, Warden auto-detects whether the repo has a test culture. Signals:

- presence of `*.test.ts` / `*.spec.ts` / `*.test.tsx` files, or `__tests__/` directories
- a test runner in `devDependencies` (`vitest`, `jest`, `ava`, `mocha`, `bun:test`, etc.)
- a `test` script in `package.json` that does meaningful work (not just `echo`, `exit 0`, or `:`)
- smoke / integration scripts under `scripts/smoke-*.ts` or similar patterns

If **none** of these are present, the tests category is suppressed entirely — Warden never flags "you should add tests" on a codebase that has chosen not to have a test culture. Many TS codebases (including most of my personal projects) fall in this bucket; nagging them on every review is exactly the noise-flood anti-pattern from `vision.md` §17. The rule is *detect, don't presume*: a future PR that *adds* a test runner to such a repo flips the detection on, and from that point forward Warden does evaluate test meaningfulness.

This caveat is what prevents priority #5 from becoming a recurring nag in repos where the choice was deliberate.

---

## ADR-0013 — Future deployment targets: GitHub PR bot, Slack bot, ClickUp integration

**Decision.** Warden's long-term shape includes three bot deployments beyond the CLI: a **GitHub PR bot** (review on PR open, post inline comments), a **Slack bot** (slash commands like `/warden review owner/repo#PR-123` plus event subscriptions), and a **ClickUp integration** (exact shape TBD — likely either auto-creating tickets from review findings or running reviews against tasks tracked in ClickUp). All three are explicitly **deferred from v0** but architectural decisions in v0 must not preclude them.

**Architectural constraint (load-bearing for v0).** `@warden/core` (per ADR-0004) exposes `review({ diff, repoRoot, config }) → CommentSet` as a pure library function. It must remain decoupled from:

- argv parsing — that's `@warden/cli`'s job
- stdout / terminal rendering — also `@warden/cli`'s job
- filesystem assumptions beyond the supplied `repoRoot`
- any persistent connection (HTTP server, queue, daemon)
- any caller-specific platform (GitHub API, Slack API, ClickUp API)

Any future bot is therefore: *receive trigger → construct a `Config` → call `core.review()` → serialize the `CommentSet` → post via the platform's API.* The bot wrapper handles transport, auth, install tokens, and platform-specific rendering. This mirrors the same pattern Alfred uses for `@alfred/api` (logic) vs `apps/server` (bootstrap + transport).

**Why deferred from v0.** Scaffolding the bot infrastructure (Elysia server, BullMQ + Redis for review jobs, Postgres for install tokens and review history) before the CLI is dogfooded would be premature commitment to a product direction whose value depends on the CLI's review quality being trustworthy — a property only proved by daily personal use over weeks. `vision.md` §17 calls out the same anti-pattern shape: building infrastructure before the value claim is validated.

**Why not "build everything now to save refactor cost."** The refactor cost is genuinely small *if* `core` stays decoupled (the architectural constraint above). Adding `apps/github-bot` later is "new app folder + new ADR for hosted infra + new docker-compose entry" — additive, not a rewrite. The cost of premature scaffolding is real: unused services run on every dev session, package boundaries ossify before they're tested against real consumers, and the doc burden grows for code that has no users.

**Rough order (sequencing intent, not committed milestones).**

1. **CLI v0** — local dogfooding loop established (this scaffolding).
2. **CLI v1** — multi-ecosystem support, two-LLM grading, integration map; driven by what dogfooding reveals.
3. **GitHub PR bot** — first bot; validates the `apps/<bot>` pattern. Adds Postgres + Redis + Elysia. Triggers a new ADR for hosted infra (likely Railway, mirroring Alfred ADR-0008).
4. **Slack bot** — slash commands and event subscriptions. Reuses the GitHub bot's Postgres/Redis stack. Auth via Slack OAuth.
5. **ClickUp integration** — concrete use case clarified before scoping; possibly a *consumer* of review output (auto-create tickets) rather than a *trigger* for review.

**Alternatives.** Scaffold all bot infrastructure in v0 (rejected — see "Why deferred"). Build only the CLI and never plan for bots (rejected — leaves architecture decisions accidental rather than intentional; the constraint above only works if it's stated). Build a hosted bot first, skip the CLI (rejected — `vision.md` §2 explicitly recommends CLI-as-product, wrappers-as-distribution; also makes dogfooding harder since CI feedback loops are slow).

**Caveat.** The architectural constraint above (`core` stays I/O-pure) is the single most important property for v0 scaffolding to preserve. Any reviewer or future-self looking at v0 PRs should ask: "does this leak CLI-specific or stdout-specific assumptions into `core`?" If yes, push it back to `cli`. The bot future depends on this discipline staying intact through M1.

---

## ADR-0014 — CLI UX paradigm: one-shot non-interactive; interactive triage deferred to web

**Decision.** Warden is a **one-shot, non-interactive CLI**. `warden check` and `warden review` are commands that run, produce output, and exit — like `eslint`, `tsc`, `npm audit`, or `gh`. Not a TUI: no Ink-based full-screen alt buffer, no keyboard navigation, no REPL, no interactive prompt loop. Output is streamed (LLM formatter renders token-by-token in `review` mode), color-coded by severity, and uses OSC 8 hyperlinks for clickable `file:line` references where the terminal supports them — but the process exits when output completes.

Interactive review triage (walk through findings one at a time, mark Useful / Not Useful, expand details, defer to follow-up, persist feedback across sessions) is a real UX want — but it lives in a future **web app**, not in the CLI.

**Why.**

1. **Composability with bots and CI.** Every wrapper from ADR-0013 — GitHub PR bot, Slack bot, future CI step — assumes a one-shot exec model: trigger fires, CLI/core runs, output is captured, process exits. A TUI in the middle is a layer the bot has to bypass; TTY-aware code in `core` would also break in CI environments where stdin/stdout are piped.
2. **Right tool for the interaction shape.** Interactive review triage benefits from rich UI affordances — clickable diff regions, side-by-side file views, persistent feedback across sessions, shareable URLs, multi-user state. A web app delivers all of these naturally; a TUI delivers a degraded subset at substantially higher engineering cost (Ink + custom layout + keyboard handlers + state machine for navigation). This is the same reason GitHub's review UI lives in the browser, not in `gh`.
3. **Scope discipline.** Building a TUI adds 300–500 LOC of UI infrastructure to maintain in v0, for value the dogfooding loop hasn't yet proved is missing. If, after 4–6 weeks of personal use, interactive triage is genuinely the gap — the answer is "build the web app," not "retrofit a TUI." A web app also positions the project for the team-sync future (ADR-0007 caveat) far more naturally.

"Non-interactive" doesn't mean "ugly." The CLI's polish bar is high: streamed output, severity-colored findings, OSC 8 hyperlinks, spinners during long operations (deterministic checks, OSV lookups, LLM streaming), terse defaults with `--verbose` for detail. Modern CLI affordances, traditional CLI shape.

**Alternatives.** Ink-based TUI (rejected — see above; also reading like Claude Code is the wrong reference frame: Claude Code is an *agentic conversation*, Warden is a *one-shot review tool*). REPL mode `warden> review` then drill into findings (rejected — interaction shape is wrong; review is "look at output, act on it," not "converse with the tool"). Hybrid `warden review` plain + `warden review -i` interactive (deferred — re-evaluate against dogfooding evidence; web-first will likely win).

**Caveat.** A future `warden patrol --watch` mode (parked per ADR-0011) would be long-running and could benefit from a TUI-style status display. That's a separate decision when patrol gets implemented; nothing in v0 forecloses it. The constraint that survives is `core` stays I/O-pure (ADR-0013) — even patrol's eventual UI lives outside `core`.

**Caveat — distinct from ADR-0024's `apps/web/` docs+marketing surface.** ADR-0024 ships a static read-only public surface (docs + marketing + `CommentSet` showcase) at `apps/web/` and `wrdn.beauty`. ADR-0014's deferred *interactive review triage* web app is a sibling future surface — different audience (single user during review vs. ad-hoc visitors after review), different shape (interactive feedback loop vs. static render), different infra needs (per-user state vs. CDN-cached HTML). When ADR-0014 de-defers, it earns its own ADR with its own grilling pass and its own codebase — likely `apps/triage/` or similar, not `apps/web/`. The two surfaces have orthogonal ADRs and orthogonal codebases when both ship.

---

## ADR-0015 — DeepSec as prior art: borrow the pipeline, reject the grounding model

**Decision.** Vercel Labs released [DeepSec](https://vercel.com/blog/introducing-deepsec-find-and-fix-vulnerabilities-in-your-code-base) in May 2026 — open-source, CLI-based, LLM-agent-driven SAST for custom-code vulnerabilities. It is the closest shipped prior art for the agent-driven vuln-discovery worker `vision.md` §3 sketches and ADR-0008 defers. After reading the source (`~/Developer/oss/deepsec`), Warden commits to the following position:

- **Borrow** the pipeline shape and ergonomic patterns when the M5+ custom-code vuln worker is scoped: three-verb pipeline (`scan` → `process` → `revalidate`), directory-batched file processing, plugin-slot architecture (DeepSec exposes seven slots — `matchers`, `notifiers`, `ownership`, `people`, `executor`, `agents`, `commands`), append-only analysis history with re-investigation markers.
- **Reject** DeepSec's grounding model. Specifically: free-form `description` / `recommendation` fields on findings (escape hatches for ungrounded claims), embedded multi-thousand-line system prompts as TypeScript string literals (`packages/processor/src/index.ts:37-149` in DeepSec — clear ergonomic debt), and second-agent revalidation as the false-positive control.
- **Diverge** on the `Finding` shape and the validation pass. Warden's findings carry structured `evidence: { tool, source, range }[]` so every claim has a citable origin. Warden's revalidation re-verifies *the source* (re-fetch the OSV record, re-run the static tool, re-query the `.d.ts`), not *the LLM's judgment of the source*.

**Why.** DeepSec's two-agent design (investigation + revalidation) treats the LLM as oracle *and* judge. Stacking two LLM judgments leaves a residual 10–20% false-positive rate, which DeepSec acknowledges. ADR-0008's citation thesis is the exact counter-bet: deterministic tooling and external sources are oracle, the LLM is judge and formatter only. That design difference ripples through the data model — DeepSec's `Finding` (`packages/core/src/types.ts:117-127`) stores `{ severity, vulnSlug, title, description, lineNumbers, recommendation, confidence }` with `description` and `recommendation` as free-form prose; Warden's must store the citation explicitly because the citation is what makes the claim postable. The pipeline patterns (three verbs, batching, plugin slots) are orthogonal to that bet — they are general orchestration shapes, transferable without conflict.

**Near-term constraint (M4 — load-bearing).** Even though M4 is a single LLM call (no agent loop, no boss/worker), prompts live in dedicated files from day one — e.g. `packages/core/src/llm/prompts/formatter.md` or a sibling `.ts` that exports a single template-literal string. The cost of this rule is one directory; the cost of *not* having it is the DeepSec failure mode (1200-line system prompt embedded in business logic, unreviewable, untestable). Codify this when M4 lands; it is cheap to honor and expensive to retrofit.

**Alternatives.** Ignore DeepSec entirely (rejected — open-source prior art with shared model assumptions is too useful to skip; the divergence points are clearer once the borrowed shapes are explicit). Adopt DeepSec wholesale and bolt OSV verification on top (rejected — the second-agent revalidation pattern fundamentally conflicts with verify-or-drop; bolting OSV onto a free-form `description` field doesn't fix the unverified-prose problem, it just adds a sidecar). Wait until M5 to record any of this (rejected — the M4 prompts-as-files constraint is *now*-actionable; the M5+ shape decisions are easier to honor when written down before the milestone starts than re-derived under deadline).

**Caveat.** This ADR commits to a *direction* for M5+, not a *milestone schedule*. The custom-code vuln worker may never get prioritized over multi-ecosystem expansion or the GitHub PR bot (ADR-0013); dogfooding evidence will decide. What this ADR fixes is: *if* and *when* it ships, the design rules above are pre-decided so the milestone work is implementation, not architecture.

---

## ADR-0016 — Index storage discipline: content-addressed, model-versioned, portable from day one

**Decision.** When the indexing layer lands (M5+ — chunk store, embedding store, Merkle tree, async job queue, sketched in `vision.md` §9 and elaborated in the indexing-design discussion logged 2026-05-05), it ships with four non-negotiable properties. These are pre-decided now so the milestone work is implementation, not architecture — same posture as ADR-0015's M4 prompts-as-files rule.

1. **Storage is interface-shaped, not SQLite-shaped.** `ChunkStore`, `EmbeddingStore`, `MerkleStore`, and `JobRunner` are interfaces (location TBD when M5+ scopes — likely `@warden/core` or a new `@warden/index` package). The default implementation is SQLite-backed via `@warden/db`. Hosted implementations (Postgres, Pinecone, S3 + Faiss, etc.) are deployment swaps. No business logic touches `db.exec()` or Drizzle queries directly for index data — only through the interface.
2. **Every embedding row carries `model_id` + `model_version`.** Row shape: `(chunk_hash, model_id, model_version, vector_bytes, created_at)`. Lets a hosted backend tell whether a local row is reusable (same model) or must be re-embedded (different model), and prevents silent corruption when the embedding model is upgraded.
3. **Bulk export/import is a first-class operation from day one.** `warden index export <path>` writes a portable archive (content-addressed rows + manifest with model metadata + repo Merkle root); `warden index import <path>` reads it. The discipline of building it forces the format to stay portable. Primitive doubles as a backup, a CI cache artifact, and the path for opt-in migration to hosted.
4. **The async queue is decoupled from storage.** `JobRunner` is a separate interface from the stores. Default impl is an in-process worker pulling from a SQLite-backed task table. Tasks are content-addressed by input — re-running the same `(embed_chunk, chunk_hash, model_id@version)` task is a no-op. A future remote dispatcher (hosted job server) is a swap, not a refactor.

**Why.** v0 commits to local-first (ADR-0007's local cache, ADR-0013's I/O-pure core). Future bot deployments (ADR-0013) and an eventual hosted indexing backend require migrating user-built indexes to the cloud without re-embedding from scratch where possible, and without ever silently mixing artifacts from different embedding models. Content-addressed, model-versioned storage makes per-user migration a one-time `INSERT INTO cloud_store SELECT * FROM local_store`. Without these seams, local-to-hosted migration becomes "rebuild every user's index in the cloud" — survivable but wasteful, and architecturally unrecoverable if assumptions about local SQLite leak into business logic.

The decision also rejects the symmetric framing "decide local vs hosted globally." Local vs hosted decomposes into four separable concerns, each with its own swap point:

| Concern                  | Local-first answer                                                              | When hosted earns rent                                                       |
| ------------------------ | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Trust / data residency   | Always local; never auto-flips.                                                 | Org-policy decision.                                                         |
| Derived artifact storage | Local default.                                                                  | Opt-in offload at scale (~>1 GB indexes) or for team sharing.                |
| Derived artifact compute | Local default with the queue.                                                   | Large codebases (hours of embed time) or shared team work.                   |
| Bot deployment           | Doesn't apply.                                                                  | Hosted by necessity (webhooks need a public URL — ADR-0013).                 |

The four interfaces above (`ChunkStore`, `EmbeddingStore`, `MerkleStore`, `JobRunner`) are each one of these concerns' swap points. Coupling them is the failure mode this ADR forecloses.

**Sizing reality check (so storage isn't a phantom worry).** int8-quantized 384-dim embeddings: ~384 bytes per chunk + ~1 KB metadata. 50k LOC ≈ ~15 MB. 500k LOC ≈ ~150 MB. 5M LOC ≈ ~1.5 GB. The actually binding constraint at scale is embed-generation *time*, not *storage* — so compute offload precedes storage offload when pain shows up. Migration upload (1 GB × 1000 users = 1 TB total) is parallelizable, one-time per user, not a scale problem.

**Cursor's design as reference (per indexing-design discussion).** Cursor's secure indexing (Merkle tree of file/dir hashes, simhash for index dedup, content-proof scheme for cross-team index reuse) is the closest shipped prior art. Their hosted design solves *team caching* — a problem Warden v0 doesn't have. Useful primitives to borrow: content-addressed chunk caching, Merkle-tree change detection, simhash-style summary for index dedup. Useful constraint to inherit: no leakage of unauthorized files (matters even single-user once bot-mode arrives). What Warden diverges on: Cursor optimizes for sub-second autocomplete latency; Warden optimizes for review correctness with citation discipline — that buys 10s of seconds per review, which changes the precision/recall tradeoff and the retrieval modalities (multi-modal index — symbol + type + embedding + history — not embedding-only).

**Alternatives.** Hard-code SQLite throughout the indexing layer, swap at hosted-mode time (rejected — guarantees the assumptions leak; "swap at hosted-mode time" becomes a rewrite). Skip model-versioning, treat embeddings as opaque blobs (rejected — produces silent corruption on model upgrade, exactly the failure mode that erodes the citation/trust thesis behind ADR-0008). Defer all of this until hosted mode is actually being built (rejected — the cost of these four seams is small at design time and substantial to retrofit). Adopt Cursor's content-proof / simhash machinery in v0 (rejected — solves team-sharing, which Warden v0 doesn't have; revisit when team-shared indexes become a real product requirement).

**Caveat — this is a *direction*, not a milestone.** The indexing layer is M5+; this ADR is what M5+ implementation must respect, not a commitment to ship the layer on a schedule. If indexing never lands, the ADR is dormant. If it does, the constraints are pre-decided.

**Caveat — interface design happens with the M5+ implementation, not now.** This ADR commits to *which* abstractions exist (`ChunkStore`, `EmbeddingStore`, `MerkleStore`, `JobRunner`) and *what properties they enforce* (content-addressing, model versioning, portable export, decoupled queue). The actual method shapes get designed when the first implementation lands. Premature interface design — guessing at methods before there's a real consumer — is exactly the dead weight ADR-0013 cautions against.

**Caveat — first-install UX.** When the indexing layer ships, first `warden review` runs against cheap signals (imports + symbol search + heuristic dirs) and produces a usable result while the chunk + Merkle + embedding store builds in the background via `JobRunner`. Subsequent reviews get the upgraded retrieval. This avoids Cursor's cold-start problem (Warden has no team index to copy from on first install) and is fine because Warden is not latency-bound the way autocomplete is.

The user-facing entry point is `warden init` (not `warden index`) — reads as friendly first-time setup in line with `git init` / `cargo init` / `terraform init`. Idempotent: re-running refreshes the index (same code path). `warden review` handles incremental updates implicitly via Merkle change detection.

When `warden review` runs with a missing or stale index (Merkle-root divergence beyond a threshold, or `--no-context` flag), the CLI surfaces a single dim limitation banner above the phase log:

```
! Running without repo context. Run `warden init` once for sharper findings.
```

The banner is yellow-toned (degraded, not failed), one line, auto-disappears once init has been run, and is not suppressible via flag (fix the cause, not the symptom). The banner state also enters `degradedWorkers` metadata so the `--json` output reflects it for bot wrappers per ADR-0013.

---

## ADR-0017 — LLM provider fallback: Anthropic primary, Google secondary

**Decision.** Amends ADR-0006's hardcoded-single-provider stance. The M4 LLM call (and every subsequent LLM call) follows a deterministic cascade:

1. **Try Anthropic** at the requested tier (`getBossModel()` / `getWorkerStrongModel()` / `getWorkerCheapModel()`).
2. **On transient failure** (HTTP 429, HTTP 5xx, network error, timeout), retry once with a 1s backoff against Anthropic.
3. **If retry fails or hard error** (auth, malformed response after schema validation), switch to **Google Gemini** at the matched tier:
   - boss / strong → `gemini-2.5-pro`
   - cheap → `gemini-2.5-flash`
4. **If Google also fails**, hard fail — exit non-zero, surface the upstream error.

**Cascade lives in `@warden/core/src/llm/cascade.ts`**, not as AI SDK middleware. Each cascade transition emits a `degradedWorkers` entry so the user sees the provider switch even on success-via-fallback. Format: `llm: anthropic <reason>, served from google`.

**Env.** Adds `GOOGLE_GENERATIVE_AI_API_KEY` (AI SDK convention; `@ai-sdk/google` reads it by default) as **optional** in `@warden/env`. When unset, no fallback — Anthropic transient/hard failure goes straight to hard fail. `ANTHROPIC_API_KEY` remains required as in ADR-0006.

**Why.** ADR-0006's single-provider hardcode was right when v0 had no LLM call to depend on. M4 inverts that: `warden review` is the headline command, the LLM is the formatter, and a single transient Anthropic 429 breaking the headline command is bad UX. Single-provider was a *startup-cost* optimization (one API key, one billing flow, one set of failure modes) — `vision.md` §2 itself flagged the trade-off. With M4 the LLM is load-bearing; resilience earns rent.

Google as the second provider:
- Different infrastructure / different uptime correlation than Anthropic. (OpenAI as fallback would correlate more — both heavily Microsoft-Azure-adjacent at peak load.)
- AI SDK v6 has first-class `@ai-sdk/google` support — same `LanguageModel` shape, no wrapper code beyond the cascade itself.
- Tier mapping is clean: `gemini-2.5-pro` is genuinely sonnet-class for code-review reasoning; `gemini-2.5-flash` is haiku-class for pattern-matching tasks. The cheap tier specifically — gemini-2.5-flash beats most older haiku-class options on cost-per-token at comparable quality, so the fallback isn't a degradation.
- User has already provisioned the key. The architecture commitment is "have a fallback path"; the choice of *which* second provider is point-in-time and revisitable.

**Why caller-side cascade, not AI SDK middleware.**
- Failure mode visible at the call site. `degradedWorkers` metadata is naturally produced.
- AI SDK middleware would hide the cascade behind a single `LanguageModel` reference. Harder to log, harder to debug, fragile to AI SDK API churn.
- ~30 lines of cascade code in `@warden/core/llm/cascade.ts` is cheaper than depending on experimental middleware APIs.

**Alternatives.**
- Stay single-provider, hard-fail on Anthropic outage (rejected — M4 makes this UX-breaking). The original ADR-0006 trade-off no longer holds when the LLM call is the headline path.
- Three-or-more provider chain (rejected for v0 — diminishing returns; two providers cover realistic outage scenarios; revisit only if Google + Anthropic outages start correlating, which they currently don't).
- User-configurable fallback chain via YAML (rejected — power-user feature, deferred to the BYOLLM milestone ADR-0006 already names; tier-mapping needs to stay opinionated for v0).
- AI SDK middleware-based fallback (rejected — see above).
- OpenAI as fallback instead of Google (rejected — user has the Google key provisioned, choice is made; OpenAI's tier-pricing volatility makes gemini-2.5-flash the more stable cheap-tier fallback at this point in time).

**Caveat — multi-provider fallback ≠ BYOLLM.** ADR-0006's deferred BYOLLM milestone (user-configurable model per role, multi-provider auto-detect via `WARDEN_API_KEY`) stays deferred. ADR-0017 commits to *one specific* fallback path with hardcoded tier mapping; it does not open the YAML-config door.

**Caveat — fallback SKUs are point-in-time.** Gemini SKUs evolve. Capture them in `packages/ai/src/models.ts` next to the Anthropic getters and revisit on Google's next-gen ship. The stable contract is the *tier mapping* (boss/strong → strong-fallback, cheap → cheap-fallback), not the specific SKU strings.

**Caveat — degradedWorkers messaging is load-bearing.** The user must see when fallback was used even on success — silent provider switching erodes the trust property Warden depends on. The `degradedWorkers` array in `CommentSetMetadata` already exists per `vision.md` §11; Warden writes there both on Anthropic-recovery-after-retry (`llm: anthropic 429, retried successfully`) and on Google-fallback-success (`llm: anthropic <reason>, served from google`).

**Caveat — does not affect ADR-0008's citation thesis.** Citation discipline is about *what the LLM is asked to claim* (tool findings + verified CVEs only, no LLM-generated assertions per the M4 grilling Q1 → A+C decision). The provider behind the LLM doesn't change that. A Gemini fallback that triages tool findings + asks clarification questions honors the thesis identically to a Sonnet primary.

---

## ADR-0018 — M5: cheap-signals context selector + jscpd dedup runner

**Decision.** M5 ships the first, narrowest iteration of ADR-0016's context-selection layer: deterministic cheap signals + jscpd as a scoped dedup runner. No embeddings, no chunk store, no Merkle tree, no `JobRunner` queue, no `warden init` subcommand, no limitation banner — every one of those is explicitly deferred to M6. Concretely:

1. **Context selector v1.** `ContextSelector` interface lives in `@warden/core/src/context/` (directory, not a workspace package). The default `CheapSignalsSelector` walks the host repo via the TypeScript Compiler API to compute four signals: direct importers, direct imports, same-folder siblings, and symbol references. Output is a ranked `ContextCandidate[]` where each candidate carries discriminated `reasons[]`, and most reasons carry per-reason `Evidence[]` (start/end line ranges pointing at the lines that triggered the signal).
2. **jscpd dedup runner.** Programmatic-API integration of `jscpd`, scoped to `changedFiles ∪ selector.candidates.map(c => c.path)`. Each clone whose pair touches the diff becomes a `Comment { category: "dedup", tier: 3, source: "jscpd" }` flowing through the existing `toolComments` channel (ADR-0012's `dedup` category finally has a producing runner).
3. **Pipeline shape.** Selector runs *parallel* with TSC/ESLint/vuln (its signals don't depend on tool output). jscpd runs *sequentially after* the selector (it consumes the candidate path set). LLM formatter receives selector output via the existing `RetrievedContext` seam in `ReviewInput` — M4 left the seam typed and forward-compat per ADR-0016.
4. **Cache.** Two new tables in `@warden/db`:
   - `import_graph(filePath, fileSha, importsJson, exportsJson, computedAt)` — content-addressed, immutable; primary key `(filePath, fileSha)`.
   - `file_state(filePath, currentSha, observedAt)` — path → current-SHA pointer, refreshed via `git ls-files --modified --others --exclude-standard`.
5. **LLM prompt assembly.** For evidence-bearing reasons: emit each evidence range with ±5 lines of surrounding code, deduped/merged when ranges overlap. For same-folder-only candidates: emit path-only (no content). Total context budget: ~3–5k tokens.

**Why.**

This ADR turns ADR-0016's pre-decided storage discipline into the smallest credible *consumer* shape. The four ADR-0016 properties (content-addressed, model-versioned, portable, queue-decoupled) are abstract until something exercises them — M5 exercises only content-addressing (cheap signals have no embedding model, no chunks to portably export, no async queue work). That partial exercise is the right pace: the import-graph cache is the wedge into the discipline, the embedding store is M6, and the seams between them get designed by M6's implementation rather than pre-guessed (per ADR-0016's "interface design happens with the implementation, not now" caveat).

The deeper reason for *cheap signals first*, not embeddings first:

- **The LLM has no repo context today.** M4 ships triage + clarification questions, but every adjudication is "diff + tool findings + verified CVEs" with zero adjacent code. The biggest review-quality gap right now is breadth of view. Cheap signals close most of that gap (directly imported files, files in the same module, files referencing changed symbols) without any embedding infrastructure.
- **Embeddings are a separate cluster of decisions.** Local Transformers.js vs. hosted Voyage/Cohere/OpenAI; chunking strategy (tree-sitter vs. AST-symbol vs. naive line-based); model-versioning UX on upgrade; queue + worker for async embed generation. None of those are 1-line decisions. Folding them into M5 either rushes them or balloons the milestone.
- **jscpd is the immediately-payable consumer.** ADR-0012 created the `dedup` category two milestones ago and there has never been a runner producing dedup findings. M5 closes the loop: the selector's path set is exactly the input scope jscpd needs to avoid running repo-wide.

Two design choices that didn't survive the planning grilling — and the reasoning behind their replacements — are worth recording explicitly because they are the non-obvious nuances:

1. **Full-file context → evidence-range context.** First draft: top-N candidates × full file content (capped at 500 lines) → ~12k tokens of context per review. Refined during planning: each `Reason` already knows *why* its file ranked, so each reason carries an `Evidence[]` of line ranges pointing at the trigger lines. The prompt then emits only those ranges (±5 lines surrounding) instead of full files. Token cost dropped from ~12k to ~3–5k, and citation precision *improved* because the LLM now sees the lines that *caused* the candidate to surface, not lines that happened to live in a related file. This is a strictly better design surfaced by grilling, not pre-conceived.
2. **Same-folder content → same-folder path-only.** Initial recommendation: include same-folder candidates' first ~80 lines as fallback context for evidence-less candidates. Refined: same-folder is *tertiary* — folders are noisy, often contain unrelated files, and dumping their content pollutes the prompt window. Final design: same-folder candidates feed jscpd by path, and the LLM prompt lists them under a "Same-folder neighbors" header without content. Folder structure is informative; folder *content* is mostly noise.

Two more nuances that came out of the discussion are worth pinning here:

- **Content-addressing is the invalidation mechanism.** A `(path, sha)`-keyed cache row is forever-valid for that exact content; "stale" rows are simply unreachable when the file changes. The natural worry "we have to invalidate the cache for staleness" reduces to a different question: *given a path, how do we cheaply know its current SHA?* For M5, the answer is `git ls-files --modified` as a per-review staleness oracle. Merkle trees (ADR-0016's `MerkleStore`) earn rent later when chunk-level granularity makes per-file granularity insufficient — but for file-level import-graph staleness, git is precisely the right granularity.
- **Tree-sitter is for multi-ecosystem, not for v1.** Tempting because Cursor uses it and ADR-0016 references it as prior art, but inside a TS-only stack tree-sitter is a heavy WASM dep with no upside over the TypeScript Compiler API (which is already a transitive dep via the TSC runner). Putting parsing behind a `SourceParser` interface lets the tree-sitter impl drop in later when Python/Go land — the trigger for refactor is "next ecosystem," not "next milestone."

**Alternatives.**

- **Embeddings + Merkle in M5 (the full ADR-0016 layer).** Rejected — packs four separate decision clusters (embedding model, chunking strategy, model-version UX, async queue) into one milestone and risks the layer landing as a mash. The cheap-signals tier earns most of the user-visible quality gain on its own.
- **Custom-code SAST worker (DeepSec-shaped per ADR-0015) as M5.** Rejected — depends on context selection to be good, so it pulls indexing in as a transitive dependency anyway. Better as a later milestone once the selector is dogfood-validated.
- **GitHub PR bot (per ADR-0013) as M5.** Rejected — distribution milestone, not a quality milestone. Reviews shipped via a bot are only as good as the underlying review engine; improving the engine first compounds.
- **`warden init` + banner in M5 with reduced wording.** Rejected — semantics drift. `warden init` for "warm the import-graph cache" is a thin verb whose contract has to expand at M6 (also building chunks, embeddings, Merkle). Users running M5's `init` once and assuming "I'm done indexing" would be wrong by M6. Defer until the verb's contract is the full thing.
- **Repo-wide jscpd with output filtering to diff-touching pairs.** Rejected — heavier compute, defeats the point of having a selector. Selector output is exactly the right input scope for jscpd.
- **AST-verified symbol-ref signal.** Rejected for v1 — symbol-ref is a *ranking* signal, so false positives (symbol name appears in a comment or string) only demote the candidate slightly via score, never surface as a finding. Grep is cheap and good enough; AST-verified upgrade if dogfooding shows precision is too low.
- **New `@warden/context` package now.** Rejected for M5 — surface is small (~3–4 files). Package boundary creation deferred to M6 when the embedding layer's surface justifies it; the name (`@warden/context` vs `@warden/embed`) can be chosen with full M6 contents in view.

**Caveats.**

- **First-review cold start is visible.** Initial parse over a 5k-file repo is ~10–30s. Surfaced as `degraded[]`: `"context: cold import-graph build (parsed N files in Ts)"`. No banner — that's M6's job. Subsequent reviews hit the cache and add near-zero overhead.
- **Cross-file moves with no symbol overlap can slip through.** A pure rename from `auth/login.ts` → `auth/elsewhere/session.ts` with renamed symbols and no imports yet wired won't be detected as related by the four signals. Acceptable v1 limitation; revisit at M6 when chunk-level content addressing makes "this chunk used to live somewhere else" structurally detectable.
- **No score-weighting tuning surface in v1.** Per-signal weights are hardcoded (imported-by 1.0, imports 0.8, symbol-ref 0.6, same-folder 0.3). Configurable via flag/config later if dogfooding shows the defaults are wrong.
- **Test files participate in the import graph.** `*.test.ts` and `*.spec.ts` are regular source for parsing purposes — they import the code they exercise, so they show up as importers of changed source. This is correct (when you change `login.ts`, `login.test.ts` is genuinely relevant). Test-pairing as an *explicit* signal stays deferred to M6.

---

## ADR-0019 — M6: hosted embedding-backed selector + content-addressed indexing storage

**Decision.** M6 ships the embedding-backed iteration of ADR-0016's storage layer with **one consumer** — the selector's new `semantic` reason variant. Cross-repo retrieval, the `leverage` review category, the custom-code SAST worker (DeepSec-shaped per ADR-0015), full `warden index export/import` CLI verbs, real async/daemon `JobRunner` impls, and BYOEmbedder are all explicitly deferred to M7+. Same posture ADR-0018 took for M5: ship the storage discipline with the smallest credible consumer; let dogfooding inform the next slice. The decisions below are pre-decided so the milestone work is implementation, not architecture.

The full surface:

1. **Embedding provider — Voyage `voyage-code-3`, hosted.** Single provider for v0; `VOYAGE_API_KEY` required (validation surfaced at start of any verb that touches the index, like `ANTHROPIC_API_KEY` already is). `EmbeddingProvider` interface in `@warden/ai/src/embeddings/` so a future BYOEmbedder milestone is additive — drop in additional impls (`OpenAIProvider`, local `TransformersProvider`, etc.) without touching consumers. Tier mapping matches Voyage's API contract: corpus-side embeds use `type=document`; query-side (diff embeddings during `review`) use `type=query`. Query-side results are not cached.

2. **Chunking — depend on `code-chunk` (npm, MIT, pinned exact version).** Tree-sitter AST-aware chunker shipping native + WASM tree-sitter, six languages out of the box (TS, JS, Python, Rust, Go, Java) — matches Warden's roadmap from `vision.md` §2. Exposes scope chain + imports + signatures per chunk; benchmarks 70.1% recall@5 on its eval (next-best Chonkie's `CodeChunker` at 49% on the same eval). `Chunker` interface in `packages/core/src/context/chunker.ts` keeps the impl swappable. Documented fork triggers (`code-chunk` abandoned >6mo, blocking bug we can't get merged upstream, Effect dep grows past comfort threshold) → fork to `@warden/chunker` from MIT source. Don't pre-empt the fork.

3. **Embedding row schema:**
    ```ts
    embeddings: {
      chunk_hash:     text,                       // sha256(raw chunk content)
      model_id:       text,                       // "voyage-code-3"
      model_version:  text,                       // "dim=1024;type=document"
      vector:         blob,                       // 1024 × float32 = 4 KB/row
      created_at:     timestamp,
      // PRIMARY KEY (chunk_hash, model_id, model_version)
    }
    ```
    Composite primary key — same chunk under a different setup is a separate row, both valid. No DB-level FK from `embeddings` to `chunks`: cardinality is mismatched, content-addressing covers correctness. `chunk_hash` is `sha256(raw chunk content)` with no whitespace normalization — whitespace changes are real changes. Float32 at rest for v0 (~4 KB/chunk × ~50k chunks ≈ ~200 MB on a 5k-file repo); int8 quantization deferred to a real storage-pain trigger.

4. **`JobRunner` timing model — Model A (`warden init` is the only embed entry point).** Reviews never modify the index. Default `JobRunner` impl is synchronous in-process with concurrency-limited promise pool (4 concurrent Voyage batches × ≤128 inputs/batch). SQLite-backed task table for crash-recovery: a Ctrl-C'd init resumes via content-addressed task idempotency — re-running `(embed_chunk, chunk_hash, model_id@version)` is a no-op per ADR-0016 #4. No daemon, no background subprocess, no review-time embed in M6. Model B (review-time incremental embed) and Model C (background subprocess) are documented future directions for M7+ if dogfooding shows users skip `init` consistently.

5. **`warden init` UX.** Three phases visible to the user: walk → chunk → embed. After Phase 1, a pre-flight LOC-based estimate panel ("≈ 12,400 chunks · ≈ 4.6M tokens · ≈ $0.83 · ETA ~50s"). Phase 3 shows observed-throughput ETA, running cost, cached-vs-newly-embedded counts. Idempotent re-runs (cache hits skip Voyage). Flags: `--rebuild` (drop current locked-model rows, switch to current default, re-embed), `--dry-run` (Phases 1+2, no API calls), `--max-cost <USD>` (abort before Phase 3 if estimate exceeds). No `--watch`, no `--background`, no interactive prompts (per ADR-0014). On failure: missing `VOYAGE_API_KEY` → fail at start; transient Voyage 5xx → retry per JobRunner; persistent failure → preserve already-persisted progress, exit non-zero with how to resume.

6. **Locked-model concept.** First-ever `init` writes `embedding_model_id`, `embedding_model_version`, `embedding_locked_at`, `format_version`, `repo_merkle_root` into a single key/value `index_meta` table. **Incremental embeds always use the locked model** regardless of Warden's current default — Voyage SKU bumps don't auto-rebuild. The user's path to upgrade is `warden init --rebuild`, which switches the locked model to `CURRENT_DEFAULT` and re-embeds. Cost is surfaced upfront with explicit "this is optional" framing. Mid-stream key-change handling for v2 multi-user / production scenarios is deferred.

7. **Limitation banner gradient.** Banner state is computed *before* the selector runs (no "we tried to retrieve and got empty" inference). `warden check` never fires the banner — it's a deterministic-only verb that doesn't use the index.
    | State | Trigger | Surface |
    |---|---|---|
    | A. No index | `chunks` empty | Banner in `review` |
    | B. Stale | Merkle divergence > 0 (any divergence, no percentage threshold) | Banner in `review` |
    | C. Current | matches | (silent) |
    | D-soft | Newer SKU available | Soft note in `init` only — never in `degradedWorkers` |
    | D-aged | Locked model >6mo non-default | Soft banner in `review`; structured `degradedWorkers` |
    | D-deprecated | Voyage EOL'd locked SKU | Real banner in `review` |
    
    D-aged math uses `defaultSince` of `CURRENT_DEFAULT`, not `locked_at` — i.e., "the new model has been current for >6mo," not "the locked model is 6mo old." Banner is not suppressible via flag (per ADR-0016); `WARDEN_LOG_LEVEL=silent` is the only global escape.
    
    Hardcoded `VOYAGE_MODELS` registry in `@warden/ai/src/embeddings/voyage-models.ts` carries `defaultSince` + `deprecatedAfter` per SKU. Bumping `CURRENT_DEFAULT` is ADR-worthy.

8. **Bulk export/import — interface-ready, CLI deferred. Amends ADR-0016 #3.** Build `IndexExporter` / `IndexImporter` as abstract methods on the storage seam with one SQLite impl in M6. Don't ship `warden index export/import` CLI verbs. The portability discipline ADR-0016 #3 cared about is preserved (storage layer can stream-export without SQLite-specific shortcuts); the CLI shipping is deferred until a concrete consumer materializes (CI cache artifact, hosted-mode migration, or laptop-switching pain). Backup affordance for v0 dogfood is documented as `cp .warden/cache.sqlite cache.sqlite.bak` — SQLite is one file.

9. **Selector v2 composition.** New `Reason` variant `{ kind: "semantic"; chunkHash; similarity; evidence: Evidence[] }` joins M5's four cheap signals. The selector embeds the unified diff text once via Voyage `type=query`, retrieves top-50 chunks, drops similarity < 0.5, aggregates per-file via *max* (preserves "this one chunk is highly relevant"). Score weight `0.9` (slot between `imported-by`'s 1.0 and `imports`' 0.8), intensity-scaled — file's semantic contribution is `0.9 × max_chunk_similarity`. Cheap signals stay binary because they're inherently binary; semantic gets intensity scaling because cosine similarity is calibrated. Updated `MAX_REASON_WEIGHT_SUM = 3.6`. `MAX_CONTENT_BEARING` stays 8 (token budget). No query-embedding cache (one Voyage call per review is free; M4's `llm_review_cache` short-circuits on diff-hash hit). Voyage failure during `review` degrades to M5 cheap-signals + `degradedWorkers` entry; never hard-fails.

10. **Storage interface placement.** Interfaces + SQLite impls in `packages/core/src/indexing/` (gerund avoids collision with the `index.ts` barrel). Five new schemas in `packages/db/src/schema/`: `chunks`, `embeddings`, `merkle`, `jobs`, `index-meta` (single key/value table for locked-model + format_version + repo_merkle_root). Embedding provider in `packages/ai/src/embeddings/` — symmetric to LLM model dispatchers. Zero new package boundaries cross; CLAUDE.md's forbidden-imports table is honored unchanged. A future `@warden/index-postgres` (or any non-SQLite impl) is additive — implements the same `interfaces.ts` types without touching `@warden/core/indexing/` consumers.

11. **`@warden/context` / `@warden/index` workspace package — deferred.** ~20 files across `context/` + `indexing/` doesn't meet the split-justification bar (one consumer, same release cadence, same build setup, tight coupling to review-pipeline assembly). Documented split triggers for M7+: (a) non-review consumer of indexing emerges (e.g., DeepSec-shaped SAST worker per ADR-0015), (b) `@warden/ai/embeddings/` grows multi-provider routing (BYOEmbedder), (c) external consumers want to embed Warden's chunks independently, (d) a `code-chunk` fork happens.

12. **Auto-`.gitignore` helper.** `ensureGitignore(repoRoot)` runs at the top of `init`, `review`, and `check` — idempotent; appends `.warden/` to existing `.gitignore` (under a `# warden` comment), creates a minimal `.gitignore` if none exists, never overwrites other entries. Surfaces `"gitignore: added .warden/ entry"` in `degradedWorkers` on first add. Lives in `@warden/core` (deterministic file I/O at known path; doesn't violate ADR-0013's I/O-pure stance — it's a one-shot config write at the boundary).

**Why.**

The headline tension in M6 is that ADR-0016 originally sized the storage layer assuming local embeddings (Transformers.js: ~50MB weights, no network), while M6 ships hosted embeddings via Voyage (network-bound, paid). The reasoning chain that produced this:

- *Q1's narrowed scope.* Cramming every gated-on-indexing feature into M6 (cross-repo retrieval, `leverage` category, SAST worker, full async daemon) packs four-plus separable decision clusters into one milestone — the "lands as a mash" failure mode ADR-0018 explicitly cited. Smallest-credible-consumer posture ships the storage discipline first; subsequent slices land with their own ADRs when consumers earn rent.

- *Q2's hosted-over-local pivot.* Voyage `voyage-code-3` is best-in-class for code retrieval, the user has already provisioned the API key, and the cost shape (~$0.83 first-index for a 5k-file dogfood repo, pennies per subsequent review) is acceptable for v0. The data-residency cost (chunks travel to Voyage to be embedded) is real and surfaced in user-facing docs; the BYOEmbedder milestone — deferred per ADR-0006's BYOLLM logic — opens a local-fallback path when sensitive-code use cases earn rent.

- *Q3's depend-don't-build call.* Warden is a *consumer* of focused tools (TSC, ESLint, jscpd, npm-audit, OSV, Anthropic, Voyage). Adding `code-chunk` to that list is consistent; building chunking ourselves duplicates what's already MIT-licensed and benchmarked. Owning every layer is the path to "let's also build our own embedding model, our own LLM, our own static analyzer." Fork only if/when triggers fire.

- *Q4's schema choices.* Content-addressing on `chunk_hash` makes invalidation a non-problem (stale rows become unreachable, never wrong). The `(model_id, model_version)` columns capture our-side change detection; silent provider weight drift is undetectable from our side and ADR-0016 #2's property is degraded but not violated — accepted tradeoff for hosted embeddings.

- *Q5's foreground-init model.* The one-shot non-interactive CLI (ADR-0014) makes background work expensive. `warden init` already exists in scope; giving it a clear contract (foreground, idempotent, resumable on Ctrl-C) is cheap. Embedding cold-start (~5–10 min on a large repo) honestly belongs to `init`, not hidden inside `review` latency.

- *Q6+Q7's UX gradient.* Costs and provider behavior are both legible to the user. Pre-flight estimates make "is this 30 seconds or 30 minutes?" answerable before commit. Locked-model + banner gradient prevents Voyage SKU bumps from being surprise re-embed events. The "this is optional" framing on `--rebuild` is doing real work — it tells the user they don't have to chase every model bump.

- *Q8's deferral of CLI verbs.* The *discipline* ADR-0016 #3 cared about is preserved by the interface shape; the *commands* would be premature scaffolding for a v0 user who can `cp .warden/cache.sqlite` for the same effect. Same logic ADR-0013 used to defer the bot infrastructure: interfaces stay decoupled; CLIs ship when there's a real consumer.

- *Q9's intensity-scaled semantic weight.* Cosine similarity is a calibrated 0–1 number that's already in Voyage's response; ignoring it would throw away information. Cheap signals stay binary because they're inherently binary; semantic gets intensity scaling because the data supports it. Top-50 / threshold-0.5 / max-aggregation / weight-0.9 are tuning constants that mirror M5's hardcoded posture; configurability is BYOEmbedder's problem.

- *Q10+Q11's flat-package shape.* The package boundary table (CLAUDE.md) is honored; `@warden/core` becoming the largest package is intentional and matches Alfred's shape. Splitting prematurely is the failure mode ADR-0013 cautioned against; the surface (~20 files) doesn't earn a workspace package, and naming it (`@warden/context` vs `@warden/index` vs `@warden/embed`) is more profitably decided when full M7+ contents are in view.

**Alternatives considered and rejected.**

- *Local Transformers.js (`bge-small-en-v1.5`) for embeddings.* Best privacy posture, $0 forever, reproducible model_version (weights file hash). Rejected for M6 because the user provisioned the Voyage key and the quality delta on code-retrieval favors hosted. Local re-enters the picture as an M7+ BYOEmbedder impl when sensitive-code use cases earn rent.
- *OpenAI / Cohere / Gemini for embeddings.* Cheaper than Voyage but not code-specialized; Gemini concentrates dependency on Google (already the LLM fallback per ADR-0017). Voyage's code-retrieval specialty earns the price premium for our task.
- *Build chunker ourselves on top of M5's `TsCompilerParser`.* TS-only by construction; recreates the multi-ecosystem trap M5 deliberately avoided at the parser layer. `code-chunk`'s six-language coverage matches Warden's roadmap without writing per-language tuning ourselves.
- *`@langchain/textsplitters`.* Regex-based language-aware separators; ~50% precision penalty on code retrieval per cAST research and Vecta benchmarks. Cheap to integrate but undercuts Voyage's code-specialty embeddings.
- *Whole-file chunking.* Loses retrieval precision; per-file aggregation is the *selector's* job, not the chunker's. Forecloses M7+ consumers that want chunk-level granularity (e.g., "find the symbol that…" queries, API claim verifier).
- *`JobRunner` Model B/C in M6.* Review-time incremental embed (B) or background subprocess (C) both fight against ADR-0014's one-shot CLI shape. Both are legitimate M7+ directions if dogfooding shows users skip `init` consistently — defer until evidence.
- *Interactive cost-confirmation prompt before Phase 3.* Per ADR-0014 — even for the heavyweight `init` verb. `--max-cost <USD>` flag is the non-interactive equivalent.
- *Auto-rebuild on Voyage SKU bump.* Surprise costs + surprise wait; user agency wins. Soft-notice in `init` only; D-aged banner kicks in at 6mo grace period.
- *Banner with percentage threshold for staleness (e.g., "if >10% of files changed").* Silent quality loss is worse UX than a one-line dim banner; trigger-eagerly is cheap to relax.
- *Full CLI `warden index export/import` in M6 per ADR-0016 #3 strict reading.* No concrete v0 consumer; `cp .warden/cache.sqlite` covers the dogfood backup case. Amend ADR-0016 #3 wording rather than ship CLI verbs in advance of need.
- *Query-embedding cache (`(diff_hash, model_id, model_version) → query_vector`).* Adds a table for ~$0.0001/review savings; M4's `llm_review_cache` already short-circuits on diff-hash hit when it matters. Not worth the surface.
- *Splitting `@warden/context` or `@warden/index` workspace package now.* Surface (~20 files), single consumer, same release cadence — the four workspace-package justifications don't fire. Documented triggers for revisit at M7+.
- *Indexing `node_modules` / `.d.ts` / cross-repo source in M6.* Cost spikes on dependency-heavy repos; ROI unclear without a concrete consumer (the `leverage` category is the obvious one but it's deferred). Vulnerability detection in dependencies stays runtime via M3's npm-audit + OSV path — no need to chunk dependency code for that goal. Cross-repo indexing reactivates when `leverage` or API claim verifier earns rent.

**Caveat — silent Voyage weight drift is undetectable from our side.** ADR-0016 #2's "prevents silent corruption when the embedding model is upgraded" property is degraded but not violated. The mitigation is "trust the SKU contract"; if Voyage ever announces a backward-incompatible refresh within a SKU, we add a manual `client_pin` segment to `model_version` and bump it. The locked-model concept (decision 6) confines the blast radius — incremental embeds always match the corpus, so query/corpus asymmetry never leaks into review quality even if Voyage drifts.

**Caveat — `code-chunk` is at v0.1.x with a solo maintainer.** Pin the exact version. Documented fork triggers (abandoned >6mo, blocking bug, Effect dep growth) → fork to `@warden/chunker` from MIT source. The fork is M7+ if-needed work, not M6 if-maybe work. Re-deciding under deadline pressure is worse than re-deciding from documented criteria.

**Caveat — local-vs-remote data flow is load-bearing for trust.** Code chunks travel to Voyage to be embedded; embeddings come back and stay local. Diffs travel to both Voyage (query-side embed, not cached) and Anthropic/Google (review LLM call). The `.warden/cache.sqlite` itself never leaves the machine; M5/M4/M3 caches stay local; API keys are read-only, never logged or persisted. M6 plan + README mirror the data-flow table verbatim. Users with sensitive code (employer NDAs, regulated codebases) get explicit signal about what crosses the wire before they run `warden init`. The local-fallback escape valve (Transformers.js) is named in the BYOEmbedder forward pointer, not blocked by this milestone.

**Caveat — first-Voyage-SKU-bump is a real test of the locked-model design.** Until `voyage-code-3.X` ships, the registry math (`defaultSince` of `CURRENT_DEFAULT`, D-aged 6mo grace, `--rebuild` semantics) is theoretical. Worth dogfooding via a deliberate test (manually flip `CURRENT_DEFAULT` in a dev branch, run `warden init --rebuild`, verify locked-model semantics) before relying on the path in production. Captured as an acceptance smoke test in `m6-plan.md`.

**Caveat — hosted-mode swap point stays open for M7+.** All four ADR-0016 properties (content-addressed, model-versioned, portable, queue-decoupled) are exercised by M6 even with hosted embeddings: `chunk_hash` is content-addressed, embedding rows carry `model_id`+`model_version`, the `IndexExporter` interface preserves portability discipline, and `JobRunner` is decoupled from storage. A future hosted backend (Postgres, KV, vector DB) implements the same interfaces — no rewrite of `@warden/core/indexing/` consumers.

**Caveat — `node_modules` / `.d.ts` chunking explicitly out of M6 scope.** Cost spikes on dependency-heavy repos and the consumer that would need it (the `leverage` category, custom-code SAST worker, API claim verifier) is M7+. Vulnerability detection on dependencies stays runtime via M3's npm-audit + OSV path. When cross-repo retrieval is scheduled, gate on a real consumer per ADR-0013's "interface boundaries crystallize after they're tested against real consumers" caveat.

**Caveat — this ADR amends two earlier ADRs.** ADR-0016 #3 ("Bulk export/import is a first-class operation from day one") softens to "interface-ready from day one; CLI shipping deferred to first concrete consumer" — the discipline survives, the CLI verbs don't ship in M6. ADR-0006's hardcoded-Anthropic-for-LLM stance gains a parallel clause: hardcoded-Voyage for embeddings in M6, with `EmbeddingProvider` interface shaped to accept future BYO impls. Both amendments are scoped: the spirit of the prior ADRs is preserved; only the implementation timing shifts.

**Caveat — this is a *direction*, not a milestone schedule.** M6 is the next milestone, but its acceptance bar is "selector v2 + locked-model + `warden init` + banner + storage interfaces work end-to-end on Alfred / milkpod / blair," not a calendar. Per ADR-0001's single-user-built-right posture, dogfooding pacing dominates artificial deadlines.

---

## ADR-0020 — Review priority order extension: scalability, consistency, deadcode, committability

**Decision.** Extend ADR-0012's five-category priority order with four new categories the LLM can emit *as questions only*:

1. Correctness
2. **Scalability** *(new)* — query / loop shapes whose asymptotics break under 10× growth.
3. **Consistency** *(new)* — README / ADR / doc claims the diff makes false.
4. **Deadcode** *(new)* — branches gated on params no caller passes; functions whose only callsites all skip them.
5. **Committability** *(new)* — added files whose name, location, or content shape says "shouldn't be committed" (hardcoded absolute paths, `scripts-bootstrap-*`, `tmp-*`, debug `console.log`, `DO NOT MERGE` markers).
6. Clarity
7. Style / conventions
8. Deduplication
9. Tests

`security` and `vulnerability` continue to share the top tier with `correctness` per ADR-0012's tier-mapping rule.

The four new categories are added to `CategoryEnum`, slotted into `PRIORITY_ORDER` in both `@warden/core` and `@warden/cli`'s formatter, and surfaced in the LLM system prompt's "Pattern shapes worth asking about" section. The hard rule that the LLM cannot author assertions without a tool source (ADR-0008's citation thesis) is unchanged: these new categories are emitted via the existing `questions[]` lane, which has empty `sources[]` by design and asks rather than asserts.

**Why.** Captured during PR #3 dogfooding: Copilot's review of the same PR caught 6 things warden missed, and 4 of those 6 cluster into shapes that don't fit any existing category — the LLM had the relevant files in context (M5 selector pulled them in), but the prompt structure didn't carve out slots for these patterns, so the LLM either downgraded them to "clarity" or dropped them. The corollary discipline from `m6-plan.md` §"Copilot review delta": *"every time another reviewer catches something warden missed, ask what category I missed, not what bug I missed."* The category answer is what makes the LLM look on future runs.

These four are locally cheap to recognize from the diff plus its adjacent context — no cross-repo work, no new tools, no embedding query. The expensive part is the *naming*; once named, the LLM is competent at the pattern-match.

**Why questions, not assertions.** ADR-0008 is non-negotiable: every assertion needs a verifiable source. None of the four new categories has a deterministic producer in M6. Routing them through the questions lane preserves citation discipline — *asking is not claiming* — while still surfacing the pattern to the human reviewer. M7+ may upgrade individual categories from "LLM asks" to "deterministic detector asserts" once the producing tool exists; the schema doesn't change when that happens.

**Alternatives.** (1) Build deterministic detectors for all four in M6 (rejected — meaningful scope creep on top of M6's embedding/indexing/banner work; each category needs its own producer with non-trivial parsing). (2) Add only `scalability` since it's the most code-pattern-shaped (rejected — half-measure; the four-category bundle is the unit the dogfood evidence pointed at). (3) Add the categories without prompt instructions, expecting the LLM to discover them (rejected — the dogfood lesson explicitly was that the LLM needs the *naming* to look). (4) Inline-amend ADR-0012 instead of writing a new ADR (rejected — separating the original five from the four extensions makes both ADRs easier to reason about; the original priority order is the v0 thesis, the extension is a learned-after-shipping correction).

**Caveat — `committability` requires an *added*-file detector.** "Added file" means `+++ b/path` with no `--- a/path` counterpart. The LLM has the diff, so this is observable from the prompt input alone — no new schema field needed. The `committability` category is meaningless on modified-only files; the prompt instructs the LLM to gate on the added-file marker. False positives (legitimate new scripts) are tolerable because the output is a *question*, not a block.

**Caveat — `consistency` is the inverse of ADR-0008's citation discipline.** Citation discipline says *"if you make a claim, cite a source."* Consistency-as-question says *"if a doc makes a claim that the diff invalidates, flag it."* Same machinery, opposite direction. M5's selector already pulls README and `CLAUDE.md` into context for files that touch them; the LLM just needs to be told that's also a verification axis, not just a citation-source axis. M7 may add a dedicated `doc-verifier` worker that asserts these as findings rather than asking; until then, the LLM-asks-question form keeps the citation invariant intact.

**Caveat — drop-in replacement, not a breaking change.** Existing consumers of `Category` (CLI formatter, JSON output, future bots) keep working: the four new values are appended to the enum, so old serialized payloads still validate. PRIORITY_ORDER lookups for the new categories simply move them to their slot; lookups for the original eight categories are unchanged.

---

## ADR-0021 — M7: detector-driven category promotion + LLM sub-agent for committability + question citation discipline

**Decision.** M7 ships the *upgrade path* ADR-0020 anticipated: three of the four new categories (`scalability`, `consistency`, `deadcode`) graduate from LLM-asked questions to deterministic-detector-asserted findings; the fourth (`committability`) gets an LLM sub-agent that emits citations into the `questions[]` lane. Two engine-maturity invariants gate the rest: schema migrations run at runtime so a fresh repo's first `warden init` doesn't crash, and `degradedWorkers` becomes a discriminated `{ kind, topic, message }[]` so the banner renderer reads structure instead of prefix-matching strings. The smaller M6 punch-list bugs (#5, #6, #12, #14) ride along; the bigger ADR-0019 deferrals (BYOEmbedder, cross-repo retrieval, custom-code SAST, async daemon, hosted index, retrieval refinements) stay deferred.

The full surface:

1. **Three deterministic detector workers, peer to TSC/ESLint/jscpd/vuln.** Each runs in parallel with the existing M4/M5 worker pipeline. Each emits `ToolFinding[]` that map to `findings[]` `Comment` entries with `kind: "assertion"` and grounded `sources[]`.

   - **`scalability-detector`** (Type 1, AST): TS Compiler API via M5's `TsCompilerParser`. Trigger names `{ all, findMany, find }` on a query-builder-shaped receiver, followed by anti-pattern next-call `{ filter, find, length, some, every }` (excludes `map` — projection isn't the smell). Also detects sequential-`await`-could-be-`Promise.all`: `AwaitExpression` siblings in the same block whose awaited values don't depend on each other's results. Direct findings — false positives are downgraded by the LLM triage layer with surrounding context, not suppressed at detection time. Citation: AST node range as `{file, startLine, endLine, snippet}`.

   - **`deadcode-detector`** (Type 1, AST + reverse import-graph): identifies optional parameters in diff-touched functions plus their presence-checking branches; for each, queries M5's `import_graph` for files importing the function's export and AST-inspects each callsite's argument list; if no callsite passes the optional argument, emits one finding per `(param, branch)` pair with a 3-part citation (param decl + branch line + representative non-passing callsite, plus total callsite count in the message). Triggers on diff-touched functions plus one hop downstream via `import_graph`. Repo-wide scanning is out of scope.

   - **`consistency-detector`** (Type 2, structured-verifier): reads canonical doc set (`README.md`, `CLAUDE.md`, `AGENTS.md`, `docs/**/*.md`); extracts three structured claim types — env-var requirements (`X required` / `X optional` / `X default Y` predicates against `wardenEnv()` zod schema), CLI command shapes (`warden <verb> --flag` against commander surface), and file-path constants (`\\.warden/[\\w./-]+`-shaped strings against repo grep). For each claim that overlaps with the diff (claim mentions a symbol/file/env-var the diff also touches), runs a deterministic check; emits findings on mismatch. Free-form prose claim extraction is M8+. Citation: doc line + code line as a paired evidence array.

2. **`committability-subagent` worker (Type 3) emits to `questions[]`.** New worker shape: `getWorkerCheapModel()` from `@warden/ai` (the M4 cheap-tier dispatcher already wired through ADR-0017's multi-provider fallback) reviews added + modified files. Pre-filter is two-tier:

   - **Tier 1 hard-skip** for patterns that are never intentional commits: `.git/`, `*.pyc`, `*.swp`, `.DS_Store`, `Thumbs.db`, `.vscode/.history/`. Excluded before the sub-agent sees them.
   - **No further regex exclusion.** Files inside `node_modules/`, `dist/`, `build/`, etc. *do* go to the sub-agent — they may be intentional (published artifact, workaround for broken dependency); the sub-agent decides.

   Above 500 files post-Tier-1, the sub-agent is skipped entirely with an actionable `degradedWorkers` entry naming the likely cause (`.gitignore` review). Below threshold, the sub-agent receives `{path, sizeBytes, snippet}` triples (snippet = first 20 lines of content; whole file if smaller; binary files send path + size only). The sub-agent emits Zod-validated `{path, line?, snippet, reason, severity}` findings into the `questions[]` lane with `kind: "question"` — preserving ADR-0020's invariant that LLMs do not author assertions, while still attaching citations the user can act on. The category remains `committability`.

3. **Substring-verification of question citations — extends ADR-0008.** Any `Comment` with `kind: "question"` that carries citations (now possible via the sub-agent) goes through a deterministic post-pass: read the cited line range, normalize whitespace, confirm the LLM's quoted snippet substring-matches the actual file content. Unverified citations are dropped silently; a forensic count surfaces in `degradedWorkers` as `{ kind: "info", topic: "llm", message: "dropped N citations without verifiable snippet" }`. Same posture as M3/OSV's "drop unverified advisories." This extends ADR-0008's citation discipline from assertions to questions: *any* citation, regardless of lane, must have a verifiable echo. Questions without citations (the common case from the main review LLM) skip verification — empty `sources[]` is not a violation, it's the discipline.

4. **Runtime schema migration (item 1 from M7 punch list — engine blocker).** `@warden/db`'s build copies `drizzle/migrations/` into `dist/migrations/` and exposes the path via an `import.meta.url`-resolved helper. The connection singleton in `packages/db/src/index.ts` calls `migrate(db, { migrationsFolder })` once per process, gated by a module-scoped `Promise<void>`; subsequent `db()` calls await the flag and see the migrated state. A DB ahead of the bundled migrations (user downgraded warden) is a hard error with an actionable message ("Cache schema is newer than this warden version (cache=v3, binary=v2). Upgrade warden or delete `.warden/cache.sqlite`").

5. **Banner state additions (item 2 from M7 punch list — engine blocker).** `BannerState` gains a peer state `no-embeddings`, triggered when `chunkCount > 0 && embeddingStore.count(lockedModel) === 0`. The banner-renderer's prefix-match list grows to include `no embeddings` so the semantic signal's `degradedWorkers` string ("context: no embeddings yet — run `warden init`") routes through the banner instead of buried in the verbose log. A broader `BannerState` discriminated-by-topic refactor is explicitly *not* scoped to M7.

6. **Repo-root precedence (item 8 from M7 punch list — engine blocker).** `findRepoRoot()` precedence flips to: nearest `pnpm-workspace.yaml` → nearest `.git/` → nearest `package.json` (lowest, not highest) → cwd. In a monorepo, `.warden/cache.sqlite` lives at the workspace root (one index per repo, mirroring `.git/`'s shape), not per sub-package. The "highest ancestor with `package.json`" footgun that put cache files in `~/Developer/` if any stray parent `package.json` existed is closed.

7. **`degradedWorkers` discriminated shape (item 7 from M7 punch list — gates ADR-0021 #3).** From `string[]` to `{ kind: "actionable" | "warning" | "info"; topic: string; message: string }[]`. Banner renderer reads `kind` instead of substring-matching message prefixes; verbose mode shows all three kinds; default mode surfaces only `actionable`. Conventional `topic` values: `context`, `osv`, `gitignore`, `committability`, `scalability`, `deadcode`, `consistency`, `embeddings`, `schema`, `llm`. Topic is an open string for forward compat. Every existing `degradedWorkers.push(...)` call site migrates.

8. **npm-audit collapse-unless-manifest-touched (item 10 from M7 punch list — output sanity).** When the diff doesn't modify `package.json` / `package-lock.json` / `pnpm-lock.yaml` / `yarn.lock`, npm-audit findings collapse into a single summary `Comment` ("repo has 61 known vulnerabilities; none introduced by this diff. Run `pnpm audit` for details.") instead of streaming all 61 advisories pinned to `package.json:1`. When the diff *does* touch a manifest, full per-advisory output is preserved (the user is currently reasoning about dependency changes; volume is appropriate). Diff-touches-manifest is the gate; the verifier discipline (ADR-0008 + OSV) is unchanged.

9. **Cheap polish items in M7.** Punch-list #5 (init summary wording: `"319 chunks (319 cached) · 0/319 embeddings · 3 failed"` — splits the chunk cache from the embedding cache in the summary line so a wholesale Phase-3 failure is no longer indistinguishable from a clean re-run); #6 (banner placement: pre-phase per ADR-0019 #7's intent; one block-move in `runReview()` to align rendered output with ADR-spec); #12 (ensureGitignore atomicity: move the call after schema bootstrap so a fresh-repo crash on item 1 no longer leaves a half-applied side-effect); #14 (Voyage echo verification: assert `json.model === this._modelId` in `VoyageProvider.fetchOnce`; on mismatch, hard-fail with a clear "voyage served X, we asked for Y — index integrity at risk" — the locked-model invariant is only worth what its detection oracle is). Punch-list #3, #4, #9, #13 are deferred to M8 polish.

10. **Sub-agent introduces the third LLM call shape into the review pipeline.** Existing pipeline does one main LLM call (M4 formatter) plus one Voyage query embed (M6 selector v2). M7 adds the cheap-tier sub-agent for committability, gated by the file-count threshold. ADR-0017's multi-provider fallback chain (Anthropic primary → retry → Google) applies to the sub-agent identically. Sub-agent failure (timeout, malformed JSON, both-providers-down) drops the `committability` category for the run with a `degradedWorkers: { kind: "warning", topic: "committability", message: "sub-agent failed: <reason>" }` entry; the rest of the review is unaffected.

11. **TS-only for M7.** All three deterministic detectors target TypeScript via M5's `TsCompilerParser`. Tree-sitter swap-in for Python / Rust / Go / Java (the `code-chunk` languages M6 already chunks) stays in the M8+ multi-language milestone, gated by ADR-0019's "wait for dogfood evidence." The committability sub-agent is language-agnostic by construction (it reads filenames and content shapes; the LLM handles language-specific recognition on its own).

12. **Smoke harness lands in M7.** `packages/cli/scripts/smoke-m7-init.mts` (validates blockers 1, 2, 8 on a fresh repo), `smoke-m7-detectors.mts` (validates the three deterministic detectors against fixtures derived from PR #3), and `smoke-m7-subagent.mts` (validates committability sub-agent against the `scripts-bootstrap-blair.mts`-shaped case). Mirrors M5's `smoke-m5-{selector,jscpd}.mts` pattern. CI runs them.

**Why.**

The headline tension in M7 is that ADR-0020 deliberately routed all four new categories through the `questions[]` lane to preserve ADR-0008's citation discipline ("LLMs ask, never assert"), while M7's job is to *upgrade* three of those four to `findings[]` (assertions with grounded citations). The reasoning chain that produced this:

- *Q1's scope cut.* M6's deferral list (BYOEmbedder, cross-repo retrieval, SAST worker, daemon JobRunner, etc.) is each its own milestone-shaped ADR. Bundling any of them into M7 dilutes both the engine-maturity blockers and the category-upgrade focus. ADR-0020 + the M6 punch-list are already a coherent unit; the architecturally heavier work waits for evidence.

- *Q2's hybrid framing.* Each of the four categories sits at a different point on the deterministic ↔ LLM spectrum: scalability is AST-pattern-shaped (Drizzle/Prisma query chains have an exact AST signature); deadcode is AST + import-graph shaped (M5 already has the reverse-graph machinery); consistency has a *structured* sub-shape (env-var / CLI / file-path claims) that's deterministically verifiable, even though free-form prose isn't; committability is meta-property recognition where the LLM is genuinely better than a regex set the user would have to maintain. Treating all four uniformly (all detectors *or* all prompts) gets one of them wrong; treating each according to its natural shape preserves ADR-0008 where deterministic detection is possible and acknowledges where LLM judgment is the right tool.

- *Q4's substring-verifier extension.* The committability sub-agent emits citations alongside its questions — the filename, the line, the snippet. Citations on the question lane are new. ADR-0008's discipline ("every assertion needs a verifiable source") generalizes naturally: every *citation*, regardless of lane, gets a verifiable echo. Substring-match of the LLM's quoted snippet against actual file content is the cheapest possible verification; second-LLM verification reintroduces the LLM-checks-LLM trust loop ADR-0008 explicitly rejects. Drop-and-record-forensically mirrors M3/OSV's "drop unverified advisories" posture.

- *Q5+Q6's pipeline reduction.* First sketch had a doc-claim extractor worker feeding a separate doc-code-verifier *phase* between worker-merge and the main LLM call. Refining the v0 consistency worker to deterministic-only (env-var / CLI / file-path structured claims) collapsed the architecture: extraction + verification both deterministic means a single worker, no new sequential phase. The verifier-phase architecture is reserved for free-form prose claims (M8+); v0 doesn't need it. "Build the seam, don't fill it" was the alternative; rejected because empty seams accumulate when there's no concrete consumer testing them.

- *Q9–Q11's flip on committability.* Initial sketch was a deterministic regex worker for filename/content patterns (`scripts-*`, `bootstrap-*`, `/Users/`, `DO NOT MERGE`). User's pushback: added-file lists are typically small (<10 in normal PRs); the LLM is better at "this filename looks suspicious" than a fixed pattern set the user has to maintain; the file path itself *is* a grounded citation, so ADR-0008's discipline survives. The sub-agent path is also where we land if M8 ever wants to extend committability to less-obvious patterns (mid-file hardcoded URLs to dev infrastructure, accidentally-committed `.env.local` content, etc.) — the regex set saturates fast; the sub-agent grows with the LLM.

- *Q12's blockers-first sequencing.* Items 1, 2, 8 of the M7 punch list block the dogfood path for any user other than the warden author running on warden's own repo. Until they cross, the rest of M7's quality lift is invisible to anyone trying it on a fresh repo. Sequencing them as Slice 1 (with a smoke harness validating they're crossed) is the only honest gate; anything else builds detector quality on a foundation that crashes on first contact with a new user.

- *Q13's punch-list scoping.* Item 7 (discriminated `degradedWorkers`) is non-negotiable because Q4's verifier emissions and Q11's sub-agent skip-warning both depend on it. Item 10 (npm-audit collapse) is non-negotiable because M7's quality lift is invisible if the output is still 90% transitive-vuln noise. Item 11 (smoke harness) is non-negotiable because "blockers crossed" without smoke is vibes. The four cheap polish items (#5, #6, #12, #14) cost ~30 minutes each and remove specific ambiguities surfaced during M6 dogfood; deferring them buys nothing. The four genuinely deferred items (#3, #4, #9, #13) all touch UX surfaces that are second-order to M7's category-upgrade focus.

- *Q15's ADR shape.* Single milestone-scoped ADR mirrors ADR-0018 (M5) and ADR-0019 (M6). The three architectural shifts in M7 (detector promotion, sub-agent, question citation discipline) are deeply coupled — question-citation discipline only matters because sub-agents emit citations; sub-agent committability is a special case of "LLM-asserts-with-cite-and-verify" applied to questions. Splitting into ADR-0021/0022/0023 would require cross-references in three directions and break the precedent. Future M8+ work that revises M7's design (upgrading committability from sub-agent-questions to a deterministic detector, adding free-form prose to consistency, etc.) gets its own ADR.

- *Q16's slice ordering.* Foundations (Slice 1: items 1, 2, 7, 8, 11) before any detector; npm-audit collapse (Slice 2: item 10) before any detector ships findings, since the noise-floor matters for evaluating new findings; detectors land in increasing-novelty order (Scalability / Deadcode / Consistency / Committability) so the simpler patterns smoke-validate the worker integration before the sub-agent's new shape lands; polish (Slice 7: items 5, 6, 12, 14) at the end after the surface area has stabilized; close-out (Slice 8) hands off to M8 with the dogfood report.

- *Q17's deferral of language-aware guidance.* Total-TS-style code-quality opinions (single source of truth; type reuse via `Pick`/`Omit`/utility types; derive types from runtime via `typeof`/`as const`/`satisfies`; avoid `any`; prefer discriminated unions) all map onto existing categories — SSOT violations are dedup; derive-don't-duplicate is dedup or clarity; `as const` / `satisfies` is clarity; `any`-escape-hatches are correctness — so no new category is warranted. Pre-training and fine-tuning are architecturally incompatible (ADR-0006 tiered models, ADR-0017 multi-provider fallback). The viable paths are static prompt-section extension (cheap, saturates ~20 patterns) or retrieval-augmented language guidance (couples to M6's chunk store). Both want their own grilling; deferring to M8 keeps the choice coherent.

**Alternatives considered and rejected.**

- *Pure prompt extension for all four categories.* Cheapest path; the LLM gets four new instruction sections; no detector code. Rejected because it erodes ADR-0008's citation thesis: the differentiation against plain Copilot is grounded findings + citations, not "the LLM looks for these patterns." Copilot caught 6/9 things warden missed *because* it's a competent LLM with adjacent context. Racing Copilot at its own game without the warden differentiator (deterministic detectors + grounded citations) loses on principle.

- *All four as deterministic detectors.* Force consistency into a deterministic shape (e.g., regex-extract env vars from README and check `wardenEnv()` schema only); force committability into a regex set. Rejected for consistency because most doc-code claims aren't env-var-shaped — file-path constants and CLI command shapes work, but the *general* prose-vs-code axis is genuinely LLM-shaped, and v0 should pick the achievable subset cleanly. Rejected for committability per Q9–Q11's reasoning: regex sets saturate fast; LLM judgment scales.

- *Sub-agent for committability emits to `findings[]` instead of `questions[]`.* Considered as an extension of ADR-0020 — formalize "LLM-asserts-with-cite-and-substring-verify" as a third assertion type. Rejected because the lane invariant is load-bearing for downstream consumers (CLI formatter, JSON output, future bots); breaking it means every consumer needs to handle "LLM-asserted findings vs. detector-asserted findings" as semantically distinct; the user-visible behavior of question-with-citation vs. finding-with-citation is nearly identical (both render with file:line context), so the lane discipline buys ADR-0008 conformance for free.

- *Verifier-phase architecture for consistency, kept even though v0 is deterministic-only.* "Build the seam, don't fill it" — reserve the architectural slot for M8+ free-form prose. Rejected because empty seams are dead architecture; the build-the-seam instinct is right when there's a concrete consumer about to materialize, wrong when there's only a hypothetical M8 use case. M8 can add the seam as part of its own ADR when free-form prose claims earn rent.

- *Land detectors in parallel rather than sequentially.* Faster wall-clock if no surprises; harder to debug regressions; loses per-slice smoke discipline. Rejected because M7 is the first time the worker pipeline gets four new entries simultaneously, and the sub-agent introduces a new shape (LLM call as a worker) — sequential land-and-smoke surfaces integration issues one at a time.

- *Repo-wide deadcode scan, not just diff-touched + 1-hop.* Higher recall on first run; expensive on every review; most findings would be pre-existing dead branches that aren't part of the user's current change. Rejected because M7 should care about what the diff introduces; pre-existing dead branches are an audit-verb concern (M8+).

- *Reorder detectors to land committability first.* The sub-agent is the most novel pattern and the easiest to validate (filename-shaped findings on a known offending file). Rejected because front-loading the most-novel piece amplifies integration risk; the three deterministic detectors validate the worker pattern first, then the sub-agent lands on a stable foundation.

- *Tighter acceptance — drop the dogfood validation gate.* Acceptance = punch-list crossed + detectors emit on test fixtures. No requirement that warden actually catches Copilot's M6 findings. Rejected because the entire premise of ADR-0020 + ADR-0021 is "Copilot caught 6/9 things; M7 closes that gap"; not validating that gate means M7 might ship four detectors that don't, in practice, catch the cases that motivated them.

- *Land language-aware review guidance (Total-TS-style code-quality) in M7.* Either a static prompt section (~15 lines) or retrieval-augmented (curated TS-pattern corpus indexed alongside user repo via M6 chunk store). Rejected — the prompt-section/retrieval/scope-detection design space is its own grilling; folding a half-formed version into M7 would either ship a saturating baseline that inhibits later redesign (the prompt-section trap) or balloon scope (retrieval-augmented at this stage). Defer to M8 as a coherent unit.

- *Three smaller single-concern ADRs (0021 promotion, 0022 sub-agent, 0023 question-citation).* Cleaner separation, easier independent evolution. Rejected because the three decisions are deeply coupled (question-citation discipline only exists *because* the sub-agent emits citations); the milestone-ADR convention from ADR-0018 + ADR-0019 keeps decisions discoverable by milestone.

- *Amend ADR-0020 in place.* Smallest doc footprint; updates ADR-0020's M7+ section in-line. Rejected because the appended-never-modified property of the ADR series is what makes diffing "what did ADR-0020 say at v1 vs. v2" tractable; in-place amendment trades clarity for compactness.

**Caveat — ADR-0021 amends ADR-0008's citation discipline by extending it to questions.** Until ADR-0021, ADR-0008's "LLMs cite or don't claim" rule applied only to assertions; questions had empty `sources[]` by design (asking is not claiming, so no citation was needed). ADR-0021's sub-agent emits questions *with* citations, and the substring-verifier applies to those citations. The discipline strengthens: any citation, regardless of lane, must echo content in the cited file. The original ADR-0008 invariant ("the LLM cannot author findings without a tool source") is preserved — the sub-agent isn't asserting findings, it's asking grounded questions whose grounding is mechanically checkable.

**Caveat — `scalability-detector`'s false-positive posture leans on the LLM triage layer.** The detector emits direct findings on every match of its trigger patterns; the LLM triage layer (M4 formatter) may downgrade severity or drop the finding when surrounding context (a tight `where` clause, a comment asserting bounded set size, a JS-side type-narrowing predicate the schema can't express) makes the smell harmless. This is the same posture jscpd's dedup findings have today (detector emits, LLM filters with context). Suppressing in-detector requires schema introspection the detector doesn't have; trusting the LLM triage layer is the principled tradeoff. False-positive rate is a tuning concern that gets re-evaluated post-dogfood, not a correctness concern.

**Caveat — `deadcode-detector`'s 1-hop scope misses cross-package transitive callers.** A function in `@warden/core` might be re-exported through `@warden/cli` and called from `@warden/cli`; the 1-hop reverse `import_graph` from the diff catches direct importers but not callers transitively reached through re-exports. M5's `import_graph` is file-level, not symbol-level, so re-exports flatten correctly — the worry is callers more than one re-export hop away. v0 acceptance is "catches the M6 PR's `computeBannerState` case"; tuning to multi-hop scope is a M8 candidate if dogfood shows the 1-hop-blind miss rate is meaningful. Dynamic dispatch (`obj[methodName]()`) is also out of scope; the LLM triage layer can downgrade if it sees dynamic-dispatch shape nearby.

**Caveat — `consistency-detector` v0 has zero recall on prose claims.** Structured-only means: env-var requirements / CLI command shapes / file-path constants are detected; statements like "the cache is content-addressed" or "diff is the target, retrieval is adjudication context" are not. The gap is intentional: free-form prose extraction needs LLM extraction + LLM verification (an entirely new worker shape) and the structured subset cleanly closes the v0 motivating case (Copilot's `VOYAGE_API_KEY` finding). Open-slot LLM questions can still surface prose mismatches the LLM happens to spot — they slot under `consistency` via category tagging in the questions lane. M8 may add a free-form prose path as a separate worker (or extend this one with a free-form mode); deferred until dogfood reveals the structured-only recall is insufficient.

**Caveat — committability sub-agent introduces the first per-review LLM-call multiplication.** Until M7, every `warden review` made one main LLM call. The sub-agent adds a second (cheap-tier) call. The total per-review cost grows from ~$0.005 (Sonnet main) to ~$0.005 + ~$0.0005 (Haiku sub-agent) on typical diffs — small in absolute terms but visible in the cost-accounting story. M8+ extensions of the sub-agent pattern (free-form consistency verification, language-aware guidance retrieval-augmented prompts) compound this; ADR-0021 doesn't pre-decide a budget, but the scaling shape is now visible.

**Caveat — runtime schema migration is the most impactful single change in M7 by user-facing impact.** Every `warden init` against a fresh repo crashes today on `no such table: index_meta`. Item 1 is one function-call's worth of code (`migrate(db, { migrationsFolder })`) gated behind a singleton promise; the build configuration to bundle migrations into `dist/` is the larger surface. Worth dogfooding on at least three fresh repos (e.g., another scratch project plus blair plus milkpod) to confirm the migration path works across pnpm-cached vs. npm-cached vs. fresh-install scenarios.

**Caveat — `degradedWorkers` discriminated migration is a fan-out edit.** Every existing `degradedWorkers.push("string")` call site becomes `degradedWorkers.push({ kind, topic, message })`. Approximately 15-20 call sites across the codebase. Worth a single mechanical refactor pass before any new detector lands, so the new detectors emit the discriminated shape from day one rather than the old string shape. The banner renderer's prefix-match list becomes a `kind`-filter; the verbose log shows all three kinds. The renderer change is the visible invariant; the call-site fan-out is the cost.

**Caveat — npm-audit collapse changes default-mode output substantially.** Today: every transitive vulnerability shows as a `package.json:1` finding. After M7: zero per-vuln findings on a non-manifest-touching diff, replaced by a single summary line. Users who relied on warden surfacing repo-wide vulnerabilities incidentally (without manifest changes) will see a behavior change. The verbose mode preserves the old behavior (`--verbose` shows full per-advisory list); the default mode trades volume for relevance. ADR-0008's verifier discipline (OSV citation) is unchanged — what changed is the *aggregation*, not the detection.

**Caveat — sub-agent failure modes and ADR-0017 fallback.** ADR-0017's Anthropic → retry → Google fallback applies to the sub-agent identically. Sub-agent timeout, malformed JSON, both-providers-down → drop committability for the run with a `warning`-kind degraded entry; the rest of the review is unaffected. Sub-agent partial success (returns 5 findings, 2 fail substring-verification) → emit the 3 verified, drop the 2 with an `info`-kind entry. The chain isolates committability blast radius; main review LLM calls are unchanged. Mid-stream key-change handling stays an M8+ concern per ADR-0019's deferral.

**Caveat — TS-only horizon for M7's deterministic detectors.** All three detectors target TypeScript. M6's `code-chunk` already chunks Python / Rust / Go / Java; the embedding path is language-agnostic from M6 onward. The detector path is not — `TsCompilerParser` is TS-shaped. Tree-sitter swap-in for multi-language detectors is the M8+ multi-language milestone, gated by ADR-0019's "wait for dogfood evidence" posture. The committability sub-agent is language-agnostic by construction.

**Caveat — ADR-0019's M7 punch-list (items 1–14 in `m6-plan.md`) is partially absorbed.** Items 1, 2, 5, 6, 7, 8, 10, 11, 12, 14 are M7 scope per this ADR's decisions. Items 3, 4, 9, 13 (Voyage retry classifier body-peek; embed-phase featureless spinner; pre-flight estimate refresh; `--simulate-fail-embed` test seam) are deferred to M8 polish. Each is small individually; bundled, they're a polish slice that fits cleanly after M7's category-upgrade story stabilizes.

**Caveat — this ADR codifies an upgrade pattern future ADRs will reuse.** ADR-0020 introduced "LLM asks via questions[] today; deterministic detector asserts via findings[] later." ADR-0021 implements that for three categories and adds a third lane (sub-agent emits citations into questions[]). The pattern — *categories shipped as questions; promoted to findings/sub-agent-citations as deterministic producers earn rent* — applies to any future category extension. M8+ may add `security-pattern` (custom-code SAST), `leverage` (cross-repo), `api-claim` (third-party API-shape verification), each starting as a question-lane category and graduating per its own ADR. The lane discipline (LLM never asserts, sub-agents emit grounded questions, deterministic detectors emit grounded assertions) is the architectural through-line.

**Caveat — this is a *direction*, not a milestone schedule.** M7 is the next milestone, but its acceptance bar is "blockers crossed + four category upgrades land + dogfood validation against M6 PR #3 catches at-least the 4-of-9 Copilot findings that motivated ADR-0020," not a calendar. Per ADR-0001's single-user-built-right posture, dogfooding pacing dominates artificial deadlines.

**Status (per numbered point in the Decision section).**

| # | Sub-point | Status |
|---|-----------|--------|
| 1 | Three deterministic detector workers | Done — `scalability-detector` (`packages/core/src/runners/scalability.ts`), `deadcode-detector` (`runners/deadcode.ts`), and `consistency-detector` (`runners/consistency.ts`, M10) all shipped. |
| 2 | `committability-subagent` worker | Done — `runners/committability.ts` ships the cheap-tier Haiku sub-agent; M10 migrated its emissions through `sources[]` with the new `{path, line, snippet}` triple. |
| 3 | Substring-verification of question citations | Done — global verifier post-pass in `packages/core/src/llm/verify-citations.ts` runs after `synthesize()` / `deterministicSynthesize()` and before `applyHardRules()` (M10). |
| 4 | Runtime schema migration | Done — `db()` in `packages/db/src/index.ts` calls `migrate()` with bundled `dist/migrations/`. |
| 5 | `BannerState` `no-embeddings` peer | Done — `packages/core/src/banner/index.ts` emits `{ kind: "no-embeddings" }`. |
| 6 | Repo-root precedence (`pnpm-workspace.yaml` → `.git` → `package.json`) | Done — `packages/db/src/path.ts:findRepoRoot()`. |
| 7 | Discriminated `degradedWorkers` shape | Done — `{ kind, topic, message }` flowing across all push sites. |
| 8 | npm-audit collapse-unless-manifest-touched | Done — `collapseVulnComments()` + `manifestTouched` gating in `packages/core/src/index.ts`. |
| 9 | Cheap polish (#5 / #6 / #12 / #14) | Partial — verify per-item before claiming closed; banner placement and runtime-migration ordering both in line with intent. |
| 10 | Sub-agent as third LLM call shape | Open — gated on #2. |
| 11 | TS-only horizon | Done — all detectors built on `TsCompilerParser`. |
| 12 | Smoke harness | Done — `smoke-m7-init.mts` + `smoke-m7-detectors.mts` (M7), `smoke-m8-spine.mts` (M8 contract), `smoke-m10-consistency.mts` + `smoke-m10-verifier.mts` (M10) shipped. |

---

## ADR-0022 — M9: diff-level noise filter; M7 placeholder via directory-concentration heuristic

**Decision.** A pre-runner stage that prunes the diff before any runner consumes it ships in M9 as the right architectural answer to the catastrophic-input problem (committed `node_modules/` or its ecosystem equivalent). The full design — ecosystem-detection-driven, profile-loaded, depth-limited tree pruning, with bounded memory regardless of input size — is described below and milestone-planned in `m9-plan.md`. M7 ships only a single-heuristic placeholder, scoped to the committability sub-agent: skip if any one top-level directory contributes >80% of added files (the "node_modules dump" signature) *or* if added files exceed 200 with no dominator. The degraded entry is `actionable` and names the suspect directory by name so the user can fix `.gitignore` directly. This supersedes ADR-0021 #2's Tier-2 raw 500-file threshold; the Tier-1 hard-skip list (`.git/`, `*.pyc`, `*.swp`, `.DS_Store`, `Thumbs.db`, `.vscode/.history/`) is unchanged.

The full M9 design:

1. **Single seam at the diff loader.** The noise filter is a property of the diff input, not of any one runner. When the loader returns a diff, it returns a *pruned* diff — every downstream runner (TSC, ESLint, jscpd, vuln, the M7 deterministic detectors, the committability sub-agent) sees the same filtered input. No per-runner threading; no per-runner re-litigation of the noise policy.

2. **Ecosystem detection drives the filter.** M2's ecosystem detection (`packages/core/src/ecosystem/`) already classifies the repo by marker files (`package.json` → JS/TS, `pyproject.toml` → Python, `go.mod` → Go, etc.). The detector is extended to emit a list of detected ecosystems; the filter loads the corresponding **noise profiles** and unions them. Multi-ecosystem repos (JS + Python; JS + Rust) get the union of both profiles' rules.

3. **Noise profiles ship inside `@warden/core`.** Per-ecosystem JSON documents at `packages/core/src/ecosystem/profiles/{javascript,python,rust,go,java,csharp,ruby}.json` listing always-noise directories (`node_modules/`, `__pycache__/`, `target/`, `bin/`, `obj/`, etc.), context-dependent directories (`dist/`, `vendor/`, `build/`), generated extensions (`.pyc`, `.min.js`, `.d.ts.map`), and lock files. Profiles are *Warden's* knowledge, not the user's burden — no new config file (`.warden/ecosystems.toml` was rejected; ADR-0008's zero-config posture holds). User override flows through the existing `.reviewbot/overlay.yaml`.

4. **Diff tree representation, not flat list.** The filter aggregates `git diff --raw` into a depth-limited tree (≤3 levels) of `(path, addedCount, modifiedCount, deletedCount)` nodes. Memory is bounded by directory structure, not file count — a 500K-file diff still fits in a few KB. Pruning happens against subtrees: when a profile says `node_modules/` is always-noise and the tree shows `node_modules/ [+498,000 files]`, the entire subtree is dropped in one pass without enumerating the leaves.

5. **`.gitignore` is the user's per-repo declaration; profiles are belt-and-suspenders.** The catastrophic case is "someone removed `node_modules/` from `.gitignore`." When that happens, gitignore alone fails. Profiles defend: regardless of gitignore, JS-detected repos skip `node_modules/`. In the normal case, gitignore already prunes most of what profiles would catch; the filter is silently redundant — exactly as belt-and-suspenders should be.

6. **One degraded-entry per pruned subtree.** Each pruned subtree emits a `{ kind: "actionable", topic: "noise-filter", message: \`skipped \${count} files in \${path}/ (\${reason}, \${ecosystem} ecosystem)\` }`. The user sees what got pruned, why, and can act on it (fix `.gitignore`, override via `.reviewbot/overlay.yaml`). No new `warden show-skipped` verb — the degraded entries themselves are the explainability surface.

7. **Per-subtree ecosystem detection is M9's own sub-decision.** The clean case is single-ecosystem repos (JS-only, Python-only). The hard case is monorepos with directory-level ecosystem boundaries: `frontend/=JS, backend/=Python`. Ideally the filter detects ecosystems per top-level directory and applies profiles scoped to each subtree, so it doesn't accidentally skip `backend/vendor/` using the JS profile's rule about Go-specific `vendor/`. M9's own grilling decides whether per-subtree detection ships in the initial cut or as a follow-up.

**Why.**

- *Single seam vs. per-runner.* The catastrophic case wastes every runner. TSC tries to type-check 500K vendored files; ESLint lints them; jscpd dedup-scans them; vuln runs against the wrong manifests; the M7 detectors traverse vendored AST; the committability sub-agent costs the most when it does, but it's the loudest victim, not the only one. Filtering at the diff loader fixes all six in one place; the per-runner alternative re-litigates the noise policy six times and threads explainability through six emission paths.

- *Profiles vs. structural-only heuristics.* Pure structural heuristics (>80% concentration, binary skip, gitignore alignment) are ecosystem-agnostic by design — no profile maintenance. The disadvantage: degraded messages can only say `"skipped: appears to be bulk-added junk"` without naming *what* the junk is. Profiles let the message say `"skipped 498,000 files in node_modules/ (vendored JS dependencies)"` — confidence vs. guess. Trust matters; profiles ship.

- *Profiles inside Warden vs. user config.* `.warden/ecosystems.toml` was the alternative — a per-project config file the user maintains. Rejected because ADR-0008's zero-config posture is load-bearing for the OSS-quality bar (ADR-0001), and noise profiles are *Warden's* domain knowledge: every JS project has the same `node_modules/`, every Python project has the same `__pycache__/`. Nothing project-specific to configure unless the project has a non-standard generated directory — which is what `.reviewbot/overlay.yaml` is for.

- *Tree representation vs. flat list.* The pathological case (500K files) can't be held as a flat list anywhere — neither in memory nor in an LLM prompt. The tree representation is the only design that bounds memory by structure rather than count. Without it, the filter falls over on the exact case it was built to defend.

- *M7 placeholder vs. nothing.* The committability sub-agent is the loudest victim of unfiltered diffs (LLM cost scales linearly with files). Shipping M7 with no guard means the first user to commit `node_modules/` and run `warden review` gets a $5 sub-agent invocation. The directory-concentration heuristic catches that case for ~1 hour of code; deferring it would either delay M7 or accept the misfire. The placeholder is also a stub of M9's structural-heuristic layer — if it catches the cases that matter, M9 inherits real evidence about heuristic signal quality.

- *Why M9 and not M7.* The full design is materially more work than the M7 placeholder: ecosystem-profile authoring (one per language), diff-tree builder + pruner, integration into all six existing runners (each one's interface adapts to "diff is now a pruned tree, not a path list"), per-subtree ecosystem decision, smoke harness on synthetic catastrophic-diff fixtures, and a dogfood pass on at least three distinct ecosystems. Cramming it into M7 either delays M7 or half-bakes the filter.

**Alternatives considered and rejected.**

- *Sub-agent-only file-volume guard.* Cheapest path; just put a hard threshold around committability and call it done. Rejected because the catastrophic case (committed `node_modules/`) wastes every runner, not just the sub-agent. Fixing only the loudest victim leaves TSC, ESLint, jscpd, vuln, and the M7 detectors silently churning through vendored input.

- *Per-runner opt-in filter.* Each runner declares whether it wants the noise filter applied. Rejected because every new runner re-litigates the policy debate, the explainability surface splinters across emission paths, and there's no principled answer to "should TSC see vendored code?" — the answer is always no, and consolidating that in the loader is the single-truth design.

- *New `.warden/ecosystems.toml` config file.* User-authored profile + ignore-list overrides. Rejected because it violates ADR-0008's zero-config posture; the project-specific override case is what `.reviewbot/overlay.yaml` already handles; per-ecosystem profile data is Warden's domain knowledge.

- *Pure structural heuristics, no profiles.* Detect the catastrophic case via ecosystem-agnostic signals only. Rejected because trust matters: a degraded message that says `"appears to be vendored junk"` builds less confidence than one that says `"vendored JS dependencies (node_modules/)"`. Profiles are the cheap source of confidence; structural heuristics complement them but don't replace them.

- *Ship the full M9 design in M7.* Rejected per "Why M9 and not M7" — would delay M7 or half-bake the filter; both worse than placeholder + clean M9.

- *Defer everything (no M7 placeholder).* Ship M7 with raw 500-file threshold (ADR-0021's Tier-2 design). Rejected because the directory-concentration heuristic is a few-hours spike that catches the actual catastrophic case and pre-validates the structural-signal layer M9 will build on. Holding it for M9 buys nothing.

**Caveat — supersedes ADR-0021 #2's Tier-2 file-count gate.** ADR-0021 specified "Above 500 files post-Tier-1, the sub-agent is skipped entirely." ADR-0022 replaces that with the directory-concentration heuristic: skip if >80% of added files share one top-level directory *or* if added files >200 with no dominator. The Tier-1 hard-skip list (`.git/`, `*.pyc`, `*.swp`, `.DS_Store`, `Thumbs.db`, `.vscode/.history/`) is unchanged. Other M7 sub-points of ADR-0021 are unaffected.

**Caveat — per-subtree ecosystem detection is an M9 sub-decision, not a commitment.** The simple case (single-ecosystem repo; multi-ecosystem repo where ecosystems share root markers) is handled by root-level detection plus profile union. The hard case — monorepos with directory-level boundaries (`frontend/`=JS, `backend/`=Python) — needs per-top-level-directory marker detection. M9's grilling decides whether to ship per-subtree detection in the initial cut or as a follow-up; storage interfaces should accommodate it either way.

**Caveat — the M7 placeholder will misfire on legitimate large refactors.** A 1,000-file rename inside `packages/api/` triggers the >80% concentration rule. The user lives with the misfire (re-run with `--force-committability` if such a flag exists, or accept the noise) until M9 ships the full filter, at which point ecosystem profiles + tree pruning eliminate the catastrophic case without false positives on legitimate concentration. Mid-flight, the placeholder is honest about being a stub.

**Caveat — degraded `topic` namespace expands by one.** Topic `noise-filter` joins the conventional list (`context`, `osv`, `gitignore`, `committability`, `scalability`, `deadcode`, `consistency`, `embeddings`, `schema`, `llm`, `vuln`). Listed here so M9's emission sites don't reinvent the topic name.

**Caveat — `.reviewbot/overlay.yaml` semantics extend slightly.** Today the overlay handles known-debt suppression. M9 extends it to also override the noise filter — `noise.always: ["generated-api-client/", "proto-out/"]` for project-specific generated dirs, `noise.never: ["vendor/internal/"]` for project-specific real dirs the profile would otherwise skip. Schema migration is additive; existing overlays keep working.

**Status.** Direction. M7 placeholder ships per the directory-concentration heuristic above. Full M9 design tracked in `m9-plan.md`.

---

## ADR-0023 — M8: orchestration spine: dispatch + scratchpad + synthesizer

**Decision.** M8 ships the *spine* of the boss/worker orchestration deferred by ADR-0008 — dispatch, scratchpad, synthesizer — without the worker tier itself. The deferred concept (CONTEXT.md §3) reserves *worker* for vision-tier specialist Sonnet LLMs in a multi-call pipeline; M8 dispatches the *existing* runners (detectors + sub-agents per CONTEXT.md §5) through new orchestration plumbing, validating the contract against committability + scalability without committing to specialist-LLM workers. The dogfood gap that motivated this scheduling — Copilot caught 6 legit findings warden review missed on PR #4, 5 of which the user fixed in commit `8944ac3` — does not close in M8 (closing it requires the LLM-shaped sub-agents M9+ adds *on top of* this spine). M8's value is *enabling*: every M9+ AI-heavy capability (adversarial critic, self-aware invariant checker, free-form prose consistency, DeepSec-shaped SAST) plugs into this spine rather than reinventing dispatch and synthesis.

The full surface:

1. **Single deferred item, no bundle.** ADR-0008's deferral list (boss/worker orchestration, two-LLM generator+grader) plus the `project_warden_self_aware_boss.md` direction plus ADR-0019's deferred DeepSec-shaped SAST collectively constitute the AI-heavy roadmap. M8 schedules exactly one of them — boss/worker orchestration's *spine* — to preserve the milestone-shape discipline established by ADR-0018 / ADR-0019 / ADR-0021. Bundling two AI-heavy directions into one milestone is exactly the failure mode ADR-0008 was written to avoid.

2. **Spine, not full orchestration.** M8 does not ship dynamic dispatch (boss reasons about which runners to invoke per-diff); it does not ship the three execution modes from the inspiration blog (direct / parallel / explore-then-decide); it does not ship new LLM-shaped sub-agents (adversarial critic, self-aware checker). Dispatch is static — the same runners are invoked on every `warden review` and `warden check`, just routed through the new dispatch + scratchpad surface. Dynamic routing earns its own ADR when M9+ adds enough LLM-shaped workers to make routing decisions meaningful.

3. **Migration scope: committability + scalability through the contract; remaining 6 detectors stay inline.** The `Runner` contract is exercised by exactly two existing runners — committability (LLM cheap-tier sub-agent) and scalability (deterministic AST detector) — so the contract is validated against both shapes. TSC, ESLint, jscpd, vuln, deadcode, and consistency continue to run inline from `runReview()` in M8; their migration to the contract is M9+ work (likely M9 since the noise filter touches the same runner-input surface). Half-migrated state is acknowledged technical debt with a documented unwind path.

4. **In-memory `Scratchpad` class with structured per-runner output lifecycle.** `Scratchpad.outputs` is a `Map<runnerName, RunnerOutput>`; `RunnerOutput = { name, findings, questions?, degraded[], durationMs, error? }`. The Map is bounded by *runner count* (~8 today, ≤20 even in M11+), not diff size; pathological-diff memory pressure scales with findings volume identically in any storage shape and is solved upstream by M9's noise filter, not by the scratchpad. SQLite-backed scratchpad is rejected for M8 — `warden review` is short-lived (seconds), no crash-recovery consumer exists, and the class abstraction preserves the swap point for M11+ daemon scenarios where persistence would actually matter.

5. **Runner contract input is `path[]` (β); diff tree stays internal to `diff/`.** No current runner benefits from tree-aware input — TSC, ESLint, jscpd, vuln, scalability, deadcode, consistency, committability all consume paths and produce findings file-locally. Threading the diff tree into runner contracts (α) without a concrete tree-aware consumer is the "build the seam, don't fill it" pattern ADR-0018 / ADR-0019 / ADR-0021 each rejected. Future tree-aware runners (M9+ "directory-level dedup," "subtree-scoped semantic chunking" if those ever materialise) ship α at that point; β doesn't burn the option.

6. **Spine code lives in `packages/core/src/orchestration/`.** Dedicated directory: `orchestration/{scratchpad.ts, dispatch.ts, synthesizer.ts, runner.ts, index.ts}`. Mirrors M5's `context/` and M6's `indexing/` pattern — each new architectural concern earns its own directory. Pre-positions for a future `@warden/orchestration` workspace-package split if ADR-0019 #11's analogue triggers ever fire (e.g., DeepSec-shaped SAST worker dispatched alongside review runners; daemon mode with cross-process coordination). `packages/core/src/llm/` keeps the prompt loader, citation verifier, and the cascade (provider-fallback) — orchestration is *what we ask the LLM to do*, cascade is *how we reach it*.

7. **Unified pipeline: both verbs go through dispatch + scratchpad.** `warden check` and `warden review` share the dispatch + scratchpad layer; only the *synthesis ending* differs. `check` runs the existing deterministic formatter on scratchpad outputs (no LLM call); `review` runs the LLM synthesizer. One code path, two endings — adding an M9+ runner threads through dispatch once, not through two divergent pipelines. `check` also validates the spine without LLM cost: smoke fixtures and dogfood loops can exercise dispatch + scratchpad through `check` (deterministic, fast, free) before any synthesizer call ever runs.

8. **Synthesizer prompt: flat input.** The synthesizer flattens `Scratchpad → ToolFinding[]` before prompting; M4's existing system prompt + user template are unchanged. M4's prompt already labels findings by source (`tsc`, `eslint`, etc.); restructuring the prompt to organize findings by runner section is a *prompt redesign* with its own dogfood needs and shouldn't ride along with the spine refactor. M9+ may revisit when dynamic dispatch arrives and the prompt actually needs new structure.

9. **Concurrency and error model preserved.** Runners continue to dispatch in parallel via `Promise.all` (same as today). Per-runner failures land in `RunnerOutput.error?`; the dispatcher records a `degradedWorkers` entry of appropriate kind (`actionable` / `warning` / `info` per ADR-0021 #7); the rest of the review is unaffected. Same posture as ADR-0017's multi-provider fallback for the synthesizer's LLM call (Anthropic → retry → Google) — orchestration is *what we ask the LLM to do*, the cascade applies inside the synthesizer call unchanged.

10. **One smoke harness: `smoke-m8-spine.mts`.** Validates dispatch (per-runner outputs land in scratchpad with correct shape, durations recorded, errors captured), scratchpad (Map access, flatten helper, type safety), and dual-ending pipeline (`warden check` and `warden review` produce expected `CommentSet` from the same scratchpad on a fixture diff). Mirrors the M5/M7 pattern of "one smoke per architectural piece"; M8 spine is one piece.

11. **Re-platform committability + scalability; preserve M7 directory-concentration placeholder.** The committability sub-agent's M7 internal Tier-1 hard-skip + directory-concentration heuristic stays inside `committability.ts` until M9 ships the noise filter at the diff loader (per ADR-0022's M9 retarget). Migrating committability through the spine's `Runner` contract doesn't change its internal logic — same input shape, same output shape, same heuristics. Scalability migrates similarly: AST traversal logic unchanged, only the dispatch wrapper differs.

12. **ADR-0008 citation discipline: trivially preserved.** M8 ships zero new LLM-shaped sub-agents. Existing committability sub-agent already lives in `questions[]` per ADR-0021 #2 with substring-verification per ADR-0021 #3. The synthesizer's job is to triage and format scratchpad outputs — same posture as M4's formatter — never to author assertions. Citation invariant unchanged.

13. **TS-only horizon for M8.** Every runner under the contract is TS (per ADR-0021 #11's TS-only horizon). The contract itself is language-agnostic; tree-sitter swap-ins for Python / Rust / Go / Java land alongside per-language detectors in the M8+ multi-language milestone (still deferred), threading through the same spine.

**Why.**

- *The single-deferred-item discipline.* ADR-0018 / ADR-0019 / ADR-0021 each shipped exactly one architectural direction — context selector, indexing layer, detector promotion. M8 picking exactly one of the four AI-heavy deferrals (boss/worker orchestration spine) preserves the pattern. Bundling two (e.g., spine + adversarial critic worker) conflates "the spine works" with "the worker works" in dogfood evaluation; if dogfood reveals a quality regression, you can't tell which piece is responsible. One milestone = one architectural commit.

- *Spine before workers.* The four AI-heavy deferrals (boss/worker orchestration, two-LLM generator+grader, self-aware boss, DeepSec-shaped SAST) reframed under the orchestration model are *spine + roles* rather than *alternatives*. The spine is foundational; the others are workers/properties that plug into it. Shipping any of the others without the spine produces mid-tier work — exactly the framing the user rejected during the M8 grilling. Spine first; specific workers earn their own ADRs when scheduled.

- *Static dispatch in M8, dynamic dispatch in M9+.* The blog's reasoning-based routing is meaningful when the boss has *multiple* LLM-shaped workers to choose between. M8 has exactly one (committability) — a thin demonstration of dynamic routing that doesn't justify its own complexity. Static dispatch in M8 ships the spine; M9+ earns dynamic routing when 2+ LLM workers exist and the routing decision actually matters.

- *Q4-Mid migration scope (committability + scalability).* Half-migrated state is debt, but full migration of all 8 runners through the spine is a milestone-and-a-half of work — error channels, fixtures, smoke harnesses, runner registration. Q4-Min (committability only) under-validates the contract against deterministic shapes. Q4-Mid validates against both LLM-shaped (committability) and deterministic-AST (scalability) at minimum cost; the remaining 6 detectors migrate in M9 (likely) when the noise filter touches their input surface anyway.

- *β interface (`path[]`).* No current runner consumes tree-aware input. Threading the diff tree (α) through every runner contract without a consumer is dead seam. β preserves the option (M9+ tree-aware runners ship α at that point) without paying for it preemptively.

- *In-memory `Scratchpad` class.* The pathological case (500K-file diff) is solved at the diff loader by M9's noise filter, not at the scratchpad. The scratchpad's pressure is bounded by findings volume, which scales identically across storage shapes — SQLite doesn't reduce it. Crash recovery is not a real consumer for short-lived `warden review`. The class abstraction preserves the SQLite swap point for M11+ daemon scenarios; in-memory is the smallest credible cut today.

- *Q6-a dedicated `orchestration/` directory.* Spine concepts (scratchpad, dispatch, synthesizer) are tightly coupled and named; scattering them across `runners/` and `llm/` muddles the architectural concern. Pre-positions the workspace-package split point named in ADR-0019 #11's analogue triggers.

- *Q7-a unified pipeline.* `check` validates the spine without LLM cost; `review` adds the synthesizer call on the same scratchpad. One code path, two endings, one runner-addition surface. Splitting into two pipelines doubles the maintenance cost for every M9+ runner.

- *Q8 flat synthesizer prompt.* Restructuring the prompt to leverage Scratchpad's per-runner shape is a prompt redesign with its own dogfood evaluation; bundling it into M8 conflates spine validation with prompt validation. M4's existing prompt already labels by source; flattening preserves that. Prompt evolution becomes its own work when dynamic dispatch in M9+ actually demands new structure.

- *Naming: "orchestration spine" not "boss/worker spine."* CONTEXT.md §3 reserves *worker* for vision-tier specialist Sonnet LLMs in a multi-call pipeline. M8 ships dispatch + scratchpad + synthesizer with *no* workers — only existing runners (detectors + sub-agents per CONTEXT.md §5). Calling M8 "boss/worker spine" pre-claims the reserved term before workers actually exist. *Orchestration spine* is descriptive and honest; the ADR body still references "boss/worker orchestration" as the deferred long-term direction the spine pre-positions for.

**Alternatives considered and rejected.**

- *Bundle spine + first LLM-shaped worker (e.g., adversarial critic).* Closes some dogfood misses immediately and demonstrates orchestration is real. Rejected because it conflates "the spine works" with "a specific worker design works" — if dogfood reveals quality issues, attribution is muddled. Single-direction milestones is the established pattern (ADR-0018 / 0019 / 0021).

- *Spine-alone with no migrated runners (Q4-Min).* Smallest credible cut. Rejected because the contract validated against zero or one runner is likely wrong-shaped for the runners M9 has to migrate; M9 would discover the misshape and redesign, making M8 a partial throwaway. Q4-Mid validates against both shapes at minimum cost.

- *Q4-Full: migrate all 8 runners in M8.* Maximum validation. Rejected because it's a milestone-and-a-half of work — the user's ADR-0019 / ADR-0021 pattern is "smallest credible consumer" + iterate, not "migrate everything in one shot."

- *α interface (tree-aware runner input).* Maximum flexibility for downstream. Rejected because no current runner benefits from tree-aware input; α is dead seam without a consumer.

- *SQLite-backed scratchpad.* Crash-recoverable, inspectable post-hoc, queryable across runs. Rejected because `warden review` is short-lived; crash-recovery has no consumer; pathological-case memory pressure isn't reduced by storage choice. The class abstraction preserves the swap point for M11+ daemon scenarios.

- *Structured synthesizer prompt with per-runner sections + per-runner durations + error states surfaced to the LLM.* More information for the synthesizer to reason about. Rejected because it's a prompt redesign needing its own dogfood pass; M8's job is the spine, not prompt evolution.

- *Diverged pipelines: `check` keeps the inline path, `review` is the only spine consumer.* Less change to `check`. Rejected because two pipelines double the maintenance cost for every M9+ runner; unified pipeline + conditional ending is the architectural cleaner cut.

- *Full boss/worker orchestration in M8 (planning + dispatch + workers + synthesis with reasoning-based routing).* Closes the dogfood gap most aggressively. Rejected as too much architecture in one milestone — same scope-creep failure mode ADR-0008 was written against. Static dispatch + spine in M8; dynamic routing + workers earn their own M9+ ADRs.

- *Mid-tier "critic worker" ADR.* The first framing offered to the user during this grilling: ship a dedicated peer LLM that critiques the diff adversarially, separate from any orchestration spine. Rejected by the user because (a) it's an ad-hoc fix rather than a foundational architectural commitment, and (b) the same capability is naturally a worker dispatched by the spine in M9+, not a freestanding ADR. Memorialised so future grilling sessions can reference the rejected framing.

- *Self-aware boss as M8.* Closes the most embarrassing dogfood miss (#2: `collapseVulnComments` violating ADR-0008's own citation discipline). Rejected because *self-aware boss* is a *property* of the boss, not an architecture — adding introspection to a boss that doesn't yet have a dispatch surface to introspect against is putting the cart before the horse. Self-aware boss earns its own ADR after the spine ships and there's actually a boss with introspectable behavior.

- *Two-LLM generator+grader as M8.* Closest to ADR-0008's deferred phrasing. Rejected because generator+grader only catches misses *within the formatter's own scope*; it doesn't add adversarial coverage of code the formatter didn't comment on. The dogfood evidence (Copilot beats warden) suggests the missing capability is *adversarial reading of the diff*, which a grader of the formatter's output doesn't supply. Adversarial reading is a worker the spine dispatches in M9+; generator+grader is a different worker shape that may also earn its own ADR.

**Caveats.**

- *Caveat — does not close the M7 PR dogfood gap by itself.* M8's value is enabling, not closing. Six findings Copilot caught on PR #4 (scopeToDiff cross-function bug, citation discipline self-violation, doc-code drift in `formatCommentSet`, `import.meta.dirname` runtime brittleness, dead-branch `findings.length >= 0` term, hard-coded path in error message) remain uncaught by warden review until M9+ adds the LLM-shaped sub-agents (adversarial critic, free-form prose consistency, etc.) that the spine dispatches. Honest scheduling: spine first; capability second.

- *Caveat — half-migrated runner state is acknowledged debt.* Six deterministic detectors (TSC, ESLint, jscpd, vuln, deadcode, consistency) stay inline in M8; only committability + scalability migrate through the contract. M9 likely closes this when the noise filter touches the same runner-input surface; if M9 ships before the migration is forced, the debt persists into M10. Documented unwind path: each remaining runner's wrapper is ~30 lines of adapter code matching the same `Runner` contract committability and scalability already exercise.

- *Caveat — `worker` stays a reserved term.* CONTEXT.md §3's *worker* (vision-tier specialist Sonnet LLM in a multi-call pipeline) is *still deferred* after M8 ships. M8's spine is *boss + dispatch + scratchpad + synthesizer* routing existing runners; it earns the right to dispatch a worker if and when one ships, but no worker ships in M8. The ADR title and prose deliberately avoid "boss/worker spine" to honor the vocabulary discipline.

- *Caveat — synthesizer is the same LLM call M4 ships, not a new one.* No additional cost or latency in M8. The synthesizer reads `Scratchpad → ToolFinding[]` (flatten helper) before prompting; the cascade (Anthropic → retry → Google per ADR-0017) and prompt template (ADR-0015's externalised `system.md` / `user-template.md`) are unchanged. Cost-neutral for the M4 → M8 transition.

- *Caveat — committability's M7 directory-concentration placeholder stays inside `committability.ts` until M9.* Per ADR-0022's M9 retarget, the noise filter at the diff loader supersedes the placeholder. Migrating committability through the spine's `Runner` contract doesn't change this — same internal Tier-1 + concentration heuristic logic. M9's noise filter removes the placeholder when it ships.

- *Caveat — orchestration directory is internal to `@warden/core` in M8.* No `@warden/orchestration` workspace package; ADR-0019 #11's analogue split-justification triggers (non-review consumer of orchestration emerges; daemon mode with cross-process coordination; external consumers want to register their own runners against the spine) don't fire. Documented for future revisit; the directory is the clean extraction point if any of those triggers materialise.

- *Caveat — the inspiration source (`https://www.ronit.one/blog/agent-orch`) is acknowledged but warden's spine differs in shape.* The blog's three execution modes (direct / parallel / explore-then-decide) and reasoning-based routing are M9+ work, not M8. M8 is "shared scratchpad + parallel dispatch + boss synthesis" — the foundational subset. Sub-agents in the blog write to a Redis scratchpad; warden's in-memory `Scratchpad` is the equivalent for single-process use, with the SQLite swap point preserved for M11+ daemon scenarios where Redis-equivalent persistence would matter.

**Status.** Direction. M8 grilling complete (Q1 → Q8); design locked. Implementation tracked in `m8-plan.md`.

---

## ADR-0024 — Post-release public surface: docs + marketing + showcase site at `apps/web/`

**Decision.** Warden ships a public-facing docs + marketing + showcase surface as a single Astro app at `apps/web/`, deployed at `wrdn.beauty`. The site is **personal-portfolio-grade**, not a commercial OSS launch — sized to the "elaborate solo project, won't renew domains" framing that extends ADR-0001's audience posture. Three audiences: peers and recruiters who land via shared link; the curious-engineer audience that wants to read architectural reasoning; future-me browsing for orientation. ADR-0024 is *direction-only*; implementation is gated on the CLI dogfood loop establishing product quality post-M9-or-equivalent, with the domain purchased at deploy time, not at ADR commit time. ADR-0014's deferred *interactive triage* web app is a sibling future surface, **not** collapsed into ADR-0024 — they have different audiences (read-only marketing + docs vs. interactive feedback loop) and cleanly orthogonal designs. The naming-collision concern from `project_warden_naming_collision.md` (`@sentry/warden`, bare `warden` taken on npm) is dormant under solo-project framing; ADR-0003 stays unreopened.

The full surface:

1. **Audience: personal-portfolio-grade public surface, not OSS-product launch.** ADR-0001's "single user, OSS-quality bar" still applies; ADR-0024 widens the audience to "people the user shares the link with" (peers, recruiters, ad-hoc visitors) without committing to a community / contributor / commercial-product trajectory. Domain is intentionally non-renewing — the surface lives as long as the project is active, then expires. No SEO target, no contribution onboarding, no community moderation, no support channels. Discoverability isn't a goal, so the naming-collision blocker dissolves.

2. **Scope: static (a)-tier — no interactive backend.** The site renders pre-generated `CommentSet` JSON fixtures as styled HTML, plus asciinema casts, plus a JS-animated hero. No paste-a-diff playground, no GitHub-PR-URL form, no hosted backend that calls `@warden/core`. The interactive-playground option (call it (b)) was rejected — it requires hosted infra, API keys, queue, abuse mitigation, and is essentially the inner mechanics of ADR-0013's GitHub PR bot exposed via web form. The triage-UI option (call it (c)) was rejected because it collapses ADR-0014's deferred interactive surface into ADR-0024 — different audiences, different shapes, different infra needs.

3. **Internal vs external docs: mirror — parallel surfaces, not transcluded, not refactored.** `decisions.md`, `CONTEXT.md`, `vision.md`, `m*-plan.md`, and `CLAUDE.md` stay exactly where they are, written for internal audiences (me-in-six-months, future agents, future contributors) in their existing declarative-ADR voice. The docs site is its own content, written for *external* readers in a task-shaped voice (install, configuration, "how do I read a comment," CI integration). Some content (install, env vars, command summary) is duplicated across `README.md` and the docs site; the small sync burden is accepted in exchange for audience-clarity. A `/design` page links *out* to `decisions.md` and `vision.md` on GitHub for the curious-engineer audience.

4. **One Astro app at `apps/web/`, not split.** Single project, single deploy, single design system, single nav. Routes: `/` (marketing landing), `/docs/*` (Starlight-managed docs), `/examples` (`CommentSet` showcase), `/design` (deep-dive links). Splitting marketing and docs into separate apps was rejected as overkill — for a single-author project, one Astro app matches the existing monorepo "one app per consumer" convention (ADR-0013), where the consumer here is "the public web surface." Mirrors `../milkpod`'s shape.

5. **Stack: Astro + Starlight + `<ClientRouter />` + `data-astro-prefetch`.** Static-first by design, matches opencode.ai's reference precedent, ships docs theme out of the box (sidebar, search via Pagefind, dark mode, mobile nav, MDX, Shiki). Navigation is SPA-feel via View Transitions + prefetch-on-hover, addressing the "instant route switches" concern without committing to a hand-built TanStack Router docs theme. Solid is available per-island (`@astrojs/solid-js`) when a heavy interactive component justifies it; not the default. Next.js + Nextra rejected for App Router navigation latency. Pure TanStack Router SPA rejected for the 2–3 week docs-theme rebuild cost. Mintlify rejected for being docs-only (incompatible with one-app-with-marketing).

6. **Domain: `wrdn.beauty`, purchased at implementation-time.** Not bought until the site is built and ready to deploy. The `.beauty` TLD is the "memorable beats safe" choice for a portfolio piece — striking enough to be a conversation starter, on-brand with warden's craft posture (the polish/delight/distill skill set). `wrdn.site` was the safe alternative; rejected as forgettable. ADR-0003's broader naming question (npm slot, full `warden` namespace) stays dormant under the solo-project framing — there's no public install command competing for the bare name.

7. **`CommentSet` renderer: inline at `apps/web/src/components/CommentSetRenderer.astro`.** No workspace-package extraction (no `@warden/render`). Direct workspace dep on `@warden/core` for `Comment` / `CommentSet` / `Tier` / `Category` types. Reasons: (a) only one consumer exists today; ADR-0013's bot wants markdown output, ADR-0014's triage UI wants interactive React/Solid — different rendering targets, different shape needs, designing a shared API in the absence of a second consumer designs the wrong contract. (b) Astro's component model is genuinely awkward to share — `.astro` files don't compose into React, and rewriting as framework-neutral HTML strings or per-framework adapters is overkill. (c) Future extraction is cheap (~2-hour PR) when a second consumer materialises. Pattern-matches ADR-0023's deferred `@warden/orchestration` workspace split.

8. **Fixtures: pre-generate, check in.** `apps/web/src/fixtures/*.json` carries pre-generated `CommentSet` JSON. Regenerated via a one-line `pnpm gen-fixtures` script that runs `warden review` on the curated sample repo and overwrites the JSON. No build-time API calls, no secret management in CI, no token cost per deploy, deterministic builds. Drift is detectable: schema changes break the renderer's TS imports at build time, surfacing as a `tsc` error rather than a silent rendering bug. The build-time-generation alternative was rejected for the secret-management cost and non-determinism; the hand-written-fictional-fixtures alternative was rejected for breaking authenticity (the load-bearing trust signal of the marketing page).

9. **Sample repo: warden-on-warden as primary, synthetic backup.** The fixtures' source repo is warden itself — `warden review` run on the warden monorepo, producing real findings on real code. Self-referential by design: "the tool that finds these problems was held to its own standards" is the proof of warden's citation-discipline thesis (ADR-0008). A small synthetic repo (handful of files with category-spanning bug injections) is kept as backup for category-specific showcase pages where warden-on-warden output is sparse on a particular category. Rejected: third-party public repos (ownership ambiguity, attribution burden, less recursive credibility).

10. **CLI demo: hybrid — JS-animated hero + asciinema casts.** The homepage hero is a hand-crafted JS-animated fake terminal (opencode.ai's pattern) — full design control, looped, paced for the eye, integrated with the Starlight design tokens. Authenticity is preserved by sourcing the hero's "output" from the same `CommentSet` JSON the renderer consumes. Deeper pages (`/examples`, individual category pages) use asciinema casts of actual `warden review` runs on warden-on-warden — authentic, scrubbable, ~50kb each, copy-paste-able terminal text. Pure-asciinema and pure-JS-animation alternatives both rejected: the first jitters on the homepage, the second loses authenticity on deeper pages.

11. **Implementation gate: dogfood-loop signal, M9 desirable but not strict.** ADR-0024 doesn't ship until the user's confidence in warden's output quality is high enough to render it publicly. M9's diff-level noise filter (ADR-0022) is desirable so warden-on-warden output isn't dominated by `node_modules`-style pollution that distorts the showcase, but not strictly mandatory if the curated sample fixture cleanly avoids the noisy directories. No formal acceptance criterion — judgment call gated on personal confidence after several weeks of dogfood usage on personal projects (Alfred, milkpod, blair).

12. **Deploy target: Cloudflare Pages or Vercel.** Both fine for static Astro output; pick at implementation-time. Not Railway — Railway is overkill for a static site, and the `use-railway` discipline reserves it for projects with real backend infrastructure (Alfred, future bot deployments per ADR-0013). Cloudflare Pages preferred for zero-config preview deploys; Vercel acceptable as a fallback.

13. **Relationship to ADR-0014.** ADR-0014's "future web app" for interactive review triage (walk through findings, mark Useful / Not Useful, persist feedback) is **not** the same surface as `apps/web/`. ADR-0024 ships the read-only marketing+docs+showcase site; ADR-0014's surface remains separately deferred — different audience (single-user-during-review vs. ad-hoc-visitor-after-review), different shape (interactive feedback vs. static render), different infra needs (per-user state vs. CDN-cached HTML). When ADR-0014 de-defers it earns its own ADR with its own grilling pass, likely codenamed `apps/triage/` or similar — not `apps/web/`. CONTEXT.md picks up entries distinguishing the two.

**Why.**

- *Single-direction discipline preserved.* ADR-0018 / ADR-0019 / ADR-0021 / ADR-0023 each shipped exactly one architectural commitment. ADR-0024 commits to "the public surface for an elaborate solo project," and explicitly *does not* collapse ADR-0014's interactive triage or ADR-0013's bot deployments into its scope. Bundling them would conflate three independent design decisions into one ADR — exactly the failure mode the milestone-shape discipline rejects.

- *Personal-portfolio framing changes the cost calculus.* The naming-collision blocker from `project_warden_naming_collision.md` was load-bearing under a "public OSS launch" framing — competing for SEO, npm namespace, brand recognition. Under "elaborate solo project, won't renew," none of those costs apply. The framing dissolves the prerequisite (formal ADR-0003 reopen) without compromising the resulting surface's craft bar; ADR-0001's OSS-quality posture still applies because portfolio-grade *is* OSS-quality from a craft perspective.

- *Static-only scope keeps the project from drifting into hosted infra by accident.* (b) interactive playground requires hosted backend, queue, secrets, rate limits, abuse mitigation. (c) interactive triage requires per-user state. Both are real milestones with their own ADRs. (a) static is a single deploy of CDN-cached HTML — keeps `apps/web/` honest about its scope and reversal-cheap if the framing shifts.

- *Astro+Starlight matches opencode.ai precedent and ships theme-for-free.* Rebuilding sidebar / search / dark mode / mobile nav / MDX / syntax highlighting in TanStack Router is 2–3 weeks of polish work for ~5ms steady-state navigation gain. Wrong tradeoff for a personal project where shipping speed beats nav-feel-perfection.

- *Mirror discipline keeps internal docs honest.* Refactoring `decisions.md` / `CONTEXT.md` / `CLAUDE.md` into Astro content collections is a separate ADR ("docs convention overhaul"). It shouldn't ride along with ADR-0024. The voice mismatch between internal-audience (declarative, ADR-shaped, dense) and external-audience (task-shaped, forgiving, introductory) makes transclusion a worst-of-both-worlds choice.

- *Inline renderer matches ADR-0023's deferred-extraction discipline.* Same logic as `@warden/orchestration` — extract when a second consumer materialises, not before. The bot and triage UI both have rendering targets sufficiently different from "static HTML for marketing" that a shared API would be wrong-shaped.

- *Warden-on-warden is the credibility proof, not a gimmick.* Citation discipline (ADR-0008) is warden's load-bearing thesis. The marketing page's job is to communicate it; running warden on its own source code is the most direct possible demonstration. The synthetic-fixture backup exists for cases where warden-on-warden's output happens to be sparse on a specific category — it doesn't compromise the primary fixture's authenticity.

- *Dogfood-gated implementation matches ADR-0001's "personal-first" trajectory.* Building the public surface before the product is trustworthy is the failure mode `vision.md` §17 names. ADR-0024 sequences: dogfood first, ship public surface second.

**Alternatives considered and rejected.**

- *Internal-orientation-only docs site (audience B from the grilling).* Rejected — no need for an Astro app to render `decisions.md`; the existing flat-file convention is already navigable in any editor and on GitHub. The "marketing page" component of the user's ask only makes sense for an external audience.

- *Interactive playground (Q2 option b).* Rejected — requires hosted infra, real cost, real abuse surface. Shape is essentially a single-tenant version of ADR-0013's GitHub PR bot. If it ever ships, it earns its own ADR with hosted-infra commitments matched to real dogfood evidence.

- *Collapse ADR-0014 into ADR-0024 (Q2 option c — hybrid marketing + interactive triage).* Rejected — different audiences, different shapes, different infra. ADR-0014's surface is single-user-during-review; ADR-0024's is ad-hoc-visitor-after-review. Forcing them into one app makes both worse.

- *Pure docs + marketing with no rendered demo (Q2 option d).* Rejected — for a project whose value prop is *the quality of its rendered review output*, refusing to render the output on the marketing page is incoherent.

- *Transclude internal markdown into the docs site (Q3 option 2).* Rejected — produces dual-audience source files, the worst of both worlds. Voice mismatch is real and unfixable by clever MDX includes.

- *Refactor internal markdown into Astro content collections (Q3 option 3).* Rejected — abandons the flat-file convention used across all the user's personal projects per `user_doc_conventions.md`. That's a separate ADR (docs overhaul), not a ride-along with ADR-0024.

- *Split apps for marketing + docs (Q4 split).* Rejected for a single-author project — overkill, doubles deploy surface, breaks design-system unity. opencode.ai precedent points at one app.

- *Next.js + Nextra (Q5 option 2).* Rejected on App Router navigation latency, the same concern that motivated the user's TanStack Router proposal. Astro+Starlight with prefetch achieves the perceived nav speed without the rebuild cost.

- *TanStack Router SPA / TanStack Start (Q5 options B / C).* Rejected for the 2–3 week docs-theme rebuild cost. Astro+Starlight ships sidebar / search / dark mode / mobile nav / MDX / Shiki out of the box; rebuilding these is the wrong place to spend cycles. If perceived nav-speed is genuinely lacking after build, escape to TanStack Start is cheap because `.mdx` content is portable.

- *Mintlify (Q5 option 3).* Rejected at Q4 — Mintlify is docs-only hosted, doesn't unify with marketing.

- *`wrdn.site` (Q6 alternative domain).* Rejected for being forgettable. Portfolio pieces optimise for memorability; `.site` is generic-overused. The "won't renew" framing argues for boldness over long-term defensibility.

- *Workspace-package renderer extraction now (Q7 option β).* Rejected — premature. ADR-0023's deferred-extraction pattern (`@warden/orchestration`) applies identically. Future second consumer materialises → 2-hour extraction PR.

- *Build-time fixture generation (Q8 option i).* Rejected on secret-management cost and non-determinism. CI gets API keys, every deploy costs LLM tokens. The drift-detection story is no better than checked-in JSON's `tsc`-level type checking.

- *Hand-written fictional fixtures (Q8 option iii).* Rejected — breaks authenticity, undermines the citation-discipline thesis the marketing page is selling.

- *Asciinema-only or video-only CLI demo (Q9 options a / b).* Rejected — asciinema-only loses homepage cinematic polish; video-only loses scrubbability and inflates the bundle. Hybrid is strictly better.

- *Pure-JS-animation everywhere (Q9 option c).* Rejected on deeper pages — handwritten scripts on every page erode authenticity. Acceptable on the homepage hero where impressions outweigh authenticity; not acceptable on `/examples`.

- *Third-party public sample repos (Q9-adjacent — alternative to warden-on-warden).* Rejected — ownership ambiguity, attribution burden, less recursive credibility. Warden-on-warden + synthetic backup is strictly better for the citation-discipline framing.

**Caveats.**

- *Caveat — implementation is gated; ADR-0024 itself ships no code.* The ADR locks design; the m-plan (whatever milestone slot picks it up) sequences the build. No `apps/web/` directory exists at ADR commit time. Premature scaffolding is the failure mode this gating prevents.

- *Caveat — `wrdn.beauty` is non-renewing.* If the project is still active when the domain expires (~12 months), the renew-or-migrate decision happens then. The ADR doesn't commit to long-term continuity; the surface is sized to the project's likely lifespan.

- *Caveat — naming-collision dormancy is a posture, not a guarantee.* If at some future point the user decides to take warden public (commercial OSS, hosted product, accepting external contributors), ADR-0003's reopen surfaces immediately and `wrdn.beauty` may need to evolve into a real `warden` namespace claim. ADR-0024's solo-project framing is reversible — but reversal triggers the dormant ADR-0003 work, not new ADR-0024 work.

- *Caveat — `apps/web/` is a third explicit `apps/*` consumer named (alongside ADR-0013's bot deployments and ADR-0014's eventual triage app).* The pnpm-workspace `apps/*` glob already accommodates additions friction-free per `CLAUDE.md`'s monorepo-layout note. No workspace-config change required.

- *Caveat — ADR-0014's deferred web app is now load-bearing-named-distinct.* CONTEXT.md picks up entries distinguishing **`apps/web/`** (this ADR) from **the future interactive triage app** (ADR-0014). The two surfaces have orthogonal ADRs and orthogonal codebases when both ship. ADR-0014 picks up a sibling caveat to make the distinction unambiguous in both places.

- *Caveat — fixture regeneration is manual, not automated.* `pnpm gen-fixtures` is a human-in-the-loop tool. Skipping it after a `CommentSet` schema change produces a build error (good), not silent drift (would be bad). Automating the regen via CI is rejected for the same reason build-time generation is — secret management + LLM token cost + non-determinism.

- *Caveat — Solid availability per-island doesn't commit to using it.* `@astrojs/solid-js` is named as a future option, not a present dep. No marketing component today justifies it; reach for it only when a heavy interactive island materialises. Same pattern as deferred features elsewhere — name the seam, don't fill it.

- *Caveat — JS-animated hero is the one place authenticity is intentionally relaxed.* The homepage hero's "output" is choreographed for visual pacing; it's sourced from real `CommentSet` JSON but the typing and reveal animation is hand-paced. This is the price of cinematic polish on a first-impression surface; deeper pages restore authenticity via asciinema casts of actual runs. Documented so future readers don't mistake the hero for a recording.

**Status.** Direction. Grilling pass complete (Q1 → Q9 + audience reframing); design locked. Implementation gated on dogfood-loop signal post-M9-or-equivalent. m-plan tracking lives at `m{N}-plan.md` for whatever milestone slot picks it up.

---

## ADR-0025 — M9: scope of the diff-level noise filter (narrows ADR-0022)

**Decision.** M9 ships the *narrowest credible cut* of the diff-level noise filter ADR-0022 committed to. The architectural commitments — single seam at the diff loader, ecosystem-driven, profile-loaded, depth-limited tree pruning, one degraded entry per pruned subtree — all hold. The *scope* narrows along six axes: (1) v0 ships exactly one ecosystem profile (`javascript`); the multi-ecosystem detector rewrite + Python / Rust / Go / Java / C# / Ruby profiles defer to M10. (2) The diff tree is built from the existing `parseUnifiedDiff()` output (`ChangedFile[]`), not from `git diff --raw` — `@warden/core` is I/O-pure per ADR-0013 and gains no new I/O capabilities. (3) `.reviewbot/overlay.yaml` does not exist in the codebase yet; M9 ships *no* user override surface. The overlay loader (yaml parser, schema, file-format choice, location debate) becomes its own M10 milestone with its own ADR. (4) M7's directory-concentration heuristic is *removed*, not preserved as a fallback — profile-only in M9. (5) Profile schema reduces to `{ ecosystem, alwaysNoise: { directories, extensions } }` — no `contextDependent` bucket (no escape hatch for false positives without overlay), no `files` bucket (lockfiles deliberately *not* pruned — see §5), no schema versioning (YAGNI for one profile). (6) The Tier-1 baseline noise list (`.git/`, `.DS_Store`, `*.pyc`, `*.swp`, `Thumbs.db`, `.vscode/.history/`) graduates from `committability.ts` to a language-agnostic `BASELINE_NOISE` constant in `diff/prune.ts`, applied unconditionally before any profile.

The full surface:

1. **JS-only profile in v0; defer multi-ecosystem detector + multi-profile shipping.** The current ecosystem detector (`packages/core/src/ecosystem/index.ts`) returns a JS-shaped record — `tsconfigPaths`, `hasPackageJson`, `lockfile: "npm" | "pnpm" | "yarn"` — and does not classify Python / Rust / Go / Java / C# / Ruby at all. ADR-0022 §3's "noise profiles ship inside `@warden/core` for `{javascript, python, rust, go, java, csharp, ruby}`" presupposed a multi-ecosystem detector that does not exist. Bundling "rewrite ecosystem detector to return a list" with "ship the noise filter" is the bundling failure mode ADR-0023 §1 warned against — it conflates two architectural commits in one milestone. M9 ships the noise filter against the existing JS-shaped detector; M10 takes up the detector rewrite + additional profiles as its own milestone with its own ADR.

2. **Diff tree built from `parseUnifiedDiff()` output, not `git diff --raw`.** `@warden/core` is I/O-pure per ADR-0013; the diff loader receives unified-diff *text* via `ReviewInput.diff` from the CLI (or a future bot wrapper) and parses it via `parseUnifiedDiff()`. ADR-0022 §4's "aggregate from `git diff --raw`" framing presumed core could shell out to git — it cannot. The tree is built by grouping `ChangedFile[]` paths by directory and counting files per node. The triplet `(addedCount, modifiedCount, deletedCount)` from ADR-0022 §4 reduces to `fileCount` per node — the noise-filter prune decision only consumes "how many files changed in this subtree," not the add/modify/delete breakdown. A small extension to the parser to mark each file's kind from the diff headers (`--- /dev/null` = added, `+++ /dev/null` = deleted) is optional polish, deferred until a downstream consumer needs it.

3. **No user override surface in M9; overlay deferred to M10 as its own milestone.** ADR-0022 §3 / #6 / "Why §3" / "Alternatives §3" all leaned on `.reviewbot/overlay.yaml` as the override surface — but no overlay loader exists in the codebase (`packages/core/src/overlay/` does not exist; no yaml parser dep; no schema). The overlay was *named* by ADR-0008 as the known-debt suppression mechanism but never implemented. ADR-0022's rejection of `.warden/ecosystems.toml` (the alternative config-file design) cited "the project-specific override case is what `.reviewbot/overlay.yaml` already handles" — the rejection still holds (ADR-0008's zero-config posture remains load-bearing), but the supporting reason was wrong. ADR-0025 retires the supporting reason without reopening the rejection. Override surface design — file format (yaml vs. toml vs. json), location (`.reviewbot/` vs. `.warden/`), schema, parser dep, known-debt + noise.always + noise.never bucket structure — becomes its own M10 ADR. M9 ships profile-only; false positives during the M9 → M10 gap are accepted as a known limitation, surfaced honestly in the noise-filter degraded entry.

4. **Drop M7's directory-concentration heuristic; profile-only in M9.** M7 ships a placeholder inside `committability.ts`: skip if any one top-level directory contributes >80% of added files OR if added files exceed ~200 with no dominator. ADR-0022 framed this placeholder as the seed of M9's structural-fallback layer. ADR-0025 cuts the lineage: M9 v0 ships profile-only. The heuristic produces real false positives on legitimate large refactors (the m9-plan flagged this — a 1K-file rename inside `packages/api/` triggers >80% concentration); without an overlay escape hatch, false positives have no remediation. Profile-only is honest about the v0 coverage gap (project-specific noise dumps that the JS profile doesn't list go undetected) and trades that gap against zero false positives. M10's overlay closes the gap properly via `noise.always: ["generated-api-client/", "proto-out/"]`. If dogfood evidence post-M10 shows project-specific dumps remain unaddressed, a structural-fallback layer can earn its own ADR at that point.

5. **Profile schema reduces to `alwaysNoise.{directories, extensions}` only.** The first-draft schema in m9-plan §2 had three buckets — `alwaysNoise` (definitive prune), `contextDependent` (requires gitignore + heuristic decision), plus `version` for forward-compat migration. ADR-0025 drops `contextDependent` (its decision rule needs an escape hatch users can reach; without overlay, the false-positive case has no remediation), drops `version` (YAGNI for one profile; reintroduce when profile schema actually evolves), and drops `alwaysNoise.files` (lockfiles `package-lock.json` / `pnpm-lock.yaml` / `yarn.lock` *should* appear in the diff — vuln runs against `repoRoot` independently of diff content; ESLint already filters by `LINT_EXTS`; pruning lockfiles removes a useful "this is a dep-bump PR" signal from the synthesizer prompt without helping any runner). Final v0 schema: `{ ecosystem: "javascript", alwaysNoise: { directories: ["node_modules", ".next", "build", "out"], extensions: [".min.js", ".min.css", ".d.ts.map", ".js.map"] } }`.

6. **Tier-1 baseline noise migrates to `diff/prune.ts` as a language-agnostic constant.** M7's `committability.ts` carries a Tier-1 hard-skip list (`.git/`, `.DS_Store`, `*.pyc`, `*.swp`, `Thumbs.db`, `.vscode/.history/`) covering OS-level junk and across-language artifacts. With M9 moving filtering to the diff loader, the list graduates to `BASELINE_NOISE` in `diff/prune.ts` and applies unconditionally — before profiles, before overlay (when M10 ships), without per-ecosystem branching. Folding this list into the JS profile would force every future profile to redeclare OS-level noise; keeping it inside `committability.ts` would mean other runners (TSC, ESLint, jscpd) don't get the floor. A language-agnostic floor is the only design that scales. `committability.ts` drops its copy of the list once the loader applies it.

7. **Acceptance scope honest about the JS-only-and-profile-only narrowing.** m9-plan's acceptance criteria narrow accordingly: no multi-ecosystem assertion, no overlay assertion, no structural-heuristic regression test. The smoke harness ships two fixtures (catastrophic JS case = 500K files in `node_modules/`; legitimate large JS refactor = 1K files inside a real source directory). The multi-ecosystem smoke fixture is reframed as an M10 acceptance check, not M9.

**Why.**

- *Single architectural commit per milestone.* ADR-0018 / ADR-0019 / ADR-0021 / ADR-0023 each shipped exactly one architectural direction. ADR-0022 named four interlocking commitments (multi-ecosystem detector, profile-loaded prune, depth-limited tree, override-via-overlay). M9 v0 holding to *one* — profile-loaded prune at the diff loader — preserves the single-commit pattern. Each deferred piece (multi-ecosystem, overlay, structural fallback) earns its own milestone shape when scheduled.

- *Reality of the codebase narrows the design.* Three of ADR-0022's commitments depend on infrastructure that does not exist: a multi-ecosystem detector, a `git diff --raw` capability inside core, an overlay loader. ADR-0022 read like a self-contained direction; ADR-0025 acknowledges that the direction was written without checking the load-bearing prerequisites. Calling that out explicitly is honest; pretending the prerequisites are minor and bundling them into M9 would compound the failure.

- *Profile-only is decisively useful for the catastrophic case.* The motivating scenario for ADR-0022 is committed `node_modules/` (and ecosystem equivalents). The JS profile catches `node_modules/` decisively. Project-specific noise dumps (a 5K-file `generated-api-client/` not in profile, not in gitignore) are real but secondary; M10's overlay closes them properly. Shipping the catastrophic-case fix in v0 with zero false positives beats shipping a partial fallback that misfires on legitimate large refactors.

- *Lockfiles in the diff are signal, not noise.* The vuln runner reads from `repoRoot` directly (`runAudit(repoRoot, lockfile)`); it does not consume the diff. ESLint filters by `LINT_EXTS` already; lockfiles fall out. TSC reads `.ts` / `.tsx` only. So pruning lockfiles benefits no runner. The synthesizer prompt, however, reads `ChangedFile[]` paths to inform the LLM about the diff's scope; lockfile entries telegraph "this is a dep-bump PR." Removing them removes context. Net: do not prune lockfiles in v0.

- *Tier-1 baseline as a language-agnostic constant matches the architecture.* If M9 says "the noise filter is a property of the diff loader, not of any one runner" (ADR-0022 §1), then OS-level junk (which is noise regardless of ecosystem) belongs in the loader's universal floor. Folding it into the JS profile makes Python's eventual M10 profile re-list `.DS_Store`. Keeping it in `committability.ts` violates the "single seam" principle ADR-0022 just established.

- *Drop the directory-concentration heuristic now, not later.* Without an overlay escape hatch, false positives have no remediation in M9. The heuristic's only honest mid-flight resting place was M7 (where it was a stub). Promoting it to M9 without overlay would be promoting a false-positive-prone heuristic to a permanent layer. Drop now; let M10's overlay close the project-specific-noise gap; revisit a structural fallback only if dogfood post-M10 shows it's still needed.

**Alternatives considered and rejected.**

- *Bundle multi-ecosystem detector rewrite into M9.* Ship the JS profile + Python profile + the detector rewrite that returns `EcosystemId[]`. Rejected because it conflates two architectural commits in one milestone; if dogfood reveals quality issues, attribution is muddled (was it the noise filter or the detector that misbehaved?). Same failure mode as ADR-0023 §1 warned against. Multi-ecosystem detection is itself a non-trivial design surface (priority on conflicts, marker-file precedence, monorepo handling) deserving its own ADR.

- *Ship overlay as M9 prerequisite.* Build the yaml parser + schema + loader as part of M9 alongside the noise filter. Rejected because it forces a yaml-vs-toml-vs-json file-format decision, a `.reviewbot/` vs `.warden/` location decision, and a `noise.always` / `noise.never` / `knownDebt` schema decision under noise-filter time pressure. Each of those is its own design surface; collapsing them produces undergrilled choices.

- *Tiny CLI flag escape hatch (`--noise-never=path/`).* Skip the yaml overlay entirely; ship `--noise-never` and `--noise-always` flags. Rejected because per-invocation flags don't survive across runs (the user has to remember to pass them every `warden review`), and the failure mode of ADR-0022 (zero-config posture) is exactly "tools that need configuration on every invocation are tools that don't get used." A persistent file-based override surface is the right shape; M10 builds it properly.

- *Keep directory-concentration heuristic as profile-miss fallback.* Profile runs first; heuristic fires when no profile match was found. Rejected because the heuristic produces real false positives on legitimate large refactors (1K-file rename inside `packages/api/`); without overlay, false positives have no remediation. Profile-only loses the project-specific-dump coverage but gains zero false positives. Net trade favors profile-only in M9.

- *Build the tree from `git diff --raw` via a CLI-side capture.* CLI invokes `git diff --raw` and passes raw output to core alongside unified diff. Rejected because it doubles `ReviewInput`'s surface for one consumer (the noise filter) and makes future bot wrappers (`apps/github-bot/`) require a raw-diff source they don't otherwise need. Deriving counts from `parseUnifiedDiff()`'s output avoids the new field entirely.

- *Keep the (added, modified, deleted) triplet on tree nodes.* Rejected — no current consumer reads anything other than file count. Add the triplet when a downstream consumer (M10 directory-level deadcode, M11+ tree-aware diff analyzer) actually needs it. Same "build the seam, don't fill it" rejection ADR-0018 / ADR-0019 / ADR-0021 / ADR-0023 each made.

- *Put lockfiles in `alwaysNoise.files`.* The first-draft profile listed `package-lock.json` / `pnpm-lock.yaml` / `yarn.lock`. Rejected because lockfile presence in the diff is *signal* — vuln runs independently, ESLint and TSC filter by extension, and the synthesizer prompt benefits from the "dep-bump PR" context. Pruning them costs context without benefit.

- *Keep schema versioning (`version: 1` in profile JSON).* YAGNI for one profile in v0; reintroduce when profile schema actually evolves and a migration is real.

- *Fold Tier-1 baseline into the JS profile.* Rejected — `.DS_Store`, `.git/`, `.vscode/.history/` are OS / editor noise unrelated to JS. A future Python profile would redeclare them. Language-agnostic floor in the loader scales; profile-embedded does not.

- *Ship full ADR-0022 design as written.* Multi-ecosystem detector + 7 profiles + overlay loader + structural fallback in one milestone. Rejected as a milestone-and-a-half of work that violates the single-architectural-commit pattern. ADR-0022 read like a single direction; ADR-0025 disambiguates it into one v0 commit + several M10+ follow-ups, each its own milestone.

**Caveats.**

- *Caveat — narrows ADR-0022; does not retract it.* ADR-0022's architectural shape (single seam, ecosystem-driven, profile-loaded, depth-limited tree, one degraded entry per pruned subtree, override via overlay) all hold. ADR-0025 narrows the *v0 coverage* (one profile, no overlay, no fallback) without weakening any architectural commitment. Future M10 work realizes the deferred commitments without redesigning the architecture.

- *Caveat — overlay is the named M10 milestone, not a vague "later."* M10 is sized to: yaml parser dep, file-format decision, schema (`knownDebt` + `noise.always` + `noise.never` at minimum), location (likely `.reviewbot/overlay.yaml` per ADR-0008's existing reference, but the location debate is M10's not M9's), loader integration with diff prune. ADR-0008's reference to the overlay is honored *retroactively* by M10's shipping; the dangling reference between M3 (when `.reviewbot/overlay.yaml` first got named) and M10 is acknowledged technical debt.

- *Caveat — multi-ecosystem detector is the named M11+ milestone.* Detector rewrite is bigger than overlay: marker-file precedence rules, monorepo per-subtree detection, priority on conflicting markers, `EcosystemId[]` shape, profile-union semantics. M11+ takes it up with its own ADR. M9 → M10 → M11+ is the implied sequence; sequence may shuffle if dogfood demands it.

- *Caveat — false positives during the M9 → M10 overlay gap are accepted.* If a user has a project-specific generated directory the JS profile doesn't list, M9 doesn't prune it, runners process it normally, and the catastrophic-case smoke fixture's wall-clock target (< 5s) may fail on that one repo. The user can fix `.gitignore` to address it (the same workaround that exists today). The honest framing is "M9 closes the JS-`node_modules/` catastrophic case decisively; project-specific noise dumps wait for M10's overlay."

- *Caveat — degraded `topic: "noise-filter"` is permanent vocabulary.* ADR-0022 introduced the topic name; ADR-0025 keeps it. Listed alongside the conventional topic list (`context`, `osv`, `gitignore`, `committability`, `scalability`, `deadcode`, `consistency`, `embeddings`, `schema`, `llm`, `vuln`).

- *Caveat — `committability.ts` cleanup is part of M9.* Removing the directory-concentration heuristic and the duplicated Tier-1 hard-skip list from `committability.ts` is part of M9's diff. The committability sub-agent continues to function, just without its noise-filtering responsibility (which the diff loader now owns universally).

- *Caveat — m9-plan.md's "open design questions" §1–§7 are answered by this ADR.* §1 (per-subtree ecosystem) — moot under JS-only. §2 (ecosystem coverage) — JS only. §3 (profile schema) — alwaysNoise.{directories, extensions} only. §4 (α vs β interface) — already locked by ADR-0023 §5; β stays. §5 (structural heuristics) — dropped. §6 (caching) — no. §7 (degraded-entry verbosity) — one entry per pruned subtree, default mode shows actionable kind, no collapse (per-subtree visibility is a trust feature, especially under JS-only where 1–2 entries is the common case).

- *Caveat — design is locked; implementation specifics live in m9-plan.md.* ADR-0025 is the design commit; the rewritten m9-plan.md is the implementation brief. Future agents read both; ADR-0025 is the authority on design questions, m9-plan.md on file-by-file scope.

**Status.** Direction. Grilling pass complete (Q1 → Q6 + ADR-shape). Implementation tracked in the rewritten `m9-plan.md`.

---
