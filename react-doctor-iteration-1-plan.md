# Warden — react-doctor Iteration-1 Plan (`react-doctor-cli` detector det-prior)

This is the implementation brief for the agent (or future-me) building the `react-doctor-cli` producer. Self-contained: read this plus `decisions.md` ADR-0046 (and its parents ADR-0045 / ADR-0044) and you have everything.

Iteration-1 wires **one new deterministic detector** — a det-prior that subprocesses the **published `react-doctor` CLI** (`react-doctor@<PIN>`, via npx-on-demand) with `--json`, parses its `JsonReport` into `ToolFinding[]` carrying the new `source: "react-doctor"`, and folds them into `det-priors.ts`'s aggregate. One call yields react-doctor's visitor rules + the 42-rule `scan()` SAST suite + the base-vs-head finding **delta** (`--scope changed`). It ships **default-off** behind `WARDEN_REACT_DOCTOR`, eval-gated before the default flips. It is **sourced** findings only — zero LLM, no questions, single-repo — so it has **no dependency on ADR-0044's unbuilt machinery** and ships in parallel with Iteration-0 (the reasoned-assertions A/B).

This plan was produced by a `/grill-with-docs` pass over ADR-0046's implementation seam (2026-06-16). It **refines ADR-0046** in three places, noted inline: **(R1)** corrects the §1 "single call yields … + dead-code" overstatement (dead-code needs `--scope full`; warden drops it); **(R2)** splits Decision 4's uniform `npx --yes` into per-verb (`--yes` in review, `--no-install` in check); **(R3)** sequences the 3-rule ESLint trim to ride the **default-on flip**, not Iteration-1.

## Read first (in this order)

