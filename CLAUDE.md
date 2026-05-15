# Warden — agent orientation

Warden is an AI code review CLI. It runs deterministic tooling (TSC, ESLint, `npm audit`), verifies every external claim through citable sources (OSV.dev), and uses an LLM only as a triage and formatting layer.

Read [`decisions.md`](./decisions.md) before proposing architectural changes — 21 ADRs cover every major choice and rejection. [`CONTEXT.md`](./CONTEXT.md) is the noun glossary — reach for those terms before inventing new ones. [`vision.md`](./vision.md) is the long-form thinking framework that preceded the project; most of it is intentionally deferred past v0.

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

**CLI → core:** `packages/cli/src/index.ts` parses argv with commander, calls `review({ diff, repoRoot, config })` from `@warden/core`, formats the returned `CommentSet` via `packages/cli/src/format.ts`. The CLI is the _only_ consumer of `core` in v0; future bots (`apps/github-bot/`, `apps/slack-bot/`) will be additional consumers.

**Core → AI:** `packages/core/src/llm/` (when M4 lands) imports model dispatchers from `@warden/ai` (`getBossModel()`, `getWorkerStrongModel()`, `getWorkerCheapModel()`). Never imports AI SDK provider functions directly — always go through `@warden/ai`.

**Core → DB:** `packages/core/src/cache/` reads/writes the cache tables from `@warden/db`. `@warden/db` exposes a `db()` accessor returning the better-sqlite3 connection singleton; the file is auto-created at `.warden/cache.sqlite` (anchored to the nearest repo root via `resolveCachePath()`) on first use. `@warden/db` re-exports drizzle-orm operators (`eq`, `and`, `gt`, etc.) so callers don't add `drizzle-orm` to their own deps.

**Core stays I/O-pure (ADR-0013).** It must not import `commander`, `picocolors`, `ora`, or anything that reads `process.argv` / writes to `process.stdout` / assumes a TTY. All input is supplied via `ReviewInput`; all output is the returned `CommentSet`. This is what makes the future bot wrappers possible without rewriting the engine.

## Package boundaries

| Package          | Allowed dependencies                                                   | Forbidden                                                                         |
| ---------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `@warden/cli`    | `@warden/core`, `@warden/env`, commander, picocolors, ora, Node stdlib | None significant.                                                                 |
| `@warden/core`   | `@warden/ai`, `@warden/db`, `@warden/env`, zod, Node stdlib            | commander, picocolors, ora, `process.argv`, `process.stdout` (use return values). |
| `@warden/ai`     | AI SDK + provider packages, `@warden/env`                              | `@warden/core` (other direction); `@warden/db`.                                   |
| `@warden/db`     | drizzle-orm, better-sqlite3, `@warden/env`                             | `@warden/core` / `@warden/ai`.                                                    |
| `@warden/env`    | zod only                                                               | Anything else (must be importable from any package).                              |
| `@warden/config` | Nothing at runtime; ships TS configs only.                             | N/A.                                                                              |

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

Warden uses AI SDK v6 (`ai@^6`). Common v6 differences from v5:

- `maxTokens` → `maxOutputTokens` in `generateText` / `streamText`.
- `maxSteps` → `stopWhen: [stepCountIs(n)]`.
- `tool()` uses `inputSchema`, not `parameters`.
- `LanguageModel` is a union — do not hardcode string model IDs in type positions.
- `generateObject` is _@deprecated_ — use `generateText` with an `output` setting.

Model selection: `getBossModel()`, `getWorkerStrongModel()`, `getWorkerCheapModel()` from `@warden/ai`. Do not call AI SDK provider functions directly from `@warden/core`. v0 hardcodes Anthropic per ADR-0006.

## Environment variables

Validated by `wardenEnv()` from `@warden/env`. Calling it with missing required vars throws a clear error.

