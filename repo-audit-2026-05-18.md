# Whole-repo review — findings (2026-05-18)

**Verdict:** Warden cannot currently review its own repo as a single shot.
The boss-loop dispatched correctly, but the worker layer collapsed under
the Anthropic rate-limit ceiling with no recovery path. **Zero comments
returned for $3.46 / 95s spend, 89 degraded warnings.**

This run is not a finding-on-code exercise — it surfaced four concrete
pipeline bugs that the PR-scope dogfood path never exercises. Each is
addressable in a small follow-up PR. The actual codebase audit is gated
on landing fixes #1 and #2 below (or chunking the audit per workspace
package).

**Branch:** `main` @ `0b58ca7`
**Command:** `git diff 4b825dc6..HEAD | pnpm warden review --stdin --json`
**Diff scope:** 269 files, 60,842 insertions (whole repo as new-file diff)
**Raw outputs:** `full-repo-review.json` (21 KB), `full-repo-review.log` (1.2 MB)

---

## Numbers

| Metric | Value |
|---|---|
| comments | 0 |
| durationMs | 95,235 |
| costUsd | $3.4646 |
| Opus boss | 33,869 input · 14 output tokens · $0.17 |
| Sonnet workers | 879,408 input · 43,778 output tokens · $3.29 |
| degraded entries | 89 |
| worker-correctness failures | 67 |
| worker-security failures | 21 |
| jscpd failures | 1 |
| rate-limit 429s in log | 636 |
| connect-timeout errors in log | 42 |

**Cost interpretation:** the 879K Sonnet input tokens were billed in
full — Anthropic charges for rate-limited prompt evaluation. We paid
$3.29 to learn the workers can't fall back. The 14-token Opus output is
the boss synthesizing an empty result after every worker dispatch
returned `{ok:false}`.

---

## Root causes, ranked

### 1. Worker fallback gap is catastrophic at whole-repo scope (P0)

**Symptom:** 88/89 degraded entries are
`anthropic sonnet failed (...); Gemini fallback skipped (tools required)`.

**Mechanism:** Whole-repo PD-multi dispatch fans out 30+ Sonnet workers
in parallel (each with full per-file context). Within seconds we
saturate the org's 2M input-tokens/minute Sonnet quota:

```
APICallError: This request would exceed your organization's rate limit
of 2,000,000 input tokens per minute (org: c91fc71f...,
model: claude-sonnet-4-6).
```

Every 429 escalates through ai-retry, then the cascade tries Gemini —
which is the path M16 dogfood finding #7 already documented as broken:
Gemini's structured-output endpoint rejects `tools[]` +
`responseMimeType: 'application/json'` simultaneously, and our workers
use both. So the fallback short-circuits with "Gemini fallback skipped
(tools required)" (`run-worker.ts:167-187`) and the worker returns
`{ok:false}` — zero output, full Anthropic cost.

**Where:** `packages/core/src/review-harness/workers/run-worker.ts`
(specifically `tryProvider()` ~389-431 and the fallback gate at 167-187).

**Fix shape (this should be its own ADR — likely ADR-0033):** pick one
of the three options from `m16-dogfood-handoff.md:73-77`:

- **(a) Skip Gemini fallback entirely for tool-using workers.** Already
  the current behavior. Documented now via this audit.
- **(b) Tool-stripped Gemini retry.** When the primary 429s/timeouts,
  retry once *without* `tools[]` (worker reasons from snippets only).
  Lower fidelity (no `lookupTypeDef`) but functional; mark findings
  `degraded: info` so reviewers know they ran tool-less.
- **(c) Restructure Gemini call to use function-declarations without
  `responseMimeType: 'application/json'`.** Highest fidelity, most
  invasive. Touches `@warden/ai`'s provider plumbing.

**Independent of fallback strategy**, two M14/M15 calibration knobs
should land alongside the ADR:

