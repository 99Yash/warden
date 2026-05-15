# CONTEXT — Warden ubiquitous language

The noun dictionary for Warden. The codebase, the docs, and any planning session should reach for these terms before inventing new ones. When language drifts in a session, sharpen the entry here. When a new concept earns a name, add it here. Don't bury definitions in code comments.

This file is **not** an architecture overview (see [`CLAUDE.md`](./CLAUDE.md)), a "why" record (see [`decisions.md`](./decisions.md)), or a milestone plan (`m{N}-plan.md`, [`scaffolding-plan.md`](./scaffolding-plan.md)). It is the layer underneath all of those.

**Conventions.** `[deferred]` marks terms that name concepts not yet built — useful shorthand, not yet load-bearing. `→ ADR-NNNN` points to the canonical justification. `→ M{N}-plan` points to a milestone plan where the term is operationalised. Type names and code symbols stay in `code style`; domain concepts stay in **bold**.

---

## 1. Pipeline + verbs

**`warden check`** — Fast, deterministic-only review (TSC + ESLint + npm audit + OSV verification). No LLM call. Pre-commit / CI gating. → ADR-0011.

**`warden review`** — Full pipeline: deterministic checks + context selection + LLM formatter that triages findings, writes citations, and orders **comments** by **priority order**. → ADR-0011, ADR-0012.

**`warden init`** — Builds (or refreshes) the embedding-backed context index. Three sequential **phases**: walk → chunk → embed. Idempotent re-runs hit the cache. Flags: `--rebuild`, `--dry-run`, `--max-cost`. → ADR-0019, m6-plan.md.

**`warden patrol`** — `[deferred]` Reserved verb for watch-mode (IDE-style background scanning). → ADR-0011.

**`warden security`** — `[deferred, M14]` On-demand deep SAST verb per the security-depth-tiers memory. Invokes the dedicated **security harness** with a Sonnet specialist worker; opt-in cost; multi-step pipeline (DeepSec-shaped scan → reason → cite with substring-verifier replacing LLM-judges-LLM revalidation). M13 shipped the default-review tier (ESLint security detector + Haiku triage sub-agent); M14 ships this verb. `--deep` flag on `warden review` is an alternative shape considered during M13 grilling; M14's ADR picks one. M13 deliberately ships no teaser pointing at this verb — discoverability lives in M14's docs + `--help`. → ADR-0028 §10, memory: `project_warden_security_depth_tiers.md`.

**`warden index export` / `warden index import`** — `[deferred]` CLI verbs for bulk index migration (laptop switching, CI cache, hosted-mode handoff). Storage interfaces ship in M6; verbs ship when a concrete consumer materialises. → ADR-0016.

**review pipeline** — The phase order inside `warden review`: ecosystem detect → deterministic runners (TSC, ESLint, vuln, jscpd, **selector**) + sub-agents (committability) routed through **dispatch + scratchpad** (M8) → **synthesizer** LLM call (M8 — replaces the M4 formatter call site) → output. M4 collapsed dispatch + synthesis into a single inline formatter call; M8 (ADR-0023) extracts the spine — `Runner` contract, in-memory `Scratchpad`, parallel `dispatch()`, `synthesize()` for `review` / deterministic formatter for `check`. Full **boss/worker orchestration** (specialist Sonnet workers, dynamic dispatch, three execution modes) is still `[deferred]`. → ADR-0008, ADR-0023, m7-plan.md, m8-plan.md.

**phase** — A named segment of `warden init` (walk / chunk / embed) or of `warden review` (the runners + formatter steps). Each phase emits progress output and, where relevant, partial snapshots for crash recovery.

---

## 2. Findings, comments, citations

**finding** — A tool-verified defect from a deterministic runner (TSC, ESLint, npm audit + OSV, jscpd, M7 detectors). Findings are facts: every finding carries a source. Maps to a **comment** of `kind: "assertion"`. → ADR-0008.

**question** — An open-ended clarification or suggestion emitted by the LLM (or an LLM **sub-agent**) when intent is ambiguous. Maps to a **comment** of `kind: "question"`. May carry citations; citations are checked by the **substring-verifier** post-pass. → ADR-0021.

**`Comment`** — The unit of review output. Carries `id`, `file`, `lineStart` / `lineEnd`, `tier`, `category`, `kind`, `claim` / `body`, `explanation`, `suggestedAction`, `sources[]`, `confidence`. → ADR-0010.

**`CommentSet`** — Wrapper returned by `review()`: `comments[]` + metadata (`durationMs`, `degradedWorkers[]`). The schema is the API every future bot wrapper consumes. → ADR-0010, ADR-0013.

**`ReviewInput`** — Sole input shape for `review({ diff, repoRoot, config })`. Anchors the **I/O-pure core** invariant.

**tier** — Severity classification on a comment: **Tier 1** must-fix (production risk, vulnerability, data corruption — always post); **Tier 2** should-fix (real bug, in-scope); **Tier 3** informational (correct but low-impact or larger refactor — post only on request).

**category** — What kind of concern a comment represents. Schema-backed categories today include `correctness`, `clarity`, `style`, `dedup`, `tests`, `security`, `vulnerability`, `contract`, `scalability`, `consistency`, `deadcode`, `committability`, and `leverage`; not every slot has a producer. M12 added the `leverage` producers (this hand-rolled code duplicates a library or stdlib primitive — ADR-0027). M13 added the first `security` producers — the **ESLint security detector** half and the **security sub-agent** half (ADR-0028). Categories drive prompt shape, worker routing, and the feedback signal used for category promotion. → ADR-0012, ADR-0020, ADR-0027, ADR-0028.

**priority order** — The reading order enforced on the output, orthogonal to tier: **correctness → security → vulnerability → contract → scalability → consistency → deadcode → committability → clarity → style → leverage → dedup → tests**. `leverage` sits before `dedup` because a library/stdlib swap can dissolve a downstream dedup finding entirely. Lower-priority findings are suppressed when a higher-priority finding would change the answer. → ADR-0012, ADR-0020, ADR-0027.

