# Warden — agent orientation

Warden is an AI code review CLI. It runs deterministic tooling (TSC, ESLint, `npm audit`), verifies every external claim through citable sources (OSV.dev), and uses an LLM only as a triage and formatting layer.

Read [`decisions.md`](./decisions.md) before proposing architectural changes — 14 ADRs cover every major choice and rejection. [`vision.md`](./vision.md) is the long-form thinking framework that preceded the project; most of it is intentionally deferred past v0.

## Commands

```bash
pnpm dev             # watch all packages
pnpm build           # build all packages
pnpm check-types     # tsc across all packages
pnpm lint            # oxlint
pnpm db:generate     # generate Drizzle migration from schema diff
pnpm db:migrate      # apply pending migrations to .warden/cache.sqlite
pnpm db:studio       # Drizzle Studio GUI
pnpm warden <cmd>    # run the CLI from the workspace
```

Non-standard rules:

- **Never `db:push` outside local exploration.** Always `db:generate` → `db:migrate`.
- Workspace packages export TS source directly (`./src/index.ts`), so `pnpm check-types` works on a fresh tree without a prior build.

## Monorepo layout

```
packages/
├── cli/             # @warden/cli — published binary; commander entry; output formatting
├── core/            # @warden/core — review pipeline; I/O-pure (ADR-0013)
├── ai/              # @warden/ai — AI SDK provider + model dispatcher
├── db/              # @warden/db — Drizzle schema + migrations for cache.sqlite
├── env/             # @warden/env — zod-validated env vars
└── config/          # @warden/config — shared tsconfig + oxlint base

apps/                # reserved for future GitHub PR bot, Slack bot, ClickUp integration (ADR-0013)
                     # empty in v0; pnpm-workspace.yaml's "apps/*" glob makes additions friction-free
```

All packages are `@warden/*`. The CLI binary is `warden`.

## How the pieces coordinate

**CLI → core:** `packages/cli/src/index.ts` parses argv with commander, calls `review({ diff, repoRoot, config })` from `@warden/core`, formats the returned `CommentSet` via `packages/cli/src/format.ts`. The CLI is the *only* consumer of `core` in v0; future bots (`apps/github-bot/`, `apps/slack-bot/`) will be additional consumers.

**Core → AI:** `packages/core/src/llm/` (when M4 lands) imports model dispatchers from `@warden/ai` (`getBossModel()`, `getWorkerStrongModel()`, `getWorkerCheapModel()`). Never imports AI SDK provider functions directly — always go through `@warden/ai`.

**Core → DB:** `packages/core/src/cache/` (when M3 lands) reads/writes the four cache tables from `@warden/db`. `@warden/db` exposes a `db()` accessor returning the better-sqlite3 connection singleton; the file is auto-created at `.warden/cache.sqlite` (relative to repo root) on first use.

**Core stays I/O-pure (ADR-0013).** It must not import `commander`, `picocolors`, `ora`, or anything that reads `process.argv` / writes to `process.stdout` / assumes a TTY. All input is supplied via `ReviewInput`; all output is the returned `CommentSet`. This is what makes the future bot wrappers possible without rewriting the engine.

## Package boundaries

| Package         | Allowed dependencies                                                          | Forbidden                                                |
| --------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------- |
| `@warden/cli`   | `@warden/core`, `@warden/env`, commander, picocolors, ora, Node stdlib        | None significant.                                        |
| `@warden/core`  | `@warden/ai`, `@warden/db`, `@warden/env`, zod, Node stdlib                   | commander, picocolors, ora, `process.argv`, `process.stdout` (use return values). |
| `@warden/ai`    | AI SDK + provider packages, `@warden/env`                                     | `@warden/core` (other direction); `@warden/db`.         |
| `@warden/db`    | drizzle-orm, better-sqlite3, `@warden/env`                                    | `@warden/core` / `@warden/ai`.                          |
| `@warden/env`   | zod only                                                                      | Anything else (must be importable from any package).    |
| `@warden/config`| Nothing at runtime; ships TS configs only.                                    | N/A.                                                     |

## TypeScript conventions

- All packages use `"moduleResolution": "bundler"` and `"verbatimModuleSyntax": true`. Use `import type` for type-only imports.
- `packages/cli` uses `tsc --noEmit` for type-checking (it's a leaf binary, not a library consumed elsewhere). All other packages use `tsc -b` via composite project references.
- When reading unfamiliar library APIs, inspect type definitions in `node_modules/.pnpm/*/node_modules/<pkg>/dist/*.d.ts` — do not guess from old docs or training data.

## Database

Schema lives in `packages/db/src/schema/`. Export everything through `packages/db/src/schemas.ts`.

```bash
# Typical schema change workflow
# 1. Edit packages/db/src/schema/<file>.ts
# 2. pnpm db:generate     ← diff schema → migration SQL
# 3. pnpm db:migrate      ← apply to local .warden/cache.sqlite
# 4. pnpm check-types     ← verify nothing broke
```

Drizzle config reads the SQLite file path from `@warden/env`'s default (`.warden/cache.sqlite`).

## AI SDK

Warden uses AI SDK v6 (`ai@^6`). Common v6 differences from v5 (mirrors Alfred):

- `maxTokens` → `maxOutputTokens` in `generateText` / `streamText`.
- `maxSteps` → `stopWhen: [stepCountIs(n)]`.
- `tool()` uses `inputSchema`, not `parameters`.
- `LanguageModel` is a union — do not hardcode string model IDs in type positions.
- `generateObject` is *@deprecated* — use `generateText` with an `output` setting.

Model selection: `getBossModel()`, `getWorkerStrongModel()`, `getWorkerCheapModel()` from `@warden/ai`. Do not call AI SDK provider functions directly from `@warden/core`. v0 hardcodes Anthropic per ADR-0006.

## Environment variables

Validated by `wardenEnv()` from `@warden/env`. Calling it with missing required vars throws a clear error.

| Var                  | Notes                                                |
| -------------------- | ---------------------------------------------------- |
| `ANTHROPIC_API_KEY`  | Required. Even `warden check` validates env at start. |
| `WARDEN_LOG_LEVEL`   | Optional. Default `info`. Values: `silent`, `error`, `warn`, `info`, `debug`. |

When adding a new env var: update `packages/env/src/index.ts`, `.env.example`, and this file.

Do not use `process.env` directly in app code — always go through `wardenEnv()`.

## Milestone status

- [x] M1 — Scaffold (see [`scaffolding-plan.md`](./scaffolding-plan.md))
- [x] M2 — Ecosystem detection + TSC/ESLint runners
- [ ] M3 — npm audit + OSV verification
- [ ] M4 — LLM formatter (end-to-end `warden review`)
- [ ] M5+ — Improvements driven by dogfooding feedback

Future, architecturally enabled per ADR-0013 (not committed):

- [ ] GitHub PR bot
- [ ] Slack bot
- [ ] ClickUp integration