- **Worker-dispatch concurrency cap** (env: `WARDEN_WORKER_CONCURRENCY`,
  default e.g. 4). PD-multi Round 0 currently does parallel `Promise.all`
  with no throttle. A semaphore at the dispatch boundary in
  `boss-loop.ts:runRound0Dispatch()` solves this at the source.
- **Soft-budget bail-out per worker.** If a worker burns its retry
  budget on 429s for >20s, drop it with one degraded entry rather than
  swallowing 5+ retry attempts billed-but-failed.

### 2. `chunks.file_path` fallback surfaces M14-deleted files (P1)

**Symptom:** One degraded entry:

```
jscpd: detector failed (ENOENT: no such file or directory, lstat
'/Users/yash/Developer/self/warden/packages/core/src/llm/formatter.ts')
```

**Mechanism:** M14 retired `llm/formatter.ts`, `cache.ts`, `cascade.ts`,
`schema.ts`, `prompt-loader.ts`. M16's `file_chunks` junction was
correctly pruned (`SELECT * FROM file_chunks WHERE file_path LIKE
'%formatter.ts%'` returns 0). But the *underlying* `chunks` table
retains 12 rows pointing at those deleted files — they're "vestigial,
kept only for the auto-backfill source-of-truth window" per M16's
design.

The hole is in `packages/core/src/context/signals/semantic.ts:141-144`:

```typescript
const filePaths =
  attributedFiles && attributedFiles.length > 0
    ? attributedFiles
    : [record.filePath];  // <-- falls back to the stale chunks.file_path
```

When `file_chunks.getFilesForHashes()` returns nothing for a hash (which
can happen if a chunk was written pre-M16 backfill or via some path
that bypassed `reconcileFiles`), the code falls back to
`chunks.file_path` — which still points at the deleted file. The
selector then includes the deleted path as a candidate; jscpd is scoped
to `changed ∪ candidates`; jscpd tries to lstat the file; ENOENT.

**Fix shape (small, additive):** in `reconcileFiles()` or as a follow-up
maintenance pass, prune `chunks` rows whose `chunk_hash` no longer
appears in `file_chunks`. This is exactly the orphan-cleanup pattern
already shipped for embeddings, applied one table earlier. Plus a
defensive filter in `semantic.ts`: after picking `filePaths`, drop any
that don't exist on disk before returning the hit. (One filesystem stat
per hit is cheap and survives any future chunk/file_chunks drift.)

**Note:** this only fires on the whole-repo path because the semantic
signal returned a much wider hit set than typical PR runs — that's why
PR-scope dogfood never tripped it.

### 3. `--base` with a non-commit ref silently returns empty diff (P1)

**Symptom:** First run with `--base 4b825dc6...` (git's empty-tree SHA)
returned `0 comments / $0.0003 / 7.2s`. No degraded entry, no error —
just an empty diff fed through the pipeline.

**Mechanism:** `packages/core/src/diff/source.ts:34` uses three-dot
symmetric difference:

```typescript
const diff = await runGitDiff(opts.repoRoot, [`${opts.baseRef}...HEAD`]);
```

git rejects `<tree>...<commit>` (only `<commit>...<commit>` is valid):

```
error: object 4b825dc642cb6eb9a060e54bf8d69288fbee4904 is a tree, not a commit
fatal: Invalid symmetric difference expression
```

`runGitDiff` at line 81 silently returns `""` on git failure:

```typescript
if (!result.ok) return "";
```

No degraded entry surfaces the failure. The review proceeds against an
empty diff and returns "all clear."

**Fix shape:** in `runGitDiff` / `resolveDiff`, when git exits non-zero,
return a `ResolvedDiff` with an empty diff *plus* surface the stderr as
a `degraded: { kind: "actionable", topic: "diff-source" }` entry. The
CLI / harness already collects degraded entries from every layer; this
is one more emitter. Bonus: switch to two-dot diff (`A..HEAD`) when
`baseRef` is provided — three-dot is appropriate for branch comparison,
not for "I gave you an explicit base."

### 4. Cost-discipline: $3.29 billed for failed structured-output (P2)

**Symptom:** Sonnet input tokens 879,408 (billed) vs output tokens
43,778 (mostly rejected by schema validation). Output:zero useful
findings. Effective $/finding: undefined.

**Mechanism:** When `streamText({ output: Output.object({ schema }) })`
returns malformed JSON, the AI SDK throws `AI_NoObjectGeneratedError`
*after* the tokens have been consumed and billed. There's no
pre-emptive guard.

**Fix shape:** this is downstream of #1 — the failures here are rate-
limit-driven, not schema-quality-driven. Land #1 first, then re-measure.
If schema-failure persists at lower concurrency, only then chase the
schema. Don't prematurely strict-mode the schema (would regress the
existing PR-scope quality).

