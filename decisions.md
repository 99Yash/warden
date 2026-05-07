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
| Comment ordering     | Correctness → Clarity → Style → Dedup → Tests (ADR-0012); orthogonal to severity tier |
| Roadmap (post-v0)    | GitHub PR bot → Slack bot → ClickUp integration (ADR-0013); architecture stays bot-ready |
| CLI UX paradigm      | One-shot non-interactive CLI (ADR-0014); no TUI; interactive triage deferred to a future web app |
| Prior-art posture    | DeepSec study (ADR-0015): borrow pipeline shape + plugin slots; reject free-form findings + 2-agent revalidation; prompts-as-files from M4 |
| Index storage seams  | Content-addressed, model-versioned, interface-shaped stores; bulk export/import primitive; queue decoupled from storage (ADR-0016)        |
| LLM provider posture | Anthropic primary; one-retry on transient; Google Gemini fallback (gemini-2.5-pro/flash matched to sonnet/haiku tiers); hard fail if both fail (ADR-0017)        |
| Context selection (M5) | Cheap-signals selector + jscpd dedup runner; embeddings/Merkle/`warden init`/banner deferred to M6 (ADR-0018) |

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