**citation discipline** — The load-bearing thesis: the LLM cannot author findings without a tool source; it can only triage and format what runners produced. M7 extends the discipline to **questions** — every quoted snippet must be mechanically verifiable. The **substring-verifier** is what enforces it. → ADR-0008, ADR-0021.

**`sources[]`** — Structured citation array on every comment. Source `type` is one of `cve` (NVD/OSV), `advisory` (GitHub Advisory), `changelog`, `documentation`, `web`, `tool` (TSC / ESLint output), `repo_convention`, `api_def` (type definition from a `node_modules/<pkg>/*.d.ts` lookup, M11+). Each source carries `id` / `url` / `title` and a `retrievedAt` ISO timestamp. → ADR-0008, ADR-0026.

**`api_def` source** — `[M11+]` Source variant carrying a type definition citation from `lookupTypeDef`. Re-uses `SourceSchema`'s M10 triple: `path` = `dts_file` (repoRoot-relative path under `node_modules/`), `line` = `line_start` of the signature, `snippet` = the signature string (single-line whitespace-normalized so the verifier can match it against a concatenated `.d.ts` window). `id` carries `${package}@${version}#${symbol}` where `package` is the **literal import path** including any subpath (e.g., `drizzle-orm/sqlite-core@0.30.0#sqliteTable`); `title` carries `${kind} ${symbol}`. The LLM does not assemble these fields — `lookupTypeDef` returns a pre-shaped `suggestedSource` object the LLM copies verbatim, eliminating partial-triple parse failures. Verified by the **API claim verifier** post-pass — concat-then-substring-match against the cited `.d.ts` window, dispatched on `type`. → ADR-0026.

**evidence** — The concrete file path + single-line range (and optional snippet) that grounds a claim in the code. Surfaced on `ContextCandidate.reasons[]` (M5) and on M7 detector findings; consumed by the substring-verifier.

**clarification question** — A specific shape of comment Warden's LLM is encouraged to emit instead of asserting when domain intent is unclear. Preserves citation discipline by refusing to invent claims. → memory: `project_warden_clarification_questions.md`.

**`degradedWorkers`** — Metadata array on `CommentSet` reporting partial failures or quality signals. M7 refactor: from `string[]` to `DegradedEntry[]` with `{ kind: "actionable" | "warning" | "info", topic, message }`. Loud only when the user can act on it (e.g., "no embeddings — run `warden init`"); silent when everything is fresh.

**confidence** — Numeric 0.0–1.0 on every comment. The LLM can preserve or lower confidence, never raise it. Current hard rules use confidence as the tertiary sort key inside priority/tier buckets; a per-category confidence gate is a deferred tuning surface, not an implemented module.

**volume cap** — Maximum comments per PR (default 5, configurable). When more findings exist, prioritise by category × confidence. Excess findings are discarded, not collapsed into "show more" — prevents nag accumulation.

---

## 3. Models + AI layer

**boss model** — Sonnet-class (`claude-sonnet-4`). The synthesiser and grader; in M1–M4, also the single LLM **formatter** call. → ADR-0006.

**worker strong** / **worker sonnet** — Sonnet-class specialist for correctness and security workers; subtle bugs warrant deep reasoning. `[deferred]` to M2+ orchestration; not invoked by the v0 single-call formatter. → ADR-0006.

**worker cheap** / **worker haiku** — Haiku-class (`claude-haiku-4`) for contract, best-practices, the M7 **committability sub-agent**, the M12 **leverage sub-agent**, and the M13 **security triage sub-agent**. Cheap, sufficient for pattern-matching and triage tasks. → ADR-0006, m7-plan.md, m13-plan.md.

**model tier** — The strong/cheap mapping per provider. Anthropic: sonnet-4 / haiku-4. Future BYO providers will mirror the tier shape (OpenAI: gpt-4.1 / mini; Google: gemini-2.5-pro / flash).

**LLM formatter** — The single Sonnet call that takes diff + tool findings + verified CVEs + retrieved context and returns a `CommentSet`. Lives in `packages/core/src/llm/`. Prompts are externalised to `prompts/{system,user-template}.md`. → ADR-0015.

**fallback chain** — Anthropic primary → 1× retry with backoff → Google Gemini secondary. Both auth and transient failures cascade. Hard-fail if both exhaust. Cascade lives in `@warden/core/src/llm/cascade.ts`. → ADR-0017.

**extended thinking** — Anthropic's multi-step reasoning mode. Token budget controlled by `WARDEN_THINKING_BUDGET` (default 4096). Optional in M1–M4; reserved for deep-reasoning workers later.

**sub-agent** — A runner whose work is a scoped LLM call (see §5 for the canonical definition). M7 ships the **committability sub-agent** (cheap-tier), which reviews added/modified files for committability anti-patterns and emits questions subject to substring-verification.

**boss/worker orchestration** — `[spine shipped in M8 (ADR-0023); worker tier still deferred]` The vision-tier pipeline: deterministic execution → parallel specialist workers → boss synthesis → grading. v0 collapses this into a single formatter call. Reintroduced incrementally: sub-agent in M7; **orchestration spine** (dispatch + scratchpad + synthesizer routing existing runners) shipped in M8 per ADR-0023; specialist Sonnet **workers** (adversarial critic, self-aware invariant checker, free-form prose consistency, DeepSec-shaped SAST, etc.) deferred to M9+ — each its own ADR when scheduled. The word **worker** is reserved for *the worker tier* — a specialist LLM in a multi-call pipeline. The M7 cheap-tier LLM runners are **sub-agents**, never workers; the M8 spine dispatches existing runners (detectors + sub-agents per §5) without committing to specialist-LLM workers. → vision.md §3, ADR-0023, ADR-0008.

