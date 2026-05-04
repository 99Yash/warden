# Warden — Scaffolding Plan (M1 handoff)

This document is a self-contained brief for the agent (or future-me) that will scaffold the Warden repo. You don't need to have participated in the design conversation — read this plus `decisions.md` and you have everything.

## Read first (in this order)

1. **`./decisions.md`** — the 14 ADRs that define the stack. The *why* of every choice.
2. **`./vision.md`** — the long-form thinking framework, preserved from the original gist. Most of it is deferred past v0; use it for context, not as a v0 spec.
3. **`../alfred/CLAUDE.md`** — Alfred's repo orientation. Warden mirrors its workspace shape and conventions, slimmed down for a CLI (no `apps/server`, no `apps/web`, no auth, no Postgres/Redis).
4. **`../alfred/scaffolding-plan.md`** — Alfred's M1 brief. The *shape* of this document. Warden's M1 is much smaller because there's no server, web app, or sync layer.
5. **`../alfred/decisions.md`** — Alfred's ADRs. Reference points for stack choices Warden adopts (Vercel AI SDK pattern, tsdown build, TS-source exports). Do **not** mirror Alfred ADRs that don't apply (Replicache, Better Auth, Resend, Elysia, Postgres+pgvector, BullMQ).
6. **`../alfred/package.json`, `../alfred/pnpm-workspace.yaml`, `../alfred/turbo.json`** — config-shape references. Copy structure, trim dependencies aggressively.

## Goal of this milestone

Implement **M1: scaffold Warden**. By the end:

- `pnpm install` succeeds at the warden root.
- `pnpm build` builds all packages.
- `pnpm check-types` passes across all packages.
- `pnpm lint` passes (oxlint).
- `pnpm warden --version` prints the version.
- `pnpm warden check --help` and `pnpm warden review --help` print sensible help text.
- `pnpm warden check` and `pnpm warden review` run, both print a stub message ("not implemented yet — M1 scaffold only"), and exit 0.
- `packages/db` has at least one Drizzle table (`external_knowledge`, the simplest of the four caches in `vision.md` §9), `pnpm db:generate` produces SQL, `pnpm db:migrate` applies it to a local `.warden/cache.sqlite`.
- `packages/ai` instantiates the AI SDK Anthropic provider (no actual API call required for M1).
- `@warden/core`'s `review({ diff, repoRoot, config }) → CommentSet` exists with the signature from ADR-0013 (returns an empty `CommentSet` for now).
- No business logic beyond the above — this is *only* scaffolding.

**Stop at "hello-world works." Do not start implementing review logic.** Subsequent milestones (ecosystem detection, TSC/ESLint runners, OSV verification, LLM formatter) are separate sessions.

## Repo layout to create

```
warden/
├── packages/
│   ├── cli/             # @warden/cli — published binary; commander entry
│   ├── core/            # @warden/core — review pipeline (I/O-pure per ADR-0013)
│   ├── ai/              # @warden/ai — AI SDK provider + model dispatcher
│   ├── db/              # @warden/db — Drizzle schema + migrations for cache.sqlite
│   ├── env/             # @warden/env — zod-validated env vars
│   └── config/          # @warden/config — shared tsconfig.base.json + oxlint base
├── apps/                # reserved for future bots (ADR-0013); leave the directory absent
│                        # in M1 — pnpm-workspace.yaml's "apps/*" glob handles future additions
├── .gitignore
├── .nvmrc               # node LTS — match Alfred's
├── .oxlintrc.json       # copy Alfred's, trim to defaults
├── .oxfmtrc.json        # copy Alfred's
├── .env.example         # ANTHROPIC_API_KEY only
├── README.md            # already exists
├── vision.md            # already exists
├── decisions.md         # already exists
├── scaffolding-plan.md  # this file
├── CLAUDE.md            # already exists (stub)
├── AGENTS.md            # symlink → CLAUDE.md
├── package.json         # root, name "warden"
├── pnpm-workspace.yaml
├── tsconfig.json        # extends @warden/config
└── turbo.json
```

Notes:

- **No `apps/`** directory in M1. The `pnpm-workspace.yaml` should include `"apps/*"` in its `packages` glob anyway, so future `apps/github-bot` is friction-free.
- **No `docker-compose.yml`** — Warden v0 has no services (ADR-0007, ADR-0013). When the GitHub bot lands later it will introduce its own docker-compose alongside an ADR for hosted infra.
- **No `packages/auth`, `packages/sync`, `packages/integrations`, `packages/ingestion`** — Alfred-specific.