---

## What the codebase findings would have been

We don't know yet — the audit didn't get to produce them. Path forward:

**Option A (recommended): land #1 + #2 + #3, then re-run the whole-repo
audit.** Once workers can survive rate-limits (b/c either Gemini
fallback works or concurrency is throttled), the same command should
return a real comment set. Budget headroom: $5–$15 estimated, ~15–30
minutes.

**Option B: scope-down audits per workspace package.** Run six smaller
audits (`packages/ai/**`, `packages/core/**`, `packages/cli/**`,
`packages/db/**`, `packages/env/**`, `apps/web/**`) each as a separate
"diff vs empty tree, filtered to that package." Each fits comfortably
under the rate limit. Multiplies the per-run cost across runs but
buys signal even before #1 lands.

**Option C: accept PR-scope is the audit unit.** Land #2 + #3 anyway,
defer #1 to ADR-0033, and let dogfood accumulate as branches merge.

---

## What this taught us about the M15+ "diff chunking" question

The original concern (from earlier in the session): `semantic.ts:63`
embeds the whole unified diff as one query vector; large multi-file
diffs blur unrelated changes.

**Updated read:** the semantic blur is real but downstream of the
worker-fallback collapse. At whole-repo scope:

- Semantic returned hits across hundreds of chunks (good — it didn't
  fail closed).
- Selector still produced per-file candidates because the M5 cheap
  signals (importers, imports, same-folder, symbol-ref) ran fine.
- Boss-loop dispatch routed per-file correctly.
- *The* failure was the worker layer 429'ing.

So the M15+ "Retrieval refinements / multi-vector queries" defer in
`docs/milestones.md:32` is still the right call. **Worker fallback +
concurrency control (#1 above) is the higher-priority M16+ follow-up.**
The diff-chunking work is downstream of that.

---

## Proposed follow-up PR shape

One PR addressing #2 + #3 (small, safe, no design needed):

- `chunks` orphan-prune in `reconcileFiles()` + defensive `existsSync`
  filter in `semantic.ts:141-144` (~30 LoC).
- Two-dot diff for explicit `--base` + degraded-entry surfacing of git
  errors in `source.ts:34/81` (~15 LoC).
- Smoke `smoke-followup-whole-repo-fallback.mts` exercises both:
  whole-repo diff against an empty tree resolves correctly + a chunk
  whose underlying file was deleted post-index doesn't crash jscpd.
- No schema impact, no ADR.

#1 stays gated on ADR-0033 (worker fallback strategy). Suggest writing
that next, with a parallel PR for the dispatch concurrency cap that
doesn't need the ADR but unblocks bigger reviews immediately.

---

## Open questions for the next session

- **Concurrency cap default?** If we ship `WARDEN_WORKER_CONCURRENCY`,
  what's the sane default? `4` is conservative; `8` matches the typical
  per-PR fanout. Decision drives whether whole-repo is feasible without
  ADR-0033 landing first.
- **Should `chunks.file_path` be dropped entirely** rather than band-
  aided? M16 notes "future cleanup ADR may drop them." If we're already
  touching the reconcile path, this might be a one-line change.
- **Is the audit cost worth $5–$15 in a v0 personal repo?** PR-scope is
  already exercising the pipeline. Argument for one-shot audit is
  "shake out failures we'd never see otherwise" — which this run just
  did successfully without producing comments. Diminishing returns may
  apply.