**self-aware boss model** — `[deferred, M6+]` Direction where the boss model can introspect its own code/limits at runtime. The introspection surface is treated as a hardened jailbreak boundary. → memory: `project_warden_self_aware_boss.md`.

**`lookupTypeDef`** — `[M11+]` AI SDK tool descriptor exposed to the formatter LLM (M11) and the **leverage sub-agent** (M12). Input `{ package, symbol }` where `package` is the **literal import path** (`drizzle-orm`, `drizzle-orm/sqlite-core`, `@radix-ui/react-dialog`); the resolver splits `(packageName, subpath)` internally and resolves the `.d.ts` via `exports['./<subpath>']` → `typesVersions` → direct fallback → `@types/*` fallback. Output `LookupTypeDefResult` (discriminated union on `found: boolean`; `found: true` carries a pre-shaped `suggestedSource` the LLM copies verbatim into `Comment.sources[]`; `found: false` carries `reason: "package_not_installed" | "no_types" | "symbol_not_found" | "lookup_error"`). Lives at `packages/core/src/llm/tools/lookup-type-def.ts`; resolver at `packages/core/src/api/lookup-type-def.ts`. Cap: 8 calls per review **per call site** (`stopWhen: stepCountIs(8)`); the formatter and the leverage sub-agent each get their own 8-call budget — not centralised. `LookupTypeDefOptions.packageSearchRoots` (M12) probes additional roots (touched workspace package directories) before falling back to `repoRoot`, so pnpm-style workspace deps that only live under `packages/<name>/node_modules` resolve correctly; `dts_file` stays relative to the original `repoRoot` for verifier compatibility. Triggered by the four trigger conditions in the formatter system prompt's "Verifying library API claims" section + by the leverage sub-agent's prompt instructions in `leverage-system.md`. → ADR-0026, ADR-0027.

---

## 4. Context selection + indexing

**`ContextSelector`** — Interface in `packages/core/src/context/`. Takes the diff + repo, returns `ContextCandidate[]`. M5 ships the **CheapSignalsSelector**; M6 adds a semantic signal on top of it.

**`ContextCandidate`** — A file proposed as relevant context for the diff, plus a discriminated `reasons[]` array. Each reason carries an `Evidence[]` of single-line ranges that justify the candidate's inclusion.

**reason** (on a candidate) — Discriminated union: `direct_importer`, `direct_import`, `same_folder`, `symbol_ref` (M5); `semantic` adds in M6. Reason kind drives weighting; evidence ranges drive what excerpt the formatter sees.

**signal** — Loose term for a single source of candidates. The four cheap signals are direct-importer, direct-import, same-folder, symbol-ref. The fifth — **semantic signal** — is M6 embedding similarity, weighted at 0.9 and intensity-scaled by cosine. → ADR-0018, ADR-0019.

**`SourceParser`** / **`TsCompilerParser`** — The DI seam for AST work in `context/parser.ts`. `TsCompilerParser` wraps the TypeScript Compiler API and is currently the only place importing `typescript`. Tree-sitter swap-ins for Python/Rust/Go drop in alongside.

**chunk** / **`ChunkRecord`** — A symbol-aware code segment extracted by the **code-chunk** library (tree-sitter under the hood). Carries `chunkHash`, `filePath`, `language`, `symbolPath` (e.g., `["ClassName", "method"]`), `startLine` / `endLine`, `content`. Chunks are the unit Warden embeds. → m6-plan.md.

**code-chunk** — The chunking library Warden adopts in M6 (`CodeChunkAdapter`). Supports TS / JS / Python / Rust / Go / Java.

**embedding** — A 1024-dim float32 vector produced by Voyage `voyage-code-3` for a chunk. Stored in the `embeddings` table keyed by `(chunkHash, lockedModelId)`.

**locked model** / **locked-model index** — The `(model_id, model_version)` pair pinned to an index in `index_meta`. Voyage SKU bumps don't auto-rebuild; the user runs `warden init --rebuild` to upgrade. Prevents silent mixing of incompatible vector spaces. → ADR-0019.

**Merkle tree** / **merkle store** — Content-addressed, append-only structure over file/dir hashes for change detection. Strictly speaking not a Merkle tree in M6, but designed to graduate into one. Lives in the `merkle` table. → ADR-0016.

**content-addressed** — Cache keyed by content hash (SHA-256), not by mutable IDs. Same content always maps to the same address. Applied to chunks, embeddings, file snapshots, and the `import_graph` table. → ADR-0016.

**`import_graph`** — M5 cache table mapping `(file_path, file_sha)` → JSON set of imported file paths. Immutable per row. Built from AST traversal; supports reverse-lookup queries (e.g., the deadcode detector). → ADR-0018.

**`file_state`** — M5 cache table tracking which files changed since the last run, refreshed via `git ls-files --modified --others --exclude-standard`. Drives incremental selector updates. → ADR-0018.

**`RetrievedContext`** — The structured payload handed to the formatter: changed files + selected candidates + their evidence excerpts + path-only same-folder neighbours.

**banner** / **`BannerState`** — Pre-phase line in `warden review` output communicating index health: `no-index` (chunks absent), `stale` (incremental rescan needed), `model-deprecated` (locked model EOL), `model-aged` (not the current default). M7 adds `no-embeddings` (chunks present, vectors missing). Maps into `degradedWorkers`. → ADR-0019, m7-plan.md.

**gate** — A condition that disables semantic retrieval. Open gates (no-index / stale / model-deprecated / model-aged) cause the **semantic signal** to be skipped while the cheap signals still run. → ADR-0019.

**`.warden/cache.sqlite`** — The single, gitignored, content-addressed cache file the entire system reads from and writes to. Schema lives in `@warden/db`. Safe to delete; `warden init` rebuilds.

