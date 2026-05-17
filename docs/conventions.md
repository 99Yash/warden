# Conventions

See [`CLAUDE.md`](../CLAUDE.md) for the slim agent index.

## TypeScript

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

**Never `db:push` outside local exploration.** Always `db:generate` → `db:migrate`.

## AI SDK

Warden uses AI SDK v6 (`ai@^6`). Common v6 differences from v5:

- `maxTokens` → `maxOutputTokens` in `generateText` / `streamText`.
- `maxSteps` → `stopWhen: [stepCountIs(n)]`.
- `tool()` uses `inputSchema`, not `parameters`.
- `LanguageModel` is a union — do not hardcode string model IDs in type positions.
- `generateObject` is _@deprecated_ — use `generateText` with an `output` setting.

Model selection: `getBossModel()`, `getWorkerStrongModel()`, `getWorkerCheapModel()` from `@warden/ai`. Do not call AI SDK provider functions directly from `@warden/core`. v0 hardcodes Anthropic per ADR-0006.

## Environment

Do not use `process.env` directly in app code — always go through `wardenEnv()` from `@warden/env`. See [`environment.md`](./environment.md) for the full env-var table and the workflow for adding a new var.
