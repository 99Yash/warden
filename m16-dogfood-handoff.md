# M16 dogfood — handoff document

**Status:** fixes #1/#3/#5 + Float32Array(0) landed on the working tree (uncommitted, ~117 LoC across 6 files).
Open: Gemini tools+JSON-mode incompat (new finding from the verification dogfood); boss laziness on real diffs (#2, gated on M15+ eval-suite v1); M16 milestone close-out paperwork.

**Branch:** `m16` (off `main` at `dfc2847`)
**Last commit:** `01a5fcf` (`feat(m16): init/review alignment — file_chunks junction + reconcileFiles + implicit review-time refresh`)
**Working tree (uncommitted):** see "What landed" below
**Last verified dogfood:** 2026-05-17 02:48 UTC — `$0.69, 2m36s, 1 substantive finding` (the Float32Array(0) bug, since fixed)

---

## Journal trail

Read these in order for full context:

- `~/journal/2026-05-17T074800Z.md` — M16 implementation landing
- `~/journal/2026-05-17T023507Z.md` — first dogfood (pre-fix); produced v1 of this doc
- `~/journal/2026-05-17T024703Z.md` — fixes #1/#3/#5 implementation
- `~/journal/2026-05-17T025416Z.md` — dogfood verification of #1/#3/#5 (cost $0.69)
- `~/journal/2026-05-17T025617Z.md` — Float32Array(0) silent-corruption fix

**Related memory:** `project_warden_m14_boss_laziness.md` (boss-laziness context).

---

## TL;DR — current state

| # | Item | State | Notes |
|---|------|-------|-------|
| 1 | Gemini schema adapter for workers | ✅ Landed | `run-worker.ts` wraps `WorkerOutputSchema` via `transformSchemaForGemini`. Eliminates the `TierEnum` numeric-literal 400. Smoke covers schema round-trip. |
| 2 | Boss laziness on real diffs | 🔄 Open | Gated on M15+ eval-suite v1 (modified-file + multi-file diff materialization). Verification dogfood actually produced 1 substantive finding, suggesting laziness is diff-shape-dependent. |
| 3 | `repo_merkle_root` after reconcile | ✅ Landed | Root recompute + persist after touched-leaf commits. Verified: `cc9b2a06... → 96d99ee7...` post-dogfood. |
| 4 | Worker fallback degraded entries | ✅ Verified | Already shipped at `run-worker.ts:167-187`. Status quo (`warning` level) per design call. No code change. |
| 5 | M16 refresh success log | ✅ Landed | `formatRefreshSummary()` emits one `info`-level entry per successful reconcile. Filtered from default CLI output; visible via `--verbose` or `--json`. |
| 6 | `Float32Array(0)` silent corruption | ✅ Landed | Boss-surfaced during dogfood verification. Explicit `throw` replaces silent zero-length BLOB. Existing catch handles disposition. |
| 7 | Gemini tools+JSON-mode incompat | 🆕 Open | **New finding.** Gemini rejects `tools[]` + `responseMimeType: 'application/json'`. Worker fallback to Gemini still 400s after fix #1 — different error, same surface (stderr noise). Needs design call. |
| 8 | M16 close-out paperwork | 🔄 Pending | Flip CLAUDE.md M16 line `[ ]` → `[x]`; flip ADR-0032 Status to Done. Awaiting fix bundle commit. |

---

## What landed (uncommitted on `m16`)

```
packages/core/src/indexing/index.ts          # +1 export
packages/core/src/indexing/merkle-root.ts    # NEW — shared computeRepoMerkleRoot helper
packages/core/src/init/index.ts              # -8 LoC (dropped local copy of helper)
packages/core/src/init/reconcile.ts          # +25 LoC (root recompute + Float32Array throw)
packages/core/src/review-harness/det-priors.ts        # +25 LoC (formatRefreshSummary + emit site)
packages/core/src/review-harness/workers/run-worker.ts # +12 LoC (Gemini adapter wire-up)
```

**Verification:** `pnpm check-types` clean; all four `pnpm smoke:m16` smokes pass; `pnpm smoke:m15-gemini-adapter` passes; one live `pnpm warden review` dogfood ($0.69) confirmed fix #3 via DB probe and fix #1 via stderr diff (old 400 message gone, new one revealed — see #7 below).

---

## New finding (#7) — Gemini tools+JSON-mode incompat

**Surface:** `pnpm warden review` stderr still contains 3 `APICallError` dumps when workers fall back to Gemini. Different error than the v1-handoff finding #1:

```
APICallError [AI_APICallError]: Function calling with a response mime type:
'application/json' is unsupported
  statusCode: 400
  status: 'INVALID_ARGUMENT'
```

**Mechanism:** Gemini's API rejects requests that combine `tools[]` with `responseMimeType: 'application/json'`. Workers ride `streamText({ tools, output: Output.object({ schema }) })` — `Output.object` sets `responseMimeType: 'application/json'`; the worker's `lookupTypeDef` + `readFile` + `grepRepo` set `tools[]`. The two are mutually exclusive in Gemini's structured-output endpoint.

**Where:** `packages/core/src/review-harness/workers/run-worker.ts:tryProvider()` (lines 389-431). Same shape exists for the boss (`boss-loop.ts:streamText` with `dispatch_worker` tool + `Output.object`), but boss has never been observed actually falling back to Gemini in dogfood, so it's latent there.

**Design options** (needs user call before fix lands):

- **(a) Skip Gemini fallback for tool-using workers.** Detect tools present and return `{ok:false}` directly with a clean `degraded: warning` entry. Loses the fallback safety net entirely.
- **(b) Tool-stripped Gemini retry.** When the primary fails and Gemini is selected, retry once *without* `tools[]` (worker reasons from snippets only). Lower fidelity (no `lookupTypeDef` for API claims) but functional. Mark findings with a `degraded: info` flag so reviewers know the worker ran tool-less.
- **(c) Restructure Gemini call to function-declarations without `responseMimeType`.** Gemini supports tool-calling in non-JSON-mode; would need to post-parse the model's free-form output via the schema. Highest fidelity but most invasive — touches `@warden/ai`'s provider plumbing.

**Out of scope** for the current fix bundle. Should get its own ADR (likely the same one that addresses worker fallback strategy more broadly). Until then, the 3 stderr dumps are cosmetic — `callWorker` still returns `{ok:false}` and the worker surfaces a `warning` degraded entry; the review continues against the remaining workers and the boss handles the gap.

---

## What's NOT a problem (carry-forward from v1)

- **M16 reconcile path itself** — fully verified end-to-end via SQLite probe both runs. Chunks/embeddings/file_chunks all maintain the invariant. Don't re-investigate.
- **`warden init` partial-state on session start** — pre-M16 state is migrated by the one-shot backfill. Working as designed.
- **First review run on empty diff (5.1s, no findings)** — HEAD == base; intentional. Subtle UX argument for a clearer message exists but is low priority.
- **One extra `file_chunks` row vs `chunks`** — chunk-shared-across-files semantic (M16's whole point).
- **Verification-dogfood cost spike to $0.69 / 2m36s** vs the v1 handoff's $0.42 / 48s — different non-determinism in PD-multi routing (more files stale on this run because of the in-progress fix edits), longer Opus boss reasoning on a real finding. Not a regression — likely better signal.

---

## Next steps — agenda for the next session

**A. Commit + M16 milestone close-out** (small, no design needed)
   1. Commit the uncommitted fix bundle on `m16` (one commit or split #1/#3/#5/#6 by topic — judgment call). Suggested message style: `fix(m16): post-dogfood follow-ups — Gemini adapter (workers), merkle root snapshot, refresh log, embedding-vector guard`.
   2. Flip `CLAUDE.md`'s M16 milestone line `[ ]` → `[x]` and update the body with "shipped 2026-05-17 with post-dogfood fixes".
   3. Flip `decisions.md`'s ADR-0032 Status: → Done. Update `CONTEXT.md` if needed.
   4. Re-run `pnpm smoke:m16` (4 smokes) + `pnpm smoke:m15-gemini-adapter` to confirm no regression on the committed state.

**B. Decide on the Gemini tools+JSON fix shape (#7)** — needs design call
   - Pick from options (a)/(b)/(c) above.
   - Write an ADR (probably ADR-0033) covering both the chosen fix AND the broader worker-fallback strategy question (when *should* workers fall back? per-tier policies?).
   - Smoke: `smoke-m17-worker-gemini-fallback.mts` exercises forced-Gemini path; assert stderr is clean.

**C. Build eval-suite v1 (M15+ item (i))** — needed before re-investigating #2
   - Extend `packages/cli/scripts/eval/`'s fixture materializer to handle modified-file diffs (read pre-state from main, apply hunks, write to `.eval-tmp-repo/`).
   - Extend it to multi-file diffs.
   - Add `m16-pr` as a real-PR fixture (commit `01a5fcf` + the now-committed post-dogfood fixes). Currently failing 0/3 on m14-closeout for material-availability reasons; m16-pr should be evaluable once modified-file materialization works.
   - Re-run `pnpm eval --compare baseline programmatic-dispatch-multi` to confirm PD-multi still wins on the expanded suite.

**D. Re-investigate boss laziness (#2) under controlled conditions**
   - Only after C is in place.
   - The 2026-05-17 02:48 dogfood produced 1 substantive finding ($0.69, 2m36s), suggesting laziness is diff-shape-dependent rather than systemic. Eval suite needs to reproduce the original 0-finding symptom before any prompt tuning is justified — otherwise we're guessing.

**E. Out-of-band — M17 prep** (deferred from the M16 plan rename; see `m17-plan.md`)
   - No active work. Stays gated on dogfood evidence from M14/M15/M16 across more diff shapes.

---

## How to resume in a fresh context window

1. Read this file end-to-end (you're here).
2. Skim the 5 journal entries in order — the trail captures every decision + verification step from M16 landing through the Float32Array fix.
3. `git status` — should show 6 modified files + 1 new file (`packages/core/src/indexing/merkle-root.ts`) + 1 untracked (this doc). If working tree is clean, the fix bundle has already been committed; check `git log --oneline -10` for the post-`01a5fcf` commit.
4. `pnpm check-types` to confirm baseline; `pnpm smoke:m16` + `pnpm smoke:m15-gemini-adapter` to confirm no regression.
5. If picking up step A: commit + milestone flip. Reference the journal entries in the commit message body or PR description.
6. If picking up step B: open `packages/core/src/review-harness/workers/run-worker.ts:tryProvider()` and `boss-loop.ts:streamText` call site — same shape, same latent issue. Pull the user into a design call on options (a)/(b)/(c).
7. If picking up step C: open `packages/cli/scripts/eval/` and trace the fixture materializer; the new-file path is shipped, modified-file is the gap.

**Hard rule:** do not re-dogfood (`pnpm warden review`) just to verify behavior — it costs ~$0.42-$0.69 per pass. Use smokes + DB probes for verification unless the user explicitly approves the spend.