**`type_def_cache`** — `[M11+]` SQLite table caching results of `lookupTypeDef` lookups against `node_modules/<pkg>/*.d.ts`. Compound primary key `(package, version, symbol)`; content-addressed in the sense that re-resolving the same triple in the same install state is idempotent. Positive rows carry `signature` / `kind` / `jsdoc` / `dts_file` / `line_start` / `line_end`; negative rows carry `reason`. Grows with usage, not with `node_modules/` size — <1 MB per repo typical. Cache invalidation is automatic via `(package, version)` mismatch when `npm install` bumps versions; old rows for previous versions become unreachable, no explicit prune step. → ADR-0026.

---

## 5. Runners — detectors + sub-agents

**runner** — Any process under `packages/core/src/runners/` that produces findings or questions. Two flavours: **detectors** (deterministic — AST, graph, structured comparison, lockfile diff; no LLM call) and **sub-agents** (cheap-tier LLM, scoped to one category, output is citation-verified). The folder name is "runners" because every runner lives there; the precise noun for any specific one is always **detector** or **sub-agent**, never bare "runner".

**detector** — A runner that emits findings via deterministic analysis only — AST traversal (TSC, ESLint, scalability, deadcode), structured comparison (consistency), or process execution (vuln, jscpd). Detector findings carry tool-grounded `sources[]`; never LLM-quoted citations. **Use a detector when the anti-pattern set is bounded *and* reliably structural across the ecosystems Warden runs in.** A regex match for `<<<<<<<` qualifies; a regex for `node_modules/` doesn't, because legitimate code references it.

**sub-agent** — A runner that wraps a scoped LLM call (cheap-tier), owns one **category**, and emits questions with citations. The committability sub-agent is the first; future categories may add their own. Sub-agent output is **citation-verified** post-pass via the substring-verifier — every quoted snippet must echo the cited file (after whitespace normalisation) or its citation is dropped. Distinct from the vision-tier **boss/worker orchestration**: there, "worker" means a specialist LLM in a multi-call pipeline; here, sub-agents are siblings of detectors in the M7 single-formatter shape. **Use a sub-agent when the anti-pattern set is open-ended, *or* when a nominally bounded set is unreliable across language ecosystems / call sites.** Committability is the canonical example of the second clause — dirname conventions and dev-script naming look bounded but break across ecosystems, so the LLM earns its keep. → m7-plan.md, ADR-0021.

**TSC runner** — Detector wrapping `tsc --noEmit` over changed files. Maps diagnostics to `ToolFinding[]`. TS-only in v0. → ADR-0008.

**ESLint runner** — Wraps `eslint --format json`. Per-rule output mapped to `ToolFinding[]` with evidence ranges. TS / JS only. → ADR-0008, ADR-0009.

**vulnerability check** — Runs `npm audit --json`, diffs the lockfile, scans added / upgraded dependencies against OSV.dev. Advisories without an OSV record are dropped — the citation discipline path lit up in M3. M7 collapses output to a summary when the manifest wasn't touched. → ADR-0008.

**OSV verification** — Calls `POST https://api.osv.dev/v1/query` (package + version) and uses the response (affected ranges, fix versions, severity) as the canonical citation for a vulnerability comment. Universal across ecosystems. → ADR-0008.

**jscpd** — Copy-paste detection runner, scoped to `changed ∪ candidates`. Surfaces dedup findings. Loaded via `createRequire` to dodge an ESM/CJS interop bug in jscpd's `colors/safe` import. → ADR-0018.

**ecosystem detection** — Auto-derives ecosystem and framework from marker files (`package.json`, `requirements.txt`, `go.mod`, etc.) and from dependency contents. Zero manual config. → ADR-0008.

**M7 detectors** — Three new detectors land in M7: **scalability detector** (load-then-narrow queries, sequential awaits), **deadcode detector** (unused optional params, dead branches via reverse import-graph), **consistency detector** (env-var / CLI-command / file-path claims in docs that diverge from code). → m7-plan.md.

**substring-verifier** — M7 post-pass that confirms LLM-quoted snippets actually appear in their cited files (after whitespace normalisation). Drops citations that don't match; if all citations on a comment drop, drops the comment. Logs an info-level entry on drops. → ADR-0021, m7-plan.md.

**API claim verifier** — `[M11+]` Post-pass extension of the **substring-verifier**, dispatched on `source.type === "api_def"`. Reads the cited `.d.ts` file across `line ± API_DEF_DRIFT` (30 lines either side — wider than M10's 5 because `.d.ts` signatures routinely span 10+ lines), concatenates the window, normalizes whitespace once, and substring-matches the (already single-line normalized) `signature`. The wider drift + concat-then-match is the key difference from M10's per-line algorithm — M10 stays per-line for its single-line snippet consumer; `api_def` widens for multi-line signatures. Failed matches drop the source; if all sources drop, the Comment drops. Same drop semantics + `degradedWorkers` surfacing as M10. The verifier walk dispatches on source `type`; one new branch for `api_def`, all other source types unchanged. → ADR-0026.

**leverage detector** — `[M12]` Deterministic AST detector at `packages/core/src/runners/leverage.ts` emitting `kind: "assertion"` findings for three v0 stdlib idiom-miss patterns: `JSON.parse(JSON.stringify(x))` → `structuredClone(x)` (single-arg only; multi-arg `stringify(x, replacer)` / `stringify(x, null, 2)` is intentional projection, not a deep clone); `arr.indexOf(x) !== -1` / `!= -1` / `> -1` / `>= 0` (either operand order) → `arr.includes(x)`; `arr.filter(p).length > 0` / `>= 1` / `!== 0` and `arr.find(p) !== undefined` / `!= null` → `arr.some(p)`. Findings use `ToolFinding.source = "leverage"` and carry `type: "tool"` sources with `(path, line, snippet)` evidence built from the matched call expression (whitespace-collapsed). Diff-localness via `anyAddedInRange`. Runs in both `check` and `review`. Rides the M8 `Runner` contract. Disjoint with **scalability** (`sequential-await` / `load-then-narrow` live there) and with **jscpd** (code similarity, not pattern substitution). Pattern set expands in M13+ as dogfood evidence dictates. → ADR-0027.

**leverage sub-agent** — `[M12]` Cheap-tier (Haiku via `getWorkerCheapModel()` with Google fallback; degrades silently when env keys missing) sub-agent at `packages/core/src/runners/leverage-libraries.ts` emitting `kind: "question"` Comments for library-specific substitution suggestions. Prompt at `packages/core/src/llm/prompts/leverage-system.md` — library-agnostic with four canonical examples (Drizzle relational `with:`, Elysia `.guard()`, AI SDK `Output.array(...)`, Drizzle `onConflictDoNothing()`) + a workspace-aware dependency preamble built from the root `package.json` plus the nearest touched workspace package manifests (top-level `dependencies` + `devDependencies` + `peerDependencies`) that gates suggestions to installed packages. The discovered package roots are also passed to `lookupTypeDef` as `packageSearchRoots` so pnpm-workspace deps resolve. Empty-deps short-circuits before the LLM call (no plausible substitutions, no tokens spent). Has access to M11's `lookupTypeDef` tool with its own `stepCountIs(8)` budget (separate from the formatter's). Emits questions carrying `api_def` sources copied verbatim from `result.suggestedSource`; the runner drops findings whose `path` is outside the diff and findings with empty `sources[]` before they become Comments (with one info-level degraded count per failure mode), and the global **API claim verifier** post-pass drops hallucinations transparently. Gated to `review` mode only (skipped silently in `check`). → ADR-0027.