1. **`./decisions.md`** — **ADR-0046** (this commit's design); ADR-0045 (the reuse thesis: react-doctor is the rule factory, warden the consumer — §4/§5 reasoned + overlay lanes are *not* Iteration-1); ADR-0044 (the `reasoned`/`sourced` split — this producer is purely `sourced`, depends on none of it); ADR-0028 (the ESLint-security detector precedent + the in-process-vs-subprocess framing this generalizes); ADR-0027 (the `leverage` detector — `ToolFinding.evidence` precedent); ADR-0031 (`review-eval` — the gate before default-on); ADR-0038 (`review intensity profile` — the deferred home of `--scope full`); ADR-0003 (no-binary-matrix — stays intact, npx keeps oxc out of warden's tree).
2. **`./CONTEXT.md`** — §1 (`warden check` / `warden review`); §2 (`finding`/`Comment`/`tier`/`category`/`sources[]`/`evidence`); §5 (`react-doctor CLI runner` entry — the canonical spec; `detector` rule; `eslint-security` for the precedent + the trim); §6 (`provider readiness` — the offline-cold-start nuance); the memory `project_warden_rd_producer_scope.md` (what's deferred out and why).
3. **`~/Developer/oss/react-doctor`** — the CLI surface this consumes: `packages/react-doctor/src/cli/index.ts` (flags), `packages/core/src/schemas.ts` (`JsonReport` / `Diagnostic` shape — warden mirrors this), `packages/oxlint-plugin-react-doctor/src/plugin/rule-registry.ts` (the 5 categories), `packages/core/src/compute-diagnostic-delta.ts` (`--scope changed` semantics).
4. **`./packages/core/src/runners/_shared.ts`** — `spawnCapture` (the subprocess precedent; **needs a timeout** added — see Work item 7).
5. **`./packages/core/src/runners/tsc.ts`** — the `spawnCapture` + parse-stdout + ignore-exit-code precedent to mirror.
6. **`./packages/core/src/runners/types.ts`** — `ToolFinding`; add `"react-doctor"` to the `source` union.
7. **`./packages/core/src/runners/to-comment.ts`** — `mapSeverity()`; add the react-doctor category→`{category, tier}` branch.
8. **`./packages/core/src/review-harness/boss-loop.ts`** — `routeFindingToConcern()` (line ~243); add the `"react-doctor"` branch.
9. **`./packages/core/src/review-harness/det-priors.ts`** — the `Promise.all` block (lines ~297–420); add the gated producer call; thread `baseRef`.
10. **`./packages/core/src/index.ts`** — `ReviewInput` (line ~184); add the `{ baseRef, description }` struct.
11. **`./packages/core/src/diff/source.ts`** — `resolveDiff()` already computes the base ref; the CLI passes it down (see Work item 1).
12. **`./packages/cli/src/index.ts`** — `resolveDiff(...)` call site (~line 152); thread the resolved base into `review()`.
13. **`./packages/core/src/runners/eslint-security.ts`** — `rulesBlock()` (lines ~261–272); the 3-rule trim, **deferred to the default-on flip (R3)**.

## Goal of this iteration

Land the `react-doctor-cli` producer as a deterministic det-prior, default-off, eval-ready. No `CategoryEnum`, `PRIORITY_ORDER`, `SourceType`, or SQLite-schema change. No LLM. No worker, no question, no cross-repo.

## Decision ledger (from the grill)

| # | Decision |
| --- | --- |
| 1 | Thread a **`{ baseRef, description }`** struct `resolveDiff → CLI → ReviewInput → DetPriorsInput → producer`; this is what enables true `--scope changed`. |
| 2 | **Subprocess the published CLI; vendor nothing.** Hand-write only the `JsonReport` zod schema (the upstream one is unpublished). |
| 3 | `review` → `--scope changed`; `check` → `--scope lines`. **Drop react-doctor dead-code** — warden's own `deadcode` detector covers reachability; `--scope full` (the only scope with whole-project checks) is deferred → ADR-0038 `xhigh`. **(R1)** |
| 4 | Producer is a **deterministic det-prior**: no LLM, no questions, single-repo. Deferred out: `--deep` (M18 security), cross-repo (sibling-repo scanning), incremental clarification questions (reasoned lane), user rules file (ADR-0036 / ADR-0045 §5). |
| 5 | **Category map** (route off react-doctor's coarse `category`): Security→`security`, Bugs→`correctness`, Performance→`scalability`, Maintainability + **Accessibility → `clarity`** (no schema ripple). clarity findings post as sourced det-priors, **no worker dispatch**. |
| 6 | **Tiers** (category-fixed, not severity-driven): Security **1**, Bugs/Performance **2**, clarity **3**. All Security → tier 1 (matches ADR-0028 §7), **eval-gated per family** as the precision control. react-doctor's `error`/`warning` is kept for debug, ignored for tiering. |
| 7 | **`evidence` snippet = read the flagged source line** (the `leverage` precedent), whitespace-collapsed, so the substring-verifier always matches. Unreadable line / empty → **evidence undefined, finding still posts** (the `tsc`/`eslint` shape). |
| 8 | Invocation flags: `--json --json-compact --no-telemetry`, temp `--changed-files-from <file>` (warden's post-prune `changedPaths`), `REACT_DOCTOR_CLI_VERSION` module const (not an env knob). Availability via **JSON-parse success, not exit code** (react-doctor exits 1 on findings). Unavailable → one actionable `degradedWorkers` entry; **never hard-fail `check`**. 60s timeout. |
| 9 | **`review` → `npx --yes`** (fetch-on-demand); **`check` → `npx --no-install`** (cache-only, fail-fast, degrade if absent) — keeps the fast floor fast and offline-friendly, matches the `tsc --no-install` precedent. **(R2)** |
| 10 | Ship behind **`WARDEN_REACT_DOCTOR`** (default **off**); gates the producer call in `det-priors.ts`. No per-family allow/deny knob yet (add only if eval surfaces a noisy family). |
| 11 | **The 3-rule ESLint-security trim (`detect-child-process`, `detect-non-literal-fs-filename`, `no-secrets/no-secrets`) rides the default-on flip, NOT Iteration-1** — trimming while react-doctor is default-off would strip 3 security families from the default config. In the eval window (react-doctor manually on) those families double-report; tolerable. **(R3)** |

## Work items

### 1. Thread the base ref through the boundary
- `packages/core/src/diff/source.ts`: `ResolvedDiff` already returns `{ diff, description }`. Add the resolved **base ref** to that return (the value behind `${base}...HEAD` / `--base` / the `HEAD~1` fallback), so the CLI can forward it.
- `packages/core/src/index.ts`: extend `ReviewInput` with an optional **`diffBase?: { baseRef?: string; description: string }`**. This is a public-surface change (the `apps/github-bot/` wrapper contract) — document it on the interface.
- `packages/cli/src/index.ts`: pass `resolveDiff(...)`'s base + description into `review({ …, diffBase })`.
- `packages/core/src/review-harness/det-priors.ts`: add `diffBase?` to `DetPriorsInput`; `runReview()` / `runCheck()` propagate it from `ReviewInput`.
- `check` default (uncommitted-vs-HEAD) leaves `baseRef` undefined → producer omits `--base` and lets react-doctor detect working-tree changes. `review` carries the resolved branch → `--base <ref>`.

### 2. `runners/types.ts` — extend the source union
- Add `"react-doctor"` to `ToolFinding.source`. No other field change (reuse the optional `evidence` triple).

### 3. `runners/react-doctor.ts` — the producer (new file)
- Export `runReactDoctor(input: { repoRoot: string; changedPaths: string[]; mode: "check" | "review"; baseRef?: string }): Promise<{ findings: ToolFinding[]; degraded: DegradedEntry[] }>`.
- Early-return `{ findings: [], degraded: [] }` when `changedPaths` is empty.
- Write `changedPaths` (newline-delimited) to an `os.tmpdir()` temp file; clean it up in `finally`.
- Build argv: `["--yes" | "--no-install", "--package", \`react-doctor@${REACT_DOCTOR_CLI_VERSION}\`, "--", "react-doctor", "--json", "--json-compact", "--no-telemetry", "--scope", mode === "review" ? "changed" : "lines", ...(baseRef ? ["--base", baseRef] : []), "--changed-files-from", tmpFile]`.
- `spawnCapture("npx", argv, { cwd: repoRoot })` with a **60s timeout** (Work item 7).
- Parse `stdout` with the local `JsonReport` zod schema (Work item 4). **Ignore exit code** (1 = findings). If parse fails or `report.ok === false` → return one actionable `degradedWorkers` entry (`topic: "react-doctor"`): `"react-doctor unavailable — security families skipped; cached after first online run"`. Never throw.
- Map each `Diagnostic` → `ToolFinding`: `source: "react-doctor"`, `file` (repoRoot-relative), `line`/`column`/`endLine`/`endColumn`, `severity` (error/warning pass-through), `ruleId: diagnostic.rule`, `message`, and a category tag carried for `mapSeverity` (see item 5). **Drop `category === "Accessibility"`? No — map to `clarity` per Decision 5.** **Drop dead-code findings** (react-doctor won't emit them at these scopes anyway — defensive filter if any whole-project rule leaks).
- `evidence`: read the flagged file once per `filePath`, slice the line at `line`, whitespace-collapse → `{ path, line, snippet }`. On read failure / empty line, leave `evidence` undefined (Decision 7).
- `REACT_DOCTOR_CLI_VERSION` module const at top of file, pinned to `0.5.6` (verify latest at build time).

### 4. Local `JsonReport` zod schema
- Minimal + lenient: parse `{ ok: boolean, error: nullable, schemaVersion: 1 | 2, diagnostics: Diagnostic[] }`; ignore unknown top-level fields (`projects`, `summary`, `elapsedMilliseconds`, `baseline`, …). `Diagnostic` parses `{ filePath, rule, severity: "error"|"warning", category: string, message, line, column, endLine?, endColumn? }`, lenient on the rest. Lives in `runners/react-doctor.ts` (or a sibling `react-doctor-schema.ts`). Pinned to `REACT_DOCTOR_CLI_VERSION`.

### 5. `runners/to-comment.ts` — `mapSeverity` branch
- Add a `react-doctor` branch keyed off the carried react-doctor `category`:
  - `Security` → `{ tier: 1, category: "security" }`
  - `Bugs` → `{ tier: 2, category: "correctness" }`
  - `Performance` → `{ tier: 2, category: "scalability" }`
  - `Maintainability` | `Accessibility` → `{ tier: 3, category: "clarity" }`
  - unknown category → `{ tier: 3, category: "clarity" }` (conservative default)
- `ToolFinding` carries no `category` field today — thread the react-doctor category via `ruleId` namespacing (e.g. `ruleId = "react-doctor/<category>/<rule>"`) **or** add an optional `rdCategory?` field on `ToolFinding`. Prefer a small optional field on the finding over string-packing (cleaner for `routeFindingToConcern`). Decide in implementation; keep it producer-local.

### 6. `boss-loop.ts` — `routeFindingToConcern` branch
- Add `case "react-doctor":` returning the concern that matches the mapped category: `security` → `security`, Bugs → `correctness`, Performance → `scalability`, `clarity` (Maint/a11y) → **no extra dispatch** (return `"correctness"` only if it's the file's sole signal; otherwise these shouldn't *drive* a dispatch — they post directly). Keep it conservative: clarity-category react-doctor findings should not trigger an LLM worker.

### 7. `spawnCapture` timeout
- Add an optional `timeoutMs` to `spawnCapture` (kill the child + resolve `{ ok: false, error }` on timeout). The producer passes 60_000. Keep existing callers unchanged (default: no timeout).

### 8. `det-priors.ts` — wire the gated producer
- In the `Promise.all` block, add: `wardenEnv().WARDEN_REACT_DOCTOR && changedPaths.length > 0 ? runReactDoctor({ repoRoot, changedPaths, mode: input.mode, baseRef: input.diffBase?.baseRef }).catch(degradeEntry) : Promise.resolve({ findings: [], degraded: [] })`.
- Fold its `findings` into the `findings` aggregate and `degraded` into the `degraded` aggregate.

### 9. `@warden/env` — the flag
- Add `WARDEN_REACT_DOCTOR` (boolean-ish, default off) to the env schema; document it in `docs/environment.md` per the env-add workflow.

### 10. Smoke + eval
- `smoke-rd-cli.mts`: assert the producer fires on a planted SQL-injection / hardcoded-secret fixture when `WARDEN_REACT_DOCTOR=1`, maps to `{ category: "security", tier: 1 }`, and is **absent** when the flag is off. Assert graceful degrade when react-doctor is unresolvable (simulate `--no-install` miss).
- `review-eval`: run the producer (flag on) against the clean-fixture gate (ADR-0031 gate c — **0 unlabeled comments**) and the `*-misses-*` recall fixtures + the precision cost. **Per-family gate** any Security family that trips the clean fixtures.

## The default-on flip (NOT this iteration — gated on review-eval)

When eval clears (recall moves on `*-misses-*` without unacceptable precision cost, clean fixtures stay at 0):
1. Flip `WARDEN_REACT_DOCTOR` default → on.
2. **In the same change**, trim `runners/eslint-security.ts` `rulesBlock()` to five: remove `security/detect-child-process`, `security/detect-non-literal-fs-filename`, `no-secrets/no-secrets` (subsumed by react-doctor's `command-execution` / `path-traversal` / secret-leak scan families). Update `CONTEXT.md §5`'s ESLint-security rule list (already done in this commit) and the `routeFindingToConcern` / `mapSeverity` comments. **(R3)**
3. Re-run the clean + `*-misses-*` gates to confirm single-source-per-family didn't open a hole.

## Out of scope (deferred — see `project_warden_rd_producer_scope.md`)
- `--scope full` whole-repo pass → ADR-0038 `xhigh` intensity tier (leave the one-line hook).
- The ADR-0045 §4 **reasoned-lane** prompt deltas → gated on Iteration-0's A/B result.
- ADR-0045 §5 **overlay / user rules file** for PR checks → ADR-0036 custom-rule lane.
- `--deep` deep-security, cross-repo / sibling-repo scanning, incremental clarification questions.
