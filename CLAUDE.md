# Warden — agent orientation

Warden is an AI code review CLI. It runs deterministic tooling (TSC, ESLint, `npm audit`), verifies every external claim through citable sources (OSV.dev), and uses an LLM only as a triage and formatting layer.

Read [`decisions.md`](./decisions.md) before proposing architectural changes — 21 ADRs cover every major choice and rejection. [`CONTEXT.md`](./CONTEXT.md) is the noun glossary — reach for those terms before inventing new ones. [`vision.md`](./vision.md) is the long-form thinking framework that preceded the project; most of it is intentionally deferred past v0.

## Where to look next

| Topic | File |
| --- | --- |
| Monorepo layout, package boundaries, how the pieces coordinate | [`docs/architecture.md`](./docs/architecture.md) |
| TypeScript / AI SDK / Database rules — do's and don'ts | [`docs/conventions.md`](./docs/conventions.md) |
| Environment variable table + workflow for adding one | [`docs/environment.md`](./docs/environment.md) |
| Milestone status (M1–M16 shipped, M17+ deferred) | [`docs/milestones.md`](./docs/milestones.md) |

`AGENTS.md` is a symlink to this file.

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

Workspace packages export TS source directly (`./src/index.ts`), so `pnpm check-types` works on a fresh tree without a prior build. **Never `db:push` outside local exploration** — always `db:generate` → `db:migrate`. See [`docs/conventions.md`](./docs/conventions.md) for the full schema-change workflow.