## What to reference from Alfred (pattern, not verbatim copy)

These can be lifted with adaptation. The package namespace is `@warden/*` (not `@alfred/*`).

- **Root config**: `pnpm-workspace.yaml` (trim catalog), `turbo.json` (drop `db:studio`-style server tasks; keep `build`, `check-types`, `dev`, `lint`), `package.json` (rename to `"warden"`, trim scripts), `tsconfig.json` (extends `@warden/config`), `.gitignore` (add `.warden/`), `.nvmrc`, `.oxlintrc.json`, `.oxfmtrc.json`.
- **`packages/config/`** — copy entire package; rename to `@warden/config`. Strip any rules that assume DOM / React.
- **`packages/env/`** — copy structure (`src/index.ts` exposing `wardenEnv()` via zod). Single env var for M1: `ANTHROPIC_API_KEY`. Optional: `WARDEN_LOG_LEVEL` with default `"info"`.
- **`packages/ai/`** — copy structure (`src/index.ts`, `src/provider.ts`, `src/models.ts`). Rewrite contents:
  - `provider.ts` — instantiate `createAnthropic({ apiKey })` from `@ai-sdk/anthropic` using `wardenEnv().ANTHROPIC_API_KEY`. No Google/OpenAI in M1 (deferred per ADR-0006).
  - `models.ts` — exports `getBossModel()`, `getWorkerStrongModel()`, `getWorkerCheapModel()` returning `LanguageModel` instances. Hardcode `claude-sonnet-4-...` for boss/strong, `claude-haiku-4-...` for cheap. Don't call them yet.
- **`packages/db/`** — port Drizzle harness: `drizzle.config.ts`, `package.json` scripts (`db:generate`, `db:migrate`, `db:studio`). **Critical adaptations:**
  - SQLite dialect, not Postgres. Driver: `better-sqlite3`. Drizzle import path: `drizzle-orm/better-sqlite3` (not `drizzle-orm/postgres-js`).
  - DB URL: `.warden/cache.sqlite` (relative to repo root). Defaults to creating the file if missing.
  - One schema file in M1: `src/schema/external-knowledge.ts` with a single table for CVE-lookup cache (id, queryKey, payload JSON, ttlExpiresAt). Don't model the other three caches yet — they land in M2-M4.
  - Drop `pgvector`-related migration setup. Drop `lifecycle_dates` if it depends on Postgres-specific defaults — re-derive a SQLite version.

## What to build from scratch (no Alfred equivalent)

### `packages/cli/`

Alfred has no CLI. Build with `commander`:

- `src/index.ts` — entry with `#!/usr/bin/env node` shebang. Defines `program.name("warden")`, two subcommands `check` and `review`, both with `--json` flag and `--help`. Action handlers call into `@warden/core`'s `review()` and print stubs in M1.
- `src/format.ts` — pretty-printer for `CommentSet` (M1 stub: prints "not implemented yet"; M4 will fill it in). Uses `picocolors` for severity coloring, OSC 8 escape sequences for `file:line` hyperlinks.
- `package.json` — `"bin": { "warden": "./dist/index.js" }`. Exports `./src/index.ts` for dev (TS-source export convention).
- Build via `tsdown`. Ensure shebang is preserved in dist output.

Public surface for M1:

```ts
// packages/cli/src/index.ts
#!/usr/bin/env node
import { Command } from "commander";
import { review } from "@warden/core";
import { wardenEnv } from "@warden/env";

const program = new Command();
program
  .name("warden")
  .description("AI code review CLI — runs deterministic tooling, verifies external claims, and uses an LLM as a triage layer")
  .version("0.0.1");

program
  .command("check")
  .description("Fast deterministic-only review (TSC + ESLint + npm audit + OSV verification)")
  .option("--json", "Emit JSON output")
  .action(async (opts) => {
    // M1 stub: validate env, call review() with mode: "check", print result
    wardenEnv();  // throws if ANTHROPIC_API_KEY missing — even though check doesn't use the LLM, fail fast at scaffold time so M2 doesn't surprise
    const result = await review({ diff: "", repoRoot: process.cwd(), config: { mode: "check" } });
    if (opts.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } else {
      console.log("warden check: not implemented yet (M1 scaffold).");
    }
  });

program
  .command("review")
  .description("Full pipeline including LLM formatter")
  .option("--json", "Emit JSON output")
  .action(async (opts) => {
    wardenEnv();
    const result = await review({ diff: "", repoRoot: process.cwd(), config: { mode: "review" } });
    if (opts.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } else {
      console.log("warden review: not implemented yet (M1 scaffold).");
    }
  });

program.parseAsync(process.argv);
```

