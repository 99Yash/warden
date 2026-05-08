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

# 2. Set the API keys
cat <<EOF > .env
ANTHROPIC_API_KEY=sk-ant-...
VOYAGE_API_KEY=pa-...
EOF

# 3. Build packages (required before type-checking with non-source exports;
#    not strictly needed when packages export ./src/*.ts directly)
pnpm build

# 4. Apply DB migrations to the local cache
pnpm db:generate
pnpm db:migrate

# 5. Build the embedding-backed context index (one-time; idempotent re-runs)
pnpm warden init

# 6. Run
pnpm warden check       # fast, deterministic-only pass — no LLM call
pnpm warden review      # full pipeline including LLM triage and formatter
```

## Environment variables

| Var                            | Purpose                                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `ANTHROPIC_API_KEY`            | Required. Primary LLM provider for the review formatter (ADR-0006).                                               |
| `VOYAGE_API_KEY`               | Required for `warden init`. Enables the semantic context selector in `warden review` (ADR-0019); when unset, review falls back to cheap signals only. |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Optional. Enables the Anthropic → retry → Google fallback (ADR-0017). When unset, Anthropic failure is hard-fail. |
| `WARDEN_THINKING_BUDGET`       | Optional. Anthropic extended-thinking budget in tokens. Default 4096.                                             |
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

`.warden/cache.sqlite` is gitignored. It's a single file you can delete or move; `warden init` rebuilds. To back it up before destructive operations, `cp .warden/cache.sqlite .warden/cache.sqlite.bak`.

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

If you're working on code subject to strict NDAs or data-residency requirements, you should know what crosses the wire before running `warden init` or `warden review`. A local-fallback embedding path (Transformers.js, no network) is on the M7+ roadmap for sensitive-code use cases (BYOEmbedder per ADR-0019).

## Implementation milestones

Progress tracked against the design captured in [`decisions.md`](./decisions.md) and broken down per-milestone in [`scaffolding-plan.md`](./scaffolding-plan.md).

- [x] M1 — Scaffold (workspace, packages, stub CLI, Drizzle harness, AI provider config)
- [x] M2 — Ecosystem detection + TSC/ESLint runners → `warden check` produces real findings
- [x] M3 — npm audit + OSV verification → advisories without an OSV record are dropped (citation discipline lit up)
- [x] M4 — LLM formatter → `warden review` produces ordered, cited comments end-to-end; multi-provider fallback (Anthropic → Google) per ADR-0017
- [x] M5 — Cheap-signals context selector (import graph, symbol refs, same-folder) + jscpd dedup runner per ADR-0018
- [ ] M6 — Hosted embedding-backed selector + content-addressed indexing storage; `warden init` + locked-model + limitation banner per ADR-0019
- [ ] M7+ — TBD based on M6 dogfooding (likely some combination of cross-repo retrieval, `leverage` review category, custom-code SAST worker, BYOEmbedder, async `JobRunner`, `warden index export/import` CLI verbs)

Future deployment milestones (architecturally enabled, not committed; see ADR-0013):

- [ ] GitHub PR bot — webhook → `core.review()` → inline PR comments
- [ ] Slack bot — slash commands and event subscriptions
- [ ] ClickUp integration — shape TBD

## Architecture decisions

Each non-obvious choice has a numbered ADR in [`decisions.md`](./decisions.md). Read it before proposing architectural changes — most alternatives have already been considered and rejected with reasoning. The single load-bearing rule for v0 scaffolding: **`@warden/core` stays I/O-pure** (ADR-0013). The bot future depends on this discipline.