**ESLint security detector** — `[M13]` Second ESLint invocation at `packages/core/src/runners/eslint-security.ts` (`runEslintSecurity()`) using Warden-owned `eslint@10` plus a Warden-managed flat config that loads `eslint-plugin-security` + `eslint-plugin-no-secrets` via `createRequire` from `packages/core`'s declared dependencies. Goes through ESLint's Node API directly (`new ESLint({ overrideConfigFile: true, overrideConfig, cwd: repoRoot })`) — never touches the target repo's lint binary or config; loads `@typescript-eslint/parser` for `.ts`/`.tsx` files so TS source parses without project-aware type info. Rule IDs prefixed `security/*` or `no-secrets/*` are routed to `{ category: "security", tier: 1 }` in `to-comment.ts` unconditionally. Runs in both `check` and `review`, independent of whether the target repo has its own ESLint config. v0 rule list is narrow (`detect-eval-with-expression`, `detect-child-process`, `detect-non-literal-fs-filename`, `detect-non-literal-regexp`, `detect-pseudoRandomBytes`, `detect-buffer-noassert`, `detect-disable-mustache-escape`, `no-secrets/no-secrets`); known-noisy rules (`detect-unsafe-regex`, `detect-object-injection`, `detect-possible-timing-attacks`, `detect-non-literal-require`) deliberately disabled per dogfood evidence. Off-the-shelf plugins by design — no custom `@warden/eslint-plugin-security` package (per ADR-0028 alternatives). Recorded into the M8 scratchpad as its own `eslint-security` entry alongside the user-config `eslint` entry. → ADR-0028.

**security sub-agent** — `[M13]` Cheap-tier (Haiku via `getWorkerCheapModel()`; graceful when env keys missing) sub-agent at `packages/core/src/runners/security.ts` emitting `kind: "question"` Comments for security concerns the ESLint detector cannot catch — cross-tenant ID leakage, missing-auth on route handlers, parameter-pollution bypasses, SSRF, path-traversal in non-canonical sinks, secret-in-log, auth-bypass via encoded characters, OAuth callback manipulation. Prompt at `packages/core/src/llm/prompts/security-system.md` — DeepSec-borrowed structure (severity classification mapped to Tier 1/2/3 + 10-slug vocabulary [`auth-bypass`, `missing-auth`, `rce`, `sql-injection`, `ssrf`, `path-traversal`, `secrets-exposure`, `insecure-crypto`, `xss`, `open-redirect`] + pre-emptive FP guidance + auth-bypass subtleties section + 5 canonical worked examples + citation discipline + out-of-scope file note) per ADR-0028 §4. Has access to M11's `lookupTypeDef` tool with its own `stepCountIs(8)` budget (third consumer after the formatter and leverage sub-agent); discovers pnpm-workspace package roots from touched files and forwards them as `packageSearchRoots`. Emits questions carrying source-line + sink-line `tool` sources (or `api_def` sources copied verbatim from `lookupTypeDef` when a finding hinges on a library API claim) verified by the existing M10 substring-verifier; lane discipline drops findings whose `path` is outside the diff (one info-level degraded entry per non-zero drop class), uncited findings dropped before they become Comments. The claim line is prefixed with the slug (e.g. `[auth-bypass] …`) so dogfood feedback into M14 can index by slug. Gated to `review` mode only (skipped silently in `check`). Rides the M8 `Runner` contract from day 1 via `dispatch()` registration. Subject to the **confidence threshold** floor (§7 — v0: `{ security: 0.8 }`; Tier-1 bypasses). → ADR-0028.

**known debt** — Code accepted as-is and excluded from review noise. Suppressed via an optional `.reviewbot/overlay.yaml`. Small, rarely changes, kept narrow on purpose. → ADR-0008.

**`Runner`** — `[M8]` The contract every runner exposes for the orchestration spine: `{ readonly name: string; run(input: RunnerInput): Promise<RunnerOutput> }`. `RunnerInput` carries `changedPaths` + `repoRoot` + optional `retrievedContext`; `RunnerOutput` carries `name` + `findings[]` + optional `questions[]` + `degraded[]` + `durationMs` + optional `error?`. M8 validates the contract against the committability sub-agent (LLM cheap-tier) and the scalability detector (deterministic AST); the remaining 6 detectors stay inline until M9+ migrates them. Lives in `packages/core/src/orchestration/runner.ts`. → ADR-0023, m8-plan.md.

