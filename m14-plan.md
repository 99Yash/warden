# Warden — M14 Plan (review harness — Opus 4.6 boss + dynamic dispatch loop + 6-concern workers + 3-phase pipeline)

This is the milestone brief for the agent (or future-me) implementing M14. Self-contained: read this plus `decisions.md` ADR-0030 and you have everything.

M14 redirects from the **deep-security harness** (originally planned in ADR-0029, now deferred to M15+ per `m15-plan.md`) to a **default `warden review` harness** at `packages/core/src/review-harness/` alongside the M8 spine slot it replaces (not a refactor of M8; M8 retires for review-mode entirely). The harness applies the same pipeline shape ADR-0029 designed for security — apex-class boss + per-file tool-equipped workers + scratchpad coordination + substring-verifier — to default `warden review`. **Key shape differences from ADR-0029:** (a) **dynamic boss loop** instead of static dispatch (boss runs as a `streamText` tool-use loop with `stopWhen: stepCountIs(5)`, dispatches workers as a tool, adjudicates round-by-round); (b) **3-phase pipeline** (Det Priors → Boss Loop → Citation Verify) instead of 6 — the dynamic loop subsumes Plan / Adjudicate / Synth into round-labeled tool calls; (c) **6 worker concerns** by `(file, concern-subset)` rather than 10 security slugs; (d) **Opus 4.6** boss (1M context; rejects 4.7's 1.4× premium per Q3) reusing `getBossModel()` upgraded from Sonnet. Schema impact zero — every concern already exists in `CategoryEnum`; all citations flow through existing `tool` / `api_def` source types; the substring-verifier dispatches unchanged after the bug-floor fix.

## Read first (in this order)

1. **`./decisions.md`** — focus on **ADR-0030** (the M14-review design commit; supersedes ADR-0029). Also: **ADR-0029** (status: Superseded; original M14-security plan now at `m15-plan.md`); **ADR-0023** (M8 orchestration spine — M14 retires the spine for review-mode; check-mode preserved via `det-priors.ts`); **ADR-0015** (DeepSec borrow framing — M14 cashes the pipeline borrow on the worker tier and rejects LLM-judges-LLM revalidation cleanly via substring-verifier); **ADR-0026** (M11 — `lookupTypeDef` tool, third+ consumer pattern in M14 workers); **ADR-0017** (multi-provider cascade — M14's boss + worker calls reuse the same shape); **ADR-0013** (I/O-pure core invariant — worker tools `readFile`/`grepRepo` must honor); **ADR-0011** (`warden check` vs `warden review` separation — check-mode preserved through `det-priors.ts`); **ADR-0008** (citation thesis — every M14 finding must carry a verified source); **ADR-0006** (model tier helpers — M14 upgrades `getBossModel()` to Opus 4.6).
2. **`./CONTEXT.md`** — §1 review pipeline (rewritten to 3 phases); §3 boss model (was Sonnet → now Opus 4.6); §3 apex model (stays for `--deep` deferral); §3 sub-agent term retires, **worker (review-harness)** supersedes; §5 new entries (review-harness, dispatch_worker tool, boss-loop, det-priors); §3 boss/worker orchestration flips status (first vision-tier worker tier ships in M14-review, not M14-security).
3. **`./CLAUDE.md`** — package boundary table; AI SDK v6 notes; M14 status line; new env vars.
4. **`./vision.md` §3** — boss/worker architecture vision. M14 ships the worker tier `vision.md §3` predicted, with the dynamic boss loop replacing static dispatch — closer to the Ronit-blog pattern than M14-security's static fan-out was.
5. **`./m15-plan.md`** — the original M14-security plan (renamed). Read to understand what M14-review intentionally **doesn't ship**: the dedicated security harness, the apex Opus 4.7 tier, the `warden security` verb, the `--deep` flag, the `securityRuns` cost-tracking table. Those are M15+.
6. **`./packages/core/src/schema.ts`** — `CategoryEnum` (line 34 onwards). M14 **does not modify** this. All 6 worker concerns (correctness, scalability, consistency, security, committability, leverage) already in the enum. `SourceTypeEnum` unchanged.
7. **`./packages/core/src/index.ts`** — `review()` entry point (currently routes through M8 spine + M4 formatter); M14 rewrites it to call `runReviewHarness()`. `check()` entry point rewires to call `runDetPriors()` directly. `applyHardRules()` (around line 592) stays unchanged.
8. **`./packages/core/src/llm/verify-citations.ts`** — M10 verifier + M11 `api_def` extension. **Bug floor Commit 1** generalizes the M11 concat-then-substring-match algorithm to all source types (currently only `api_def` uses it). Per-line match in the non-`api_def` branch (lines 177-181) is the bug; collapsed multi-line snippets never match any single line.
9. **`./packages/core/src/runners/leverage.ts`** — M12 detector. **Bug floor Commit 3** addresses the multi-line snippet emission at lines 333-365. The detector ALREADY guards single-line via `startLine === endLine ? evidence : undefined` (good); the bug-floor commit is belt-and-suspenders in case Commit 1's verifier fix has edge cases.
10. **`./packages/db/src/index.ts`** — `db()` accessor. Verified at read-time: it **already** calls `migrate()` at lines 32-49 on first open. Bug floor Commit 2 may be a no-op or a smoke-test-only commit (add a regression test asserting fresh sqlite works end-to-end without manual migrate). Re-verify before writing the migration logic.
11. **`./packages/core/src/llm/prompts/security-system.md`** — M13 Haiku security sub-agent prompt. **Seeds** `packages/core/src/review-harness/prompts/workers/security-system.md` for M14's security worker (now Sonnet-tier; promoted from Haiku per Q6 tier mapping).
12. **`./packages/core/src/llm/prompts/leverage-system.md`** — M12 leverage sub-agent prompt. **Seeds** `review-harness/prompts/workers/leverage-system.md`.
13. **`./packages/core/src/runners/committability.ts`** — M7 committability sub-agent. Its inline prompt content **seeds** `review-harness/prompts/workers/committability-system.md`. The runner file itself **retires** (sub-agent half deleted; detector half already graduated to M9 `BASELINE_NOISE`).
14. **`./packages/core/src/runners/security.ts`** — M13 Haiku security sub-agent. **Deleted** in M14. Prompt content moves to the new worker.
15. **`./packages/core/src/runners/leverage-libraries.ts`** — M12 Haiku leverage sub-agent. **Deleted** in M14. Prompt content already lives in `leverage-system.md`.
16. **`./packages/core/src/orchestration/{dispatch,synthesizer,scratchpad}.ts`** — M8 spine. **Retire for review-mode.** The `Runner` contract in `runner.ts` survives for future Phase 1 (Det Priors) additions; check-mode goes through `det-priors.ts` directly.
17. **`./packages/core/src/llm/tools/lookup-type-def.ts`** — M11 tool descriptor. M14 workers import this as a **fourth consumer** (after M11 formatter, M12 leverage sub-agent, M13 security sub-agent — the latter two retire so they don't count post-M14, leaving the M11 formatter and M14 workers as the live consumers).
18. **`./packages/ai/src/models.ts`** — current `getBossModel()` (Sonnet) / `getWorkerStrongModel()` (Sonnet) / `getWorkerCheapModel()` (Haiku) / `getApexModel()` (Opus 4.7 — M14-security carry-over). **M14 changes:** `getBossModel()` → Opus 4.6 (was Sonnet). `getApexModel()` stays at Opus 4.7 until `--deep` re-grilled in M15+. Worker helpers unchanged.
19. **`./packages/env/src/index.ts`** — `wardenEnv()`. M14 adds `WARDEN_REVIEW_BOSS_ROUNDS` (default 5, clamped [1,10]) and `WARDEN_REVIEW_WORKER_BUDGET` (optional positive integer, unset = unbounded).
20. **`./packages/cli/src/render.ts`** — phase-log + reasoning-tail UX. M14 extends to render Phase 1 (Det Priors per-runner status), Phase 2 (boss-loop rounds with `phase` label per call + per-worker progress), Phase 3 (Citation Verify drop counts). Cost line shows per-model breakdown.

## Status (in-flight)

Updated as commits land. Tick boxes as `[x]` when done; keep this section short. Detailed status moves to CLAUDE.md's M14 line on close-out.

- [x] **Bug floor C1** — `verify-citations.ts` per-line match generalised to concat-then-substring-match across all source types (`LINE_DRIFT=5` for general, `API_DEF_DRIFT=30` for `api_def`); `verifyApiDef()` replaced by parametric `verifyWindow()`.
- [x] **Bug floor C1 smoke** — `smoke-bugfloor-verify-citations.mts` (single-line at L5/50/500/5000 + multi-line `tool` / `repo_convention` + bogus drop).
- [x] **Bug floor C2 smoke** — `smoke-bugfloor-db-automigrate.mts` (fresh cache boots, every M6 table queryable). `db()` already auto-migrates at `packages/db/src/index.ts:30-31`; smoke is regression-only.
- [x] **Bug floor C3 smoke** — `smoke-bugfloor-leverage-snippet.mts` (multi-line `JSON.parse(JSON.stringify(...))` survives `verifyCitations`). Detector already guards single-line at `runners/leverage.ts:347-354`; smoke is regression-only.
- [x] **`pnpm smoke:bugfloor`** — chained script in `packages/cli/package.json`.
- [x] **ADR-0030 drafted** + ADR-0029 status flipped to `Superseded by ADR-0030` + snapshot table + status table + deferred-list updated. `m15-plan.md` referenced as the preserved deep-security plan.
- [x] **`getBossModel()` → Opus 4.6** in `packages/ai/src/models.ts` (`claude-opus-4-6`). `getApexModel()` slot still designed but does not exist yet (M15+).
- [x] **Env vars** — `WARDEN_REVIEW_BOSS_ROUNDS` (clamped [1,10], default 5 applied at call site) + `WARDEN_REVIEW_WORKER_BUDGET` (positive int, optional) in `@warden/env`; `.env.example` updated.
- [ ] **Harness scaffold** — `packages/core/src/review-harness/{harness,scratchpad,det-priors}.ts`. Phase 1 factors the existing parallel runner block out of `packages/core/src/index.ts:368-461`; reused by `warden check`.
- [ ] **Tools** — `review-harness/tools/{dispatch-worker,read-file,grep-repo}.ts` with safety constraints (`resolveWithinRoot`, secret-deny list, gitignore-honoring, 1000-line cap, 200-result cap).
- [ ] **Boss loop** — `review-harness/boss-loop.ts` (`streamText` + `dispatch_worker` tool + `stopWhen: stepCountIs(env.WARDEN_REVIEW_BOSS_ROUNDS ?? 5)`). Final round emits `Output.array(CommentSchema)`.
- [ ] **Workers (3 fresh)** — `review-harness/workers/{correctness,scalability,consistency}.ts` (Sonnet tier; `lookupTypeDef` + `readFile` + `grepRepo`; `stopWhen: stepCountIs(8)`) + 3 fresh system prompts in `review-harness/prompts/workers/`.
- [ ] **Workers (3 seeded)** — `review-harness/workers/{security,committability,leverage}.ts`. Prompts seeded from M13's `security-system.md` (Haiku → Sonnet), M7's inline committability prompt, M12's `leverage-system.md`. Source runners delete.
- [ ] **`runners/security.ts` deletion** (prompt content already in `llm/prompts/security-system.md`).
- [ ] **`runners/leverage-libraries.ts` deletion** (prompt content already in `llm/prompts/leverage-system.md`).
- [ ] **`runners/committability.ts` LLM-half deletion** (detector half already retired by M9 `BASELINE_NOISE`; may end up deleting the whole file).
- [ ] **M8 spine retirement** — `orchestration/{dispatch,scratchpad,synthesizer}.ts` retire for review-mode. `orchestration/runner.ts` (the contract) stays; `det-priors.ts` does not need it but future Phase 1 additions may.
- [ ] **`packages/core/src/index.ts` rewire** — `review()` branches: `mode === 'check'` → `runDetPriors()` + `toComment()` + `applyHardRules()`; `mode === 'review'` → `runReviewHarness()`. Empty-diff early-return in both paths.
- [ ] **`packages/core/src/llm/prompt-loader.ts`** — add `loadBossSystemPrompt()` + `loadWorkerSystemPrompt(concern)`.
- [ ] **`packages/core/tsdown.config.ts`** — include `review-harness/prompts/**` in the published bundle.
- [ ] **`packages/cli/src/render.ts`** — extend phase log: Phase 1 (det-prior status), Phase 2 (boss-loop rounds + per-worker), Phase 3 (verify drop counts); per-model cost line.
- [ ] **Smoke fixtures + scripts** — `smoke-m14-{correctness,scalability,consistency,security,committability,leverage,boss-loop,empty-diff,verify-drop}.mts` + `fixtures/m14/*.diff` + chained `pnpm smoke:m14`.
- [ ] **CLAUDE.md** — M14 line `[ ]` → `[x]`; env table adds the two new vars; M15+ deferred list restructured to put deep-security tier at the top.
- [ ] **CONTEXT.md** — §1 review pipeline rewritten to 3-phase; §3 boss model = Opus 4.6; §3 sub-agent retired; §3 worker (review-harness) added; §5 review-harness / boss-loop / dispatch_worker / per-worker entries; §7 confidence threshold unchanged.
- [ ] **Journal entry** under `~/journal/YYYY-MM-DDTHHMMSSZ.md`.

## Goal of this milestone

Land ADR-0030's design in a single coherent slice:

- **No `CategoryEnum` change.** All 6 worker concerns already in the enum.
- **No `PRIORITY_ORDER` change.** Existing slots stay.
- **No new `Source.type`.** Workers emit existing `tool` / `api_def` sources.
- **No verifier API change** *post-bug-floor*. Commit 1 fixes the per-line match limitation; the verifier signature stays the same.
- **`getBossModel()` → Opus 4.6.** Existing helper, new mapping. `getApexModel()` (Opus 4.7) untouched.
- **Env vars.** `WARDEN_REVIEW_BOSS_ROUNDS` (default 5) + `WARDEN_REVIEW_WORKER_BUDGET` (optional). Documented in `.env.example` + CLAUDE.md env table.
- **No new SQLite tables.** Cost-tracking deferred per Q12.
- **Dedicated harness module.** New `packages/core/src/review-harness/` directory: `harness.ts` (entry), `scratchpad.ts` (`ReviewScratchpad`), `det-priors.ts` (Phase 1; reused by `warden check`), `boss-loop.ts` (Phase 2), `workers/{correctness,scalability,consistency,security,committability,leverage}.ts`, `workers/dispatch.ts` (the `dispatch_worker` tool's worker-routing fn), `tools/{dispatch-worker,read-file,grep-repo}.ts`, `prompts/boss-system.md`, `prompts/workers/*-system.md` (6 worker prompts). Prompt loaders in `packages/core/src/llm/prompt-loader.ts` extended.
- **CLI: no new verbs, no new flags.** `warden review` redirects to `runReviewHarness()`; `warden check` redirects to `runDetPriors()` + return shape. No `--deep`, no `warden security` (both M15+).
- **Smoke harness.** `smoke-bugfloor-{verify-citations,db-automigrate,leverage-snippet}.mts` for the 3 bug-floor commits. `smoke-m14-{correctness,scalability,consistency,security,committability,leverage}.mts` — 6 worker fixture smokes asserting catch + verify + hard-rules pass. Plus `smoke-m14-{boss-loop,empty-diff,verify-drop}.mts` for harness-level assertions.

By the end:

- `warden review HEAD~1..HEAD` on the M14 PR itself: Opus 4.6 boss runs ≤5 rounds, dispatches Sonnet/Haiku workers per concern, emits ≥3 review-quality findings with ≤1 false positive; final cost line ≤ $2.00 with per-model breakdown.
- `warden check HEAD~1..HEAD` on the same diff: deterministic-only output identical to pre-M14 check; zero LLM calls; sub-second wall-clock.
- `pnpm smoke:m14` exercises all 9 smoke scripts (6 worker fixtures + boss-loop + empty-diff + verify-drop); `pnpm smoke:bugfloor` exercises the 3 bug-floor smokes.
- `pnpm check-types` + `pnpm lint` pass on every commit.
- ADR-0030 status snapshot row stays `Direction` until dogfood acceptance, then flips to `Done`.
- ADR-0029 status flips to `Superseded` (pointer to ADR-0030).
- CLAUDE.md M14 line flips to `[x]`; M15+ deferred list reorganised; new env vars documented; glossary updates landed.

**Stop at "bug floor + harness module + boss loop + 6 worker prompts + retirement of M8 spine + M7/M12/M13 sub-agents + render UX + smoke + dogfood + close-out." Do NOT start:** `warden security` standalone verb (M15+); `warden review --deep` flag (M15+); promote/drop `getApexModel()` Opus 4.7 (M15+ `--deep` re-grill); cost-tracking SQLite table (Q12 defer); mid-stream context compaction for pathological large diffs (post-M14 milestone); ESLint security `ignore: true` config-bleed fix (PR #15 — defer to post-M14 polish; consistency worker may catch); DB `getByFile()` / `count()` SQL inefficiency (PR #3 — defer); replay-on-past-PRs harness (Q11-III rejected for over-engineering; defer to state-of-the-art verification suite); migrating remaining inline runners through M8's `Runner` contract (M8 retires for review; check goes through det-priors); workers emitting new `SourceType` variants; boss-side tool access beyond `dispatch_worker`; multi-language worker prompts (TS/JS only in v0); finer-grained sub-knobs like `WARDEN_REVIEW_ADJUDICATE_ROUNDS` (single `BOSS_ROUNDS` cap is enough for v1). Those are later milestones.

## Design decisions (grill-with-docs lock — full reasoning + rejected alternatives)

| # | Decision | Lock | Reasoning + rejected alternatives |
|---|---|---|---|
| Q1 | Harness IS the polish — not a separate polish sprint | M14 = harness | **Rejected (A) Polish + harness as separate milestones.** Polish sprint has no clean exit criterion — Copilot will catch new things between PRs. Hand-patching each bug ("optimize the prompt every time Copilot finds something") doesn't scale and was explicitly the strategy rejected. The 3 bug-floor items are preconditions for the harness, not a milestone in themselves. **Chosen (B):** harness's per-file Sonnet workers + boss adjudication catch the *classes* Copilot caught; only the 3 verifier/db/leverage bugs block the harness itself from working. |
| Q2 | Worker dimension = hybrid `(file, concern-subset)` | (C) Hybrid | **Rejected (A) By concern alone (vision §3 shape).** Fixed concerns × full-diff input misses "this specific file is interesting" — Copilot's verifier-head-only finding required deep look at `verify-citations.ts`, not all files. **Rejected (B) By file alone.** Misses concern-specificity — running every concern on every file is wasteful for styling-only files. **Chosen (C):** boss plans `(files[], concerns[], tier?)` per subtask; M14-security already chose this shape (investigator + classifier). Boss decides "send Sonnet for `verify-citations.ts` correctness+consistency; send Haiku to classify if `README.md`'s VOYAGE_API_KEY claim drifts." |
| Q3 | Boss model tier = Opus 4.6 | (A) downgraded | **Rejected (B) Sonnet boss; Opus only for `--deep`.** Loses the "smarter planning" payoff per user's explicit "won't be doing good code reviews otherwise." **Rejected (C) Haiku boss.** Too weak for multi-file budget allocation. **Rejected (D) Env-tunable.** Over-design without dogfood evidence. **Chosen (A) downgraded to Opus 4.6:** 1M context; rejects 4.7's 1.4× premium (user: "I can do without that"). `getBossModel()` becomes Opus 4.6 (was Sonnet). `getApexModel()` stays Opus 4.7 until `--deep` re-grill in M15+. |
| Q4 | Full replacement — M8 spine + M7/M12/M13 sub-agents retire for review-mode | (A) | **Rejected (B) Harness wraps spine.** Preserves the half-baked M8 spine (only 2 of 8 runners migrated through `Runner` contract per ADR-0023 status); wrapping adds complexity without payoff. **Rejected (C) Replace synth; keep sub-agents parallel.** Dual-LLM-brain pattern stays alive — sub-agents bypass the boss's planning, defeating the harness. **Chosen (A):** single planning brain. M13/M12/M7 sub-agent prompts seed M14 worker prompts verbatim; runner files delete; M8 `synthesizer.ts` + `dispatch.ts` + `scratchpad.ts` retire for review-mode. `Runner` contract survives for det-priors additions. Check-mode preserved via thin `det-priors.ts` helper. |
| Q5 | Boss loop dynamism = full dynamic, `stepCountIs(5)` cap | (γ-capped) | **Rejected (α) Static dispatch (M14-security shape).** Boss never sees scratchpad mid-stream; can't adjudicate. User's framing ("the boss will basically be adjudicating what to do next based on their findings") demanded dynamism. **Rejected (β) Bounded dynamic (3-4 calls).** User asked for full dynamic with cap. **Rejected uncapped γ.** $1.50–2.00/review Opus cost at 10 rounds × 5–20 reviews/day = $7.50–40/day; unacceptable for personal v1. **Chosen (γ-capped at 5 rounds):** boss runs `streamText` tool-use loop with `dispatch_worker` tool + `stopWhen: stepCountIs(5)`. ~$0.75–1.00/review Opus boss; workers separately bounded by `WARDEN_REVIEW_WORKER_BUDGET`. Each round labeled via `phase: 'plan'|'adjudicate'|'synth'` for render UX. |
| Q6 | Concern set = 6 (correctness, scalability, consistency, security, committability, leverage) | (I) Aggressive 6 | **Rejected (II) Lean 4 (drop committability + leverage workers).** Partial replacement; contradicts Q4 (A); leaves M7/M12 sub-agents as parallel cheap-tier mini-LLMs. **Rejected (III) Maximal 7+ (add clarity/contract).** Clarity overlaps with correctness; contract has no data source pre-sibling-repo. Over-design. **Chosen (I):** full sub-agent consolidation. 3 new prompts (correctness, scalability, consistency) + 3 migrated from M13/M7/M12. Tier defaults: correctness/scalability/consistency/security = Sonnet (vision §3 mandate); committability/leverage = Haiku (matches today). Boss can override per subtask. |
| Q7 | Phase structure = 3 (Det Priors → Boss Loop → Citation Verify) | (α) Collapsed | **Rejected (β) 6-phase M14-security shape preserved.** Incompatible with γ-capped — full dynamic boss can't be split across rigid Plan/Adjudicate/Synth phases. **Rejected (γ) 4-phase with no-op gate.** Phase 1.5 (Triage Gate) is dead code in review-mode; speculative "might need later" framing. M14-security's gate is binary skip; review can't skip when invoked. **Chosen (α) 3-phase:** Det Priors → Boss Loop → Citation Verify. Boss loop labels rounds via `phase` field. Empty-diff is one-line early-return at harness entry, not a phase. Render UX shows rounds inside Phase 2. |
| Q10 | Bug floor = 3 commits before harness | as-listed | **Rejected expansion to include ESLint security `ignore: true` fix.** Detector survives as Phase 1 det prior; bug stays live post-harness if not in floor, but it's a detector-quality issue not a harness blocker. Consistency worker may catch. **Rejected expansion to include DB perf.** Performance polish, not correctness. **Rejected narrowing to 2 (drop leverage).** Leverage detector survives the migration; broken detector emits broken comments regardless of harness. **Chosen 3 exact items:** verify-citations multi-line + read-around-line (PR #8 + half of PR #14), `db()` auto-migrate (PR #3 — re-verify at impl-time; may be already-fixed by an existing `migrate()` call), leverage single-line snippet (other half of PR #14, belt-and-suspenders). |
| Q11 | Exit criterion = dogfood on M14 PR + 6 canonical fixtures | (II) | **Rejected (I) Dogfood-only.** Matches M5–M13 pattern but too soft for M14's scale (6 workers, 5-round boss loop, ~12 new files). One silently-broken worker would slip past. **Rejected (III) Replay on past PRs.** Multi-day tooling investment for marginal signal vs (II); defer to state-of-the-art verification suite milestone. **Chosen (II):** 6 fixtures (one per worker, ~5–10 lines each); each smoke asserts catch + verify + hard-rules pass. Plus dogfood on M14 PR (≥3 issues, ≤1 FP). Fixtures double as per-worker regression tests. |
| Q12 | Cost-tracking SQLite table = defer | (c) Defer | **Rejected (a) `reviewRuns` table now.** v1 cost ceiling is small (~$5–20/day for personal use); per-run tracking has limited urgency. **Rejected (b) Generalize to `harnessRuns` now.** Pre-empts future fragmentation but adds schema complexity before there's a second consumer. **Chosen (c):** no SQLite table in M14. Add when `--deep` ships in M15+ and cost-tracking matters across both verbs; generalize to `harnessRuns` then with `mode` column. |

## Evidence — Copilot findings that drove this milestone

The Copilot reviews on PRs #3 / #5 / #6 / #8 / #14 / #15 are the **specification** for what the review-harness must catch, not a checklist of bugs to hand-patch. Each cluster maps to a worker concern. Citations are GitHub PR comment URLs (lookup via `gh api repos/99Yash/warden/pulls/N/comments`).

**Class 1 — doc-vs-code drift inside a single function/file** (caught by `consistency` worker)

| Finding | Source | Worker target |
|---|---|---|
| Verifier docstring claims `line ± DRIFT`, impl reads file head | PR #8, `verify-citations.ts` | consistency (also bug floor Commit 1 — too load-bearing to wait for harness) |
| `SourceSchema` docstring claims "silently-skipped", `.refine()` rejects partial triples | PR #8, `schema.ts` | consistency |
| `diff/tree.ts` docstring claims memory not O(files), code pushes per-file refs | PR #6 | consistency |
| `diff/tree.ts` comment claims Windows-path defense, code only splits on `/` | PR #6 | consistency |
| `cli/src/index.ts` banner-ordering comment claims "before phase log", renders after | PR #3 | consistency |
| `committability.ts` doc says citation verified "before the question lands" — pre-M10 framing | PR #8 | consistency |
| README claims `VOYAGE_API_KEY` required for `warden review`, code degrades gracefully | PR #3 | consistency |

**Class 2 — scalability / inefficient resource use** (caught by `scalability` worker)

| Finding | Source | Worker target |
|---|---|---|
| `chunk-store.ts` `getByFile()` filters by `fileSha` in JS, not SQL `WHERE` | PR #3 | scalability |
| `chunk-store.ts` + `embedding-store.ts` `count()` loads all rows, returns `rows.length` | PR #3 | scalability |
| `committability.ts` `buildFileInput()` reads entire file when only first ~4KB used | PR #5 | scalability |
| `committability.ts` prompt includes first ~20 lines regardless of where diff touched (leaks unrelated header) | PR #5 | scalability (or security — info leak) |
| `index.ts` `rawChanged` retained for full `review()` lifetime | PR #6 | scalability (irrelevant post-harness — index.ts rewritten) |

**Class 3 — parallelism / latency regression in diff** (caught by `scalability` + `correctness` workers)

| Finding | Source | Worker target |
|---|---|---|
| `scalabilityRunner` dispatched serially after first `Promise.all` (latency regression) | PR #5 | scalability (correctness for the regression-in-diff signal; irrelevant post-harness — M8 spine retires) |

**Class 4 — security / path safety** (caught by `security` worker)

| Finding | Source | Worker target |
|---|---|---|
| `committability.ts` path traversal — `cf.path` used without repoRoot check | PR #5 | security (irrelevant post-harness — committability worker uses `readFile` tool which is repo-scoped) |
| `verifyCitation()` reads sub-agent-provided paths without repoRoot check | PR #5 | security (irrelevant post-harness — verifier already has `resolveWithinRoot` per current code) |
| `eslint-security.ts` `ignore: true` lets target repo's `.eslintignore` bleed in | PR #15 | security (defer to post-M14 polish; detector-quality issue) |

**Class 5 — silent failures / missing degraded entries** (caught by `correctness` + `consistency` workers)

| Finding | Source | Worker target |
|---|---|---|
| `eslint-security.ts` non-`security/*` rules silently `continue` despite comment saying degraded entry | PR #15 | consistency (comment-vs-code drift) |
| `leverage-libraries.ts` `buildFileInput()` silent on path escape, no degraded entry | PR #14 | correctness (irrelevant post-harness — file deletes) |
| Stale banner can never trigger because `currentHashes` not supplied | PR #3 | correctness (dead-branch detection) |
| `renderBannerLine()` doesn't match `context: no embeddings yet — run \`warden init\`` prefix | PR #3 | consistency |
| Bootstrap script `packages/db/scripts-bootstrap-blair.mts` hardcodes developer paths | PR #3 | committability (committed-helper / dev-script anti-pattern) |

**Class 6 — load-bearing bugs blocking the harness itself** (bug floor, NOT worker territory)

| Finding | Source | Bug-floor commit |
|---|---|---|
| Verifier reads file head — citations beyond N silently fail | PR #8 | Commit 1 (also covers multi-line) |
| `db()` doesn't auto-run migrations on fresh `cache.sqlite` | PR #3 | Commit 2 (re-verify; may already be fixed at line 32-49 of `db/src/index.ts`) |
| `leverage.ts` `emit()` multi-line snippet causes verifier to drop comment | PR #14 | Commit 1 generalizes verifier; Commit 3 is belt-and-suspenders |

**Rejection reasoning for non-floor items:** Any Copilot finding that the harness will catch via worker dispatch is **not** hand-patched. Any finding whose codepath gets rewritten as part of the harness migration is **not** hand-patched. Any finding that's pure detector-quality polish (eslint-security ignore-config) defers to post-M14. The 3 bug-floor items are exactly the ones where (a) the codepath survives M14 unchanged AND (b) the harness can't function trustworthily without the fix.

## Bug floor (lands first, in order, before harness code)

Each commit is independently revertable + carries a smoke script. Order matters — Commit 1's verifier fix is a precondition for any worker's citations to verify.

### Commit 1 — `verify-citations.ts`: generalize concat-then-substring-match across all source types

- **Triggered by:** PR #8 (verifier head bug — verified at read-time: `ensureLinesUpTo()` already reads around `line + LINE_DRIFT`; the **per-line match** in the non-`api_def` branch at lines 177-181 is what's actually broken). PR #14 (leverage multi-line snippet → verifier drops).
- **File:** `packages/core/src/llm/verify-citations.ts`
- **Change:** Replace the per-line `for (let i = start; i <= end; i++) { if (candidate.includes(norm)) return true; }` loop with the M11 `api_def` concat-then-substring-match (`entry.lines.slice(start - 1, end).join(" ")` then normalize then `includes(norm)`). Single-line snippets are a degenerate 1-line case of multi-line; one algorithm covers both. Keep `LINE_DRIFT = 5` for non-`api_def`, `API_DEF_DRIFT = 30` for `api_def` — same dispatch shape, same window widths, unified match algorithm.
- **Reused:** `ensureLinesUpTo()` + `normalizeWhitespace()` unchanged; the existing `verifyApiDef()` function body becomes the shared algorithm.
- **Smoke:** `packages/cli/scripts/smoke-bugfloor-verify-citations.mts` — asserts (a) single-line snippets still verify at line 5, 50, 500, 5000 of a 10000-line fixture file (regression: head-only bug stays dead); (b) multi-line snippets verify across `tool` / `repo_convention` / other non-`api_def` types (new capability).

### Commit 2 — `@warden/db`: confirm auto-migrate (likely a no-op + regression test only)

- **Triggered by:** PR #3 (no such table: index_meta on fresh init).
- **Current state (verified at read-time):** `packages/db/src/index.ts` lines 32-49 already call `migrate(handle, { migrationsFolder: MIGRATIONS_DIR })` on first `db()`. This bug may have been fixed in a post-PR-#3 commit.
- **Action:** Re-verify by deleting `.warden/cache.sqlite` and running `pnpm warden init --dry-run`; if it works, this commit is a **regression test only** (smoke script that exercises the path). If the bug recurs (e.g., migration runs but a schema-extending commit isn't picked up), add the missing logic.
- **Smoke:** `packages/cli/scripts/smoke-bugfloor-db-automigrate.mts` — `rm -f .warden/cache.sqlite && warden init --dry-run` succeeds without "no such table" stderr; asserts `index_meta` row exists post-run.

### Commit 3 — `runners/leverage.ts`: confirm single-line snippet guard (likely already-correct)

- **Triggered by:** PR #14 (leverage multi-line snippet drops).
- **Current state (verified at read-time):** `emit()` at lines 333-365 already guards via `startLine === endLine ? evidence : undefined`. Multi-line nodes already get `undefined` evidence (no snippet), which the verifier skips per the `hasCitationTriple()` check. This bug may be already-fixed.
- **Action:** Re-verify with a smoke that runs leverage detector on a planted multi-line `JSON.parse(JSON.stringify(\n  x,\n))` and asserts the comment survives end-to-end. If it survives, this commit is the smoke + a docstring tightening; if not, fix the emission logic.
- **Smoke:** `packages/cli/scripts/smoke-bugfloor-leverage-snippet.mts` — fixture diff with multi-line `JSON.parse(JSON.stringify(...))`; asserts emitted Comment survives `applyHardRules()`.

**Implementation note:** Commits 2 and 3 may both reduce to "add a smoke test" if the bugs were already fixed in post-PR commits. Re-verify at implementation time. Commit 1 is the load-bearing one.

## Repo additions

```
packages/core/src/review-harness/
├── harness.ts                                    # NEW — entry.
│                                                 #   Exports `runReviewHarness(input):
│                                                 #   Promise<CommentSet>`. Orchestrates
│                                                 #   Phase 1 → Phase 2 → Phase 3. Empty-diff
│                                                 #   early-return at top.
│
├── scratchpad.ts                                 # NEW — ReviewScratchpad class.
│                                                 #   Holds { detPriors, workerOutputs[],
│                                                 #   tokenUsage, costUsd?, degraded[] }.
│                                                 #   Methods: recordDetPrior(),
│                                                 #   recordWorker(), all(). Different shape
│                                                 #   from M8's `Map<runnerName, RunnerOutput>`
│                                                 #   — structured around worker outputs and
│                                                 #   tool-call provenance.
│
├── det-priors.ts                                 # NEW — Phase 1.
│                                                 #   `runDetPriors(input): Promise<DetPriors>`.
│                                                 #   Runs 9 deterministic runners (TSC,
│                                                 #   ESLint user-config, ESLint security,
│                                                 #   jscpd, vuln/OSV, scalability detector,
│                                                 #   consistency detector, deadcode detector,
│                                                 #   leverage detector) + M5/M6 selector.
│                                                 #   Reused by harness AND by `warden check`
│                                                 #   (which returns its output directly).
│
├── boss-loop.ts                                  # NEW — Phase 2.
│                                                 #   `runBossLoop(input)`. streamText
│                                                 #   tool-use loop. model = getBossModel()
│                                                 #   (Opus 4.6). stopWhen: stepCountIs(
│                                                 #   env.WARDEN_REVIEW_BOSS_ROUNDS ?? 5).
│                                                 #   Tools: { dispatch_worker }. Final round
│                                                 #   emits Output.array(CommentSchema).
│
├── workers/
│   ├── dispatch.ts                               # NEW — the dispatch_worker tool's
│   │                                             #   worker-routing function. Routes
│   │                                             #   `concern` → per-concern worker fn.
│   │                                             #   Enforces WARDEN_REVIEW_WORKER_BUDGET
│   │                                             #   total cap; emits degraded entry on
│   │                                             #   budget exhaustion.
│   │
│   ├── correctness.ts                            # NEW — Sonnet worker.
│   │                                             #   streamText with lookupTypeDef +
│   │                                             #   readFile + grepRepo tools;
│   │                                             #   stopWhen: stepCountIs(8).
│   ├── scalability.ts                            # NEW — Sonnet worker. Same shape.
│   ├── consistency.ts                            # NEW — Sonnet worker. Same shape.
│   ├── security.ts                               # NEW — Sonnet worker. Same shape.
│   │                                             #   Prompt seeded from M13's
│   │                                             #   security-system.md.
│   ├── committability.ts                         # NEW — Haiku worker. Same shape (cheap
│   │                                             #   tier per Q6). Prompt seeded from M7's
│   │                                             #   committability inline prompt.
│   └── leverage.ts                               # NEW — Haiku worker. Same shape.
│                                                 #   Prompt seeded from M12's
│                                                 #   leverage-system.md.
│
├── tools/
│   ├── dispatch-worker.ts                        # NEW — boss-side `dispatch_worker` tool
│   │                                             #   descriptor. Input zod schema:
│   │                                             #   { files: string[], concern: Concern,
│   │                                             #   tier?: 'sonnet'|'haiku',
│   │                                             #   focus?: string, phase:
│   │                                             #   'plan'|'adjudicate'|'synth' }.
│   │                                             #   Output: { findings, toolCalls,
│   │                                             #   degraded }. Lane discipline drops
│   │                                             #   findings whose `path` is outside
│   │                                             #   `files`.
│   │
│   ├── read-file.ts                              # NEW — `makeReadFileTool({ repoRoot })`.
│   │                                             #   Path-traversal check; secret-deny
│   │                                             #   list (.env, *.pem, id_rsa, *.key);
│   │                                             #   gitignore-honored; 1000-line cap with
│   │                                             #   truncation marker.
│   │
│   └── grep-repo.ts                              # NEW — `makeGrepRepoTool({ repoRoot })`.
│                                                 #   Literal-substring pattern v0; max 200
│                                                 #   results; secret-deny list; gitignore-
│                                                 #   honored. Shell out to ripgrep if
│                                                 #   available, else Node-side walker.
│
└── prompts/
    ├── boss-system.md                            # NEW — Opus boss prompt.
    │                                             #   Sections: role; pipeline overview;
    │                                             #   dispatch_worker tool usage; concern
    │                                             #   vocabulary (6 concerns + tier
    │                                             #   defaults); cost discipline
    │                                             #   (WARDEN_REVIEW_WORKER_BUDGET aware);
    │                                             #   phase labels (plan/adjudicate/synth);
    │                                             #   citation discipline (sources copied
    │                                             #   verbatim from worker outputs); final
    │                                             #   round = Output.array(CommentSchema).
    │
    └── workers/
        ├── correctness-system.md                 # NEW — Sonnet correctness worker.
        ├── scalability-system.md                 # NEW — Sonnet scalability worker.
        ├── consistency-system.md                 # NEW — Sonnet consistency worker.
        │                                         #   Emphasizes doc-vs-code drift, README
        │                                         #   vs schema, comment-vs-impl divergence.
        ├── security-system.md                    # SEEDED from packages/core/src/llm/
        │                                         #   prompts/security-system.md (M13).
        │                                         #   Promoted Haiku → Sonnet via cheaper
        │                                         #   tier defaults per Q6.
        ├── committability-system.md              # NEW — seeded from M7's inline
        │                                         #   committability prompt content in
        │                                         #   runners/committability.ts.
        └── leverage-system.md                    # SEEDED from packages/core/src/llm/
                                                  #   prompts/leverage-system.md (M12).

packages/core/src/index.ts                        # MODIFIED — `review()` rewires to
                                                  #   `runReviewHarness()`. `check()`
                                                  #   rewires to `runDetPriors()` + thin
                                                  #   wrapper returning CommentSet from
                                                  #   det priors only.

packages/core/src/llm/verify-citations.ts         # MODIFIED — Commit 1 generalizes
                                                  #   concat-then-substring-match across all
                                                  #   source types.

packages/core/src/runners/leverage.ts             # MODIFIED — Commit 3 (likely smoke-only
                                                  #   if already correct).

packages/core/src/llm/prompt-loader.ts            # MODIFIED — add loadBossSystemPrompt() +
                                                  #   loadWorkerSystemPrompt(concern). Each
                                                  #   mirrors existing loaders.

packages/core/tsdown.config.ts                    # MODIFIED — copy review-harness prompt
                                                  #   directory into published bundle.

packages/ai/src/models.ts                         # MODIFIED — getBossModel() returns
                                                  #   anthropicProvider()('claude-opus-4-6')
                                                  #   (was Sonnet). getApexModel() unchanged
                                                  #   for now (4.7; M15+ may downgrade).

packages/env/src/index.ts                         # MODIFIED — add WARDEN_REVIEW_BOSS_ROUNDS
                                                  #   (optional, integer, default 5, clamped
                                                  #   [1,10]) + WARDEN_REVIEW_WORKER_BUDGET
                                                  #   (optional, positive integer; unset =
                                                  #   unbounded).

.env.example                                      # MODIFIED — document new env vars.

packages/cli/src/index.ts                         # MODIFIED — `review` command routes to
                                                  #   the harness; `check` to det-priors.
                                                  #   No new verbs, no new flags.

packages/cli/src/render.ts                        # MODIFIED — extend phase log: Phase 1
                                                  #   (det-prior runner status), Phase 2
                                                  #   (boss-loop rounds with phase label +
                                                  #   per-worker progress), Phase 3 (verify
                                                  #   drops); final cost line per model.

packages/db/src/index.ts                          # POSSIBLY MODIFIED — Commit 2 (only if
                                                  #   re-verify shows auto-migrate broken;
                                                  #   else smoke-only).

packages/cli/scripts/
├── smoke-bugfloor-verify-citations.mts           # NEW
├── smoke-bugfloor-db-automigrate.mts             # NEW
├── smoke-bugfloor-leverage-snippet.mts           # NEW
├── smoke-m14-correctness.mts                     # NEW
├── smoke-m14-scalability.mts                     # NEW
├── smoke-m14-consistency.mts                     # NEW
├── smoke-m14-security.mts                        # NEW
├── smoke-m14-committability.mts                  # NEW
├── smoke-m14-leverage.mts                        # NEW
├── smoke-m14-boss-loop.mts                       # NEW — asserts boss loop respects
│                                                 #   stopWhen: stepCountIs(5).
├── smoke-m14-empty-diff.mts                      # NEW — asserts empty diff → empty
│                                                 #   CommentSet, no LLM calls.
├── smoke-m14-verify-drop.mts                     # NEW — asserts a planted bad citation
│                                                 #   gets dropped + degraded entry surfaces.
└── fixtures/m14/
    ├── correctness-null-deref.diff               # NEW — fixture
    ├── consistency-doc-drift.diff                # NEW — fixture (≈ PR #8 verifier bug)
    ├── scalability-load-all.diff                 # NEW — fixture
    ├── security-eval.diff                        # NEW — fixture
    ├── committability-debugger.diff              # NEW — fixture
    └── leverage-stringify.diff                   # NEW — fixture

packages/cli/package.json                         # MODIFIED — add `smoke:bugfloor` script
                                                  #   chaining the 3 bug-floor smokes;
                                                  #   `smoke:m14` script chaining the 9
                                                  #   M14 smokes (6 worker + boss-loop +
                                                  #   empty-diff + verify-drop).
```

## File deletions / retirements (Q4 full replacement)

```
packages/core/src/runners/security.ts             DELETE — M13 Haiku sub-agent. Prompt
                                                     content already mostly lives in
                                                     packages/core/src/llm/prompts/
                                                     security-system.md which seeds the new
                                                     worker.

packages/core/src/runners/leverage-libraries.ts   DELETE — M12 Haiku sub-agent. Prompt
                                                     content lives in
                                                     packages/core/src/llm/prompts/
                                                     leverage-system.md.

packages/core/src/runners/committability.ts       MODIFY (likely DELETE) — M7 sub-agent
                                                     half deleted. Detector half (Tier-1
                                                     hard-skip) already graduated to M9
                                                     BASELINE_NOISE per CLAUDE.md M9 entry;
                                                     verify nothing-of-substance remains;
                                                     if nothing, delete file.

packages/core/src/orchestration/synthesizer.ts    RETIRE for review-mode (delete or stub).
                                                     check-mode goes through
                                                     review-harness/det-priors.ts directly.

packages/core/src/orchestration/dispatch.ts       RETIRE for review-mode. check-mode does
                                                     NOT need dispatch (det-priors.ts handles
                                                     parallelism via Promise.all internally
                                                     OR via the surviving Runner contract).
                                                     Delete if no consumer remains.

packages/core/src/orchestration/scratchpad.ts     RETIRE — ReviewScratchpad replaces it.

packages/core/src/orchestration/runner.ts         KEEP — Runner contract stays for future
                                                     runner additions in det-priors.ts (the
                                                     contract is the right shape for new
                                                     deterministic runners).

packages/core/src/llm/formatter.ts                RETIRE for review-mode — boss-loop.ts is
                                                     the new LLM entry. Helper functions
                                                     (prompt loading, etc.) may survive if
                                                     used elsewhere.

packages/core/src/llm/prompts/system.md           KEEP IF used by warden check; review-mode
                                                     M4 formatter prompt; M14 obsoletes the
                                                     review-mode call site. Delete if no
                                                     other consumer.

packages/core/src/llm/prompts/user-template.md    KEEP IF still referenced; same logic.

packages/core/src/llm/cache.ts                    KEEP — content-addressed LLM cache still
                                                     useful at boss + worker call sites.
                                                     May need cache-key updates to include
                                                     boss-round number + worker concern.
```

## Package boundaries (M14 additions)

| Package          | M14 additions                                                                                                                |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `@warden/cli`    | Render extensions for 3-phase + boss-loop UX; smoke harness; no new verbs/flags.                                              |
| `@warden/core`   | `packages/core/src/review-harness/` module; rewires `review()` + `check()`; deletes M7/M12/M13 sub-agent runners; retires parts of M8 spine. Bug floor commits modify `verify-citations.ts` + `leverage.ts`. |
| `@warden/ai`     | `getBossModel()` mapping changes to Opus 4.6; no new helpers.                                                                |
| `@warden/db`     | Possibly `db()` migration logic (Commit 2 — re-verify; likely no change).                                                    |
| `@warden/env`    | `WARDEN_REVIEW_BOSS_ROUNDS` + `WARDEN_REVIEW_WORKER_BUDGET`.                                                                |
| `@warden/config` | No changes.                                                                                                                  |

`@warden/core/src/review-harness/` may import `@warden/ai` (for models + tools) and is forbidden from importing `commander`, `picocolors`, `ora`, or anything reading `process.argv` / writing `process.stdout` (ADR-0013 invariant). Worker tools (`read-file.ts`, `grep-repo.ts`) read files via Node's `node:fs` directly — bounded I/O-impurity for the tool implementations; surrounding harness remains pure relative to the LLM context.

## What to build — phase by phase

### Phase 1 — Det Priors (`det-priors.ts`)

- `runDetPriors({ diff, repoRoot, changed, retrievedContext }): Promise<DetPriors>`.
- Internally runs in parallel via `Promise.all`:
  - TSC (existing runner).
  - ESLint user-config (existing).
  - ESLint security (existing M13 detector).
  - jscpd (existing).
  - vuln + OSV (existing M3 runner).
  - Scalability detector (existing M7).
  - Consistency detector (existing M10).
  - Deadcode detector (existing M7).
  - Leverage detector (existing M12).
  - M5/M6 selector for retrieved context.
- Output: `DetPriors = { findings: ToolFinding[], retrievedContext, degraded: DegradedEntry[] }`.
- Reused by `runCheck()` directly — returned shape converts to `CommentSet` via existing `toComment()` mapping.

### Phase 2 — Boss Loop (`boss-loop.ts`)

```typescript
export async function runBossLoop({
  scratchpad, diff, repoRoot, detPriors,
}: BossLoopInput): Promise<BossLoopOutput> {
  const result = await streamText({
    model: getBossModel(),                       // Opus 4.6
    system: loadBossSystemPrompt(),
    messages: buildBossMessages({ diff, detPriors }),
    tools: {
      dispatch_worker: makeDispatchWorkerTool({ scratchpad, repoRoot }),
    },
    stopWhen: stepCountIs(env.WARDEN_REVIEW_BOSS_ROUNDS ?? 5),
  });
  // Boss's final assistant message contains Output.array(CommentSchema).
  // Worker outputs sit in scratchpad.workerOutputs[]; boss reads via tool results.
  return parseFinalComments(result, scratchpad);
}
```

**Boss prompt instructs (`boss-system.md`):**
- Round 1 — read diff + det priors + retrieved context; dispatch initial workers via `dispatch_worker` (label `phase: 'plan'`).
- Rounds 2–4 — read tool results; decide if more workers warranted; if yes, dispatch more (label `phase: 'adjudicate'`); if not, proceed to synth.
- Final round — emit `Output.array(CommentSchema)` via the LLM's structured-output channel (label `phase: 'synth'`).
- Cost discipline — `WARDEN_REVIEW_WORKER_BUDGET` (when set) is communicated in the prompt; boss prioritizes within budget; lane discipline drops findings outside the requested `files`.
- Citation discipline — boss does NOT invent sources. Every Comment's `sources[]` is copied verbatim from worker output. The substring-verifier catches drift in Phase 3.

### `dispatch_worker` tool descriptor (`tools/dispatch-worker.ts`)

```typescript
import { z } from 'zod';

const ConcernEnum = z.enum([
  'correctness', 'scalability', 'consistency',
  'security', 'committability', 'leverage',
]);

export const dispatchWorkerInput = z.object({
  files: z.array(z.string()).min(1),               // repo-relative
  concern: ConcernEnum,
  tier: z.enum(['sonnet', 'haiku']).optional(),    // boss override
  focus: z.string().optional(),                    // one-line hint
  phase: z.enum(['plan', 'adjudicate', 'synth']),  // render UX hint
});

export const dispatchWorkerOutput = z.object({
  findings: z.array(WorkerFindingSchema),
  toolCalls: z.number().int().nonnegative(),
  degraded: z.array(DegradedEntrySchema),
});
```

**Default tier per concern** (boss can override per call):

| Concern         | Default tier | Reason |
|-----------------|--------------|--------|
| `correctness`   | Sonnet       | Subtle bugs (null-deref, off-by-one, async race) — vision §3 mandate |
| `scalability`   | Sonnet       | Perf/memory patterns need reasoning across call sites |
| `consistency`   | Sonnet       | Multi-file reading (docstring vs impl, README vs schema) |
| `security`      | Sonnet       | Vision §3 mandate; auth/injection too important to skimp on |
| `committability`| Haiku        | Pattern-matching against known anti-patterns; M7 baseline |
| `leverage`      | Haiku        | Pattern-matching against library idioms; M12 baseline |

### Per-worker shape (each `workers/<concern>.ts`)

```typescript
export async function run<Concern>Worker({
  files, focus, repoRoot,
}: WorkerInput): Promise<WorkerOutput> {
  const result = await streamText({
    model: tier === 'sonnet' ? getWorkerStrongModel() : getWorkerCheapModel(),
    system: loadWorkerSystemPrompt('<concern>'),
    messages: buildWorkerMessages({ files, focus, repoRoot }),
    tools: {
      lookupTypeDef: lookupTypeDefTool,             // M11 reuse
      readFile: makeReadFileTool({ repoRoot }),
      grepRepo: makeGrepRepoTool({ repoRoot }),
    },
    stopWhen: stepCountIs(8),                       // per-worker step budget
  });
  // Final message: Output.array(WorkerFindingSchema)
  return parseFindings(result, files);
}
```

Two-tier dynamism: boss loop × worker loop. Boss budget = 5; worker budget = 8 (per worker invocation).

### Phase 3 — Citation Verify (`verifyCitations()`)

Unchanged from M10 + Commit 1 generalization. Same call site M8 had:

```typescript
const verified = await verifyCitations({ comments: bossComments, repoRoot });
const final = applyHardRules(verified.comments, { harness: 'm14-review' });
```

The `harness` discriminator on `applyHardRules` was introduced in ADR-0029 for the M14-security carve-out (skips confidence floor). For M14-review, the discriminator is `'m14-review'` and the **confidence floor stays in place** — same posture as M8 path. Naming nit: ADR-0029 used `'m8-review'`; M14 renames to `'m14-review'` (or just drops the discriminator if no longer needed since M14-security defers).

### `warden check` continuity

```typescript
export async function check(input: CheckInput): Promise<CommentSet> {
  const detPriors = await runDetPriors(input);
  const toolComments = detPriors.findings.map(toComment);
  const comments = applyHardRules(toolComments, { harness: 'm14-check' });
  return { comments, durationMs, degradedWorkers: detPriors.degraded };
}
```

Same det-priors call as Phase 1 of `runReviewHarness()`; no Phase 2, no Phase 3. ADR-0011 invariant preserved.

## Acceptance criteria

1. `pnpm check-types` passes; `pnpm lint` passes on every commit.
2. After Commit 2 lands (or smoke-only): `rm -f .warden/cache.sqlite && pnpm warden init --dry-run` succeeds without "no such table" stderr.
3. `pnpm smoke:bugfloor` — 3 bug-floor smoke scripts pass.
4. `pnpm smoke:m14` — 9 smoke scripts pass (6 worker fixtures + boss-loop + empty-diff + verify-drop).
5. Dogfood: `pnpm warden review HEAD~1..HEAD` on the M14 PR catches ≥3 review-quality issues with ≤1 false positive (eyeball judgment).
6. Dogfood `warden check`: same diff returns deterministic findings; no LLM calls; no regression vs pre-M14.
7. Cost ceiling sanity: dogfood run cost (Opus 4.6 boss + Sonnet/Haiku workers) totals < $2.00; rendered cost line shows per-model breakdown.
8. Boss loop respects `WARDEN_REVIEW_BOSS_ROUNDS` cap (assert via smoke: setting it to `1` ends loop after one round; degraded entry surfaces if final synth missed).
9. Worker budget respects `WARDEN_REVIEW_WORKER_BUDGET` cap (assert via smoke: setting to `2` on a fixture that would otherwise spawn 5+ workers caps total dispatched at 2 + degraded entry).
10. M8 spine retirement verified — `packages/core/src/orchestration/synthesizer.ts` + `dispatch.ts` + `scratchpad.ts` either deleted or no longer imported from `review()` codepath; `check()` codepath audited for non-dependence on retired modules.
11. M7/M12/M13 sub-agent runner files (`security.ts`, `leverage-libraries.ts`, `committability.ts` LLM half) deleted; their tests/smokes updated or removed.
12. ADR-0030 status row flips from `Direction` to `Done`; ADR-0029 status flips to `Superseded` with one-line pointer to ADR-0030.
13. CLAUDE.md M14 line flips to `[x]`; M15+ deferred list reorganised; `WARDEN_REVIEW_BOSS_ROUNDS` + `WARDEN_REVIEW_WORKER_BUDGET` documented in env table; M14 status line names the harness.
14. CONTEXT.md updates landed (boss model entry, sub-agent retirement, worker-review-harness new entry, review-harness new §5 entry, dispatch_worker new entry, review pipeline rewritten to 3-phase, boss/worker orchestration status flipped).
15. Journal entry written under `~/journal/YYYY-MM-DDTHHMMSSZ.md`.

## What NOT to do

Listed for emphasis (see also "Stop at..." line near the top):

- ❌ `warden security` standalone verb (M15+; in `m15-plan.md`).
- ❌ `warden review --deep` flag (M15+).
- ❌ Promote/drop `getApexModel()` Opus 4.7 mapping (M15+ `--deep` re-grill).
- ❌ Cost-tracking SQLite table (`reviewRuns` / `harnessRuns` / `securityRuns`) — defer per Q12.
- ❌ Mid-stream context compaction for pathological large diffs (Ronit's two-tier pattern) — defer to a large-diff milestone; baseline harness doesn't depend on it.
- ❌ ESLint security `ignore: true` config-bleed fix (PR #15) — defer to post-M14 polish PR; consistency worker may catch.
- ❌ DB `getByFile()` / `count()` SQL-side filtering (PR #3) — defer to a perf-polish PR.
- ❌ Replay-on-past-PRs harness (Q11-III rejected) — defer to state-of-the-art verification suite.
- ❌ Migration of remaining 6 inline runners through M8's `Runner` contract — M8 retires for review; check goes through det-priors.
- ❌ Workers emitting additional `SourceType` variants — workers use existing `tool` / `api_def` shapes.
- ❌ Boss-side tool access beyond `dispatch_worker` (e.g., direct `readFile` for the boss) — boss reasons through workers, not via tools itself.
- ❌ `WARDEN_REVIEW_ADJUDICATE_ROUNDS` or finer-grained sub-knobs — single `BOSS_ROUNDS` cap is enough for v1.
- ❌ Multi-language worker prompts (Python-specific correctness, Go-specific scalability, etc.) — TS/JS only in v0 per ADR-0008.
- ❌ `bashExec` worker tool (ADR-0029 alternatives — hard no, transferred to this plan).
- ❌ Claude Agent SDK adoption (ADR-0029 alternatives — rejected, transferred to this plan).
- ❌ BYO boss-model flag (`--boss-model opus-4-7`) — deferred to ADR-0006 BYOLLM milestone.
- ❌ Per-call confidence threshold for M14-review — confidence floor stays in place via existing `applyHardRules()`; substring-verifier + floor + Tier-3 gate is the existing M8 posture, preserved.

## CONTEXT.md additions / updates (do in same PR)

- **§1 review pipeline** — rewrite from 4-phase M8 shape to 3-phase M14 shape: Det Priors → Boss Loop → Citation Verify. Note the boss-loop's `stepCountIs(5)` cap and the dispatch_worker tool.
- **§1 `warden security` / `warden review --deep`** — both stay `[deferred, M15+]`; `m15-plan.md` holds the deep-security plan.
- **§3 boss model** — was Sonnet → now Opus 4.6 (`claude-opus-4-6`) via `getBossModel()`. Note: was Sonnet through M1–M13; M14 upgrades for the harness boss seat. The "boss" role now spans planning, adjudication, and synthesis inside the 5-round loop.
- **§3 apex model** — stays Opus 4.7; M14-review does not use it; reserved for M15+ `--deep`.
- **§3 sub-agent** — retired as a v0–M13 era term. Add note: "Superseded by **worker (review-harness)** in M14. Historical sub-agents (committability, leverage-libraries, security) collapsed into harness workers under unified boss planning."
- **§3 worker strong** / **worker cheap** — update to mention M14-review as the live consumer site (replacing M14-security's deferred references).
- **§3 boss/worker orchestration** — flip status: "first vision-tier worker tier ships in **M14-review** via the **review harness**" (was M14-security). Update example to reference the dynamic boss-loop pattern.
- **§5 new entry `review-harness`** — describes the 3-phase + 5-round boss-loop + 6-worker shape.
- **§5 new entry `boss loop`** — Phase 2 of the harness; `streamText` tool-use loop; `stopWhen: stepCountIs(5)`; Opus 4.6.
- **§5 new entry `dispatch_worker tool`** — boss-side tool; routes `{ files, concern, tier?, focus?, phase }` to a per-concern worker; manages `WARDEN_REVIEW_WORKER_BUDGET`.
- **§5 new entries** per worker concern (or one umbrella entry for "worker (review-harness)" with per-concern bullets): correctness worker, scalability worker, consistency worker, security worker, committability worker, leverage worker.
- **§5 remove or mark superseded** — committability sub-agent (M7), leverage sub-agent (M12), security sub-agent (M13) entries flip to "Superseded by review-harness worker — see §5 review-harness."
- **§5 `Runner`** — note that the contract survives for Phase 1 det-priors additions, but the M8 spine (`dispatch` / `Scratchpad` / `synthesizer`) retires for review-mode.
- **§7 confidence threshold** — unchanged; M14-review keeps the floor via `applyHardRules()`. (M14-security carve-out from ADR-0029 §10 is moot for M14-review.)

## Design nuances (gotchas + judgment calls)

- **`ReviewScratchpad` vs M14-security's `SecurityScratchpad`:** intentionally different types. M14-security held `{ detPriors, plan, workerOutputs[], tokenUsage, costUsd, degraded[] }` with a structured Plan field. M14-review's `ReviewScratchpad` holds `{ detPriors, workerOutputs[], tokenUsage, degraded[] }` — no Plan field because the dynamic boss loop emits decisions per-round rather than upfront. Adapt M14-security's shape; don't reuse it directly.
- **Boss final-output shape:** the boss's last `streamText` round emits `Output.array(CommentSchema)`. Implementation question to resolve at impl-time: does the boss's final message contain *only* the comment array (no tool calls), or does it call a synthetic `emit_final` tool? Test both with AI SDK v6 docs; pick whichever the cascade + retry path handles cleanly.
- **Worker output shape:** workers emit `WorkerFinding[]` (worker-internal); the boss's final synth pass converts to `Comment[]` with citations attached. Workers don't emit `Comment` directly because boss may dedupe / reframe / drop before final emission.
- **Boss-side citation discipline:** the boss MUST copy sources verbatim from worker output. Spell this out in `boss-system.md` clearly; substring-verifier (Phase 3) catches drift but only after the boss has spent tokens. Save tokens by trusting the verifier as backstop, not the boss.
- **Cost estimation accuracy:** AI SDK v6 returns a `usage` object per `streamText` call. Sum across all boss rounds + all worker calls. Render in the final cost line per model. Static pricing table can live inline in `boss-loop.ts` for v0 (Opus 4.6 = $5 input / $25 output per 1M tokens — verify at ship-time; Sonnet 4.6 = $3 / $15; Haiku 4.5 = $1 / $5). Update via a one-line PR when prices change.
- **`readFile` truncation marker:** when a file exceeds 1000 lines, return the first 1000 lines + `\n[… truncated. File has N total lines; request a specific range with startLine/endLine.]`. Workers can re-request specific ranges.
- **`grepRepo` literal vs regex:** v0 ships literal-substring only (faster, simpler, avoids ReDoS). If dogfood shows workers wanting regex, M15+ adds a `regex: boolean` flag with bounded complexity.
- **Tool error handling:** wrap each tool's `execute()` body in try/catch; return `{ error: '...' }` instead of throwing. LLM receives error in tool result; cascade retry unaffected.
- **`WARDEN_REVIEW_BOSS_ROUNDS = 1` is valid** (clamped [1,10]). At 1, the boss plans + dispatches workers + must immediately emit final synth — all in one call. Smoke this. Useful for cost-conscious users.
- **`WARDEN_REVIEW_WORKER_BUDGET = 0` is invalid** — the env var is "positive integer," so `0` should fail wardenEnv() validation. Document.
- **Empty-diff path:** `if (changedFiles.length === 0) return { comments: [], degraded: [], durationMs: ... };` at top of `runReviewHarness()`. Zero LLM calls; zero cost. Don't even instantiate the scratchpad.
- **Two-tier dynamism budgeting:** boss has `stepCountIs(5)`; each worker has `stepCountIs(8)`. Max tool calls per review = 5 (boss rounds) × W (workers per round) × 8 (per-worker steps). With `WORKER_BUDGET = 10`, that's ≤80 worker tool calls + 5 boss calls. Cost-bound.
- **`dispatch_worker` reentrancy:** within a single boss round, the boss may dispatch multiple workers in parallel (AI SDK's tool-use loop supports multi-tool-call rounds). The dispatch function runs workers via `Promise.all`; lane discipline applies per-worker.
- **Render UX phase-log order:** Phase 1 lines appear before Phase 2 begins (det priors first). Phase 2 lines stream per boss round (no buffering — show in real time). Phase 3 line appears after final synth, summarizing drop count. Cost line is the last line of output.
- **Render UX phase labels:** trust the boss's `phase: 'plan'|'adjudicate'|'synth'` on each dispatch_worker call. If boss forgets the field, default to `'adjudicate'`. Don't block on missing labels.
- **Smoke-test API key requirements:** smoke tests that exercise the LLM path require valid `ANTHROPIC_API_KEY`. Document in smoke script headers; print clear "skipping — no key" message when missing rather than failing CI.
- **Bug-floor smokes may be smoke-only (no code change):** Commits 2 and 3 may turn out to be regression tests asserting existing behavior, if the underlying bugs were already fixed in post-PR commits. Re-verify at implementation. Commit 1 is load-bearing — its verifier generalization is real new logic.
- **Prompts-as-files (ADR-0015):** all new prompts live in `packages/core/src/review-harness/prompts/*.md` and load via existing `packages/core/src/llm/prompt-loader.ts` extended with `loadBossSystemPrompt()` + `loadWorkerSystemPrompt(concern)`. Do not embed prompts inline in TS.
- **Worker prompt seeding policy:** the 3 migrated prompts (security, committability, leverage) start from a verbatim copy of their M13/M7/M12 source; minor edits to adapt to the new tool-use envelope + remove M8-spine references. The 3 new prompts (correctness, scalability, consistency) are written fresh, with worked examples drawn from the corresponding Copilot finding clusters (evidence section above).
- **`applyHardRules()` discriminator hygiene:** ADR-0029 introduced `{ harness: 'm8-review' | 'm14-security' }`. M14-review uses `'m14-review'`. M14-security defers, so `'m14-security'` may be unused; document in ADR-0030 that the discriminator's `'m14-security'` value is reserved for M15+. Alternatively, simplify to no discriminator if confidence-floor carve-outs are gone post-M14.
- **Cache key updates (M11 `computeCacheKey`):** M11 keyed the LLM cache by `(diff, retrievedContext, ...)`. M14-review's boss-loop cache key must also include `boss-round` index and `worker-concern` (so the same diff at different boss rounds caches independently). Verify M11's key shape and extend if needed.
- **`warden check` doesn't run verifier:** check-mode emits det-prior findings only; their sources are tool-grounded (file:line from TSC/ESLint/etc.), not LLM-cited. No substring verification needed. Skip Phase 3 entirely.
- **Concern `'leverage'` worker is Haiku-tier by default but boss can promote to Sonnet** for tricky cases (e.g., library-specific suggestion that needs cross-file reading). The `tier?` override in `dispatch_worker` enables this.

## Branch / commit sequence

Current branch is `m14`; keep the name. The branch was created for M14-security; the work now lands here instead. The 11-commit history:

1. `feat(m14): bug floor — verify-citations generalize concat-then-match across source types`
2. `feat(m14): bug floor — db() auto-migrate regression test (and fix if needed)`
3. `feat(m14): bug floor — leverage detector single-line snippet regression test (and fix if needed)`
4. `docs(m14): redirect ADR-0029 → ADR-0030 review-harness; m14-plan.md → m15-plan.md preserved`
5. `feat(m14): scaffold review-harness module — harness.ts + ReviewScratchpad + det-priors.ts`
6. `feat(m14): boss-loop.ts + dispatch_worker tool descriptor + readFile/grepRepo tools`
7. `feat(m14): correctness + scalability + consistency worker prompts + smokes`
8. `feat(m14): security + committability + leverage workers (seeded from M13/M7/M12 prompts)`
9. `refactor(m14): retire M8 spine + M7/M12/M13 sub-agents; rewire review() and check()`
10. `feat(m14): WARDEN_REVIEW_BOSS_ROUNDS + WARDEN_REVIEW_WORKER_BUDGET env vars + render UX`
11. `docs(m14): CLAUDE.md + CONTEXT.md glossary updates + close-out`

## Close-out checklist

- [x] `pnpm check-types` + `pnpm lint` clean on every commit (one pre-existing voyage.ts `no-useless-catch` warning unrelated to M14).
- [x] `pnpm smoke:bugfloor` all green (verify-citations + db-automigrate + leverage-snippet).
- [x] `pnpm smoke:m14` all green (9 scripts: 6 per-worker + boss-loop + empty-diff + verify-drop).
- [~] Dogfood: `warden review --base main` on the M14 close-out delta — 0 final comments at $0.10–$0.17 / 15.3–56.5s across two runs. Pipeline ran end-to-end; cost line rendered; worker dispatch worked (Sonnet ~$0.06 on run #1). Does NOT meet the strict `≥3 real, ≤1 FP` acceptance — boss prompt calibration is conservative on empty-det-prior diffs. Documented in `project_warden_m14_boss_laziness.md`; iterative prompt edits regressed during dogfood; tuning deferred to a dedicated post-M14 milestone.
- [x] Dogfood `warden check` on the warden repo — 7 deterministic findings in 4.8s, zero LLM calls, no regression vs pre-M14.
- [x] Cost ceiling — dogfood total < $0.20 each run, well below the $2 ceiling; per-model breakdown rendered correctly.
- [x] `WARDEN_REVIEW_BOSS_ROUNDS=1` smoke — boss exits cleanly after one step (covered by `smoke-m14-boss-loop.mts` scenario 2).
- [x] `WARDEN_REVIEW_WORKER_BUDGET` smoke — budget cap honored (covered by `smoke-m14-boss-loop.mts` scenario 3, asserting dispatched count ≤ cap + budget-exhausted degraded entry when boss tries more).
- [x] ADR-0030 written; status `Direction` → `Done` with close-out summary including dogfood caveat + Gemini schema observation.
- [x] ADR-0029 status `Superseded` with one-line pointer to ADR-0030 (verified — already landed in the ADR-0030 commit).
- [x] CLAUDE.md M14 line → `[x]`; status paragraph rewritten to past tense with known-shipped limitations called out; env table updated to reflect live-since-close-out.
- [x] CONTEXT.md updates landed — review pipeline rewritten to canonical 3-phase shape; `[in-flight, M14]` markers flipped to live (or dropped) on review harness / boss loop / dispatch_worker / worker concern / readFile tool / grepRepo tool / ReviewScratchpad / det priors; M7/M12/M13 sub-agent entries marked retired with pointers to the M14 worker concerns; `dispatch` + `synthesizer` + `Runner` entries reflect M14 retirement.
- [x] `m15-plan.md` preserved (deep-security plan unchanged, ready for whichever future milestone picks it up).
- [x] Journal entry written.
- [ ] Journal entry under `~/journal/YYYY-MM-DDTHHMMSSZ.md`.
