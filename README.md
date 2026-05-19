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

# 2. Create Warden's global config + env templates
pnpm warden setup

# 3. Build packages (required before type-checking with non-source exports;
#    not strictly needed when packages export ./src/*.ts directly)
pnpm build

# 4. Apply DB migrations to the local cache
pnpm db:generate
pnpm db:migrate

# 5. Add ANTHROPIC_API_KEY / VOYAGE_API_KEY to ~/.config/warden/env,
#    export them in your shell, or use a secret manager wrapper such as:
#    infisical run -- pnpm warden review

# 6. Build the embedding-backed context index (one-time; idempotent re-runs)
pnpm warden init

# 7. Run
pnpm warden check       # fast, deterministic-only pass — no LLM call
pnpm warden review      # full pipeline including LLM triage and formatter
```

## Environment variables

| Var                            | Purpose                                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `ANTHROPIC_API_KEY`            | Needed by `warden review`. Primary LLM provider for the review formatter (ADR-0006). `warden check` does not need it. |
| `VOYAGE_API_KEY`               | Needed by `warden init`. Enables the semantic context selector in `warden review` (ADR-0019); when unset, review falls back to cheap signals only. |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Optional. Enables the Anthropic → retry → Google fallback (ADR-0017). When unset, Anthropic failure is hard-fail. |
| `WARDEN_LOG_LEVEL`             | Optional. `silent` / `error` / `warn` / `info` (default) / `debug`.                                               |

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
warden setup   # create ~/.config/warden/config.jsonc + ~/.config/warden/env
               # and report readiness for check/review/init.
               # Use `warden setup --check` for read-only diagnostics.
               # Use `warden setup project` to add a repo-level warden.jsonc override.

warden init     # build (or refresh) the embedding-backed context index used by `review`.
                # Three phases: walk → chunk → embed. Idempotent re-runs hit the cache.
                # Flags: --rebuild, --dry-run, --max-cost <usd>.

warden check    # fast deterministic-only pass (TSC + ESLint + npm audit + OSV verification).
                # No LLM call. Suitable for pre-commit / CI gating.

warden review   # full pipeline: deterministic checks + semantic context selection +
                # LLM formatter that triages findings, writes citations, and orders
                # comments by review priority (correctness → clarity → style → dedup → tests).
```

Both accept `--json` for machine-readable output (the schema designed in ADR-0010 is what every future bot/wrapper consumes).

`warden patrol` (watch mode) is reserved for a future milestone (ADR-0011).

## Data flow

Warden is local-first by default — source code, caches, and the SQLite database stay on your machine. Three deterministic operations cross the network: CVE verification (M3), the LLM review call (M4), and embedding-backed context retrieval (M6). Warden has no telemetry; nothing else phones home.

**Stays on your machine, always:**

| What                                                  | Where                                                         |
| ----------------------------------------------------- | ------------------------------------------------------------- |
| Source code                                           | Your repo (Warden never modifies repo files)                  |
| Chunk metadata + raw chunk text                       | `.warden/cache.sqlite` → `chunks`                             |
| Embedding vectors                                     | `.warden/cache.sqlite` → `embeddings`                         |
| Merkle tree (file/dir hashes for change detection)    | `.warden/cache.sqlite` → `merkle`                             |
| LLM review cache                                      | `.warden/cache.sqlite` → `llm_review_cache`                   |
| M5 caches (import graph, file state)                  | `.warden/cache.sqlite`                                        |
| API keys                                              | Env vars only — read at runtime; never logged or persisted    |
| Tool output (TSC, ESLint, jscpd, npm-audit)           | In-memory during the run                                      |

`.warden/cache.sqlite` is gitignored. It's a single file you can delete or move; `warden init` rebuilds. Back it up outside the repo before destructive operations if you want a restore point.

**Sent over the network:**

| Verb                | Direction | What                                                          | Endpoint                                                                                  |
| ------------------- | --------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `warden init`       | outbound  | Chunk text (raw code excerpts)                                | Voyage `voyage-code-3` for embedding generation                                           |
| `warden init`       | inbound   | 1024-dim float32 vectors                                      | Voyage (persisted locally to `embeddings` table)                                          |
| `warden review`     | outbound  | Diff content (query-side embedding, not cached)               | Voyage                                                                                    |
| `warden review`     | inbound   | Query vector (held in memory only)                            | Voyage                                                                                    |
| `warden review`     | outbound  | Diff + tool findings + retrieved code excerpts                | Anthropic (Claude Sonnet 4 / Haiku 4); Google Gemini on transient failure per ADR-0017    |
| `warden review`     | inbound   | Review JSON (cached locally per diff hash)                    | Anthropic / Google                                                                        |
| `review` and `check`| outbound  | CVE IDs from `npm audit`                                      | OSV.dev (CVE verification per ADR-0008's citation thesis)                                 |
| `review` and `check`| inbound   | CVE verification records                                      | OSV.dev (cached locally with TTL)                                                         |

**What this means.** Code chunks travel to Voyage during `warden init` to produce embeddings; embeddings come back and stay local. Voyage doesn't retain inputs per their published policy, but the bits do traverse their infrastructure during the request. Diffs travel to both Voyage (query-side embedding, not cached) and Anthropic / Google (LLM review). CVE identifiers travel to OSV.dev for verification — never source code or repo metadata. Warden never uploads `.warden/cache.sqlite` itself.

If you're working on code subject to strict NDAs or data-residency requirements, you should know what crosses the wire before running `warden init` or `warden review`. A local-fallback embedding path (Transformers.js, no network) remains a deferred BYOEmbedder item per ADR-0019.

## Implementation milestones

Progress is tracked against the design captured in [`decisions.md`](./decisions.md), with the current milestone ledger in [`docs/milestones.md`](./docs/milestones.md).

- [x] M1–M17 — shipped local-first review CLI, deterministic checks, verified vulnerability citations, embedding-backed repo index, review harness, semantic refresh, eval calibration, worker dispatch throttling, and setup/onboarding.
- [ ] M18 — dedicated deep-security harness + `warden security` / `warden review --deep`, preserved at [`m18-plan.md`](./m18-plan.md).
- [ ] M19+ — BYOEmbedder, cross-repo retrieval, daemon/cloud index work, bot wrappers, and broader integration backlog.

Future deployment milestones (architecturally enabled, not committed; see ADR-0013):

- [ ] GitHub PR bot — webhook → `core.review()` → inline PR comments
- [ ] Slack bot — slash commands and event subscriptions
- [ ] ClickUp integration — shape TBD

## Architecture decisions

Each non-obvious choice has a numbered ADR in [`decisions.md`](./decisions.md). Read it before proposing architectural changes — most alternatives have already been considered and rejected with reasoning. The single load-bearing rule for v0 scaffolding: **`@warden/core` stays I/O-pure** (ADR-0013). The bot future depends on this discipline.