**`Scratchpad`** — `[M8]` In-memory class collecting per-runner outputs during a single `runReview()` / `runCheck()` call. Internal `Map<runnerName, RunnerOutput>`; methods `record()`, `get()`, `all()`, `flatten()` (returns `ToolFinding[]`), `flattenQuestions()`, `flattenDegraded()`. Bounded by runner count (~8 today, ≤20 even in M11+); pathological-diff memory pressure is solved upstream by M9's noise filter, not here. SQLite swap-point preserved for M11+ daemon scenarios. Lives in `packages/core/src/orchestration/scratchpad.ts`. → ADR-0023, m8-plan.md.

**dispatch** — `[M8]` The function that runs registered runners in parallel via `Promise.all` and writes their `RunnerOutput`s to the `Scratchpad`. Captures per-runner errors as `RunnerOutput.error` and emits a `warning`-kind `DegradedEntry`; the rest of the pipeline continues. Signature: `async function dispatch(runners: Runner[], input: RunnerInput, scratchpad: Scratchpad): Promise<void>`. M8 ships static dispatch — same runners every run; dynamic dispatch (boss reasons about which runners to invoke per-diff) is M9+. Lives in `packages/core/src/orchestration/dispatch.ts`. → ADR-0023.

**synthesizer** — `[M8]` The boss-tier LLM call that reads a `Scratchpad`, flattens it to `ToolFinding[]`, and produces a `CommentSet`. Replaces the M4 formatter call site; uses the same `system.md` + `user-template.md` (per ADR-0015) and the same Anthropic → retry → Google cascade (per ADR-0017). Distinct from the broader **boss model** role: in M8 the synthesizer *is* the boss model's only job; in M9+ when dynamic dispatch lands, the boss model also plans + decides what to dispatch. Lives in `packages/core/src/orchestration/synthesizer.ts`. → ADR-0023, ADR-0015, ADR-0017.

---

## 6. Architecture invariants

**I/O-pure core** — `@warden/core` must not import `commander` / `picocolors` / `ora`, must not call `console.log` / `process.stdout`, must not read `process.argv`, must not assume a TTY. Input via `ReviewInput`; output via the returned `CommentSet`. This is the load-bearing property that makes future bot wrappers possible without rewriting the engine. → ADR-0013.

**package boundaries** — Strict imports between workspace packages. CLI may use commander / colors / ora; core may not. Core depends on AI and DB; AI does not depend on core; env is importable from anywhere; config ships only TS configs. → CLAUDE.md "Package boundaries" table.

**one-shot CLI** — No TUI, no REPL, no interactive prompts. Input via flags / stdin, output via stdout / JSON, process exits. Enables bots, CI integration, and scripting. → ADR-0014.

**dogfooding** — Personal-first development. v0 ships for one user; the OSS-quality bar holds anyway because trustworthiness is the moat. M5 and M6 PRs are reviewed by Warden itself plus Copilot for ground-truth comparison. → ADR-0001, memory: `project_warden_review_category_gaps.md`.

**security depth tiers** — Always-on fast pass + default review + on-demand deep mode. Critical findings short-circuit through the gate regardless of mode. → memory: `project_warden_security_depth_tiers.md`.

---

## 7. Quality metrics

**confidence threshold** — Per-category numeric floor for silently dropping low-confidence findings before render. Implemented in `packages/core/src/confidence.ts` as `CATEGORY_CONFIDENCE_FLOOR: Partial<Record<Category, number>>` consumed by `applyConfidenceFloor()` (called from `applyHardRules()` before the Tier-3 verbose gate and the priority sort). v0 floors: `{ security: 0.8 }`; other categories implicit 0 (no filtering). **Tier-1 findings bypass the floor unconditionally** — the critical-finding short-circuit named in `project_warden_security_depth_tiers.md`. Drops surface as one info-level `degradedWorkers` entry per non-zero drop count per category (the message quotes the *effective* floor — env override or default — not always the static default). Override: `WARDEN_SECURITY_CONFIDENCE_FLOOR` env var; other categories add their own env vars on demand when they ship with non-zero floors. Future-tunable per category as dogfood reveals volume-control need — style is the natural next candidate (very conservative on nits). → ADR-0028.

**false positive rate** — % of comments developers mark "Not Useful". Prototype expectation < 35%; mature target < 25%.

**usefulness rate** — % of comments developers mark "Useful". Prototype expectation 40–60%; mature target > 70%.

**address rate** — % of comments resolved in the final commit (post-merge re-run). Prototype 30–50%; mature > 60%.

**latency** — Time from PR creation to comments posted. v0 target < 10 min; mature target < 5 min.

---

## 8. Deferred concepts

Named shorthand for things not yet built. Useful when reading docs that reference them; not yet load-bearing.

**BYOLLM** — Bring-Your-Own-LLM. Multi-provider config + per-role model selection. v0 hardcodes Anthropic. → ADR-0006.

**BYOEmbedder** — Multi-provider embedding abstraction (Voyage + OpenAI + Cohere + Gemini + local Transformers.js) with per-provider cost estimates. v0 hardcodes Voyage `voyage-code-3`. The local Transformers.js path addresses NDA / data-residency cases. → ADR-0019.

**custom-code SAST worker** — `[narrowed by M13 to the deep-mode worker]` M13 shipped the default-review tier (ESLint security detector + Haiku triage sub-agent — see §2 categories + §5 runners). M14 ships the on-demand-deep tier — **Sonnet specialist worker** in a dedicated **security harness** (see below), DeepSec-shaped per ADR-0015 (borrow pipeline, reject grounding model), invoked via the `warden security` verb (see §1). Gated on M13 dogfood evidence of which slugs the Haiku consistently misses. → ADR-0015, ADR-0028, memory: `project_warden_deepsec_reference.md`.

