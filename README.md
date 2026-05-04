# Warden

AI code review CLI. Runs deterministic tooling (TSC, ESLint, npm audit), verifies every external claim through citable sources (OSV.dev for CVEs, package registries for deprecations), and uses an LLM as a triage and formatting layer — never as the source of truth. Built for personal Turborepo projects; designed to grow into GitHub PR, Slack, and ClickUp deployments later.

Architecture decisions are documented exhaustively in [`decisions.md`](./decisions.md). The long-form thinking framework that preceded the project lives in [`vision.md`](./vision.md).

## Stack

| Layer            | Choice                                                                  |
| ---------------- | ----------------------------------------------------------------------- |
| Monorepo         | pnpm + Turborepo                                                        |
| CLI              | `@warden/cli` (commander)                                               |
| Engine           | `@warden/core` — I/O-pure: `review({ diff, repoRoot, config }) → CommentSet` |
| Database         | Drizzle on better-sqlite3 (`.warden/cache.sqlite`, gitignored)          |
| AI               | Vercel AI SDK — Anthropic; Sonnet 4 (boss/grader/correctness/security), Haiku 4 (contract/best-practices) |
| Static analysis  | TSC + ESLint (TS only in v0; multi-ecosystem deferred)                  |
| Vulnerabilities  | `npm audit` + OSV.dev verification (every CVE cited before posting)     |
| Lint / format    | oxlint + oxfmt                                                          |
| Build            | tsdown                                                                  |

## Local setup

```bash
# 1. Install dependencies
pnpm install

# 2. Set the API key
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env

# 3. Build packages (required before type-checking with non-source exports;
#    not strictly needed when packages export ./src/*.ts directly)
pnpm build

# 4. Apply DB migrations to the local cache
pnpm db:generate
pnpm db:migrate

# 5. Run
pnpm warden check       # fast, deterministic-only pass — no LLM call
pnpm warden review      # full pipeline including LLM triage and formatter
```

## Environment variables

| Var                  | Purpose                                                |
| -------------------- | ------------------------------------------------------ |
| `ANTHROPIC_API_KEY`  | Required. LLM provider for the formatter / grader.    |
| `WARDEN_LOG_LEVEL`   | Optional. `silent` / `error` / `warn` / `info` (default) / `debug`. |

## Commands

```bash
pnpm dev               # watch all packages
pnpm build             # production build of all packages
pnpm check-types       # tsc across all packages
pnpm lint              # oxlint
pnpm db:generate       # generate Drizzle migration from schema diff
pnpm db:migrate        # apply pending migrations to .warden/cache.sqlite
pnpm db:studio         # Drizzle Studio GUI
pnpm warden <command>  # run the CLI from the workspace
```

## CLI verbs

```bash
warden check    # fast deterministic-only pass (TSC + ESLint + npm audit + OSV verification).
                # No LLM call. Suitable for pre-commit / CI gating.

warden review   # full pipeline: deterministic checks + LLM formatter that triages findings,
                # writes citations, and orders comments by review priority
                # (correctness → clarity → style → dedup → tests; ADR-0012).
```

Both accept `--json` for machine-readable output (the schema designed in ADR-0010 is what every future bot/wrapper consumes).

`warden patrol` (watch mode) is reserved for a future milestone (ADR-0011).

## Implementation milestones

Progress tracked against the design captured in [`decisions.md`](./decisions.md) and broken down per-milestone in [`scaffolding-plan.md`](./scaffolding-plan.md).

- [ ] M1 — Scaffold (workspace, packages, stub CLI, Drizzle harness, AI provider config)
- [ ] M2 — Ecosystem detection + TSC/ESLint runners → `warden check` produces real findings
- [ ] M3 — npm audit + OSV verification → CVE findings join the deterministic set
- [ ] M4 — LLM formatter → `warden review` produces ordered, cited comments end-to-end
- [ ] M5+ — Improvements driven by personal dogfooding feedback

Future deployment milestones (architecturally enabled, not committed; see ADR-0013):

- [ ] GitHub PR bot — webhook → `core.review()` → inline PR comments
- [ ] Slack bot — slash commands and event subscriptions
- [ ] ClickUp integration — shape TBD

## Architecture decisions

Each non-obvious choice has a numbered ADR in [`decisions.md`](./decisions.md). Read it before proposing architectural changes — most alternatives have already been considered and rejected with reasoning. The single load-bearing rule for v0 scaffolding: **`@warden/core` stays I/O-pure** (ADR-0013). The bot future depends on this discipline.