| Var                            | Notes                                                                                                     |
| ------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`            | Required. Even `warden check` validates env at start.                                                     |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Optional. Enables the ADR-0017 fallback (Anthropic → retry → Google). When unset, Anthropic failure is hard-fail. |
| `WARDEN_THINKING_BUDGET`       | Optional. Anthropic extended-thinking budget in tokens. Default 4096.                                     |
| `WARDEN_LOG_LEVEL`             | Optional. Default `info`. Values: `silent`, `error`, `warn`, `info`, `debug`.                             |

When adding a new env var: update `packages/env/src/index.ts`, `.env.example`, and this file.

Do not use `process.env` directly in app code — always go through `wardenEnv()`.

## Milestone status

- [x] M1 — Scaffold (see [`scaffolding-plan.md`](./scaffolding-plan.md))
- [x] M2 — Ecosystem detection + TSC/ESLint runners
- [x] M3 — npm audit + OSV verification (citation-discipline path lit up; advisories without an OSV record are dropped)
- [x] M4 — LLM formatter (end-to-end `warden review`). LLM is constrained to triage tool findings + ask clarification questions — never invents assertions (preserves ADR-0008 citation thesis). Prompts live in `packages/core/src/llm/prompts/{system,user-template}.md` per ADR-0015. Multi-provider fallback (Anthropic → retry → Google) per ADR-0017. Stable hash comment ids + content-addressed `llm_review_cache` table per the M4 grilling. Diff source auto-detects per mode (uncommitted for `check`, vs default-branch for `review`); `--base`/`--stdin`/`--verbose` flags supported. Phase log + reasoning-tail UX in `packages/cli/src/render.ts`.
- [x] M5 — Cheap-signals context selector + jscpd dedup runner per ADR-0018. `ContextSelector` interface in `packages/core/src/context/`; four signals (direct importers, direct imports, same-folder, symbol-ref) emit `ContextCandidate[]` with discriminated `reasons[]` carrying `Evidence[]` single-line ranges. Parser surface in `context/parser.ts` (`SourceParser` + `TsCompilerParser`) is the only place that imports `typescript`; the M6 tree-sitter swap-in drops in alongside. Selector runs parallel with TSC/ESLint/vuln; jscpd runs sequential after selector scoped to `changed ∪ candidates`. jscpd is loaded via `createRequire` to avoid an ESM/CJS interop bug in its `colors/safe` import. LLM prompt gains evidence-range adjacent context + path-only same-folder neighbors. New tables in `@warden/db`: `import_graph` (content-addressed, immutable per `(file_path, file_sha)`) + `file_state` (git-driven staleness pointer, refreshed via `git ls-files --modified --others --exclude-standard`). Smoke scripts: `packages/cli/scripts/smoke-m5-{selector,jscpd}.mts`.
- [x] M6 — Hosted embedding-backed selector + content-addressed indexing storage per ADR-0019. Voyage `voyage-code-3` embeddings via `code-chunk` chunker (TS/JS/Python/Rust/Go/Java); selector v2 adds `{kind:"semantic"}` reason variant (weight 0.9, intensity-scaled by cosine similarity). Locked-model concept (sticky `(model_id, model_version)` in `index_meta`); Voyage SKU bumps don't auto-rebuild — user runs `warden init --rebuild` to upgrade. `warden init` ships three-phase progress (walk → chunk → embed) + pre-flight LOC-based cost estimate + content-addressed crash-recovery; flags `--rebuild` / `--dry-run` / `--max-cost`. Limitation banner gradient (no-index / stale / model-aged / model-deprecated / D-soft init-only notice). Storage interfaces (`ChunkStore` / `EmbeddingStore` / `MerkleStore` / `JobRunner` / `IndexExporter` / `IndexImporter`) in `packages/core/src/indexing/` with SQLite default impls; `EmbeddingProvider` in `packages/ai/src/embeddings/`. Five new schemas: `chunks`, `embeddings`, `merkle`, `jobs`, `index_meta`. Auto-`.gitignore` helper runs at top of every verb. Plan: `m6-plan.md`.
- [x] M7 — Detector-driven category promotion + committability sub-agent + question citation discipline per ADR-0021. Two deterministic detectors (`scalability`, `deadcode`) shipped on the `m7` branch; the committability sub-agent shipped as part of M8's close-out; consistency detector + global citation verifier shipped in M10 (see below). Engine-maturity invariants: runtime schema migration; discriminated `degradedWorkers: { kind, topic, message }[]`. M6 punch-list blockers + cheap polish absorbed (#1, #2, #5, #6, #7, #8, #10, #12, #14). `committability.ts` ships an internal directory-concentration heuristic (per ADR-0022) until M9's diff-level noise filter at the diff loader supersedes it. Plan: `m7-plan.md`.
- [x] M8 — Orchestration spine: dispatch + scratchpad + synthesizer per ADR-0023. `packages/core/src/orchestration/` ships `Runner` contract + in-memory `Scratchpad` class + parallel `dispatch()` + `synthesize()` (review) / `deterministicSynthesize()` (check). Both verbs go through scratchpad; synthesis ending diverges. Migrated runners: `scalabilityRunner` + `committabilityRunner`. Remaining 6 (TSC, ESLint, jscpd, vuln, deadcode, consistency) stay inline and record outputs into the scratchpad directly; contract migration remains deferred. Synthesizer prompt byte-identical to M4. Committability sub-agent (M7 close-out): cheap-tier Haiku via `getWorkerCheapModel()` + Tier-1 hard-skip + ADR-0022 directory-concentration heuristic + per-finding substring-verified citations; prompt at `packages/core/src/llm/prompts/committability-system.md`; gated to `review` mode (no LLM in `check`). Vuln stays inline outside the scratchpad in M8 — its already-mapped `Comment[]` shape doesn't fit `RunnerOutput.findings: ToolFinding[]`; M9+ may revisit. Smoke: `packages/cli/scripts/smoke-m8-spine.mts`. Plan: `m8-plan.md`.
- [x] M9 — Diff-level noise filter per ADR-0022 / ADR-0025. Pre-runner stage at the diff loader (`packages/core/src/diff/prune.ts`) prunes via JS-only ecosystem profile (`packages/core/src/ecosystem/profiles/javascript.json`, `alwaysNoise.{directories,extensions}`) + language-agnostic `BASELINE_NOISE` constant + depth-limited diff tree (`packages/core/src/diff/tree.ts`, depth=3). One `topic: "noise-filter"` `kind: "actionable"` degraded entry per pruned subtree; per-file extension/baseline drops are silent ("loud about subtrees, quiet about individual files"). Defends the catastrophic case (committed `node_modules/` etc.) for *every* runner simultaneously — TSC, ESLint, jscpd, vuln, scalability, deadcode, consistency, committability all consume the pruned `ChangedFile[]`. M7 directory-concentration heuristic + Tier-1 hard-skip list removed from `committability.ts` (heuristic gone; Tier-1 graduated to `BASELINE_NOISE`). Lockfiles deliberately left in the diff (vuln runs against `repoRoot`; lockfile presence is signal). Smoke: `smoke-m9-{catastrophic,large-refactor}.mts`. Overlay surface, multi-ecosystem detector, structural fallback all deferred to M10+ per ADR-0025. Plan: `m9-plan.md`.
- [x] M10 — Close M7: consistency detector + global citation verifier per ADR-0021 §1c + §3. Schema extension (`SourceSchema` carries optional `{path, line, snippet}` triple with all-or-nothing refinement); committability migrated to emit through `sources[]` (internal verifier removed). Consistency detector (`packages/core/src/runners/consistency.ts`) is deterministic structured-verifier over the canonical doc set (`README.md`, `CLAUDE.md`, `AGENTS.md`, `docs/**`) for three claim types — env-var requirements (re-parses `packages/env/src/index.ts` as source to avoid `wardenEnv()` side-effects), CLI command shapes (re-parses `packages/cli/src/{index,commands/*}.ts` for `program.command(...)` / `.option(...)` calls), and `.warden/*` file-path constants (set-membership against literals grepped from `packages/*/src`). Global substring-verifier post-pass (`packages/core/src/llm/verify-citations.ts`) runs after `synthesize()` / `deterministicSynthesize()` and before `applyHardRules()`; drops sources whose `{path, line, snippet}` triple fails to substring-match the cited file at `line ± 5`, drops Comments left with no verified snippet sources, surfaces one `degraded: { kind: "info", topic: "llm" }` entry per failure mode. Stays inline like deadcode (not contract-migrated). Smoke: `smoke-m10-{consistency,verifier}.mts`. Plan: `m10-plan.md`.
- [x] M11 — Tool-augmented formatter + API claim verifier via `.d.ts` lookup per ADR-0026. Narrows ADR-0019's M10+ cross-repo retrieval entry to `.d.ts` only via lookup-on-demand cache. Formatter gains `lookupTypeDef({ package, symbol })` tool exposed through `@warden/ai`'s re-exported `tool()`; result becomes a new `api_def` `SourceTypeEnum` variant re-using M10's `{path, line, snippet}` triple; verifier post-pass extends `verify-citations.ts` with a `type`-dispatched branch on the same substring-match algorithm (api_def uses `API_DEF_DRIFT = 30` + concat-then-substring-match for multi-line `.d.ts` signatures; M10's per-line `LINE_DRIFT = 5` path stays unchanged for every other source type). AI SDK v6 tool-use loop with `stopWhen: stepCountIs(8)`; tool errors swallowed inside `execute()` so ai-retry's transient path is unaffected. Cache key (`computeCacheKey`) gains `dependenciesHash` (sha256 of `pnpm-lock.yaml` / `package-lock.json` / `yarn.lock`) so cached output invalidates on `npm install`. New `type_def_cache` SQLite table (compound primary key `(package, version, symbol)`; positive + negative-except-`package_not_installed` cached). Resolver under `packages/core/src/api/lookup-type-def.ts` walks `package.json#types/typings/exports/typesVersions` + `@types/<pkg>` fallback + relative-`.d.ts`-with-JS-extension-rewriting (`./sub.js` → `./sub.d.ts`); recursive re-export following capped at depth 8 with visited-set loop guard; symbol table covers namespaces (dotted paths like `NS.foo`), class/interface members (`User.method`), default exports, variable declarations. Tool descriptor at `packages/core/src/llm/tools/lookup-type-def.ts` owns the once-per-review "no node_modules/" `kind: "actionable", topic: "api-claim-verifier"` degraded emission via a mutable collector. System prompt gains a four-trigger "Verifying library API claims" section instructing the LLM to copy `result.suggestedSource` verbatim into `Comment.sources[]`. Tool exposed to formatter only — committability and future sub-agents stay tool-less until their own ADR. `leverage` review category, `node_modules/<pkg>/src` chunking, sibling repos, embedding-based `.d.ts` retrieval, webfetch fallback, user-global cache, and `Comment.api_claims[]` self-tagging are all explicitly out-of-scope per ADR-0026. Smoke: `smoke-m11-{lookup,verifier,no-node-modules}.mts` (`pnpm smoke:m11`). Dogfood observation logged for M12+: planted `parameters/inputSchema` library-claim diff triggered the formatter LLM but it did not invoke `lookupTypeDef` despite trigger #4 in the prompt — prompt-tuning signal, not a pipeline bug (acceptance criterion 4(b) "zero verified library claims attempted is acceptable" was met). Plan: `m11-plan.md`.
- [ ] M12 — `leverage` review category per ADR-0027. Cashes the second half of ADR-0026's keystone framing (M11 shipped the API claim verifier; M12 ships the producer half). Adds `'leverage'` to `CategoryEnum`, slots it between `style` and `dedup` in `PRIORITY_ORDER`, and teaches the internal `ToolFinding` / `toComment()` path about `source: "leverage"`. Two runners under one category: (a) **leverage detector** at `packages/core/src/runners/leverage.ts` — pure AST runner emitting `kind: "assertion"` findings for three v0 stdlib idiom-miss patterns (`JSON.parse(JSON.stringify)` → `structuredClone`; `indexOf !== -1` → `includes`; `filter(p).length > 0` / `find(p) !== undefined` → `some(p)`); runs in both `check` and `review`. (b) **leverage sub-agent** at `packages/core/src/runners/leverage-libraries.ts` — Haiku via `getWorkerCheapModel()` with own system prompt at `packages/core/src/llm/prompts/leverage-system.md` (library-agnostic + 4 canonical examples + dependency preamble from root/touched package manifests); has access to M11's `lookupTypeDef` tool with its own `stepCountIs(8)` budget; emits `kind: "question"` Comments carrying `api_def` sources verified post-pass by the existing M10/M11 global verifier; gated to `review` mode only. Both runners ride the M8 `Runner` contract from day 1 (no new debt). Public schema impact: one-line `CategoryEnum` extension — no new `SourceType`, no new SQLite tables, no `verify-citations.ts` changes. No FP escape hatch (dogfood-tune the patterns). Semantic retrieval over `.d.ts` via `type_def_embeddings` stays deferred to M13+ per ADR-0026 §14 + ADR-0027 §10. Smoke: `smoke-m12-{detector,sub-agent}.mts` (`pnpm smoke:m12`). Plan: `m12-plan.md`.
- [ ] M12+ — Deferred items spanning ADR-0008 (boss/worker workers, generator+grader, sibling-repo, multi-ecosystem detectors, state-of-the-art verification suite, license scanning) and ADR-0019 (BYOEmbedder, `node_modules/<pkg>/src` + sibling-repo + embedding-based `.d.ts` retrieval — the rest of the cross-repo bag M11 narrowed, custom-code SAST worker, `warden index export/import` CLI verbs, real async/daemon `JobRunner`, cloud-hosted index, mid-stream key-change handling, retrieval refinements). Plus self-aware boss model (memory `project_warden_self_aware_boss.md`), semantic retrieval over `.d.ts` for the leverage category (`type_def_embeddings` table per ADR-0026 §14 + ADR-0027 §10), webfetch fallback for uninstalled packages, and contract-migration of the remaining 6 inline runners (TSC, ESLint, jscpd, vuln, deadcode, consistency — ADR-0023 deferred). Each gets its own ADR + milestone plan when scheduled:
  - **BYOEmbedder** — multi-provider embedding abstraction (Voyage + OpenAI + Cohere + Gemini + local Transformers.js) + per-provider cost estimates. Mirrors ADR-0006's BYOLLM deferral. Local Transformers.js path addresses TOS / data-residency use cases for sensitive code.
  - **Semantic retrieval over `.d.ts` for leverage** — additive `type_def_embeddings` table keyed on `(package, version, symbol, model_id, model_version)` layered on M11's `type_def_cache`. Enables "find Drizzle's join-related primitives" queries when the M12 sub-agent's exact-match `lookupTypeDef` path hits recall limits. Schema is shaped for it per ADR-0026 §14; gated on dogfood evidence the M12 path is the bottleneck.
  - **Rest-of-cross-repo retrieval** — `node_modules/<pkg>/src` chunking + sibling-repo indexing (`--sibling-repo` flag) + embedding-based `.d.ts` retrieval. M11 shipped the `.d.ts` lookup subset; these three remain. Each likely earns its own ADR — sibling repos have a different change-detection surface, source chunking spikes Voyage cost on dep-heavy repos, embedding `.d.ts` is gated on the M12 sub-agent needing semantic queries.
  - **Custom-code SAST worker** — DeepSec-shaped per ADR-0015 (borrow pipeline, reject grounding model). Gated on M6 dogfood evidence that retrieval is good enough to support it.
  - **State-of-the-art verification suite** — evaluation milestone for proving or falsifying a narrow Warden quality claim, not a standing marketing claim. Combines public code-review benchmarks, adjacent agent benchmarks, a private WardenBench holdout, deterministic / LLM / Warden-ablation baselines, and hard metrics for precision, recall, F0.5, unsupported claims, citation verification, accepted-by-developer rate, cost, latency, and degradation. See `vision.md` §12.
  - **`warden index export/import` CLI verbs** — Q8 β deferral; interfaces ship in M6, verbs ship when first concrete consumer (CI cache, hosted migration, laptop-switching) materializes.
  - **Real async / daemon `JobRunner`** — Model B (review-time incremental embed) or Model C (background subprocess / `warden daemon`). Gated on dogfood evidence that users skip `warden init` consistently.
  - **Cloud-hosted index + sync** — hosted-mode swap point already named in ADR-0016; storage interfaces are backend-agnostic so this is additive, not a rewrite. Solves cache-loss recovery (the "embeddings on our cloud" hypothesis).
  - **Mid-stream key-change handling** — v2 multi-user / production scenarios where users change `VOYAGE_API_KEY` or per-user model selection partway through a project. Different problem space; different ADR.
  - **Retrieval refinements** — multi-vector queries (embed each changed file separately), per-symbol semantic ranking, hybrid BM25 + semantic, second-model reranking. Defer until dogfood reveals a specific gap; speculative without evidence.

Future, architecturally enabled per ADR-0013 (not committed):

- [ ] GitHub PR bot
- [ ] Slack bot
- [ ] ClickUp integration