**security harness** — `[deferred, M14]` Dedicated orchestration spine for `warden security` per the two-harness vision from M13 grilling (Ronit's agent-orch framing, vision.md §3). Separate from the M8 spine that `warden review` rides: own dispatch, own scratchpad, own synthesizer, own Sonnet specialist multi-step pipeline (DeepSec-shaped scan → reason → cite, with substring-verifier replacing DeepSec's LLM-judges-LLM revalidation). M13's Haiku sub-agent stays in the existing M8 spine on purpose; M14's ADR introduces the second harness greenfield. The first **worker** (CONTEXT.md §3's reserved term — specialist Sonnet in a multi-call pipeline) lives here. → ADR-0028 §11.

**leverage** (semantic retrieval) — `[deferred]` The category itself shipped in M12 (see §2 categories + §5 runners). What stays deferred is **semantic retrieval over `.d.ts`** for queries like "find Drizzle's join-related primitives" — the additive `type_def_embeddings` table per ADR-0026 §14 + ADR-0027 §10, gated on dogfood evidence the M12 exact-match `lookupTypeDef` path hits recall limits. → ADR-0027.

**verify API claims** — Applying citation discipline to LLM claims about library APIs by retrieving installed `.d.ts` definitions via `lookupTypeDef`. GitHub/source webfetch remains deferred. Shares infrastructure with the leverage category. → ADR-0026, memory: `project_warden_verify_api_claims.md`.

**cross-repo retrieval** — `[narrowed by M11 to `.d.ts` lookup]` Indexing sibling repos + `node_modules` + `.d.ts` files. M11 ships the `.d.ts` lookup subset (per ADR-0026) via `lookupTypeDef` — lookup-on-demand cache, no Voyage call, formatter tool exposure first. M12 added the leverage sub-agent as the second producer on that same tool. The rest of the bag — `node_modules/<pkg>/src` chunking, sibling-repo indexing, embedding-based `.d.ts` retrieval, webfetch fallback for uninstalled packages — stays deferred for its own future ADRs.

**daemon `JobRunner`** — Real async embedding work, either review-time incremental (Model B) or background subprocess / `warden daemon` (Model C). Gated on dogfood evidence that users skip `warden init` consistently. → ADR-0019.

**cloud-hosted index + sync** — The hosted-mode swap point named in ADR-0016. Storage interfaces are backend-agnostic; cloud index is additive, not a rewrite. Solves cache-loss recovery.

**sibling-repo scanning** — `--sibling-repo` flag accepting paths to related repos. Auto-discovers integration points (HTTP calls, shared constants, webhook handlers) and flags PRs that modify an integration boundary. Requires a pre-built integration map.

**license scanning** — Deterministic check for copyleft licences (GPL / AGPL) introduced into proprietary code. → ADR-0008 deferred.

**state-of-the-art verification suite** — `[deferred]` Evaluation milestone for proving or falsifying a narrow Warden quality claim, not a standing marketing claim. Combines public code-review benchmarks (CodeReviewBench, c-CRAB, SWRBench, CodeFuse-CR-Bench), adjacent agent benchmarks (SWE-bench Verified for retrieval / context-selection signal only), a private WardenBench holdout, deterministic / one-shot-LLM / Warden-ablation baselines, and metrics for precision, recall, F0.5, P0/P1 recall, false-positive rate, citation verification rate, unsupported-claim rate, accepted-by-developer rate, cost, latency, and degradation rate. → vision.md §12, ADR-0008 deferred.

**committability detector half** — A detector for the genuinely bounded subset of committability anti-patterns (merge-conflict markers, leftover `debugger`, `// TODO(remove before commit)`-style sentinels) — i.e., the patterns that survive the "reliable across ecosystems" test. Consciously parked: the open-tail sub-agent is the v0 implementation, and splitting was rejected in M7 because the supposedly-bounded patterns (dirname conventions, hardcoded path heuristics) turned out to be context-dependent. Revisit if a clean bounded subset surfaces.

**diff-level noise filter** — `[M9 v0]` A pre-runner stage in the diff loader that prunes the diff before any runner consumes it, defending the catastrophic case where committed `node_modules/` explodes the input for *every* runner. Composes the **`BASELINE_NOISE`** language-agnostic floor (OS / editor junk: `.git/`, `.DS_Store`, `*.pyc`, `*.swp`, `Thumbs.db`, `.vscode/.history/`) with per-ecosystem **noise profiles**. Internal representation is a **diff tree** built from `parseUnifiedDiff()` output (`ChangedFile[]` grouped by directory, file count per node) — bounded by directory structure, not file count, so 500K-file diffs fit in a few KB. Pruned subtrees each emit a `degradedWorkers` entry of `topic: "noise-filter"`, `kind: "actionable"`, naming the path + count + ecosystem. M9 v0 ships exactly one profile (`javascript.json`) + the baseline floor; no user override surface (overlay deferred to M10's own milestone); no structural fallback heuristic (M7's directory-concentration placeholder dropped — false-positive risk without overlay escape hatch). Per-subtree ecosystem detection deferred to M11+ (depends on the multi-ecosystem detector rewrite). M7 ships a single-heuristic placeholder inside `committability.ts` (>80% directory concentration *or* >200 added files no dominator), removed in M9. Design: ADR-0022 (direction) + ADR-0025 (M9 v0 scope); implementation: `m9-plan.md`.

**`BASELINE_NOISE`** — `[M9 v0]` Language-agnostic noise constant in `packages/core/src/diff/prune.ts`, applied unconditionally before any **noise profile**. Lists OS / editor junk that's noise regardless of ecosystem: `.git/`, `.DS_Store`, `*.pyc`, `*.swp`, `Thumbs.db`, `.vscode/.history/`. Graduated from M7's `committability.ts` (where it lived as the Tier-1 hard-skip list); now applied universally at the diff loader so every runner — not just the committability sub-agent — gets the floor. Distinct from **noise profiles** (per-ecosystem) by being language-agnostic. → ADR-0025.

**noise profile** — `[M9 v0]` Per-ecosystem JSON document at `packages/core/src/ecosystem/profiles/{ecosystem}.json` listing always-noise directories and extensions. v0 schema: `{ ecosystem, alwaysNoise: { directories, extensions } }` — no `contextDependent` bucket (no escape hatch without overlay), no `files` bucket (lockfiles are diff signal, not noise — vuln runs against `repoRoot`, not the diff), no schema versioning (YAGNI). v0 ships exactly one profile (`javascript.json`); Python / Rust / Go / Java / C# / Ruby profiles defer to M11+ alongside the multi-ecosystem detector rewrite. Distinct from `.gitignore` (per-repo declaration); profiles are Warden's belt-and-suspenders for the case where gitignore is missing or wrong. Distinct from **`BASELINE_NOISE`** (language-agnostic floor in `diff/prune.ts`) — profiles add ecosystem-specific entries on top of the universal floor. → ADR-0025.

**diff tree** — `[M9 v0]` Depth-limited (≤3) representation of a diff, built from `parseUnifiedDiff()` output (`ChangedFile[]`) by grouping paths by directory. Each node carries `(path, fileCount, children)`. Bounded by directory structure, not file count — a 500K-file diff still fits in a few KB. Internal to `packages/core/src/diff/`; not exposed on runner contracts (β interface per ADR-0023 §5; runners consume `path[]`). The internal representation the **diff-level noise filter** prunes against. The `(addedCount, modifiedCount, deletedCount)` triplet from ADR-0022 §4 reduces to `fileCount` in v0 — no consumer reads the breakdown; reintroduce when one does. → ADR-0025.

**GitHub PR bot** — Future `apps/github-bot/`: Elysia server, BullMQ + Redis queue, Postgres install tokens + review history, GitHub OAuth. Calls `@warden/core` → posts via the GitHub API. → ADR-0013, memory: `project_warden_bot_roadmap.md`.

**Slack bot** — Future `apps/slack-bot/`: slash commands (`/warden review owner/repo#PR-123`), event subscriptions. Reuses the GitHub bot's Postgres / Redis. → ADR-0013.

**ClickUp integration** — Future integration; shape TBD. → ADR-0013.

**`apps/web/`** — `[deferred]` Post-release public surface: docs + marketing + `CommentSet` showcase site. Single Astro + Starlight app with `<ClientRouter />` + prefetch-on-hover; routes: `/` (marketing landing), `/docs/*` (Starlight-managed docs), `/examples` (`CommentSet` showcase), `/design` (deep-dive links to `decisions.md` / `vision.md`). Personal-portfolio-grade per ADR-0024 — not a commercial OSS launch; sized to the "elaborate solo project, won't renew domains" framing. Deployed at `wrdn.beauty`. Implementation gated on dogfood-loop signal post-M9-or-equivalent. Distinct from the **interactive triage app** (ADR-0014), which is a sibling future surface with a different audience and shape. → ADR-0024.

**`CommentSetRenderer`** — `[deferred]` Inline Astro component at `apps/web/src/components/CommentSetRenderer.astro` (when shipped). Consumes pre-generated `CommentSet` JSON fixtures and produces styled HTML — severity colors, category badges, file:line links, priority order. Direct workspace dep on `@warden/core` for `Comment` / `CommentSet` / `Tier` / `Category` types. No workspace-package extraction; would extract to `@warden/render` (or similar) when a second consumer (ADR-0013 bot, ADR-0014 triage UI) materialises. Pattern-matches ADR-0023's deferred `@warden/orchestration` split. → ADR-0024.

**fixture** (showcase sense) — `[deferred]` Pre-generated `CommentSet` JSON checked into `apps/web/src/fixtures/`, regenerated via a one-line `pnpm gen-fixtures` script that runs `warden review` on the curated sample repo. Source repo: warden itself (warden-on-warden), with a small synthetic repo as backup for category-specific showcase pages where warden-on-warden output is sparse. Distinct from M-plan smoke fixtures and from M5/M6 cache fixtures. → ADR-0024.

**`wrdn.beauty`** — `[deferred]` Domain for the post-release public surface. Non-renewing — sized to the project's likely lifespan, ~12 months. Sidesteps the `project_warden_naming_collision.md` discoverability problem via the `wrdn.*` TLD abbreviation (no `warden` namespace claim required). Purchased at implementation-time, not at ADR commit time. ADR-0003 stays dormant — reversal of the solo-project framing would trigger ADR-0003 reopen, not new ADR-0024 work. → ADR-0024.

**interactive triage app** — `[deferred]` Per ADR-0014, a future web app surface for walking through findings one at a time, marking Useful / Not Useful, expanding details, deferring to follow-up, persisting feedback across sessions. Audience: single user during review. Distinct from `apps/web/` (ADR-0024 — read-only marketing+docs+showcase, audience: ad-hoc visitors after review). Likely lives at `apps/triage/` or similar when scheduled — not `apps/web/`. Earns its own ADR with its own grilling pass when de-deferred. → ADR-0014, ADR-0024.

---

## Open inconsistencies

Things the docs spell more than one way. Pick one before they ossify.

- **boss model** vs **boss LLM** vs **synthesiser** — the same role; prefer **boss model** in code, **boss** in prose.
- **worker strong** vs **worker sonnet** vs **strong worker** — prefer **worker strong** to mirror **worker cheap**.
- **finding** (tool-derived) vs **comment** (output unit) — never use them interchangeably; the formatter promotes findings into comments.
- **citation** vs **source** — `sources[]` is the field; **citation** is the activity / discipline. Don't say "the citations array."
- **selector** vs **context selector** vs `ContextSelector` — prefer **selector** in prose, `ContextSelector` for the type, **context selector** only when disambiguation is needed.
