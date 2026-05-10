# Warden — M9 Plan (diff-level noise filter)

This is the milestone brief for the agent (or future-me) implementing M9. Self-contained: read this plus `decisions.md` ADR-0022 (the M9 direction) and you have everything.

**Status: stub.** The design direction is locked by ADR-0022; the implementation specifics below are first-draft and several call-outs are deliberately marked **TBD per M9 grilling**. Run the grilling pass before writing code — the M7 plan went through ~17 questions before it stabilised, and M9 has at least four open design seams (per-subtree ecosystem detection, profile schema, runner-interface migration, override surface).

## Read first (in this order)

1. **`./decisions.md`** — focus on **ADR-0022 (this milestone's direction)** plus ADR-0008 (zero-config posture; existing `.reviewbot/overlay.yaml` is the override surface), ADR-0013 (I/O-pure core; the diff loader change is internal to `@warden/core`), ADR-0019 (M6 — content-addressed storage discipline applies to profile loading), ADR-0021 #2 (the M7 placeholder this milestone replaces).
2. **`./CONTEXT.md`** — `diff-level noise filter`, `noise profile`, and `diff tree` are defined there. Reach for those terms before inventing new ones.
3. **`./m7-plan.md`** — the committability sub-agent's directory-concentration heuristic (the M7 placeholder) is the current state of the world. M9 generalises it: the heuristic stops being committability-specific and moves to the diff loader.
4. **`./packages/core/src/ecosystem/`** — the M2 ecosystem detector. M9 extends it to emit a list of detected ecosystems (currently it returns the active one).
5. **`./packages/core/src/diff/`** — the diff loader. M9's seam lives here.
6. **`./packages/core/src/runners/`** — TSC, ESLint, jscpd, vuln, and the M7 detectors. Each consumes the diff today; each will consume the *pruned* diff after M9.
7. **`./packages/core/src/index.ts`** — `review()`'s pipeline order. M9 inserts the filter between diff loading and runner dispatch.

## Goal of this milestone

Implement **M9: diff-level noise filter — ecosystem-detection-driven, profile-loaded, depth-limited tree pruning, applied at the diff loader, every runner benefits.** By the end:

- A repo with `node_modules/` accidentally committed (gitignore broken, 500K+ files in `node_modules/`) runs `warden review` cleanly: TSC / ESLint / jscpd / vuln / scalability / deadcode / consistency / committability all see the *pruned* diff (changed source files only). One degraded entry per pruned subtree explains what got skipped and why.
- The M7 directory-concentration heuristic in `committability.ts` is removed (the diff loader handles it generically now). The Tier-1 hard-skip list (`.git/`, `*.pyc`, etc.) stays — it's per-file noise that profiles also catch but a pre-runner glob is fine for files no profile would dispute.
- `packages/core/src/ecosystem/profiles/` ships with one JSON profile per language Warden currently supports (start: `javascript`, `python`; **TBD per M9 grilling: which others — `rust`, `go`, `java`, `csharp`, `ruby`?**).
- The diff is represented internally as a depth-limited tree (≤3 levels) with `(addedCount, modifiedCount, deletedCount)` per node. Pruning operates on subtrees; the catastrophic case never materialises as a flat path list anywhere.
- The existing `.reviewbot/overlay.yaml` schema extends to `noise.always` / `noise.never` (additive; existing overlays continue to work).
- Per-runner integration: each runner's input shape changes from `path[]` to `{ tree, paths }` (or equivalent — **TBD per M9 grilling**). Backward-compat shim through M9 if needed; removed in M10.
- Smoke harness covers the catastrophic case (synthetic 500K-file `node_modules/` diff), the legitimate-large-refactor case (1K-file rename inside `packages/api/` that the M7 placeholder false-positives on but M9 should pass cleanly), and the multi-ecosystem case (JS + Python repo with `node_modules/` and `__pycache__/` both in the diff).
- Dogfood validation: rerun `warden review` against warden's own M6 / M7 PRs; confirm no regressions vs. the M7-placeholder behaviour, and confirm the catastrophic-case smoke fixture's pruned diff matches the expected subset.
- `pnpm check-types` + `pnpm lint` pass.
- All M4–M7 behaviour preserved on non-catastrophic inputs.

**Stop at "diff-level filter ships, all runners consume pruned diffs, smoke harness passes." Do NOT start implementing per-symbol noise filtering, free-form prose claim extraction (M10 candidate), BYOEmbedder, cross-repo retrieval, custom-code SAST worker, full `warden index export/import` CLI verbs, async/daemon `JobRunner`, cloud-hosted index, mid-stream key handling, or retrieval refinements.** Those are M10+.

## Repo additions

```
packages/core/src/ecosystem/
├── detect.ts                  # MODIFIED — emit list of detected ecosystems (was single).
└── profiles/                  # NEW directory.
    ├── javascript.json        # NEW — node_modules/, dist/, .next/, build/, .min.js, lockfiles.
    ├── python.json            # NEW — __pycache__/, .venv/, *.egg-info/, .pyc, etc.
    └── ...                    # NEW — TBD per M9 grilling: which other ecosystems ship in v0.

packages/core/src/diff/
├── tree.ts                    # NEW — build depth-limited diff tree from `git diff --raw`.
├── prune.ts                   # NEW — apply noise profiles to the diff tree; emit degraded entries.
└── index.ts                   # MODIFIED — diff loader composes tree + prune; returns pruned shape.

packages/core/src/runners/
├── *.ts                       # MODIFIED — each runner adapts to the pruned-diff input shape.
└── committability.ts          # MODIFIED — drop the M7 directory-concentration heuristic
                               # (diff loader does it generically now); keep Tier-1 hard-skip.

packages/core/src/overlay/
└── index.ts                   # MODIFIED — extend overlay schema with `noise.always` / `noise.never`.

packages/cli/scripts/
├── smoke-m8-catastrophic.mts  # NEW — synthetic 500K-file `node_modules/` diff fixture.
├── smoke-m8-large-refactor.mts # NEW — 1K-file legitimate refactor; assert no false-positive prune.
└── smoke-m8-multi-ecosystem.mts # NEW — JS + Python diff; assert both profiles apply.
```

No new workspace package. No new CLI verb. No new env var.

## Package boundaries to honor

- All M9 code lives in `@warden/core`. The diff loader is internal; runners are internal; profiles ship inside the package.
- `@warden/core` stays I/O-pure per ADR-0013. The diff loader reads `git diff --raw` (it has to — it's the diff loader), but no runner gains new I/O capabilities. Output flows through the existing `Comment[]` + `degradedWorkers[]` return surface.
- No `@warden/ai` changes. The noise filter is deterministic; no LLM call.
- No `@warden/db` changes (tentative — **TBD per M9 grilling: should pruned-diff state be cached for incremental re-runs?**).

## What to build (first-draft sketch — confirm during M9 grilling)

### 1. Ecosystem detector extension

`packages/core/src/ecosystem/detect.ts`:

- Today: returns the active ecosystem (single).
- After M9: returns `{ ecosystems: EcosystemId[], rootMarkers: Record<EcosystemId, string> }` — list of detected ecosystems plus the root marker that triggered each detection.
- Detection driven by root marker files: `package.json` / `pnpm-lock.yaml` → `javascript`; `pyproject.toml` / `requirements.txt` → `python`; `go.mod` → `go`; `Cargo.toml` → `rust`; etc. (Full list **TBD per M9 grilling**.)
- Per-subtree detection: **TBD per M9 grilling.** Whether `frontend/=JS, backend/=Python` monorepos get top-level-directory marker scanning in v0, or whether they're a known limitation that M10 closes.

### 2. Noise profiles

`packages/core/src/ecosystem/profiles/{ecosystem}.json`:

- Schema (first draft; **TBD per M9 grilling**):

```json
{
  "ecosystem": "javascript",
  "alwaysNoise": {
    "directories": ["node_modules", ".next", "build", "out"],
    "extensions": [".min.js", ".min.css", ".d.ts.map", ".js.map"],
    "files": ["yarn.lock", "package-lock.json", "pnpm-lock.yaml"]
  },
  "contextDependent": {
    "directories": ["dist", "vendor"]
  },
  "version": 1
}
```

- Profiles ship as static JSON; no codegen.
- Multi-ecosystem repos union the rules: `alwaysNoise.directories` from JS (`node_modules`) + `alwaysNoise.directories` from Python (`__pycache__`) → both pruned.
- `contextDependent` directories require additional checks (gitignore membership, file-extension homogeneity) before pruning.

### 3. Diff tree builder

`packages/core/src/diff/tree.ts`:

- Input: raw output of `git diff --raw` (or equivalent diff source).
- Output: a tree of `DiffTreeNode` rooted at the repo root, with `(name, addedCount, modifiedCount, deletedCount, totalSize, gitignored, children)` per node.
- Depth limit: 3 levels by default. Beyond depth 3, leaves aggregate (so `src/foo/bar/baz/quux.ts` rolls up into `src/foo/bar` with just count metadata, not a path list).
- Recursive expansion: if a leaf's count is small enough to justify it (**threshold TBD per M9 grilling**), expand one more level. Used by runners that need real paths for files that survived pruning.
- Memory-bounded: the tree's node count is bounded by directory structure, not file count. A 500K-file diff fits in a few KB.

### 4. Prune logic

`packages/core/src/diff/prune.ts`:

- Input: the diff tree + the union of loaded noise profiles + the parsed overlay (`noise.always` / `noise.never`).
- Output: a *pruned* diff tree + a list of `DegradedEntry` per pruned subtree.
- Algorithm:
  1. Apply `overlay.noise.never` first — these directories are explicitly user-protected; never prune them, even if a profile says always-noise.
  2. Apply `overlay.noise.always` next — user-declared noise; prune unconditionally.
  3. Apply `alwaysNoise.directories` from the profile union; prune matching subtrees.
  4. Apply `alwaysNoise.extensions` to leaves; prune individual files matching the extension.
  5. Apply `alwaysNoise.files` to leaves.
  6. For `contextDependent.directories`: check gitignore membership and file-extension homogeneity. **TBD per M9 grilling: full decision rule.**
  7. Apply structural fallback heuristics for cases the profiles miss (the M7 directory-concentration check, generalised). **TBD per M9 grilling: which structural heuristics survive into M9 vs. get dropped because profiles cover the case.**
- Each pruned subtree emits one `DegradedEntry` with `topic: "noise-filter"`, `kind: "actionable"`, and a message naming the path + count + reason + ecosystem.

### 5. Runner-interface migration

Each existing runner consumes the diff today. After M9 each consumes the *pruned* diff. The interface change is **TBD per M9 grilling** — two candidate shapes:

- **(α)** Replace `path[]` with `{ tree: DiffTreeNode, paths: string[] }`; runners that need flat paths use `paths` (computed once from the tree); runners that want tree-aware logic (e.g., a future "directory-level deadcode") use `tree`.
- **(β)** Keep `path[]` as the runner contract; the loader returns the flattened pruned paths. Runners stay shape-stable; the tree is internal to `diff/`. Loses tree-aware capabilities for downstream runners but matches the existing interface exactly.

Recommendation TBD; the asymmetry is whether any runner benefits from the tree. M7's deadcode detector might.

### 6. Overlay schema extension

`packages/core/src/overlay/index.ts`:

- Extend the existing zod schema:

```ts
const OverlaySchema = z.object({
  knownDebt: z.array(...).optional(),     // existing
  noise: z.object({                        // NEW
    always: z.array(z.string()).optional(),
    never: z.array(z.string()).optional(),
  }).optional(),
});
```

- Path entries are repo-relative directory globs (e.g., `generated-api-client/`, `proto-out/**`).
- Existing overlays without a `noise` block continue to validate (the field is optional).

### 7. Smoke harness

`packages/cli/scripts/smoke-m8-catastrophic.mts`:

- Synthesises a fixture diff with 500K added files in `node_modules/` plus 12 added files in `src/`.
- Asserts: pruned diff has 12 paths (only `src/`), one degraded entry with `topic: "noise-filter"` naming `node_modules/` and the JS ecosystem.
- Wall-clock target: < 5 seconds for the full pipeline (the catastrophic case shouldn't be 50× slower than the normal case).

`packages/cli/scripts/smoke-m8-large-refactor.mts`:

- Synthesises a fixture diff with 1K added files inside `packages/api/` (legitimate refactor).
- Asserts: pruned diff has 1K paths (no false-positive prune), no `noise-filter` degraded entries.
- Asserts the M7 directory-concentration placeholder *would* have skipped the committability sub-agent on this diff (validating that M9 strictly improves on the placeholder).

`packages/cli/scripts/smoke-m8-multi-ecosystem.mts`:

- Repo with both `package.json` and `pyproject.toml` at root.
- Diff includes added files in `node_modules/`, `__pycache__/`, `src/`, and `app/` (Python source).
- Asserts: pruned diff has only `src/` and `app/` paths; two degraded entries (one for each ecosystem); `frontend/=JS, backend/=Python`-style per-subtree detection is **NOT asserted** unless M9 grilling commits to shipping it.

## Open design questions (for the M9 grilling)

1. **Per-subtree ecosystem detection — ship or defer?** The simple case (root-marker detection + profile union) covers single-ecosystem repos and ecosystem-mixed monorepos with shared roots. The hard case (`frontend/=JS, backend/=Python` with directory-level boundaries) needs per-top-level-directory marker scanning. ADR-0022's "Caveat — per-subtree ecosystem detection is an M9 sub-decision" parks the choice; M9 grilling makes it.
2. **Ecosystem coverage in v0.** Profiles for which languages? `javascript` + `python` are the floor; what's the ceiling — `rust`, `go`, `java`, `csharp`, `ruby`, `php`, `elixir`, `dart`? Trade-off is profile-authoring effort vs. catastrophic-case coverage; the "first user from a new ecosystem" experience is the ceiling lever.
3. **Profile schema.** The first-draft schema in §2 is plausibly right but not grilled. Open seams: should `contextDependent` have its own decision rule per directory, or one global rule? Should profiles have versioning to support migration when Warden's profile-consumption logic evolves? Should profiles be loadable from `node_modules/@warden/profiles-*` for community-contributed profiles, or hardcoded in `@warden/core`?
4. **Runner-interface migration shape (α vs. β).** Whether the tree leaks into runner contracts or stays internal to `diff/`. The asymmetry is whether any runner benefits from tree-aware input — and that depends on M9+ ambitions for cross-runner abstractions.
5. **Structural heuristics — kept or dropped?** The M7 directory-concentration heuristic catches the catastrophic case without profiles. After profiles ship, it's redundant in the JS-`node_modules/` case but might still help in cases profiles don't cover (project-specific generated dirs the user hasn't added to the overlay). Do they live as a permanent fallback layer, or does the overlay carry that load?
6. **Caching — pruned-diff state in `.warden/cache.sqlite`?** Pruning is fast on small diffs and bounded on large ones, so probably not worth caching. But if M10+ adds expensive per-subtree analysis (semantic chunking on the pruned tree), caching becomes worth it. Decide whether the storage interface accommodates it.
7. **Degraded-entry verbosity.** One entry per pruned subtree at default verbosity might be noisy in multi-ecosystem repos (4–6 entries every run). Should default mode collapse them to "noise filter pruned N subtrees (run with --verbose for breakdown)"? **Or is per-subtree visibility a trust feature, never collapsed?**

## What NOT to do in this milestone

- **No symbol-level filtering.** M9 prunes at the file/directory level. "Skip this function because it's auto-generated" is M10+ territory.
- **No prose-claim extraction or LLM noise classification.** ADR-0022's "pure structural heuristics, no profiles" rejection cuts both ways: profiles are structured data; LLM classification was tried-and-rejected in the original chat thread for being expensive at scale. Don't reintroduce it.
- **No new CLI verbs.** `warden show-skipped` was floated and rejected — degraded entries are the explainability surface. Adding a verb is M10+ scope, gated on dogfood evidence that degraded entries are insufficient.
- **No mid-stream profile reloading.** Profiles are loaded once at the start of the review; reloading on profile-file changes mid-review is YAGNI.
- **No community-profile contribution mechanism.** Question (3) in "Open design questions" raises this; v0 ships hardcoded profiles only. Community profiles are an M10+ feature gated on a real contributor case.
- **No retroactive overlay migration.** Existing overlays (`.reviewbot/overlay.yaml`) without a `noise` block continue to work as-is. Don't auto-add empty `noise` blocks; don't write to user files.

## Acceptance criteria

- [ ] Ecosystem detector emits a list of detected ecosystems (extension to the M2 detector) — verified by unit fixture.
- [ ] Profiles for `javascript` and `python` ship in `packages/core/src/ecosystem/profiles/` (additional ecosystems per M9 grilling decision).
- [ ] Diff tree builder produces a depth-limited tree from `git diff --raw` output — verified by unit fixture, including the 500K-file pathological case (memory bounded, fast build time).
- [ ] Prune logic applies overlay → profile → structural-heuristic-fallback in order; pruned subtrees emit one degraded entry each.
- [ ] All existing runners (TSC, ESLint, jscpd, vuln, scalability, deadcode, consistency, committability) consume the pruned diff. No runner regressions on M4–M7 behaviour.
- [ ] Committability runner's M7 directory-concentration heuristic removed; Tier-1 hard-skip preserved.
- [ ] Overlay schema accepts `noise.always` / `noise.never`; existing overlays validate as before.
- [ ] Smoke harness passes: `smoke-m8-catastrophic.mts`, `smoke-m8-large-refactor.mts`, `smoke-m8-multi-ecosystem.mts`.
- [ ] Dogfood: rerun against warden's M6 + M7 PRs, no regressions vs. M7-placeholder behaviour on non-catastrophic inputs.
- [ ] `pnpm check-types` + `pnpm lint` clean.
- [ ] M7 placeholder text in `m7-plan.md` (§10 Threshold) marked obsolete with a pointer to "removed in M9."

## Lessons from M7 → M9 transition

(Filled in post-implementation, mirroring `scaffolding-plan.md`'s convention.)

## When you're done

Hand back: a list of any deviations from this plan (with reasons), confirmation all acceptance criteria pass, and one short note on which of the seven "open design questions" the M9 grilling resolved (so the next milestone's brief can reference them).
