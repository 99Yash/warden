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