### `packages/core/`

The engine. **I/O-pure per ADR-0013**: no `commander`, no `console.log`, no `process.argv`, no platform-specific imports. Public API:

```ts
// packages/core/src/index.ts
import { z } from "zod";

// Comment schema mirrors vision.md §14 (full schema lands in M4 when LLM formatter ships).
// M1 ships the type contract only.

export const CommentSchema = z.object({
  id: z.string(),
  file: z.string(),
  lineStart: z.number().int().nonnegative(),
  lineEnd: z.number().int().nonnegative(),
  tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  category: z.enum(["correctness", "clarity", "style", "dedup", "tests", "security", "vulnerability"]),
  claim: z.string(),
  explanation: z.string(),
  suggestedAction: z.string().optional(),
  sources: z.array(z.object({
    type: z.enum(["cve", "advisory", "changelog", "documentation", "web", "tool", "repo_convention"]),
    url: z.string().url().optional(),
    id: z.string().optional(),
    title: z.string().optional(),
    retrievedAt: z.string(),  // ISO timestamp
  })).default([]),
  confidence: z.number().min(0).max(1),
});

export const CommentSetSchema = z.object({
  comments: z.array(CommentSchema),
  metadata: z.object({
    durationMs: z.number().nonnegative(),
    degradedWorkers: z.array(z.string()).default([]),
  }),
});

export type Comment = z.infer<typeof CommentSchema>;
export type CommentSet = z.infer<typeof CommentSetSchema>;

export interface ReviewConfig {
  mode: "check" | "review";
}

export interface ReviewInput {
  diff: string;
  repoRoot: string;
  config: ReviewConfig;
}

export async function review(input: ReviewInput): Promise<CommentSet> {
  // M1: stub. M2 wires ecosystem detection + TSC/ESLint. M3 adds OSV. M4 adds LLM formatter.
  return {
    comments: [],
    metadata: { durationMs: 0, degradedWorkers: [] },
  };
}
```

The `review()` signature is **load-bearing for the bot future** (ADR-0013). It must not change shape without a new ADR.

## Catalog dependencies (in `pnpm-workspace.yaml`)

Trim Alfred's catalog aggressively. Warden M1 needs:

**Runtime:**
- `ai` (Vercel AI SDK v6)
- `@ai-sdk/anthropic`
- `commander` — CLI argv
- `zod` — schemas + env validation
- `picocolors` — terminal colors (lighter than chalk)
- `ora` — spinners
- `better-sqlite3` — SQLite driver
- `drizzle-orm` — ORM
- `nanoid` — ID generation

**Dev:**
- `typescript`
- `tsdown` — bundler
- `@types/node`
- `@types/better-sqlite3`
- `oxlint`
- `oxfmt`
- `drizzle-kit`
- `turbo`

**Do not include** (Alfred-only): `pg`, `@types/pg`, `replicache`, `bullmq`, `ioredis`, `better-auth`, `resend`, `@elysiajs/*`, `@tanstack/react-router`, `vite`, `@simplewebauthn/*`, `voyageai`, `perplexity` clients, `langfuse`, `posthog`, `sentry`, `@modelcontextprotocol/sdk`. None of them apply to v0.

## Environment variables expected

Add to `packages/env/src/index.ts`:

```ts
import { z } from "zod";

const Schema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY required — see https://console.anthropic.com"),
  WARDEN_LOG_LEVEL: z.enum(["silent", "error", "warn", "info", "debug"]).default("info"),
});

let cached: z.infer<typeof Schema> | undefined;

export function wardenEnv() {
  if (!cached) cached = Schema.parse(process.env);
  return cached;
}
```

`.env.example` at repo root:

```bash
# Required
ANTHROPIC_API_KEY=sk-ant-...

# Optional
WARDEN_LOG_LEVEL=info
```

## Conventions to enforce from day one

These come from Alfred and apply to Warden verbatim:

