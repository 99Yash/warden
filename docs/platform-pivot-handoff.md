# Warden Platform Pivot — Session Handoff (2026-06-11)

> **Purpose.** This is a session-continuity document for a large in-flight planning effort: turning Warden from a solo local CLI into a hosted, Greptile-class code-review platform with a homegrown indexer, cross-repo clusters, custom rules, and a dashboard. It captures the chronological progression, the research evidence, the decisions locked, the ADRs drafted, and the open questions — so a fresh context window can resume cold.
>
> **Canonical records live elsewhere.** ADRs 0039–0043 are in [`decisions.md`](../decisions.md) (the source of truth for locked decisions). This doc is the _narrative + evidence + live grill state_ that the ADRs don't carry. Where they disagree, `decisions.md` wins.
>
> **Status: mid-grill.** Five ADRs are written but the grilling pass (via `/grill-with-docs`) is still open and has already surfaced amendments. Do **not** treat 0039–0043 as final until the grill closes. ADR-0008 is being reopened (see §7).

---

## 1. TL;DR — where we are

- **Decided (via explicit user choice):** (a) build our own chunker as a **Rust core via napi-rs**, not fork the MIT `code-chunk`; (b) take Warden **hosted** (Greptile-class platform, dashboard in scope); (c) start with **Phase 0 ADRs**.
- **Written:** ADRs **0039** (hosted identity), **0040** (naming reopened — OPEN), **0041** (Rust napi chunker), **0042** (contextualized embeddings + dedup-key), **0043** (cross-repo clusters). Registered in both index tables in `decisions.md`.
- **Grill so far:** Q1 → custom rules ARE in scope (amends ADR-0036). Q2 → wedge question. Q3 → **user is questioning whether citations are needed at all** (reopens ADR-0008); leaning toward _demote citations, elevate observability_.
- **Biggest open items:** the product name (ADR-0040), the citation/ADR-0008 rethink (provisional ADR-0044), and the assertion-vs-question shape for custom-rule output.

---

## 2. Origin of this thread

