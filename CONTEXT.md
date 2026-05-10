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

**tier** — Severity classification on a comment: **Tier 1** must-fix (production risk, vulnerability, data corruption — always post); **Tier 2** should-fix (real bug, in-scope — post if confidence > threshold); **Tier 3** informational (correct but low-impact or larger refactor — post only on request).

**category** — What kind of concern a comment represents. Shipped: `correctness`, `clarity`, `style`, `dedup`, `tests`. M7 additions: `scalability`, `consistency`, `deadcode`, `committability`. Categories drive prompt shape, worker routing, and the feedback signal used for category promotion. → ADR-0012, ADR-0020.

**priority order** — The reading order enforced on the output, orthogonal to tier: **correctness → clarity → style → dedup → tests** (M7 inserts scalability, consistency, deadcode, committability between correctness and clarity). Lower-priority findings are suppressed when a higher-priority finding would change the answer. → ADR-0012, ADR-0020.

**citation discipline** — The load-bearing thesis: the LLM cannot author findings without a tool source; it can only triage and format what runners produced. M7 extends the discipline to **questions** — every quoted snippet must be mechanically verifiable. The **substring-verifier** is what enforces it. → ADR-0008, ADR-0021.

**`sources[]`** — Structured citation array on every comment. Source `type` is one of `cve` (NVD/OSV), `advisory` (GitHub Advisory), `changelog`, `documentation`, `web`, `tool` (TSC / ESLint output), `file` (a code snippet from the repo, M7+), `repo_convention`. Each source carries `id` / `url` / `title` and a `retrievedAt` ISO timestamp. → ADR-0008.

**evidence** — The concrete file path + single-line range (and optional snippet) that grounds a claim in the code. Surfaced on `ContextCandidate.reasons[]` (M5) and on M7 detector findings; consumed by the substring-verifier.

**clarification question** — A specific shape of comment Warden's LLM is encouraged to emit instead of asserting when domain intent is unclear. Preserves citation discipline by refusing to invent claims. → memory: `project_warden_clarification_questions.md`.

**`degradedWorkers`** — Metadata array on `CommentSet` reporting partial failures or quality signals. M7 refactor: from `string[]` to `DegradedEntry[]` with `{ kind: "actionable" | "warning" | "info", topic, message }`. Loud only when the user can act on it (e.g., "no embeddings — run `warden init`"); silent when everything is fresh.

**confidence** — Numeric 0.0–1.0 on every comment. Below the per-category **confidence threshold** (default 0.7), the comment is silently dropped during the **grading** step.

**volume cap** — Maximum comments per PR (default 5, configurable). When more findings exist, prioritise by category × confidence. Excess findings are discarded, not collapsed into "show more" — prevents nag accumulation.

---

## 3. Models + AI layer

**boss model** — Sonnet-class (`claude-sonnet-4`). The synthesiser and grader; in M1–M4, also the single LLM **formatter** call. → ADR-0006.

**worker strong** / **worker sonnet** — Sonnet-class specialist for correctness and security workers; subtle bugs warrant deep reasoning. `[deferred]` to M2+ orchestration; not invoked by the v0 single-call formatter. → ADR-0006.

**worker cheap** / **worker haiku** — Haiku-class (`claude-haiku-4`) for contract, best-practices, and the M7 **committability sub-agent**. Cheap, sufficient for pattern-matching tasks. → ADR-0006, m7-plan.md.

**model tier** — The strong/cheap mapping per provider. Anthropic: sonnet-4 / haiku-4. Future BYO providers will mirror the tier shape (OpenAI: gpt-4.1 / mini; Google: gemini-2.5-pro / flash).

**LLM formatter** — The single Sonnet call that takes diff + tool findings + verified CVEs + retrieved context and returns a `CommentSet`. Lives in `packages/core/src/llm/`. Prompts are externalised to `prompts/{system,user-template}.md`. → ADR-0015.

**fallback chain** — Anthropic primary → 1× retry with backoff → Google Gemini secondary. Both auth and transient failures cascade. Hard-fail if both exhaust. Cascade lives in `@warden/core/src/llm/cascade.ts`. → ADR-0017.

**extended thinking** — Anthropic's multi-step reasoning mode. Token budget controlled by `WARDEN_THINKING_BUDGET` (default 4096). Optional in M1–M4; reserved for deep-reasoning workers later.