- **All packages export TS source via `"default": "./src/index.ts"`**. The `tsdown` build only emits `.d.ts` for downstream type resolution. See Alfred's `docs/package-boundaries.md` for the rationale (when alfred/docs lands; otherwise extrapolate from `apps/server/package.json`).
- **`pnpm check-types` works on a fresh tree without a prior build** because of the TS-source export convention above.
- **No transitive package imports** — `packages/cli` imports `@warden/core` types via the package export, never reaches into `packages/core/src/...` directly.
- **Drizzle migrations**: `pnpm db:generate` then `pnpm db:migrate`. Never `db:push` outside local exploration.

These are Warden-specific:

- **`@warden/core` is I/O-pure** (ADR-0013). Never imports `commander`, never calls `console.log` or `process.stdout` directly, never reads `process.argv`, never assumes a TTY. All output flows through the function return value. *This is the load-bearing constraint for the bot future.*
- **One-shot CLI shape** (ADR-0014). No long-running processes, no interactive prompts, no Ink/TUI. Streamed output is fine; persistent state machines are not.

Worth adding an oxlint config rule that bans `commander` / `picocolors` / `ora` / `process.argv` from being imported under `packages/core/`. If oxlint can't express this, leave a comment in `packages/core/src/index.ts` and add it as M2 work.

## Acceptance criteria for M1

When all of these pass, scaffolding is done:

- [ ] `pnpm install` at root succeeds.
- [ ] `pnpm build` builds all packages.
- [ ] `pnpm check-types` passes across all packages.
- [ ] `pnpm lint` passes (oxlint).
- [ ] `packages/db` `db:generate` produces a `*.sql` file in `packages/db/src/migrations/`; `db:migrate` applies it to `.warden/cache.sqlite`. The file is created in the project root's `.warden/` directory and is gitignored.
- [ ] `packages/ai`'s `getBossModel()` / `getWorkerStrongModel()` / `getWorkerCheapModel()` return non-null `LanguageModel` instances when `ANTHROPIC_API_KEY` is set. (No actual generation call required.)
- [ ] `pnpm warden --version` prints `0.0.1`.
- [ ] `pnpm warden check --help` and `pnpm warden review --help` print help text including the `--json` flag.
- [ ] `pnpm warden check` exits 0 and prints "warden check: not implemented yet (M1 scaffold).".
- [ ] `pnpm warden check --json` exits 0 and prints `{"comments":[],"metadata":{"durationMs":0,"degradedWorkers":[]}}` (or the equivalent JSON structure).
- [ ] Same for `pnpm warden review` and `pnpm warden review --json`.
- [ ] `pnpm warden check` exits non-zero with a clear error if `ANTHROPIC_API_KEY` is missing (env validation runs even for `check` so M2 onwards doesn't surprise).
- [ ] No business logic beyond the above. No ecosystem detection, no TSC runner, no ESLint runner, no `npm audit` runner, no OSV calls, no LLM calls.

## What NOT to do in this milestone

- **Do not implement ecosystem detection.** That's M2 (the first real review feature).
- **Do not run TSC, ESLint, or any deterministic tool.** M2.
- **Do not call `npm audit` or query OSV.** M3.
- **Do not call the LLM for anything.** M4. M1 only *constructs* the model instance; it never calls `.generateText()` or similar.
- **Do not scaffold `apps/*`.** Bot deployments are deferred per ADR-0013.
- **Do not add Postgres, Redis, or any docker-compose service.** Deferred.
- **Do not implement `warden patrol`.** Parked per ADR-0011.
- **Do not write tests.** Personal-project convention is no test culture (per memory + ADR-0012's caveat). Smoke scripts (when needed) live under `scripts/smoke-*.ts` per Alfred's pattern.
- **Do not implement multi-provider model selection.** Hardcoded Anthropic per ADR-0006.
- **Do not add interactive prompts, TUI, or Ink.** Forbidden by ADR-0014.

If you find yourself reaching for any of the above, stop and re-read `decisions.md` — those are explicitly deferred.

## When you're done

- Commit message format follows Alfred's convention. Inspect `git log` in `../alfred` for the style. Sign off with the same `Co-Authored-By` line.
- Hand back: a list of any deviations from this plan (with reasons), and a confirmation that all acceptance criteria pass.
- The next session will pick up at M2 (ecosystem detection + TSC/ESLint integration → `warden check` produces real findings on a TS Turborepo).

---

## Lessons from M1 → M2 transition

*(Empty — append after M1 ships and M2 begins, mirroring Alfred's pattern.)*
