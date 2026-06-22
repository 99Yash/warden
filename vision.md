# Warden — Vision

This is the long-form thinking framework that preceded Warden. It's the **vision**, not the v0 spec.

- For the choices we're actually making in v0, see [`decisions.md`](./decisions.md).
- For the M1 implementation brief, see [`scaffolding-plan.md`](./scaffolding-plan.md) (written after ADRs lock).

Preserved verbatim from the original design gist (`gist.github.com/yashgkr/605ddc7edddca1f4e43daeab8fdbf951`) so future iterations can audit what was rejected, what was deferred, and what the original framing assumed. The gist is the source of truth for the long-term shape of the product; `decisions.md` narrates which slices we're actually building and when.

---

# Designing a Generalized AI Code Review Agent

A design document for building an AI-powered code review agent that works across ecosystems, auto-derives codebase knowledge, cites external sources, and adapts to codebase-specific conventions.

Written as a thinking framework — not tied to any single repo or organization.

---

## Table of Contents

1. [Design Goals](#1-design-goals)
2. [Integration Form Factor — The Product Decision](#2-integration-form-factor--the-product-decision)
3. [Agent Orchestration — Boss/Worker Architecture](#3-agent-orchestration--bossworker-architecture)
4. [Phase 0: Ecosystem Detection & Inventory](#4-phase-0-ecosystem-detection--inventory)
5. [Phase 1: Static Analysis Layer — LSPs, Linters, Type Checkers](#5-phase-1-static-analysis-layer--lsps-linters-type-checkers)
6. [Phase 2: Dependency & Vulnerability Layer](#6-phase-2-dependency--vulnerability-layer)
7. [Phase 3: LLM Review Layer — Context-Aware Code Review](#7-phase-3-llm-review-layer--context-aware-code-review)
8. [Phase 4: Citation & Source Verification](#8-phase-4-citation--source-verification)
9. [Phase 5: Persistent Memory — Auto-Derived, Not Manually Maintained](#9-phase-5-persistent-memory--auto-derived-not-manually-maintained)
10. [Phase 6: Cross-Repo Awareness — Discovery, Not Documentation](#10-phase-6-cross-repo-awareness--discovery-not-documentation)
11. [Phase 7: Staleness Detection & Self-Healing](#11-phase-7-staleness-detection--self-healing)
12. [Phase 8: Feedback Loop & Continuous Improvement](#12-phase-8-feedback-loop--continuous-improvement)
13. [Phase 9: Escape Hatches — Rewrites, Migrations, Overrides](#13-phase-9-escape-hatches--rewrites-migrations-overrides)
14. [Comment Schema](#14-comment-schema)
15. [Triage Tiers](#15-triage-tiers)
16. [Lessons from Uber's UReview](#16-lessons-from-ubers-ureview)
17. [Anti-Patterns to Avoid](#17-anti-patterns-to-avoid)

---

## 1. Design Goals

- **Generalized**: Works for any repo, with first-class support for JS/TS and extensibility to Python, Go, Clojure, Rust, Java/Kotlin.
- **Tool-backed, not hallucination-backed**: Every factual claim (CVE, deprecation, version info) must be verified by a deterministic tool before being posted. The LLM generates hypotheses; tools verify them.
- **Citation-first**: Every comment referencing external knowledge includes a source URL and retrieval timestamp.
- **Auto-derived knowledge**: The agent infers codebase structure, integration points, and contracts from the code itself. It does not depend on manually maintained YAML files that will rot within weeks.
- **Tiered severity**: Comments are classified by actionability (must-fix / should-fix / informational), and volume is capped to avoid overwhelming developers.
- **Self-aware of staleness**: The agent knows when its cached knowledge might be wrong and says so visibly, rather than silently giving advice based on outdated context.
- **Form-factor agnostic**: Built as a CLI core with thin wrappers for GitHub, GitLab, IDE, and pre-commit. The product decision (where it runs) is made independently of the review logic.
- **Orchestrated, not monolithic**: Uses a boss/worker agent architecture. The boss decides what kind of review is needed; specialist workers execute in parallel. Inspired by [Dimension's orchestration patterns](https://www.ronit.one/blog/agent-orch).

---

## 2. Integration Form Factor — The Product Decision

The form factor determines everything — feedback loop speed, persistence model, scope of context, cost structure, adoption friction. This decision comes first because it constrains every subsequent design choice.

### Option A: GitHub App / Bot

| Aspect          | Detail                                           |
| --------------- | ------------------------------------------------ |
| **Trigger**     | PR webhook (automatic)                           |
| **Scope**       | Full PR diff, all commits                        |
| **Context**     | Can clone repo, read full codebase, query APIs   |
| **Persistence** | Bot owns its own storage (DB, Redis, S3)         |
| **Feedback**    | Inline PR comments, reactions, resolve/unresolve |
| **UI**          | GitHub's existing review UI — rich, familiar     |
| **Adoption**    | Install once per org, works for all repos        |
| **Cost model**  | You host, you pay for LLM calls                  |
| **Cross-repo**  | Possible — bot can have access to multiple repos |

**Best for**: Teams using GitHub as their primary review platform. This is where reviews already happen — no behavior change required. Persistent memory is natural. Cross-repo awareness is architecturally possible since the bot can access sibling repos.

**Worst for**: Teams on other platforms (Gerrit, Phabricator, Bitbucket). The tight GitHub coupling doesn't transfer.

### Option B: CI Step (GitHub Action / GitLab CI Job)

| Aspect          | Detail                                                       |
| --------------- | ------------------------------------------------------------ |
| **Trigger**     | CI pipeline (automatic on push/MR)                           |
| **Scope**       | Full diff available in CI env                                |
| **Context**     | Repo is already checked out, can run tools                   |
| **Persistence** | None native — needs external storage or cache action         |
| **Feedback**    | Post comments via API, but not truly inline on all platforms |
| **UI**          | CI log output + API-posted comments                          |
| **Adoption**    | Add a YAML block to CI config                                |
| **Cost model**  | Runs in customer's CI — their compute, their LLM keys        |
| **Cross-repo**  | Hard — CI job scoped to one repo                             |

**Best for**: Enterprise teams with data sensitivity concerns (code never leaves their infra). Open-source projects wanting zero-dependency installs. Trivially installable. Customer brings their own LLM API keys — your cost is zero.

**Worst for**: Fast feedback. CI takes minutes. No persistent memory across runs unless you bolt on external storage. Cross-repo is awkward — the job only sees one repo.

### Option C: IDE Extension (VS Code, JetBrains)

| Aspect          | Detail                                                           |
| --------------- | ---------------------------------------------------------------- |
| **Trigger**     | On save, on file open, or manual invocation                      |
| **Scope**       | Current file or staged changes                                   |
| **Context**     | Full workspace via LSP, open files, git diff                     |
| **Persistence** | Local storage (extension state, SQLite in workspace)             |
| **Feedback**    | Inline diagnostics, code lenses, quick fixes                     |
| **UI**          | Native IDE integration — squiggles, hover cards, fix suggestions |
| **Adoption**    | Install from marketplace                                         |
| **Cost model**  | User's own LLM keys or your proxy service                        |
| **Cross-repo**  | If both repos are in workspace, yes. Otherwise no                |

**Best for**: Fastest feedback loop — issues caught as you type, before code reaches review. Native IDE affordances (diagnostics, code actions) are richer than any PR comment.

**Worst for**: Per-developer scope — no team-level visibility or enforcement. A manager can't see if developers are ignoring findings. PR-level diff view is awkward. Persistence is local — no shared learning.

### Option D: Pre-commit Hook / CLI

| Aspect          | Detail                                                       |
| --------------- | ------------------------------------------------------------ |
| **Trigger**     | Manual (`reviewbot check`) or git hook (pre-commit/pre-push) |
| **Scope**       | Staged changes or specified files                            |
| **Context**     | Full repo on disk, can run any local tool                    |
| **Persistence** | None unless you build a local daemon or use a DB file        |
| **Feedback**    | Terminal output, exit codes                                  |
| **UI**          | Plain text                                                   |
| **Adoption**    | `npm install -g` / `pip install` / `brew install`            |
| **Cost model**  | User brings own LLM keys (BYOLLM)                            |
| **Cross-repo**  | Only if user points it at multiple repos                     |

**Best for**: Power users, CLI-native developers. BYOLLM — zero vendor lock-in. Pre-commit catches issues before they become commits.

**Worst for**: No persistent memory across runs (without a local DB). No team-level enforcement. Pre-commit hooks that call LLMs are slow (seconds to minutes) — will annoy developers.

### Recommended: Option E — CLI Core + Thin Wrappers

```
reviewbot (CLI core)
├── Ecosystem detection
├── Static analysis runners
├── LLM review pipeline
├── Caching layer (SQLite)
├── Citation / verification tools
└── Output formatter

Wrappers:
├── GitHub Action     → calls CLI, posts PR comments
├── GitLab CI job     → calls CLI, posts MR comments
├── VS Code extension → calls CLI on save, renders diagnostics
├── Pre-commit hook   → calls CLI on staged files
└── Gerrit hook       → calls CLI, posts inline comments
```

Build the CLI as the core engine. It does the heavy lifting. The wrappers handle trigger and presentation.

**Persistence**: The CLI uses a local SQLite DB (`.reviewbot/cache.sqlite`, gitignored) that persists between runs. No daemon needed — just a file.

**Model strategy**: The agent ships with a default model configuration that works out of the box. For the CLI, users provide their own API key for the default provider. For a hosted bot, you control the model and billing entirely — don't expose model selection to end users.

```yaml
# Default config — ships with the agent, works for 95% of users
# Only the API key needs to be provided
model:
  default_provider: anthropic
  default_model: claude-sonnet-4-20250514
  api_key_env: REVIEWBOT_API_KEY # single key, single provider

# Advanced override — for power users who want control
# Most users should never touch this
advanced:
  generator:
    provider: anthropic
    model: claude-sonnet-4-20250514
    api_key_env: ANTHROPIC_API_KEY
  grader:
    provider: openai
    model: o4-mini
    api_key_env: OPENAI_API_KEY
  worker:
    provider: anthropic
    model: claude-haiku-4 # cheaper model for parallel sub-agents
    api_key_env: ANTHROPIC_API_KEY
```

For a hosted bot: pick one model, handle billing yourself, and don't expose provider selection. BYOLLM creates operational tax (key rotation, provider-specific failure modes, billing per provider) that isn't worth it unless you're building a platform. Let advanced users override via config file if they really need to — but don't design the product around it.

For the CLI: a single `REVIEWBOT_API_KEY` env var with the default provider is the happy path. The advanced override config exists for the ~5% who want to use a different provider or a cheaper model for sub-agents.

**Cross-repo**: The CLI accepts `--sibling-repo /path/to/other/repo` and scans both. In CI, you'd checkout both repos. In IDE, both repos would be in the workspace.

This architecture lets teams start with whatever form factor they prefer and switch without losing the review logic. The CLI is the product; the wrappers are distribution.

---

## 3. Agent Orchestration — Boss/Worker Architecture

A code review agent isn't a single LLM call. It's a coordination problem. The diff might need type checking, vulnerability scanning, contract verification, and semantic review — simultaneously. Running these sequentially is slow. Running them in a single massive prompt is unreliable (context window pressure, mixed concerns, degraded quality).

The solution is a boss/worker pattern, inspired by [Dimension's orchestration layer](https://www.ronit.one/blog/agent-orch): a lightweight routing step decides what kind of review is needed, deterministic checks run inline, specialist workers execute in parallel, and a boss synthesizes and grades findings before posting.

### The pipeline: Route → Execute → Synthesize → Grade

```
Diff arrives
  │
  ├── Step 0: TRIAGE (heuristic, no LLM)
  │   Classify the diff by file extensions, integration-map hits,
  │   gotcha-pattern triggers, lockfile changes.
  │   Output: which execution modes to activate.
  │   Cost: zero tokens, <100ms.
  │
  ├── Step 1: DETERMINISTIC EXECUTION (no LLM)
  │   Run pattern matchers, linters, type checkers, vuln scanners.
  │   Findings are pre-verified facts — highest confidence.
  │   (See "Deterministic Pattern Registry" below.)
  │
  ├── Step 2: PARALLEL WORKERS (LLM, concurrent)
  │   Specialist workers review the diff for their concern type.
  │   Workers write findings to the scratchpad.
  │
  ├── Step 3: SYNTHESIS (boss LLM, single call)
  │   Boss reads all findings (deterministic + worker),
  │   resolves cross-cutting overlaps, deduplicates.
  │
  └── Step 4: GRADING (boss LLM or dedicated grader, single call)
      Per-comment quality grading. Confidence scoring.
      Kill low-confidence findings. Emit final comment set.
```

**Triage is not a "third mode" — it's a router.** It's a cheap heuristic step (file extensions, regex matches, integration-map lookups) that decides which combination of deterministic checks and LLM workers to activate. It does not use an LLM. It runs on every diff in <100ms.

**Grading is a distinct step, not folded into synthesis.** UReview's most empirically validated finding is that a separate grading pass (different prompt, potentially different model) significantly improves precision. The boss synthesizes (resolves duplication, resolves cross-cutting ownership). Then a grading step evaluates each surviving comment for correctness, actionability, and confidence. These are different cognitive tasks and should not be collapsed.

### Deterministic pattern registry (Step 1)

This is the highest-value, highest-precision part of the system and deserves first-class treatment. Deterministic checks produce zero false positives — if the pattern matches, the finding is real.

The registry is a curated list of patterns, maintained by the team. This is the one place manual curation pays off: patterns are stable, few in number, and change rarely. This is not the YAML-rot anti-pattern — a gotcha-pattern list of 10-20 entries has a much longer half-life than an architecture description because each entry is independently testable and directly tied to a past production incident.

```yaml
# .reviewbot/patterns.yaml — deterministic check registry
# Each pattern is a regex/glob trigger + a verification function.
# These run on every diff with zero LLM cost.

patterns:
  - id: sync-loop-source-metadata
    description: "Baserow write missing source_metadata"
    trigger:
      file_glob: "**/baserow/**"
      diff_regex: "update.row|create.row|batch.update"
    verify: "check that source_metadata with edit_source is present in the call"
    severity: critical
    tier: 1
    added_after: "2025-01 production sync loop incident"

  - id: oauth-fk-string-compare
    description: "oauth_tokens provider/app compared as string"
    trigger:
      diff_regex: "oauth_tokens.*provider\\s*=\\s*['\"]|oauth_tokens.*app\\s*=\\s*['\"]"
    verify: "flag direct string comparison, require JOIN through keywords table"
    severity: critical
    tier: 1
    added_after: "2025-03 auth failure — empty result set from FK misuse"

  - id: cve-in-lockfile
    description: "Known CVE in added/changed dependency"
    trigger:
      file_glob: "**/package-lock.json|**/requirements.txt|**/deps.edn"
    verify: "run ecosystem scanner, cross-reference OSV.dev"
    severity: critical
    tier: 1
```

**Who maintains these?** The engineering team. Each pattern is added after a production incident or near-miss. The pattern file is reviewed like code. It should grow by 2-3 entries per quarter, not per week. If it's growing faster than that, the patterns are too specific.

### Parallel LLM workers (Step 2)

When triage determines that LLM review is needed, specialist workers run in parallel.

```
Triage says: needs correctness + contract review
  ├── Spawn: Correctness worker → reviews logic, null safety, error handling
  ├── Spawn: Contract worker    → checks cross-repo integration points
  └── Both write to scratchpad concurrently
```

Each worker gets:

- Only the files relevant to its concern (not the entire diff)
- A focused system prompt for its specialty
- No access to other workers' findings

#### Worker model tiering

Not all workers are equal. UReview uses Sonnet for generation — and for good reason. Subtle bugs (race conditions, type narrowing edge cases, auth flow correctness) degrade noticeably on small models. The cost savings of Haiku aren't worth it if the security worker misses an auth bypass.

| Worker type        | Model tier   | Why                                                                                                  |
| ------------------ | ------------ | ---------------------------------------------------------------------------------------------------- |
| **Correctness**    | Sonnet-class | Subtle bugs require strong reasoning — off-by-one, null narrowing, async race conditions             |
| **Security**       | Sonnet-class | Auth bypass, injection, secrets — too important to skimp on                                          |
| **Contract**       | Haiku-class  | Focused comparison task: "does this change match the integration map?" — doesn't need deep reasoning |
| **Dependency**     | No LLM       | Deterministic tool output (npm audit, pip-audit). LLM only formats the comment.                      |
| **Best practices** | Haiku-class  | Pattern matching against known conventions — Haiku is sufficient                                     |

This means the per-provider model mapping matters:

| Provider  | Boss / Grader   | Sonnet-tier worker | Haiku-tier worker |
| --------- | --------------- | ------------------ | ----------------- |
| Anthropic | claude-sonnet-4 | claude-sonnet-4    | claude-haiku-4    |
| OpenAI    | gpt-4.1         | gpt-4.1            | gpt-4.1-mini      |
| Google    | gemini-2.5-pro  | gemini-2.5-pro     | gemini-2.5-flash  |

When `REVIEWBOT_API_KEY` points to a provider, the agent selects the appropriate model per role from that provider's lineup. Each supported provider must offer both a strong and a cheap SKU.

#### Cross-cutting concerns and dedup

A null-deref in a webhook handler that touches an integration boundary is both a correctness finding and a contract finding. With workers in silos, you'll get overlapping comments framed differently.

**Ownership rule**: When two workers flag the same file+line range, the finding belongs to whichever worker's concern is more specific. Contract > Correctness > Security > Best Practices. (Security overrides this if the finding is a vulnerability, not a code quality issue.)

**Dedup tiebreak**: The boss (Step 3) sees all findings grouped by file+line. For overlapping findings:

1. If findings are semantically identical (same claim, different framing): keep the higher-confidence one, merge citations from both.
2. If findings are complementary (different claims about the same code): keep both, but the boss rewrites them as a single compound comment ("This webhook handler has a null-deref risk AND touches a cross-repo integration point").
3. If findings contradict: the grader (Step 4) decides. If the grader can't resolve the contradiction, drop both — a contradictory comment is worse than no comment.

This is not a hallucination-free process. The boss's dedup is an LLM call and can get it wrong. But the alternative (posting duplicate/contradictory comments) is worse for trust.

#### Worker timeouts and partial failures

```yaml
orchestration:
  max_workers: 4
  worker_timeout: 30 # seconds per worker
  boss_timeout: 45 # seconds for synthesis + grading
  on_worker_timeout: continue # "continue" or "fail"
```

**Default behavior: continue with degraded coverage.**

If Worker 3 of 5 times out, the review proceeds with findings from the other 4 workers. The boss marks the comment set with metadata:

```json
{
  "degraded_workers": ["security"],
  "degradation_reason": "security worker timed out after 30s"
}
```

This surfaces in the staleness output (which is now quiet by default, but a timed-out security worker is a reason to be loud):

```
reviewbot: security worker timed out. This review may miss security findings.
Remaining checks (correctness, contract, dependency) completed normally.
```

**Silently dropping the security worker is unacceptable.** If a critical worker fails, the developer must know. If a non-critical worker (best practices) fails, mention it but don't alarm.

| Worker type    | On timeout                             |
| -------------- | -------------------------------------- |
| Security       | Loud warning. Suggest re-running.      |
| Correctness    | Loud warning. Suggest re-running.      |
| Contract       | Quiet mention. Review is still useful. |
| Best practices | Silent. Nobody misses it.              |

### Sibling-repo integration map: built offline, consumed per-PR

Scanning a sibling repo on every PR is expensive if the sibling is large. The integration map should be built as a **nightly job** (or on-push to the sibling's main branch) and stored as an artifact:

```
Nightly job (or post-merge hook on sibling repo):
  1. Scan sibling repo for route handlers, shared constants, webhook patterns
  2. Produce integration-map.json artifact
  3. Store in shared location (S3 bucket, git submodule, or .reviewbot/ in the primary repo)

Per-PR review:
  1. Read integration-map.json (cached, not re-scanned)
  2. Cross-reference diff against known integration points
  3. Flag if diff touches an integration boundary
```

The per-PR run reads a pre-built artifact. It never clones or scans the sibling repo in real time. This keeps per-PR latency low and avoids the cost of scanning a 1M-LOC sibling on every push.

The integration map is rebuilt when:

- The sibling repo's main branch changes (post-merge hook)
- A nightly cron fires (catch-all)
- A developer manually triggers `reviewbot rescan-siblings`

### Lazy tool loading

Not every review needs every tool. Triage (Step 0) activates tools based on what the diff touches:

| Diff touches...           | Tools activated                                              |
| ------------------------- | ------------------------------------------------------------ |
| `.ts` / `.tsx` files      | TypeScript compiler, ESLint                                  |
| `package.json` / lockfile | npm audit, dependency diff                                   |
| `.py` files               | Ruff, Pyright (if configured)                                |
| `requirements.txt`        | pip-audit                                                    |
| Files in integration map  | Cross-repo contract checker                                  |
| Webhook handlers          | Sync loop pattern matcher                                    |
| SQL files or SQL strings  | SQL injection scanner (Bandit for Python, custom for others) |

Tools not needed for this diff are never loaded. This keeps context tight and avoids wasting time on irrelevant scans.

### Feedback → orchestration loop

Phase 8 (Feedback Loop) feeds back into orchestration over time:

| Feedback signal                                                 | Orchestration adaptation                                                              |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Security worker findings consistently rated "Useful"            | Lower confidence threshold for security → post more                                   |
| Best practices worker findings consistently rated "Not Useful"  | Stop spawning best practices worker entirely                                          |
| Correctness worker on Python files has high false-positive rate | Switch Python correctness worker to Sonnet-class (if currently Haiku)                 |
| Contract worker findings never addressed                        | Investigate: are the integration map entries stale, or is the worker producing noise? |
| A specific deterministic pattern generates false positives      | Remove or refine the pattern in `patterns.yaml`                                       |

Worker selection isn't static. The set of workers spawned, and their model tiers, should drift over time based on which workers produce value for this specific codebase. This is the long-term payoff of the feedback loop — not just threshold tuning, but structural adaptation of the orchestration itself.

---

## 4. Phase 0: Ecosystem Detection & Inventory

Before the agent can review anything, it needs to understand what it's looking at. This is **fully auto-derived** — no manual configuration needed.

### Detection heuristics

On every run, scan the repo root for ecosystem markers:

| Marker File(s)                                              | Ecosystem               | Package Manager            |
| ----------------------------------------------------------- | ----------------------- | -------------------------- |
| `package.json`, `tsconfig.json`                             | JavaScript / TypeScript | npm / yarn / pnpm / bun    |
| `requirements.txt`, `pyproject.toml`, `setup.py`, `Pipfile` | Python                  | pip / pipenv / poetry / uv |
| `go.mod`                                                    | Go                      | go modules                 |
| `deps.edn`, `project.clj`                                   | Clojure                 | deps / leiningen           |
| `Cargo.toml`                                                | Rust                    | cargo                      |
| `pom.xml`, `build.gradle`, `build.gradle.kts`               | Java / Kotlin           | maven / gradle             |
| `Gemfile`                                                   | Ruby                    | bundler                    |
| `composer.json`                                             | PHP                     | composer                   |
| `Package.swift`                                             | Swift                   | SPM                        |

### What to auto-derive (not manually write)

- **Ecosystems**: Detected from marker files. Cached, re-scanned if markers change.
- **Framework**: Detected from dependencies (`next` in package.json → Next.js, `fastapi` in requirements.txt → FastAPI).
- **Framework version**: Parsed from lockfile or dependency declaration.
- **Monorepo structure**: Detected from workspace configs (`turbo.json`, `nx.json`, `pnpm-workspace.yaml`, multiple `package.json` files).
- **Module boundaries**: Inferred from directory structure and import graph.

### What requires a human overlay (kept minimal)

Only things that genuinely can't be inferred from the code:

```yaml
# .reviewbot/overlay.yaml — the ONLY manually maintained file
# Everything else is auto-derived. This file is optional.
known_debt:
  - path: "src/legacy/**"
    reason: "Pre-TypeScript migration, scheduled for Q3"
    suppress: all
suppressed_categories:
  - readability:naming
  - readability:formatting
```

This file is small (10-20 lines), rarely changes, and the agent works fine without it — it just won't suppress known debt.

---

## 5. Phase 1: Static Analysis Layer — LSPs, Linters, Type Checkers

The agent should activate the appropriate language tooling per ecosystem. These provide deterministic, high-confidence findings that don't need LLM verification.

### JavaScript / TypeScript

| Tool                                                                       | Purpose                                               | Activation                              |
| -------------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------- |
| **TypeScript Language Server** (`tsserver` / `typescript-language-server`) | Type errors, unreachable code, missing imports        | Run `tsc --noEmit` on changed files     |
| **ESLint**                                                                 | Linting rules, best practices, plugin-specific checks | Run on changed files with repo's config |
| **Biome** (if configured)                                                  | Combined lint + format                                | Alternative to ESLint                   |
| **Knip**                                                                   | Dead code, unused exports, unused dependencies        | Run on full project (cached)            |
| **Madge**                                                                  | Circular dependency detection                         | Run on changed module graphs            |

**Key nuance for TS**: The LSP can give you type-level insights the LLM can't — like "this function returns `Promise<string | undefined>` but you're not handling the `undefined` case." The agent should consume TSC diagnostics as structured data and pass them to the LLM only for formatting into human-readable comments.

### Python

| Tool                    | Purpose                                                          |
| ----------------------- | ---------------------------------------------------------------- |
| **Pyright** / **Pylsp** | Type checking, missing imports                                   |
| **Ruff**                | Fast linting (replaces flake8 + isort + pyupgrade + many others) |
| **mypy**                | Strict type checking (if configured)                             |
| **Bandit**              | Security-focused static analysis                                 |

### Go

| Tool              | Purpose                                     |
| ----------------- | ------------------------------------------- |
| **gopls**         | Type errors, unused variables               |
| **staticcheck**   | Bug detection, simplifications, performance |
| **golangci-lint** | Meta-linter aggregating 50+ linters         |
| **govulncheck**   | Vulnerability scanning for Go modules       |

### Clojure

| Tool            | Purpose                                           |
| --------------- | ------------------------------------------------- |
| **clojure-lsp** | Namespace resolution, unused imports, refactoring |
| **clj-kondo**   | Linting, type hints, arity checks                 |
| **Eastwood**    | Additional lint rules                             |

### Rust

| Tool              | Purpose                                        |
| ----------------- | ---------------------------------------------- |
| **rust-analyzer** | Type errors, borrow checker insights           |
| **clippy**        | Idiomatic Rust lints, performance, correctness |
| **cargo audit**   | Dependency vulnerabilities                     |

### Java / Kotlin

| Tool                                            | Purpose                               |
| ----------------------------------------------- | ------------------------------------- |
| **Eclipse JDT LS** / **kotlin-language-server** | Type errors, missing imports          |
| **ErrorProne** (Java)                           | Bug pattern detection at compile time |
| **Detekt** (Kotlin)                             | Code smell detection                  |
| **SpotBugs**                                    | Bytecode-level bug detection          |

### How the agent uses tool output

The agent does NOT run an LSP interactively. It runs the CLI equivalents (`tsc --noEmit`, `eslint --format json`, `ruff check --output-format json`, etc.) and consumes their structured output. This is:

- Faster than starting an LSP server
- Cacheable (same input → same output)
- CI-friendly (no persistent process needed)

The tool findings become **pre-verified facts** the LLM can reference. The LLM's job is to triage them (is this finding relevant to this specific change?) and explain them (what should the developer do about it?).

---

## 6. Phase 2: Dependency & Vulnerability Layer

### Per-ecosystem vulnerability scanning

| Ecosystem | Scanner                                  | Data Source               |
| --------- | ---------------------------------------- | ------------------------- |
| JS/TS     | `npm audit --json` / `yarn audit --json` | GitHub Advisory Database  |
| Python    | `pip-audit --format json`                | OSV.dev, PyPI             |
| Go        | `govulncheck ./...`                      | Go Vulnerability Database |
| Rust      | `cargo audit --json`                     | RustSec Advisory Database |
| Java      | OWASP `dependency-check`                 | NVD, various              |
| Clojure   | `nvd-clojure`                            | NVD                       |

### Universal fallback: OSV.dev API

[OSV.dev](https://osv.dev/) provides a free, open API covering all major ecosystems. For any ecosystem without a dedicated scanner, query:

```
POST https://api.osv.dev/v1/query
{
  "package": { "name": "axios", "ecosystem": "npm" },
  "version": "0.21.1"
}
```

This returns structured CVE data with severity scores, affected version ranges, and fix versions — all citable.

### What to do with findings

1. **Direct CVE matches** (the installed version is in the affected range) → Tier 1 comment with full citation
2. **Outdated with available fix** (no CVE, but the installed version is N major versions behind and a security fix exists in a newer release) → Tier 2 comment
3. **Outdated but no security issue** → Do NOT comment. Developers hate unsolicited "you should upgrade" nits

### Dependency diff analysis

When a PR modifies a lockfile, diff the before/after to identify:

- Newly added dependencies → scan each for known vulnerabilities
- Version changes → check if the new version resolves or introduces CVEs
- Removed dependencies → no action needed (but note if a transitive dep now brings in something flagged)

### License scanning (optional but valuable)

Tools like `license-checker` (npm) or `pip-licenses` (Python) can flag copyleft licenses (GPL, AGPL) being introduced into a proprietary codebase. This is a compliance concern that's easy to check deterministically.

---

## 7. Phase 3: LLM Review Layer — Context-Aware Code Review

This is where the actual AI review happens. The LLM receives:

1. **The diff** — what changed
2. **Surrounding context** — the full file(s), imported modules, type definitions
3. **Auto-derived codebase context** — ecosystem, framework, module structure, detected integration points
4. **Human overlay** — known debt suppressions (if the optional overlay file exists)
5. **Tool findings** — pre-verified issues from linters, type checkers, vulnerability scanners
6. **Dependency scan results** — CVE data to format into comments

### Specialized assistants (modular prompts)

Following UReview's approach, use separate prompt chains for different concern types:

| Assistant          | Focus                                                                        | When to activate                  |
| ------------------ | ---------------------------------------------------------------------------- | --------------------------------- |
| **Correctness**    | Logic bugs, null safety, race conditions, off-by-one, incorrect return types | Always                            |
| **Error Handling** | Missing try/catch, unhandled promise rejections, error propagation gaps      | Always                            |
| **Security**       | Injection, auth bypass, secrets in code, unsafe deserialization              | Always                            |
| **Best Practices** | Ecosystem-specific conventions (React hooks rules, Go error idioms, etc.)    | Always, but category-filtered     |
| **Dependency**     | CVE findings, deprecated APIs, breaking changes in upgraded deps             | Only when dependency files change |
| **Contract**       | Cross-module or cross-repo API contract violations                           | When touching API boundaries      |

### The orchestrated pipeline

See [Section 3: Agent Orchestration](#3-agent-orchestration--bossworker-architecture) for the full architecture. The four-step pipeline:

1. **Triage** (heuristic, no LLM) — classify the diff, decide which workers + tools to activate
2. **Deterministic checks + parallel workers** — pattern matchers and linters run inline; LLM workers run concurrently, writing to a shared scratchpad
3. **Synthesis** (boss, Sonnet-class) — reads all findings, resolves cross-cutting overlaps, deduplicates, merges citations
4. **Grading** (separate step, Sonnet-class or dedicated grader) — evaluates each surviving comment on:
   - **Correctness**: Is this actually a bug, or is the LLM confused about the code's intent?
   - **Actionability**: Can this be fixed in this PR, or does it require a larger refactor?
   - **Novelty**: Is this something the developer likely already knows, or is it a genuine blind spot?
   - **Confidence score**: 0.0 – 1.0
5. Comments below the confidence threshold are silently dropped

**Synthesis and grading are separate steps.** This follows UReview's most empirically validated finding: a distinct grading pass (different prompt, potentially different model) significantly improves precision. The synthesizer resolves duplication. The grader evaluates quality. Collapsing them loses the adversarial tension that makes grading effective.

Worker models are tiered by concern type (Sonnet for correctness/security, Haiku for contract/best-practices). See the [worker model tiering table](#worker-model-tiering) in Section 3.

---

## 8. Phase 4: Citation & Source Verification

### Citation schema

Every comment that references external knowledge MUST include structured source data:

```json
{
  "sources": [
    {
      "type": "cve",
      "id": "CVE-2024-28849",
      "url": "https://nvd.nist.gov/vuln/detail/CVE-2024-28849",
      "title": "follow-redirects exposes Authorization header to third-party host",
      "severity": "medium",
      "cvss_score": 6.5,
      "retrieved_at": "2026-05-03T10:30:00Z"
    },
    {
      "type": "advisory",
      "url": "https://github.com/advisories/GHSA-cxjh-pqwp-8mfp",
      "retrieved_at": "2026-05-03T10:30:00Z"
    }
  ]
}
```

### Source types

| Type              | Example                           | Verification method                                           |
| ----------------- | --------------------------------- | ------------------------------------------------------------- |
| `cve`             | NVD entry                         | OSV.dev API or `npm audit` output                             |
| `advisory`        | GitHub Advisory                   | GitHub Advisory Database API                                  |
| `changelog`       | Package release notes             | Registry API (npmjs.com, pypi.org)                            |
| `documentation`   | Official docs page                | Web fetch + content verification                              |
| `web`             | Blog post, Stack Overflow         | Web search + LLM verification that content supports the claim |
| `tool`            | TypeScript compiler diagnostic    | TSC output (deterministic, no URL needed)                     |
| `repo_convention` | Project's own style guide or docs | File path within the repo                                     |

### Verification pipeline

The agent MUST NOT post a comment citing a source it hasn't actually retrieved and verified. The flow:

1. Generator LLM says: "This version of `follow-redirects` has a redirect bypass vulnerability"
2. Tool layer queries OSV.dev for `follow-redirects` at the installed version
3. If confirmed → attach the CVE data and source URLs
4. If not confirmed → drop the comment (it was a hallucination)
5. Grader LLM reviews the final comment + sources for coherence

For web-sourced claims (deprecation notices, best practice changes), the agent should:

1. Fetch the cited URL
2. Verify the page content actually supports the claim
3. Include a relevant quote/snippet in the comment for the developer to scan without clicking through

---

## 9. Phase 5: Persistent Memory — Auto-Derived, Not Manually Maintained

### The core problem with manually maintained context

A hand-written `architecture.yaml` describing modules, contracts, and known debt has a half-life of about one sprint. Someone merges a change that invalidates it, nobody updates the file, and the agent silently gives advice based on stale context. The "agent proposes updates, human merges" loop fails because there's no visible cost signal for staleness.

### The solution: auto-derive everything possible, make staleness visible for the rest

The agent maintains four distinct caches. Three are fully automated. One has a small human overlay.

### Cache 1: Auto-Derived Codebase Snapshot

**What**: Ecosystem detection, framework versions, module structure, import graph, detected integration points (HTTP calls, shared constants, webhook handlers).

**Built by**: The agent itself, on every run (incrementally — only re-scan changed areas).

**How it works**:

- Scan for marker files → detect ecosystems (see Phase 0)
- Parse dependency declarations → detect frameworks and versions
- Scan for HTTP client calls → detect integration points (what URLs does this repo call?)
- Scan for webhook/route handlers → detect inbound integration points
- Scan for shared constants → detect naming conventions and magic values
- Build import graph → detect module boundaries

**Storage**: `.reviewbot/cache.sqlite` (gitignored). Table: `codebase_snapshot`.

**Invalidation**: Incremental. On each run, re-scan files that changed since last run. Full re-scan if >30% of files changed (likely a major refactor).

**No manual maintenance required.** The agent discovers what it needs from the code.

### Cache 2: Dependency State

**What**: Resolved dependency tree, installed versions, known CVEs, latest available versions.

**Built by**: Running ecosystem-specific scanners (`npm audit`, `pip-audit`, etc.) on each run where lockfiles changed.

**Storage**: `.reviewbot/cache.sqlite`. Table: `dependency_state`.

**Invalidation**: Automatic when lockfiles change. CVE data has a 24-hour TTL (re-queried from OSV.dev if stale).

### Cache 3: Review History & Feedback

**What**: Every comment posted, developer feedback (useful/not useful), category usefulness rates, suppression rules derived from feedback.

**Built by**: Appended after each review cycle. Feedback collected via thumbs-up/down reactions on posted comments (mechanism depends on form factor — GitHub reactions, Gerrit votes, CLI confirmation).

**Storage**: `.reviewbot/cache.sqlite`. Tables: `review_comments`, `feedback`, `category_stats`.

**Invalidation**: Never. Append-only.

**Used for**:

- Auto-suppressing categories with <30% usefulness rate
- Tuning confidence thresholds per category
- Tracking comment-addressed rate over time

### Cache 4: External Knowledge

**What**: Results from CVE lookups, package registry queries, web searches.

**Built by**: Populated on-demand during review runs.

**Storage**: `.reviewbot/cache.sqlite`. Table: `external_knowledge`.

**Invalidation**: TTL-based:

| Query type                              | TTL      |
| --------------------------------------- | -------- |
| CVE lookup for specific package+version | 24 hours |
| Package latest version                  | 6 hours  |
| Web search result                       | 48 hours |
| Changelog/release notes                 | 7 days   |

### The human overlay (optional, minimal)

The only manually maintained file is `.reviewbot/overlay.yaml` — and it's optional. It contains only things that genuinely can't be inferred from code:

```yaml
# Things the agent can't auto-derive
known_debt:
  - path: "src/legacy/**"
    reason: "Pre-TypeScript migration"
    suppress: all

# Override auto-derived suppressions
force_enable_categories:
  - error-handling # even if feedback says suppress, keep this on
```

This file is typically 5-20 lines. If it's missing, the agent works fine — it just doesn't suppress known debt.

---

## 10. Phase 6: Cross-Repo Awareness — Discovery, Not Documentation

### The problem with manual contract files

Expecting teams to write down cross-repo contracts accurately is optimistic. In practice: three contracts get written on day one, zero in the next year. Uber has the org muscle to maintain this. Most teams don't.

### The solution: auto-discover integration points from code

Instead of "humans document contracts, agent checks them," the model is "agent discovers integration points from code, humans confirm or dismiss."

### How auto-discovery works

On first run (and incrementally thereafter), the agent scans the codebase for integration signals:

**Outbound HTTP calls**:

```
grep for: fetch(, axios., httpx., http/get, http/post, requests.get, etc.
Extract: URL patterns, base URL variables, endpoint paths
Result: "This repo calls https://api.example.com/internal/users"
```

**Inbound route handlers**:

```
grep for: app.get(, app.post(, defroutes, @app.route, router.post, etc.
Extract: Endpoint paths, expected request/response shapes
Result: "This repo exposes POST /internal/token-to-user"
```

**Shared constants and magic values**:

```
grep for: repeated string literals, enum values, status codes
Cross-reference between repos
Result: "Both repos reference 'datomic' as an edit_source value"
```

**Webhook handlers**:

```
grep for: webhook, callback, hook, event handler patterns
Extract: Expected payload shapes
Result: "This repo handles POST /baserow/update webhooks"
```

### What the agent produces

A **draft integration map** — not a contract file, but a discovered fact sheet:

```
Integration points discovered:

  [OUTBOUND] baserow-middleware → autosched
    - GET  /internal/token-to-user  (clients/oliv.py:45)
    - POST /internal/get-recording-url  (clients/oliv.py:112)
    - POST /internal/delete-datomic-entity  (clients/oliv.py:156)

  [SHARED VALUES]
    - edit_source: "datomic" | "user" | "ai_extraction"
      Used in: autosched/baserow/data_sync.clj, middleware/utils/api.py
    - Table names: "Deals", "Contacts", "Meetings", "Companies"
      Used in: autosched/baserow/*, middleware/model/schema.py

  [INBOUND WEBHOOKS]
    - POST /baserow/update  (autosched/baserow/app.clj)
      Payload includes: source_metadata.edit_source
```

### How this feeds into reviews

When a PR touches a file that the auto-discovery has identified as an integration point:

1. The agent includes the integration context in the LLM prompt
2. The LLM can reason about whether the change might break the other side
3. If the change modifies an outbound call's URL, payload shape, or a shared constant value, the agent flags it: "This modifies an integration point with [other repo]. Verify the other side is compatible."

**No manual contract files needed.** The agent discovers them from the code and re-discovers them on each run.

### For sibling repos

If the CLI is invoked with `--sibling-repo /path/to/other/repo`, it scans both repos and cross-references their integration points. This is the most powerful mode — the agent can say "you changed the response shape of `/internal/token-to-user` in autosched, and baserow-middleware parses this response in `clients/oliv.py:48`."

In CI, this means checking out both repos:

```yaml
# GitHub Action example
- uses: actions/checkout@v4
  with:
    repository: your-org/sibling-repo
    path: sibling
- run: reviewbot check --sibling-repo ./sibling
```

---

## 11. Phase 7: Staleness Detection & Self-Healing

### The problem

Even auto-derived knowledge can go stale. The codebase snapshot might be from last week. The CVE data might be from yesterday. The integration map might reference files that have been renamed.

### Quiet by default, loud when it matters

If the agent shows a staleness report on every PR, it becomes wallpaper. People stop reading it within a week. Instead:

**When everything is fresh**: Silence. No preamble. Just the review comments. At most, a single line at the bottom:

```
reviewbot: all checks current.
```

**When staleness actually impacted the review**: Explain what happened and what it means:

```
reviewbot: integration map was stale (2 endpoints referenced deleted files).
Re-scanned before this review. All integration points now verified.
```

**When staleness couldn't be auto-fixed**: Be specific about what's degraded and why:

```
reviewbot: overlay.yaml hasn't been updated in 94 days. Suppressed path
src/legacy/** no longer exists — I may be commenting on resolved debt.
Update .reviewbot/overlay.yaml to fix this, or ignore if debt is still active.
```

The principle: **only interrupt the developer when you have something actionable to say.** "Everything is fine" is not actionable. "I re-scanned because X was stale" is informational but non-blocking. "I can't tell if this is known debt" is actionable — the developer needs to decide.

### Self-healing actions

When the agent detects staleness, it doesn't just report it — it fixes what it can:

| Staleness                           | Auto-fix                                                                                                                          |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Codebase snapshot outdated          | Trigger incremental re-scan of changed files                                                                                      |
| Full re-scan needed (>30% churn)    | Trigger full re-scan, warn that review may take longer                                                                            |
| Dependency state stale              | Re-run `npm audit` / `pip-audit` before reviewing                                                                                 |
| Integration map has dead references | Remove stale entries, re-scan for new integration points                                                                          |
| CVE cache expired                   | Re-query OSV.dev for affected packages                                                                                            |
| Human overlay file stale            | Can't auto-fix — post a reminder: "overlay.yaml hasn't been updated in 94 days. If known debt has changed, consider updating it." |

The only thing that requires human action is the overlay file — and since it's optional and small, the blast radius of it being stale is limited to "the agent might comment on known debt that the team has already accepted."

### Staleness as a metric

Track the % of reviews run at HIGH vs. DEGRADED confidence over time. If DEGRADED is increasing, the agent's auto-derivation logic might need improvement — or the codebase is evolving in ways the agent doesn't understand.

---

## 12. Phase 8: Feedback Loop & Continuous Improvement

### Developer feedback collection

Every posted comment includes:

- A "Useful" / "Not Useful" action (button, emoji reaction, or CLI command depending on form factor)
- An optional free-text note for "Not Useful" comments explaining why

### Automated feedback

Following UReview's approach: after a PR is merged, re-run the agent on the final commit. If a comment's issue is no longer present in the final code, it was likely addressed. If it persists, it was likely ignored (either not useful or deferred).

### What feedback drives

| Signal                                            | Action                                                        |
| ------------------------------------------------- | ------------------------------------------------------------- |
| Category usefulness drops below 30%               | Auto-suppress that category                                   |
| Specific file paths consistently get "Not Useful" | Add to auto-derived suppression list                          |
| A comment type gets high "Useful" rate            | Lower confidence threshold → post more of these               |
| False citation reported                           | Flag source as unreliable, increase verification requirements |

### Metrics to track

**Important caveat**: The targets below are aspirational numbers for a mature, tuned system (6+ months of operation with feedback data). They are NOT baselines for a prototype. A freshly deployed agent will have lower usefulness rates and higher false positive rates. That's expected. Don't measure a v0.1 prototype against Uber's production numbers and panic — iterate on the feedback loop instead.

| Metric                  | What it measures                           | Aspirational target (mature) | Prototype expectation                                                                                              |
| ----------------------- | ------------------------------------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Usefulness rate**     | % of comments marked "Useful"              | >70%                         | 40-60% is fine initially                                                                                           |
| **Address rate**        | % of comments resolved in final commit     | >60%                         | 30-50%                                                                                                             |
| **False positive rate** | % of comments marked "Not Useful"          | <25%                         | <35% — developers tune out around 30-35% noise. Higher than this and your pilot won't survive the first two weeks. |
| **Coverage**            | % of PRs that receive at least one comment | Track, no target             | Track, no target                                                                                                   |
| **Latency**             | Time from PR creation to comments posted   | <5 minutes                   | <10 minutes                                                                                                        |
| **Cost per review**     | LLM API cost per PR                        | Track to avoid surprises     | Track to avoid surprises                                                                                           |

Track all of these from day one, but set expectations with the team that early numbers will be rough. The feedback loop (Phase 8) is what drives improvement — the metrics just measure the rate of improvement.

### Deferred: state-of-the-art verification

"State of the art" is not a standing product claim. Treat it as a future evaluation milestone with a frozen protocol, public baselines, and a hidden holdout set. The claim must be scoped narrowly — for example, "high-signal, citation-grounded TypeScript/Node PR review under a fixed cost and latency budget" — and revalidated over time as models and competing agents move.

The deferred suite should combine:

- Public code-review benchmarks such as CodeReviewBench, c-CRAB, SWRBench, and CodeFuse-CR-Bench
- Adjacent agent benchmarks such as SWE-bench Verified, used only for retrieval / context-selection signal rather than as proof of review quality
- A private WardenBench made from real PRs, seeded cross-file regressions, dependency / API misuse cases, security advisories requiring OSV-backed citations, and false-positive traps where the correct behavior is silence
- Baselines against deterministic tools alone, one-shot frontier LLM review, Warden ablations, and accessible commercial / open review agents

Primary metrics: precision, recall, F1 / F0.5, P0/P1 recall, false positives per PR, duplicate rate, line-localization accuracy, citation verification rate, unsupported-claim rate, accepted-by-developer rate, cost per review, latency, and degradation / crash rate.

This deserves its own ADR when scheduled. Until then, Warden should avoid broad "best AI code reviewer" language and prefer falsifiable, protocol-backed claims.

---

## 13. Phase 9: Escape Hatches — Rewrites, Migrations, Overrides

### Detecting major structural changes

The agent should flag when its cached knowledge might be stale:

- **File churn threshold**: If a PR modifies >40% of files in a module → likely a refactor
- **Dependency churn**: If >5 direct dependencies are added/removed in one PR → likely a migration
- **Build system changes**: If `tsconfig.json`, `next.config.js`, `webpack.config.js`, etc. are fundamentally altered → framework migration possible
- **New ecosystem markers**: If a `Cargo.toml` appears in a repo that was previously JS-only → new ecosystem being introduced

### What to do when detected

1. Post a single meta-comment: "This PR appears to contain a major structural change. Running a full re-scan before review. Some findings may have lower confidence than usual."
2. Trigger full codebase re-scan (not just incremental)
3. Set a flag in the review history so metrics aren't skewed

### Manual overrides

| Mechanism                     | Effect                                                    |
| ----------------------------- | --------------------------------------------------------- |
| PR label: `skip-ai-review`    | Agent does not post any comments                          |
| PR label: `full-ai-review`    | Agent ignores known-debt suppressions (review everything) |
| File: `.reviewbot/pause`      | Agent is globally paused until file is removed            |
| Comment: `@reviewbot ignore`  | Agent suppresses the specific comment thread              |
| Comment: `@reviewbot explain` | Agent elaborates on a specific finding with more context  |
| Comment: `@reviewbot rescan`  | Force full codebase re-scan                               |

---

## 14. Comment Schema

The full schema for a review comment, covering all phases:

```json
{
  "id": "uuid-v4",
  "file": "src/lib/api/client.ts",
  "line_start": 42,
  "line_end": 42,
  "tier": 1,
  "category": "vulnerability",
  "subcategory": "dependency-cve",
  "assistant": "dependency",
  "claim": "axios 0.21.1 is vulnerable to Server-Side Request Forgery (SSRF) via a crafted relative URL",
  "explanation": "An attacker can bypass hostname checks by supplying a relative URL that the library resolves against a base URL. This allows requests to internal services.",
  "suggested_action": "Upgrade to axios >=0.21.2. Run: npm install axios@latest",
  "sources": [
    {
      "type": "cve",
      "id": "CVE-2021-3749",
      "url": "https://nvd.nist.gov/vuln/detail/CVE-2021-3749",
      "severity": "high",
      "cvss_score": 7.5,
      "retrieved_at": "2026-05-03T10:30:00Z"
    },
    {
      "type": "advisory",
      "id": "GHSA-cph5-m8f7-6c5x",
      "url": "https://github.com/advisories/GHSA-cph5-m8f7-6c5x",
      "retrieved_at": "2026-05-03T10:30:00Z"
    }
  ],
  "confidence": 0.97,
  "source_type": "tool",
  "grader_reasoning": "CVE confirmed by OSV.dev API. Installed version 0.21.1 is within affected range. Fix available in 0.21.2+.",
  "suppressed": false,
  "posted_at": "2026-05-03T10:31:00Z",
  "feedback": null
}
```

---

## 15. Triage Tiers

| Tier  | Label         | Criteria                                                                                | Agent behavior                                                                  | Example                                                                                                   |
| ----- | ------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **1** | Must-fix      | Production incident risk, security vulnerability, data corruption, contract violation   | Always post. Never suppress. Block merge if integrated with CI.                 | Missing auth check, CVE in dependency, sync loop risk                                                     |
| **2** | Should-fix    | Valid bug or improvement, fixable within the PR scope                                   | Post if confidence > threshold. Developer can dismiss.                          | Missing error handling, unhandled promise rejection, unused variable in hot path                          |
| **3** | Informational | Technically correct observation, but either requires a larger refactor or is low-impact | Post only if explicitly requested (`full-ai-review` label). Otherwise suppress. | "This module doesn't follow current naming conventions", "Consider extracting this into a shared utility" |

### Volume cap

- Maximum **5 comments per PR** across all tiers (configurable)
- If more than 5 findings, prioritize by tier, then by confidence score
- **Remaining findings are discarded, not hidden.** No "additional findings" collapse section — that becomes a dumping ground where nags accumulate and nobody reads. If a finding isn't important enough to make the top 5, it isn't important enough to post. If it's genuinely important, tune the confidence thresholds so it ranks higher next time.

---

## 16. Lessons from Uber's UReview

Key takeaways from [Uber's UReview system](https://www.uber.com/en-IN/blog/ureview/) (deployed across 6 monorepos, 65k diffs/week, 75% usefulness rate):

1. **Precision > volume.** Developers lose trust after seeing a few bad comments. Start with fewer, higher-confidence comments and expand gradually.

2. **Two-LLM pipeline is essential.** Generator + Grader. Single-shot prompting produces too many false positives. UReview's best config: Claude Sonnet (generator) + o4-mini (grader).

3. **Developers hate style nits from AI.** Readability comments, naming suggestions, minor formatting issues — all consistently rated "Not Useful." Don't generate them.

4. **Category-level suppression works.** Track usefulness per comment category. If a category consistently gets poor ratings, suppress the entire category.

5. **CI-time review > IDE-time review.** You can't control what developers do locally. The code review platform is the enforcement point.

6. **LLMs catch bugs, not design issues.** Without access to PRDs, architecture docs, feature flags, and database schemas, the LLM can only assess what's visible in the source code. It can't evaluate whether the overall approach is correct.

7. **Feedback must be frictionless.** One-click "Useful" / "Not Useful" on every comment. If feedback requires effort, you won't get enough data to improve.

8. **Gradual rollout builds trust.** Start with one team, one assistant type. Prove value. Expand. Don't launch across the entire org on day one.

---

## 17. Anti-Patterns to Avoid

### The hallucinated CVE

The agent confidently claims a package has a vulnerability, but the CVE doesn't exist or doesn't apply to the installed version. **This is the single fastest way to destroy trust.** Every vulnerability claim must be tool-verified before posting.

### The drive-by refactor suggestion

"You should restructure this module to use the repository pattern." Technically valid, completely useless in the context of a 10-line bug fix PR. The agent must assess whether a suggestion is actionable within the scope of the current change.

### The stale knowledge assertion

"React.FC is deprecated" — it's not deprecated, it's discouraged by some style guides. The agent must distinguish between official deprecations (documented in changelogs) and community preferences (blog posts, tweets). Citation type matters.

### The noise flood

Posting 20 comments on a single PR. Even if all 20 are valid, the developer will ignore all of them. Cap volume ruthlessly.

### The repeated nag

Commenting on the same known-debt issue every time a file in that module is touched. If the team has acknowledged the debt and deferred it, the agent must stay silent. That's what the suppression list is for.

### The phantom context

Making claims about code behavior based on training data rather than the actual code in the repo. "Typically, this library handles X by doing Y" — but the repo has a custom wrapper that changes the behavior. The agent must reason from the actual codebase, not from general knowledge about libraries.

### The unverified upgrade suggestion

"Upgrade to v5.0.0 for the fix" — but v5.0.0 has a breaking change that affects the repo's usage. Upgrade suggestions must be verified against the repo's actual usage patterns, or at minimum flagged as "verify compatibility before upgrading."

### The rotting YAML

Designing a system that depends on humans maintaining a detailed architecture description file. They won't. Auto-derive everything possible. Make staleness of the rest visible and painful.

---

## Appendix: File Structure

```
.reviewbot/
├── overlay.yaml         # OPTIONAL human-maintained (known debt, force-enable categories)
├── config.yaml          # Agent configuration (thresholds, volume caps, BYOLLM provider config)
└── cache.sqlite         # Auto-managed (gitignored)
    ├── codebase_snapshot   # Auto-derived ecosystem, modules, integration points
    ├── dependency_state    # Scanner results with timestamps
    ├── review_comments     # Every comment posted
    ├── feedback            # Developer reactions
    ├── category_stats      # Aggregated usefulness per category
    └── external_knowledge  # CVE lookups, web search results with TTL
```

Note: only `overlay.yaml` and `config.yaml` are committed to the repo. Everything else is auto-managed and gitignored. The agent works without either file — they just tune its behavior.

### Example `config.yaml`

```yaml
# Review agent configuration
version: 1

# Model configuration
# Default: single provider, single API key. Works for 95% of users.
# The agent uses the default model for the boss and grading,
# and a cheaper model from the same provider for workers.
model:
  provider: anthropic
  api_key_env: REVIEWBOT_API_KEY # single env var, single provider

# Per-provider model mapping (auto-selected based on provider above)
# Each provider must offer a strong SKU (boss/grader/critical workers)
# and a cheap SKU (non-critical workers). The agent picks automatically.
#
#   Provider    | Strong (boss/grader/security/correctness) | Cheap (contract/best-practices)
#   anthropic   | claude-sonnet-4                            | claude-haiku-4
#   openai      | gpt-4.1                                   | gpt-4.1-mini
#   google      | gemini-2.5-pro                             | gemini-2.5-flash
#
# Advanced: override per-role if the default mapping doesn't fit
# advanced_model:
#   boss:      { model: claude-sonnet-4-20250514 }
#   grader:    { model: claude-sonnet-4-20250514 }
#   worker_strong: { model: claude-sonnet-4-20250514 }
#   worker_cheap:  { model: claude-haiku-4 }

# Comment thresholds
confidence_threshold:
  default: 0.7
  vulnerability: 0.5 # lower threshold — don't miss CVEs
  readability: 0.95 # very high threshold — almost never post these

# Volume limits
max_comments_per_pr: 5
max_tier3_comments: 0 # don't post informational comments by default

# Category suppression (auto-updated from feedback, can be manually overridden)
suppressed_categories:
  - readability:naming
  - readability:formatting
  - style:preferences

# File exclusions
excluded_paths:
  - "**/*.generated.*"
  - "**/*.min.js"
  - "**/vendor/**"
  - "**/__snapshots__/**"
  - "**/migrations/**"

# Ecosystem-specific tool config
tools:
  npm_audit: true
  pip_audit: true
  govulncheck: true
  osv_api: true
  license_check: false # enable when needed

# External knowledge cache TTLs (seconds)
cache_ttl:
  cve_lookup: 86400 # 24 hours
  package_version: 21600 # 6 hours
  web_search: 172800 # 48 hours
  changelog: 604800 # 7 days

# Deterministic pattern registry
patterns_file: .reviewbot/patterns.yaml

# Orchestration
orchestration:
  max_workers: 4
  worker_timeout: 30 # seconds per worker
  boss_timeout: 45 # seconds for synthesis + grading
  on_worker_timeout: continue # "continue" (post with degraded_workers) or "fail"

# Sibling repo integration map
# Built nightly or on sibling's main branch push — never scanned per-PR
sibling_repos: []
  # - path: ../other-repo            # for local dev / CLI
  #   name: other-repo
  #   integration_map: .reviewbot/integration-maps/other-repo.json  # pre-built artifact
```