**sub-agent** — A runner whose work is a scoped LLM call (see §5 for the canonical definition). M7 ships the **committability sub-agent** (cheap-tier), which reviews added/modified files for committability anti-patterns and emits questions subject to substring-verification.

**boss/worker orchestration** — `[deferred — spine in M8 (ADR-0023); worker tier still deferred]` The vision-tier pipeline: deterministic execution → parallel specialist workers → boss synthesis → grading. v0 collapses this into a single formatter call. Reintroduced incrementally: sub-agent in M7; **orchestration spine** (dispatch + scratchpad + synthesizer routing existing runners) in M8 per ADR-0023; specialist Sonnet **workers** (adversarial critic, self-aware invariant checker, free-form prose consistency, DeepSec-shaped SAST, etc.) in M9+ — each its own ADR when scheduled. The word **worker** is reserved for *the worker tier* — a specialist LLM in a multi-call pipeline. The M7 cheap-tier LLM runners are **sub-agents**, never workers; the M8 spine dispatches existing runners (detectors + sub-agents per §5) without committing to specialist-LLM workers. → vision.md §3, ADR-0023, ADR-0008.

**self-aware boss model** — `[deferred, M6+]` Direction where the boss model can introspect its own code/limits at runtime. The introspection surface is treated as a hardened jailbreak boundary. → memory: `project_warden_self_aware_boss.md`.

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