User returned to the `warden` repo and noticed the chunking dependency `code-chunk` supports ~6 AST parsers, while the sibling `../-dimension-ai-code-indexing-rust` has ~32 (actually 43). Initial ask: "see what we can do." It scoped up across the session into: homegrown indexer (ideally Rust), cross-repo "clusters" (à la Greptile's launch), and a dashboard (lifting UI from Greptile / `-dimension-ai-web` / `-dimension-ai-legacy`). User explicitly invited browsing Greptile in Chrome.

---

## 3. Research findings (with evidence)

### 3.1 `code-chunk` (current dep, supermemoryai, MIT, v0.1.14)

- 6 languages: TS, JS, Python, Rust, Go, Java. `web-tree-sitter` (WASM grammars).
- **Rich semantic chunking**: scope chains, entity signatures, sibling context, imports, and a `contextualizedText` field built _specifically for embeddings_ (`formatChunkWithContext` prepends `# path`, `# Scope: Class > method`, `# Defines:`, `# Uses:`, sibling/overlap).
- Options (defaults): `maxChunkSize: 1500` (non-whitespace chars), `contextMode: 'full'` (note: `'minimal'` and `'full'` are treated **identically** in code — only `'none'` branches), `siblingDetail: 'signatures'`, `filterImports: false`, `overlapLines: 10`. **`overlapLines` only affects `contextualizedText`.**
- Entity-based greedy windowing; merges small adjacent entities; splits oversized leaves at line boundaries.

### 3.2 How Warden uses it (the critical findings)

- Single seam: `packages/core/src/context/chunker.ts` — `CodeChunkAdapter`, the only importer (ADR-0019 #2 discipline). `SUPPORTED_LANGUAGES` hardcoded to the 6.
- Walk filter gates everything upstream: `packages/core/src/init/walk.ts:47` — `SOURCE_EXT_RE = /\.(?:tsx?|jsx?|mjs|cjs|py|rs|go|java)$/i`. **Even a 43-language chunker wouldn't widen review scope until this changes.**
- **Warden embeds raw `c.text` (`chunker.ts:120`), NOT `contextualizedText`** — leaving the provider's main embedding-quality lever unused, _and_ silently paying for the inert `overlapLines:10`.
- Semantic signal: `packages/core/src/context/signals/semantic.ts` — embeds the **whole unified diff** as the query (`type=query`), retrieves top-50 doc chunks ≥0.5 cosine, max-aggregates per file. So the corpus/query asymmetry is "contextualized chunk vs raw diff."
- Dedup: `chunk_hash = sha256(raw content)` is the shared embedding key (ADR-0019 #3) — identical code across files collapses to one row.

### 3.3 `-dimension-ai-code-indexing-rust` (sibling, owned)

- 43 tree-sitter parsers / 80 extension mappings. Registry: `src/helpers/language.rs` (`LANGUAGE_MAP`, `language_for_ext`). Cargo grammar block lines 66–109.
- **Chunking is dumb**: `text_splitter::CodeSplitter`, ~1024-char size-based splitting on AST boundaries, **zero semantic metadata** (`StructuredChunk` = path/content/start_line/end_line/token_count). This is _why_ it gets 43 langs cheaply — and why porting its chunking would be a quality regression.
- Heavily infra-coupled: NATS JetStream service, Postgres, GCP KMS, Voyage (`voyage-3.5-lite`), **TurboPuffer** vector DB, Infisical. NOT a CLI; ~10–15h to extract the portable core. No napi/wasm today.
- **Verdict: take its language _registry as data_, not its chunking.**

### 3.4 Dashboard UI reuse (`-dimension-ai-web` vs `-dimension-ai-legacy`)

- Both: Next 15 / Tailwind / Radix / Zustand / tRPC, ~210 UI components, cleanly decoupled at the UI layer but bound to dimension's tRPC backend.
- **`-dimension-ai-legacy` is the better lift** — transactional dashboard DNA (projects/teams/tasks/settings, real tables, member mgmt). `-dimension-ai-web` is chat/generative-UI focused, weaker fit.
- Build fresh regardless: diff viewer, findings panel, repo/index-status, review feed — neither codebase has these.

### 3.5 Greptile live recon (verified in-browser, app.greptile.com, user's own org)

- **Dashboard IA:** Analytics · Repositories · Code Review Settings · **Custom Context** · Pull Requests · Code Providers · Integrations · Organization Settings.
- **PR feed:** table with PR# · name · repo · branch · **STATUS** (COMPLETED / TRIAL ENDED) · **CONFIDENCE (X/5)** · # REVIEWS · last updated. (Confidence-per-PR is a surface warden has no analog for.)
- **Clusters = "Cross-repo context"** (URL `/custom-context/repo-clusters`). Verbatim: _"Create repo clusters here. While reviewing a PR in any member repo in the cluster, Greptile will have context of every other repo."_ → a **named, bidirectional group of member repos**, created via a dashboard button. (My ADR-0043 modeled it as a _directional_ `cluster.repos[]` config — needs reshaping to bidirectional + dashboard-managed.)
- **Custom Rules** (`/custom-context/context`): freeform user-authored prose rules, scoped per-repo, with TYPE ∈ {custom rule, Agents.md files, CLAUDE.md files}, USAGE count, STATUS. User has a 20-review-deep backend/frontend checklist (N+1, timeouts, the Promise.all-over-billable-calls trap, library-leverage, TS patterns, a11y…). **This is exactly what warden's ADR-0036 rejected — and the user gets real value from it.**
- Billing: free trial, per-author review limits.

---

## 4. Decisions locked (via AskUserQuestion)

1. **Indexer** → **Rust core via napi-rs** (reuse dimension registry + tree-sitter plumbing, add code-chunk-parity semantic extraction). Rejected: fork-code-chunk-in-TS (cheaper, noted as fallback), port-dimension-as-is, CLI sidecar, wasm-only.
2. **Product identity** → **Hosted platform** (dashboard in scope; reopens naming + multi-tenancy + hosted infra). Rejected: stay local-only; hosted-first-deprecate-CLI.
3. **Start with** → **Phase 0 ADRs.**

---

## 5. ADRs written (`decisions.md`) — treat as DRAFT pending grill close

| ADR  | Title                                        | Status                              | Key amendments                                                                          |
| ---- | -------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------- |
| 0039 | Product identity: hosted platform            | Direction                           | reopens ADR-0001, ADR-0024                                                              |
| 0040 | Name resolution under hosted pivot           | **Open — awaiting owner name pick** | reopens ADR-0003; rec: rename public product, keep `@warden/*` internal                 |
| 0041 | Homegrown chunker: Rust core via napi-rs     | Direction                           | supersedes ADR-0019 #2, amends ADR-0003 (binary-matrix)                                 |
| 0042 | Embed contextualized text; revisit dedup key | Direction                           | revises ADR-0019 #3; eval-gated A/B                                                     |
| 0043 | Cross-repo clusters                          | Direction                           | de-defers ADR-0019/0026; **needs reshape: bidirectional + dashboard entity** (see §3.5) |

**Provisional, not yet written:**

- **ADR-0044** — review quality over citation discipline; observability as trust spine; verifier demoted to anti-fabrication guard. (Reopens **ADR-0008**.) See §7.
- **ADR-0036 amendment** — custom rules in scope (see §6).

---

## 6. Grill progress

### Q1 (RESOLVED) — custom rules are in scope; amends ADR-0036

User: "yes we should allow them… use a cheap model to verify user inputs… they can define custom rules in their repo and we pick those up."

- Custom rules ARE in scope, both as a repo file warden auto-detects (graduates ADR-0035's reserved **repo-overlay** lane) and as a hosted dashboard Custom-Context page.
- **Citation-discipline rider (to keep ADR-0008 intact _if_ it survives §7):** a custom-rule **comment** cites the rule via the existing `repo_convention` **source** type, and the **substring-verifier** still confirms any quoted code — deterministic, not LLM-judges-LLM. The "cheap model to verify user inputs" is the _rule-intake/normalization/injection-guard_ step, NOT the finding verifier (keeps ADR-0015's no-LLM-judge stance).
- Glossary term to add: **custom rule**.
- **Open sub-point:** does custom-rule output emit as **assertion** (Tier-able finding) or **question**? Leaning: assertion when structural enough to cite a verifiable snippet; question otherwise.

### Q2 — the wedge

Posed: if warden adopts Greptile's custom rules + clusters + dashboard + confidence, what makes it not "Greptile with citations"? Recommended wedge: _verifiable-or-it's-a-question + honest confidence_. **Superseded in spirit by Q3** — user pivoted the wedge toward "phenomenal reviews + observability."

### Q3 (RESOLVED — the big one) — do we even need citations? → ADR-0044 written

User: "lets think if we really need citations. what we need is phenomenal code reviews, and maybe some o11y as to how a review was generated."

- **Resolved via `/grill-with-docs` (2026-06-11): ADR-0044 written + registered in both index tables.** The grill surfaced the load-bearing finding that _the M14 review harness already broke citation discipline_ — the `correctness` worker (an LLM) emits `kind:"assertion"` findings whose mandatory `sources[].min(1)` is a self-quoted snippet tagged `type:"tool"`; the substring-verifier checks the _quote exists_, never the _claim_. So ADR-0044's charter is **ratify + make honest**, not net-new.
- **Decisions locked (all six grill questions):** (A) ratify the M14 reality; (X) split `evidence` (mandatory anti-fab locator) from `sources[]` (optional, external/deterministic-only); gate is **per-claim-type not per-concern** (CVE→OSV hard, library→`api_def` soft, convention→soft, diff-judgment→none); **never drop for empty `sources[]`**; provenance adjective **sourced/reasoned**; **confidence sets `kind`** (low-confidence reasoned → question, never dropped), Tier-1 = "never drops" not "always asserts"; **review trace** = descriptive read-model from `ReviewScratchpad`, persisted to a local `reviewRuns` table, dashboard deferred to Phase 4.
- **Ripple:** reopens ADR-0008, reaffirms ADR-0015 (no LLM-judges-LLM — the degrade + verifier stay deterministic), edits ADR-0021 ("LLMs ask never assert" relaxed), generalizes ADR-0026 §7, revises CONTEXT.md §2.
- **Still pending (lands _with_ the schema migration, not ahead of it — else CONTEXT.md becomes the new forward-lie):** the `evidence`-field migration (`Comment` + `WorkerFindingSchema` + 6 worker prompts + `to-comment.ts` + verifier + renderer + `applyHardRules()` confidence→kind), the `reviewRuns` table, and the CONTEXT.md §2 glossary rewrite. Eval-gated: `review-eval` A/B (reasoned-assertions on vs off) against the `*-misses-*` fixtures before the default flips.

---

## 7. Open questions / pending decisions

1. ~~**ADR-0008 / citations** (§6 Q3) — demote + observability spine?~~ **RESOLVED 2026-06-11 — ADR-0044 written (per-claim-type gate, `evidence`/`sources[]` split, sourced/reasoned, confidence-sets-kind, review trace). Remaining: the schema migration + CONTEXT.md §2 sweep land together, eval-gated.**
2. **Product name** (ADR-0040) — owner's pick. Recommended: public rename, keep `@warden/*` internal. Blocks public launch, not Phases 1–3.
3. **Clusters shape** (ADR-0043) — reshape to bidirectional named cluster + dashboard-managed entity (+ local config mirror). Confirm.
4. **Custom-rule output shape** — assertion vs question (§6 Q1 sub-point).
5. **Rust build-matrix cost** (ADR-0041) — confirm willingness to own per-(os,arch) prebuilds + wasm fallback; or keep TS-fork as fallback if CI burden bites.
6. **Dedup-key tradeoff** (ADR-0042) — confirm accepting reduced cross-file dedup for correct per-location contextualized embeddings; eval-gated.
7. **Observability surface** — what exactly the review trace records and how it's stored (extends `CommentSet` metadata / a new table) and shown in the dashboard.

---

## 8. The 4-phase plan (sequencing)

- **Phase 0 — Decisions/ADRs** (in progress; grill open).
- **Phase 1 — Chunk quality in majors**: contextualizedText A/B on `review-eval` real-PR fixtures (the `*-misses-*` fixtures in the working tree are ground truth); resolve dedup key. Highest-leverage, Rust-decision-independent. Feeds the Tier-A parity gate.
- **Phase 2 — Breadth**: Rust chunker languages (tiered A→B→C) + widen `SOURCE_EXT_RE` + review scope.
- **Phase 3 — Clusters**: bidirectional repo clusters + cross-repo index/retrieval.
- **Phase 4 — Dashboard**: lift design system from `-dimension-ai-legacy`; build diff-viewer / findings-panel / review-trace surfaces fresh. Hosted API + tenancy. Gated on the naming decision for public launch.

Phases 1–3 ship locally first and are cloud-compatible by construction (ADR-0016 storage interfaces).

---

## 9. Pointers

- **ADRs:** `decisions.md` 0039–0043 (+ Snapshot rows + Status-snapshot rows).
- **Glossary:** `CONTEXT.md` (terms to add: _custom rule_, _review guidance/overlay_, _cluster / cross-repo context_, _review trace / observability_; terms to revise if Q3 lands: _citation discipline_, _finding_, _substring-verifier_).
- **Memories:** `project_warden_hosted_pivot.md` (new), `project_warden_naming_collision.md` (updated dormant→blocking), `MEMORY.md` index.
- **Journal:** `~/journal/2026-06-11T055227Z.md` + `~/journal/2026-06-11T060226Z.md`.
- **Key code seams:** `packages/core/src/context/chunker.ts`, `…/context/signals/semantic.ts`, `…/init/walk.ts`, `…/init/reconcile.ts`, `…/review-harness/`, `packages/db/src/schema/`.
- **Sibling repos:** `../-dimension-ai-code-indexing-rust` (registry source), `../-dimension-ai-legacy` (dashboard UI source).
- **Greptile (prior art):** app.greptile.com — Custom Context (rules + repo-clusters), Confidence-per-PR, dashboard IA per §3.5.

---

## 10. Immediate next actions for the next context window

1. Get the user's **citation/ADR-0008 call** (§7.1). If demote+observability: write ADR-0044, then sweep ADR-0008/0015/0021/0026 + CONTEXT.md §2.
2. Get the **name** (§7.2); fill in ADR-0040.
3. Reshape **ADR-0043** to bidirectional/dashboard (§7.3).
4. Close remaining grill points (§7.4–7.7), then re-lock 0039–0043.
5. Kick off **Phase 1** (contextualizedText A/B) — brand- and citation-neutral, can start anytime.
