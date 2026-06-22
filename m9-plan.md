# Warden — M9 Plan (diff-level noise filter, v0 scope)

This is the milestone brief for the agent (or future-me) implementing M9. Self-contained: read this plus `decisions.md` ADR-0022 (direction) + ADR-0025 (v0 scope) and you have everything.

**Status: locked.** ADR-0025 closes M9's grilling pass. The seven open design questions in the prior version of this plan are all answered (see ADR-0025 caveat "m9-plan.md's open design questions"); start coding when ready.

## Read first (in this order)

1. **`./decisions.md`** — focus on **ADR-0025 (M9 v0 scope)** and **ADR-0022 (architectural direction)** in that order. ADR-0025 is authoritative on what M9 ships; ADR-0022 is the long-term shape M10+ realizes. Also relevant: ADR-0008 (zero-config posture), ADR-0013 (I/O-pure core; no `git diff --raw` from inside core), ADR-0021 #2 + ADR-0022 (the M7 directory-concentration placeholder this milestone removes), ADR-0023 §5 (β interface — runners stay on `path[]`).
2. **`./CONTEXT.md`** — `diff-level noise filter`, `noise profile`, `BASELINE_NOISE`, `diff tree` are defined there. Reach for those terms; do not invent new ones.
3. **`./packages/core/src/diff/index.ts`** — the existing `parseUnifiedDiff()` returning `ChangedFile[]`. M9's tree builder consumes its output.
4. **`./packages/core/src/ecosystem/index.ts`** — the existing JS-shaped detector. **Read but do not modify.** Multi-ecosystem detection is M11+ work; M9 assumes JS.
5. **`./packages/core/src/runners/committability.ts`** — carries the M7 directory-concentration heuristic + Tier-1 hard-skip list that M9 removes (heuristic gone) and migrates (Tier-1 list → `BASELINE_NOISE` in `diff/prune.ts`).
6. **`./packages/core/src/runners/`** — every runner (TSC, ESLint, jscpd, vuln, scalability, deadcode, consistency, committability) consumes the diff. After M9, each consumes the _pruned_ `ChangedFile[]`. The β interface (ADR-0023 §5) means runners' contracts don't change shape — `path[]` stays — only the contents narrow.
7. **`./packages/core/src/index.ts`** — `review()`'s pipeline order. M9 inserts the prune step between diff parsing and runner dispatch.

## Goal of this milestone

Implement **M9 v0: diff-level noise filter — JS profile + universal Tier-1 baseline + tree pruning at the diff loader.** By the end:

- A repo with `node_modules/` accidentally committed (gitignore broken, 500K+ files in `node_modules/`) runs `warden review` cleanly: TSC / ESLint / jscpd / vuln / scalability / deadcode / consistency / committability all see the _pruned_ `ChangedFile[]` (real source files only). One degraded entry of `topic: "noise-filter"`, `kind: "actionable"` names what got skipped and why.
- The M7 directory-concentration heuristic in `committability.ts` is removed entirely (no fallback layer in M9 v0; M10's overlay closes the project-specific-noise gap properly).
- The Tier-1 hard-skip list (`.git/`, `*.pyc`, `*.swp`, `.DS_Store`, `Thumbs.db`, `.vscode/.history/`) graduates from `committability.ts` to a language-agnostic `BASELINE_NOISE` constant in `diff/prune.ts`. Applied universally before any profile; every runner benefits, not just committability.
- `packages/core/src/ecosystem/profiles/javascript.json` ships with `alwaysNoise.{directories, extensions}`. No `contextDependent`, no `files`, no schema versioning. Lockfiles deliberately _not_ pruned (vuln runs against `repoRoot`; lockfile presence in the diff is signal, not noise).
- The diff tree is depth-limited (≤3 levels) with `fileCount` per node. Built from `parseUnifiedDiff()` output. Bounded in memory by directory structure, not file count.
- Smoke harness covers the catastrophic JS case (synthetic 500K-file `node_modules/` diff) and the legitimate-large-refactor case (1K-file refactor inside a real source directory; assert no false-positive prune).
- Dogfood validation: rerun `warden review` against warden's own M6 / M7 / M8 PRs; confirm no regressions on non-catastrophic inputs.
- `pnpm check-types` + `pnpm lint` pass.
- All M4–M8 behaviour preserved on non-catastrophic inputs.

**Stop at "diff-level filter ships, JS profile + baseline land, smoke harness passes." Do NOT start implementing the overlay loader, multi-ecosystem detector rewrite, additional ecosystem profiles, structural-heuristic fallback, per-symbol noise filtering, prose-claim extraction, BYOEmbedder, cross-repo retrieval, custom-code SAST worker, async/daemon `JobRunner`, or anything else.** Those are M10+. ADR-0025 is explicit about each deferred piece's milestone slot.

## Repo additions

```
packages/core/src/ecosystem/
└── profiles/                    # NEW directory.
    └── javascript.json          # NEW — see §2 for schema and contents.

packages/core/src/diff/
├── tree.ts                      # NEW — build depth-limited tree from ChangedFile[].
├── prune.ts                     # NEW — BASELINE_NOISE + profile loader + prune logic.
└── index.ts                     # MODIFIED — `parseUnifiedDiff()` is unchanged; the prune
                                 # entry point becomes a sibling export consumed by review().

packages/core/src/runners/
└── committability.ts            # MODIFIED — drop directory-concentration heuristic;
                                 # drop the duplicated Tier-1 hard-skip list (now in BASELINE_NOISE).

packages/core/src/index.ts       # MODIFIED — pipeline inserts prune between
                                 # parseUnifiedDiff() and runner dispatch.

packages/cli/scripts/
├── smoke-m9-catastrophic.mts    # NEW — synthetic 500K-file `node_modules/` diff fixture.
└── smoke-m9-large-refactor.mts  # NEW — 1K-file legitimate refactor; assert no false-positive prune.
```

No new workspace package. No new CLI verb. No new env var. No new dep (no yaml parser, no `@vercel/style` ecosystem registry — all profile data ships as static JSON inside `@warden/core`).

## Package boundaries to honor

- All M9 code lives in `@warden/core`. The diff loader stays internal; runners stay internal; profiles ship inside the package.
- `@warden/core` stays I/O-pure per ADR-0013. The diff loader does not invoke `git`; profiles load via `import` (or `readFileSync` of bundled JSON, depending on build setup — check what `code-chunk-shim.d.ts` did and mirror).
- No `@warden/ai` changes. Noise filter is deterministic; no LLM call.
- No `@warden/db` changes. ADR-0025 explicitly rejects caching pruned-diff state.

## What to build

### 1. JavaScript noise profile

`packages/core/src/ecosystem/profiles/javascript.json`:

```json
{
  "ecosystem": "javascript",
  "alwaysNoise": {
    "directories": ["node_modules", ".next", "build", "out", ".turbo", "coverage"],
    "extensions": [".min.js", ".min.css", ".d.ts.map", ".js.map", ".css.map"]
  }
}
```

Notes:

- **Lockfiles are deliberately absent.** `package-lock.json` / `pnpm-lock.yaml` / `yarn.lock` belong in the diff — vuln runs against `repoRoot` independently of diff content; ESLint and TSC filter by extension; the synthesizer prompt benefits from "this is a dep-bump PR" context.
- `.turbo` and `coverage` echo the existing `SKIP_DIRS` set in `ecosystem/index.ts` (line 15) to keep the two lists conceptually aligned. The profile is the source of truth for the noise filter; `SKIP_DIRS` continues to scope tsconfig discovery only.
- `dist/` is **not** in `alwaysNoise.directories`. It's a context-dependent directory (some monorepos commit `dist/` intentionally). Without an overlay escape hatch, false-positive risk is too high. M10's overlay re-opens the question.

### 2. `BASELINE_NOISE` constant in `diff/prune.ts`

```ts
// Language-agnostic noise floor; applied unconditionally before any profile.
// OS / editor junk that's noise regardless of ecosystem.
const BASELINE_NOISE = {
  directories: [".git", ".vscode/.history"],
  fileNames: [".DS_Store", "Thumbs.db"],
  extensions: [".pyc", ".swp"],
} as const;
```

Notes:

- Migrated from `committability.ts`'s Tier-1 hard-skip list. Original location drops it once `BASELINE_NOISE` is wired in.
- Distinct from the JS profile by being language-agnostic. Future profiles add to the picture without redeclaring this floor.

### 3. Diff tree builder

`packages/core/src/diff/tree.ts`:

- Input: `ChangedFile[]` from `parseUnifiedDiff()`.
- Output: a `DiffTreeNode` rooted at `""` (repo-relative), each node carrying `{ name, fileCount, files: ChangedFile[], children: Map<string, DiffTreeNode> }`.
- Depth limit: 3 levels by default. Beyond depth 3, files aggregate into the depth-3 node — its `fileCount` grows; its `files[]` carries the leaves; no further `children` materialise.
- Bounded by directory structure, not file count. A 500K-file diff produces a tree whose node count is O(directories), not O(files).
- The tree stays internal to `diff/`. Runners receive `ChangedFile[]` (β interface per ADR-0023 §5).

### 4. Prune logic

`packages/core/src/diff/prune.ts`:

- Input: the `DiffTreeNode` + the loaded JS noise profile (statically imported at module load) + the `BASELINE_NOISE` constant.
- Output: the _pruned_ `ChangedFile[]` + a `DegradedEntry[]` listing pruned subtrees.
- Algorithm (apply in this order):
  1. **Apply `BASELINE_NOISE`.** Walk the tree; drop nodes whose name matches `BASELINE_NOISE.directories`; drop files whose name matches `BASELINE_NOISE.fileNames` or whose extension matches `BASELINE_NOISE.extensions`. Each dropped subtree (not each file) emits one degraded entry.
  2. **Apply the JS profile's `alwaysNoise.directories`.** Walk the tree; drop nodes whose name (at any depth) matches. One degraded entry per dropped subtree.
  3. **Apply the JS profile's `alwaysNoise.extensions`.** Walk the leaves; drop files matching the extension. **No degraded entry per file** — the M9 v0 acceptance is "loud about subtrees, quiet about individual files." If many files of the same extension are dropped, that's already implied by the surrounding directory structure being unchanged.

Each pruned subtree's degraded entry: `{ kind: "actionable", topic: "noise-filter", message: \`skipped \${count} files in \${path}/ (\${reason})\` }`. Reason text examples: `"node_modules — JS ecosystem profile"`, `".git directory — baseline noise"`, `".vscode/.history — baseline noise"`.

### 5. Pipeline integration

`packages/core/src/index.ts`:

- Today: `review()` calls `parseUnifiedDiff(diff)` and threads `ChangedFile[]` into runner dispatch.
- After M9: `review()` calls `parseUnifiedDiff(diff)`, then `pruneDiff(changedFiles)` (returns `{ pruned, degraded }`), then threads `pruned` into dispatch and `degraded` into the existing `degradedWorkers` accumulator. Same for `check()`.

The β interface holds: runners still receive `ChangedFile[]`. Only the contents narrow.

### 6. `committability.ts` cleanup

- Remove the directory-concentration heuristic entirely (the `>80% concentration *or* >200 files` block).
- Remove the duplicated Tier-1 hard-skip list (the entries that moved to `BASELINE_NOISE`).
- Keep the rest of the sub-agent's logic untouched (citation verification, prompt construction, model selection — all unchanged).
- Verify the existing committability smoke fixture still passes after the heuristic + Tier-1 removal.

### 7. Smoke harness

`packages/cli/scripts/smoke-m9-catastrophic.mts`:

- Synthesizes a fixture diff with 500K added files in `node_modules/` plus 12 added files in `src/`.
- Asserts: pruned `ChangedFile[]` has 12 paths (only `src/`); one degraded entry of `topic: "noise-filter"` naming `node_modules/`.
- Wall-clock target: < 5 seconds end-to-end (the catastrophic case shouldn't be 50× slower than a normal review).

`packages/cli/scripts/smoke-m9-large-refactor.mts`:

- Synthesizes a fixture diff with 1K added files inside a legitimate source directory (e.g., `packages/api/src/`).
- Asserts: pruned `ChangedFile[]` has 1K paths (no false-positive prune); zero `topic: "noise-filter"` degraded entries.
- Documents that the M7 directory-concentration heuristic _would_ have skipped committability on this diff — i.e., M9 strictly improves on the placeholder.

There is **no** multi-ecosystem smoke fixture in M9. That fixture is named in M11+ when the multi-ecosystem detector ships.

## What NOT to do in this milestone

- **No overlay loader.** ADR-0025 §3 explicitly defers this to M10's own milestone. Do not introduce a yaml parser dep, do not create `packages/core/src/overlay/`, do not touch `.reviewbot/overlay.yaml`. If you find yourself wanting an escape hatch for a profile false positive, the answer is "M10 fixes it" — note the case in the milestone's lessons section and move on.
- **No multi-ecosystem detector rewrite.** ADR-0025 §1 explicitly defers this to M11+. Do not modify `packages/core/src/ecosystem/index.ts`. The JS profile loads unconditionally — the assumption that the active project is JS is hardcoded for M9 v0.
- **No additional ecosystem profiles.** No Python, no Rust, no Go. ADR-0025 §1 names the milestone slot.
- **No structural-heuristic fallback.** ADR-0025 §4 dropped it. If the JS profile misses a project-specific noise dump, that's M10's overlay's job.
- **No `contextDependent` schema bucket.** ADR-0025 §5 dropped it.
- **No schema versioning.** ADR-0025 §5 dropped it.
- **No `git diff --raw` invocation from core.** ADR-0025 §2: tree built from `parseUnifiedDiff()` output. Core stays I/O-pure.
- **No new CLI verbs.** `warden show-skipped` was floated and rejected in ADR-0022; degraded entries are the explainability surface.
- **No symbol-level filtering.** M9 prunes at the file/directory level. "Skip this function because it's auto-generated" is M10+ territory.
- **No tree on runner contracts.** ADR-0023 §5 + ADR-0025 keep β: runners receive `ChangedFile[]`. The tree stays internal to `diff/`.
- **No caching of pruned-diff state.** ADR-0025 §"Why" rejects this for v0; pruning is fast and bounded.

## Acceptance criteria

- [ ] `packages/core/src/ecosystem/profiles/javascript.json` ships with the schema in §1; loads via `import` from `prune.ts`.
- [ ] `BASELINE_NOISE` constant in `diff/prune.ts` covers `.git/`, `.DS_Store`, `*.pyc`, `*.swp`, `Thumbs.db`, `.vscode/.history/`.
- [ ] Diff tree builder produces a depth-limited tree from `ChangedFile[]` — verified by unit fixture, including the 500K-file pathological case (memory bounded, fast build time).
- [ ] Prune logic applies baseline → profile-directories → profile-extensions in order; pruned subtrees emit one degraded entry each with `topic: "noise-filter"`, `kind: "actionable"`.
- [ ] All existing runners (TSC, ESLint, jscpd, vuln, scalability, deadcode, consistency, committability) consume the _pruned_ `ChangedFile[]`. No runner regressions on M4–M8 behaviour.
- [ ] `committability.ts` no longer runs the directory-concentration heuristic; no longer maintains its own Tier-1 hard-skip list.
- [ ] Smoke harness passes: `smoke-m9-catastrophic.mts` + `smoke-m9-large-refactor.mts`.
- [ ] Dogfood: rerun against warden's M6 + M7 + M8 PRs, no regressions vs. M8 baseline behaviour on non-catastrophic inputs.
- [ ] `pnpm check-types` + `pnpm lint` clean.
- [ ] M7 placeholder text in `m7-plan.md` (§10 Threshold or wherever the heuristic is described) marked obsolete with a pointer to "removed in M9 per ADR-0025."

## Dependencies on M10+

Naming the deferred work explicitly so the M10+ briefs can pick it up:

- **M10 — overlay loader.** `.reviewbot/overlay.yaml` (or wherever the M10 grilling lands the file). Schema includes existing `knownDebt` (deferred from M3) plus `noise.always` + `noise.never`. Yaml parser dep, schema, location debate, integration with `prune.ts`. Closes the project-specific-noise gap M9 leaves open.
- **M11+ — multi-ecosystem detector + Python/Rust/etc. profiles.** Detector rewrite to return `EcosystemId[]` + per-ecosystem profile authoring + profile-union semantics + per-subtree detection (the `frontend/=JS, backend/=Python` case from ADR-0022 §7).
- **M11+ — structural fallback (only if dogfood demands it).** ADR-0025 §4 dropped the heuristic. If post-M10 dogfood shows project-specific noise dumps remain unaddressed even with overlays available, a structural fallback layer earns its own ADR + milestone slot.

## Lessons from M8 → M9 transition

1. **Profile-only coverage held up against the catastrophic-case fixture.** The 500K-file `node_modules/` synthetic ran in ~200ms — three orders of magnitude under the 5-second budget. The depth-3 tree's "aggregate at the limit" rule does its job: node count is bounded by directory shape (a few thousand for the synthetic), and the leaves sit in a few `files[]` arrays under depth-3 nodes. No GC pressure, no heap blow-up. The same pruning loop handles the 1K-file legitimate-refactor case in <10ms with zero `noise-filter` entries.
2. **The "loud about subtrees, quiet about individual files" rule earns its keep.** Initial sketch emitted a degraded entry per dropped file name match. Re-reading m9-plan §4: `BASELINE_NOISE.fileNames` and `BASELINE_NOISE.extensions` drops are silent; only directory drops get a degraded line. Removing the per-file noise made the catastrophic-case smoke land exactly one `topic: "noise-filter"` entry — the cleanest possible UX signal. Per-file emissions would have buried the directory drop under noise.
3. **Committability cleanup was small but load-bearing.** The runner shrank by ~50 lines (TIER1_HARD_SKIP_PATTERNS + analyseConcentration + topLevelDir + the constants). What was left is exactly the sub-agent surface (citation verification, prompt build, model fallback, sensitive-path policy). Single responsibility restored — committability now does committability, not noise filtering. Wireup change was one line in `runCommittability`: `const candidates = input.changed`.
4. **JS profile feels sufficient for warden's own dogfood scope.** Walking the M5/M6/M7/M8 PRs in mind: no PR I can recall wanted a noise pattern that the JS profile + baseline doesn't already cover (`node_modules`, `.next`, `dist`, `coverage`, `.turbo`, plus baseline OS/editor junk). The case for M10's overlay is real but isn't urgent for warden's own development. Confidence the JS profile works for typical TS monorepos is high; the overlay's value will show up first on consumer projects with project-specific generated directories (`generated-api-client/`, `proto-out/`, `gql-types/`).
5. **Asset loading mirrors prompt-loader's `readFileSync` shape.** Sticking with the existing pattern (no JSON `import` attribute, no `with { type: "json" }` ergonomics) avoided a `verbatimModuleSyntax`/Node-version question. The dist-time asset-copy story (prompts and now profiles both rely on adjacent files at runtime) is a known gap shared across both surfaces — when M10+ touches it for prompts, profiles get fixed simultaneously.

## When you're done

Hand back: a list of any deviations from this plan (with reasons), confirmation all acceptance criteria pass, and one short note on whether the JS profile's `alwaysNoise.directories` set (`node_modules`, `.next`, `build`, `out`, `.turbo`, `coverage`) caught all the noise patterns warden's own dogfood produced — i.e., did profile-only coverage feel sufficient mid-flight, or did you find yourself wanting overlay support before M10 ships? That signal directly informs M10's priority.