**confidence threshold** — Per-category numeric gate (default 0.7). Findings below it are silently dropped. Tunable per category — vulnerability runs lower (don't miss CVEs); style / readability runs higher (very conservative on nits).

**false positive rate** — % of comments developers mark "Not Useful". Prototype expectation < 35%; mature target < 25%.

**usefulness rate** — % of comments developers mark "Useful". Prototype expectation 40–60%; mature target > 70%.

**address rate** — % of comments resolved in the final commit (post-merge re-run). Prototype 30–50%; mature > 60%.

**latency** — Time from PR creation to comments posted. v0 target < 10 min; mature target < 5 min.

---

## 8. Deferred concepts

Named shorthand for things not yet built. Useful when reading docs that reference them; not yet load-bearing.

**BYOLLM** — Bring-Your-Own-LLM. Multi-provider config + per-role model selection. v0 hardcodes Anthropic. → ADR-0006.

**BYOEmbedder** — Multi-provider embedding abstraction (Voyage + OpenAI + Cohere + Gemini + local Transformers.js) with per-provider cost estimates. v0 hardcodes Voyage `voyage-code-3`. The local Transformers.js path addresses NDA / data-residency cases. → ADR-0019.

**custom-code SAST worker** — DeepSec-shaped per ADR-0015: borrow the pipeline, reject the grounding model. Gated on M6 dogfood evidence that retrieval is good enough to support it. → ADR-0015, memory: `project_warden_deepsec_reference.md`.

**leverage** (review category) — A sixth category for "this library / utility already does what you wrote." Distinct from dedup. Gated on cross-repo / `node_modules` / `.d.ts` retrieval. → memory: `project_warden_leverage_category.md`.

**verify API claims** — Applying citation discipline to LLM claims about library APIs by retrieving `.d.ts` and GitHub source. Shares infrastructure with the leverage category. → memory: `project_warden_verify_api_claims.md`.

**cross-repo retrieval** — Indexing sibling repos + `node_modules` + `.d.ts` files. Unblocks both the leverage category and the API-claim verifier.

**daemon `JobRunner`** — Real async embedding work, either review-time incremental (Model B) or background subprocess / `warden daemon` (Model C). Gated on dogfood evidence that users skip `warden init` consistently. → ADR-0019.

**cloud-hosted index + sync** — The hosted-mode swap point named in ADR-0016. Storage interfaces are backend-agnostic; cloud index is additive, not a rewrite. Solves cache-loss recovery.

**sibling-repo scanning** — `--sibling-repo` flag accepting paths to related repos. Auto-discovers integration points (HTTP calls, shared constants, webhook handlers) and flags PRs that modify an integration boundary. Requires a pre-built integration map.

**license scanning** — Deterministic check for copyleft licences (GPL / AGPL) introduced into proprietary code. → ADR-0008 deferred.

**committability detector half** — A detector for the genuinely bounded subset of committability anti-patterns (merge-conflict markers, leftover `debugger`, `// TODO(remove before commit)`-style sentinels) — i.e., the patterns that survive the "reliable across ecosystems" test. Consciously parked: the open-tail sub-agent is the v0 implementation, and splitting was rejected in M7 because the supposedly-bounded patterns (dirname conventions, hardcoded path heuristics) turned out to be context-dependent. Revisit if a clean bounded subset surfaces.

**diff-level noise filter** — `[deferred to M9]` A pre-runner stage that prunes the diff before any runner consumes it, defending the catastrophic case where committed `node_modules/` (or its ecosystem equivalent) explodes the input for *every* runner — TSC, ESLint, jscpd, vuln, the M7 detectors, and the committability sub-agent alike. Composes the existing M2 ecosystem detection with per-ecosystem **noise profiles**: small JSON documents shipped *inside* `@warden/core` listing always-noise directories (`node_modules/`, `__pycache__/`, `target/`, `bin/obj/`, etc.), context-dependent ones (`dist/`, `vendor/`), generated extensions, and lock files. Internal representation is a **diff tree** — depth-limited (≤3 levels), aggregated from `git diff --raw`, carrying `(addedCount, modifiedCount, deletedCount)` per node — so the catastrophic 500K-file case is bounded in memory regardless of input size. Pruned subtrees each emit a `degradedWorkers` entry like `"skipped 4,900 files in node_modules/ (vendored, JS ecosystem)"`. User override flows through the existing `.reviewbot/overlay.yaml` per ADR-0008; no new config file. Per-subtree ecosystem detection (e.g., `frontend/`=JS, `backend/`=Python monorepos) is an explicit M9+ sub-decision, not part of the initial cut. M7 ships a single-heuristic placeholder, scoped to the committability sub-agent: skip if any one top-level directory contributes >80% of added files (the "node_modules dump" signature) *or* if added files exceed a hard count (≈200) with no dominator. The degraded entry is `actionable` and names the suspect directory so the user can fix `.gitignore` directly. The full design lands as ADR-0022 + `m9-plan.md`.

**noise profile** — `[deferred to M9]` Per-ecosystem data document (JSON, shipped inside `@warden/core/src/ecosystem/profiles/`) that classifies directories and extensions as always-noise, context-dependent, or generated. Used by the **diff-level noise filter** to prune the diff tree before runners see it. Distinct from `.gitignore` (which is the user's per-repo declaration); profiles are Warden's belt-and-suspenders for the case where gitignore is missing or wrong.

**diff tree** — `[deferred to M9]` Depth-limited (≤3) representation of a diff, aggregated from `git diff --raw` into nodes carrying `(path, addedCount, modifiedCount, deletedCount)`. Bounded by directory structure, not file count — a 500K-file diff still fits in a few KB. The internal representation the **diff-level noise filter** prunes against.

**GitHub PR bot** — Future `apps/github-bot/`: Elysia server, BullMQ + Redis queue, Postgres install tokens + review history, GitHub OAuth. Calls `@warden/core` → posts via the GitHub API. → ADR-0013, memory: `project_warden_bot_roadmap.md`.

**Slack bot** — Future `apps/slack-bot/`: slash commands (`/warden review owner/repo#PR-123`), event subscriptions. Reuses the GitHub bot's Postgres / Redis. → ADR-0013.

**ClickUp integration** — Future integration; shape TBD. → ADR-0013.

---

## Open inconsistencies

Things the docs spell more than one way. Pick one before they ossify.

- **boss model** vs **boss LLM** vs **synthesiser** — the same role; prefer **boss model** in code, **boss** in prose.
- **worker strong** vs **worker sonnet** vs **strong worker** — prefer **worker strong** to mirror **worker cheap**.
- **finding** (tool-derived) vs **comment** (output unit) — never use them interchangeably; the formatter promotes findings into comments.
- **citation** vs **source** — `sources[]` is the field; **citation** is the activity / discipline. Don't say "the citations array."
- **selector** vs **context selector** vs `ContextSelector` — prefer **selector** in prose, `ContextSelector` for the type, **context selector** only when disambiguation is needed.
