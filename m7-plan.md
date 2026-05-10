# Warden — M7 Plan (detector-driven category promotion + committability sub-agent + question citation discipline)

This is the milestone brief for the agent (or future-me) implementing M7. Self-contained: read this plus `decisions.md` ADR-0021 (and ADR-0008, ADR-0012, ADR-0017, ADR-0019, ADR-0020 as background) and you have everything.

## Read first (in this order)

1. **`./decisions.md`** — focus on **ADR-0021 (this milestone's direction)** plus ADR-0008 (citation thesis — extends to questions in M7), ADR-0012 (review priority order — its successor ADR-0020 lists the four new category slots), ADR-0013 (I/O-pure core), ADR-0017 (LLM provider fallback — applies to the sub-agent), ADR-0019 (M6 — punch-list items 1–14 originate here), ADR-0020 (the four new category names + slot ordering — M7 implements its M7+ upgrade path), **ADR-0022 (M7 placeholder for diff-level noise filter; supersedes ADR-0021 #2's Tier-2 file-count gate).**

   Also worth a skim: **`./CONTEXT.md`** — the noun glossary for Warden. The runner / detector / sub-agent vocabulary used throughout this plan is canonicalised there; reach for those terms before inventing new ones.
2. **`./CLAUDE.md`** — package boundary table is load-bearing. M7 adds files in `@warden/core` only; no new workspace package; no new package boundary crossings.
3. **`./packages/core/src/index.ts`** — current `review()` pipeline. M5 left `RetrievedContext` populated via `candidatesToRetrievedContext()`; M6 added the semantic signal + `runInit`. M7 adds three deterministic detector workers + one sub-agent worker + the question-citation verifier post-pass + the npm-audit collapse logic.
4. **`./packages/core/src/schema.ts`** — `CategoryEnum` already contains `scalability`, `consistency`, `deadcode`, `committability` (added by ADR-0020). `KindEnum` already discriminates `assertion | question`. No schema changes in M7 beyond the `degradedWorkers` discriminated shape.
5. **`./packages/core/src/llm/prompts/system.md`** + `user-template.md` — current system prompt. M7 modifies the "Pattern shapes worth asking about" section to remove the four new categories from the LLM-asks list (since detectors now produce them) and adds a single line clarifying that question citations are substring-verified.
6. **`./packages/core/src/banner/index.ts`** — `BannerState` and `computeBannerState`. M7 adds the `no-embeddings` peer state and updates the renderer's prefix-match list.
7. **`./packages/core/src/runners/`** — current TSC / ESLint / jscpd / vuln runners. M7's three deterministic detectors mirror this shape (`runners/scalability.ts`, `runners/deadcode.ts`, `runners/consistency.ts`) plus one sub-agent worker (`runners/committability.ts`).
8. **`./packages/core/src/context/parser.ts`** — `SourceParser` interface + `TsCompilerParser` impl. The scalability and deadcode detectors accept a `SourceParser` via DI; no detector imports `typescript` directly.
9. **`./packages/db/src/index.ts`** + `path.ts` + `migrations/` — `db()` singleton + `findRepoRoot()` + the migration JSON folder. Items 1 and 8 land here.
10. **The "Design nuances captured during planning" section at the bottom of this doc** — non-obvious refinements from the M7 grilling. Worth reading before writing code, not after.

## Goal of this milestone

Implement **M7: detector-driven promotion of three categories from `questions[]` to `findings[]`, LLM sub-agent for the fourth category emitting citations into `questions[]`, substring-verification of all question citations, plus the M6 punch-list blockers + cheap polish items**. By the end:

- Fresh repo (e.g., a scratch directory) → `pnpm warden init` → `pnpm warden review --stdin` works end-to-end with no manual schema bootstrap, no working-dir tricks, and no `findRepoRoot()` footgun. (Items 1, 2, 8 crossed.)
- `degradedWorkers` is `{ kind: "actionable" | "warning" | "info"; topic: string; message: string }[]` everywhere; the banner renderer reads `kind` instead of substring-matching prefixes; verbose mode shows all three kinds. (Item 7 crossed.)
- npm-audit findings collapse to a single summary `Comment` when the diff doesn't touch `package.json` / lockfiles; full per-advisory output preserved when it does. (Item 10 crossed.)
- Three new detector workers (`scalability-detector`, `deadcode-detector`, `consistency-detector`) emit assertions to `findings[]` with grounded citations; each catches its motivating Copilot-PR-#3 case.
- `committability-subagent` worker uses `getWorkerCheapModel()` to review added + modified files; emits questions to `questions[]` with citations; substring-verifier drops citations that don't echo file content (forensic count surfaces in `degradedWorkers`).
- LLM system prompt's "Pattern shapes worth asking about" section is updated: scalability / consistency / deadcode are removed (detectors produce them now); committability remains in the prompt as a fallback signal but the sub-agent is the primary producer.
- Smoke harness (`smoke-m7-init.mts`, `smoke-m7-detectors.mts`, `smoke-m7-subagent.mts`) lands and passes.
- Polish: init summary line splits chunks-cache from embeddings-cache wording; banner placement moves to pre-phase per ADR-0019 #7's intent; ensureGitignore moves after schema bootstrap (atomicity); Voyage echo verified against requested model. (Items 5, 6, 12, 14 crossed.)
- `pnpm check-types` + `pnpm lint` pass.
- All M4 / M5 / M6 behavior preserved (no regression in TSC / ESLint / vuln / jscpd / cheap-signals / semantic / `init` / banner flow).
- **Dogfood validation gate**: rerun `warden review` against warden's own M6 PR (`#3`); confirm at least 4 of the 6 Copilot findings warden missed at M6 now surface as findings (not just questions). The 2 that overlap with warden's prior coverage stay covered. Anything still missed gets a written explanation in the close-out report — either documented as known limitation or as a later-milestone punch-list candidate.

**Stop at "blockers crossed + three deterministic detectors + sub-agent + question-citation verifier + npm-audit collapse + cheap polish + smoke harness work end-to-end on a fresh repo and on warden's own M6 PR." Do NOT start implementing multi-language detector support, free-form prose claim extraction in consistency, repo-wide deadcode scan, language-aware review guidance, BYOEmbedder, cross-repo retrieval, custom-code SAST worker, full `warden index export/import` CLI verbs, async/daemon `JobRunner`, cloud-hosted index, mid-stream key handling, or retrieval refinements.** Those are later milestones.

## Repo additions

```
packages/core/src/runners/
├── scalability.ts            # NEW — Scalability detector (AST). Direct-finding runner.
├── deadcode.ts               # NEW — Deadcode detector (AST + reverse import-graph).
├── consistency.ts            # NEW — Consistency detector (structured-verifier).
└── committability.ts         # NEW — Committability sub-agent (cheap-tier LLM).

packages/core/src/llm/
├── verify-citations.ts       # NEW — substring-verifier post-pass; reads cited line ranges,
│                             # confirms LLM-quoted snippets substring-match file content.
└── subagent.ts               # NEW — sub-agent dispatcher; wraps getWorkerCheapModel() with
                              # ADR-0017 fallback; Zod-validated output schema.

packages/core/src/runners/
└── audit.ts                  # MODIFIED — add diff-touches-manifest gate; collapse-to-summary path.

packages/core/src/banner/
└── index.ts                  # MODIFIED — add `no-embeddings` peer state; renderer prefix-match list.

packages/core/src/init/
├── index.ts                  # MODIFIED — summary wording (item 5); ensureGitignore order (item 12).
└── ensure-gitignore.ts       # MODIFIED — relocated call site only; logic unchanged.

packages/core/src/llm/prompts/
└── system.md                 # MODIFIED — remove scalability/consistency/deadcode from
                              # "Pattern shapes worth asking about"; clarify question-citation
                              # verification policy; committability remains as fallback signal.

packages/core/src/index.ts    # MODIFIED — wire new detectors + sub-agent + verifier into review();
                              # banner placement (item 6); npm-audit collapse coordination.

packages/db/src/
├── index.ts                  # MODIFIED — runtime migration on db() singleton (item 1).
└── path.ts                   # MODIFIED — findRepoRoot() precedence flip (item 8).

packages/db/                  # MODIFIED — build config copies migrations/ into dist/migrations/.
                              # (drizzle.config.ts unchanged; only the build pipeline moves the
                              # JSON + .sql files into the published surface.)

packages/ai/src/embeddings/
└── voyage.ts                 # MODIFIED — fetchOnce() asserts json.model === this._modelId
                              # (item 14); on mismatch, hard-fail with index-integrity message.

packages/cli/scripts/
├── smoke-m7-init.mts         # NEW — fresh-repo init + review smoke (validates items 1, 2, 8).
├── smoke-m7-detectors.mts    # NEW — runs each detector against PR-#3-derived fixtures.
└── smoke-m7-subagent.mts     # NEW — sub-agent against committability-shaped fixtures.
```

No new workspace package. Whether `@warden/context` or `@warden/index` ever exists is a later-milestone call when split-justification triggers fire (per ADR-0019 #11).

## Package boundaries to honor

- All M7 code lives in `@warden/core`, `@warden/db`, `@warden/ai`, `@warden/cli`. No new workspace package.
- `@warden/core` stays I/O-pure per ADR-0013 in spirit. The detectors read source files (they have to — that's how AST queries work). The committability sub-agent calls Anthropic / Google through `@warden/ai`. The substring-verifier reads cited files. None of these write to stdout, assume a TTY, or read `process.argv`. Output flows through `Comment[]` and `degradedWorkers[]` returned from `review()`.
- `@warden/ai` adds the sub-agent dispatcher (`packages/ai/src/subagent/` if needed, or extend `models.ts` with a `getCommittabilitySubAgent()` thin wrapper). Multi-provider fallback (ADR-0017) routes through the existing chain — the sub-agent is just another consumer of `getWorkerCheapModel()`.
- `@warden/db` gets migrations bundled into `dist/`. No new schema files. The connection singleton in `index.ts` runs `migrate()` once per process; subsequent `db()` calls await the flag.
- `@warden/cli` gets the three new smoke scripts. No new commands; the binary surface is unchanged.

## What to build

### 1. Runtime schema migration (item 1 — engine blocker)

In `packages/db/`:

- Build pipeline: copy `drizzle/migrations/` (existing folder containing `meta/_journal.json` + per-migration `*.sql` files generated by `pnpm db:generate`) into `dist/migrations/` as part of the package build. Update `package.json`'s `files` field to ship `dist/migrations/` alongside `dist/index.js`.
- Resolution helper: in `packages/db/src/index.ts`, expose a `migrationsFolder()` function using `import.meta.url` to resolve to the bundled `dist/migrations/` path at runtime. Works whether the consumer is published-warden (`node_modules/@warden/db/dist/migrations/`) or workspace-warden (`packages/db/dist/migrations/` after `pnpm build`).
- Gate the migration call: a module-scoped `let migrated: Promise<void> | null = null` in `packages/db/src/index.ts`. The first `db()` call sets `migrated = migrate(connection, { migrationsFolder: migrationsFolder() })` and awaits it before returning. Subsequent `db()` calls await the same promise — idempotent, costs ~1ms per call after the first.
- Fail-forward: a DB ahead of bundled migrations (cache schema is newer than the warden binary) is a hard error. Detect via drizzle's `migrate()` return value / thrown error — capture and rethrow as `Error("Cache schema is newer than this warden version (cache=v<N>, binary=v<M>). Upgrade warden or delete .warden/cache.sqlite to recreate.")`.
- Acceptance: a fresh repo with no `.warden/cache.sqlite` runs `pnpm warden init` → success. Re-running `init` is idempotent. Deleting `.warden/cache.sqlite` and re-running `init` is also fine. `pnpm db:migrate` (the existing dev-loop command) still works — it targets warden's *own* `.warden/cache.sqlite` and is unrelated to the runtime migration in published `@warden/db`.

### 2. `no-embeddings` banner state (item 2 — engine blocker)

In `packages/core/src/banner/index.ts`:

- Add a peer state to `BannerState`: `{ kind: "no-embeddings"; chunkCount: number }`. Triggered when `chunkCount > 0 && embeddingStore.count(lockedModel) === 0` (chunks exist but Phase 3 of `init` produced no embeddings — typical of Voyage 429 or Ctrl-C between phases).
- Update `computeBannerState()`: after the existing `chunkCount === 0 → "no-index"` guard, check `embeddingStore.count(lockedModel)`. If zero, return `{ kind: "no-embeddings", chunkCount }`.
- Update `bannerStateToDegraded()`: emit `{ kind: "actionable", topic: "embeddings", message: \`Index built (\${chunkCount} chunks) but no embeddings — semantic signal disabled. Run \\\`warden init\\\` to retry the embed phase.\` }` for the new state.
- Update the renderer (in `packages/cli/src/render.ts` if M6 left it there, otherwise wherever the banner rendering currently lives) to recognize the new `kind` value. If the renderer uses prefix-matching on message strings (per the M7 punch list complaint), the discriminated `degradedWorkers` shape from item 7 supersedes that — match on `kind` instead.
- Acceptance: a fresh `init` that fails Phase 3 (e.g., Voyage 429 or simulated by skipping the embed phase) → `warden review` shows the banner with the new state's message instead of `"no-banner"`.

### 3. `findRepoRoot()` precedence flip (item 8 — engine blocker)

In `packages/db/src/path.ts`:

- Replace the current "highest ancestor with `package.json`" walk with a precedence chain: `findNearest("pnpm-workspace.yaml", cwd)` → `findNearest(".git", cwd)` → `findNearestLowest("package.json", cwd)` → `cwd`.
- `findNearest(name, dir)`: walks upward from `dir` looking for `name`; returns the first hit's parent directory. Stops at filesystem root.
- `findNearestLowest(name, dir)`: same as `findNearest` — closest ancestor (not highest). The "lowest" naming here is to disambiguate from the old "highest" behavior; semantically it's the same as `findNearest`.
- Document the precedence in `CLAUDE.md` (one line in the package boundaries section).
- Acceptance: working directory under `packages/cli/src/` resolves to the workspace root (where `pnpm-workspace.yaml` lives), so `.warden/cache.sqlite` lands there. A repo with no `pnpm-workspace.yaml` falls through to `.git/`. A repo with neither falls through to nearest `package.json`. A loose script outside any repo falls through to `cwd`.

### 4. `degradedWorkers` discriminated shape (item 7 — gates ADR-0021 #3 + item 11)

The schema change:

```ts
export interface DegradedEntry {
  kind: "actionable" | "warning" | "info";
  topic: string;
  message: string;
}
```

In `packages/core/src/schema.ts` (or wherever `CommentSet` is currently defined): change `degradedWorkers: string[]` to `degradedWorkers: DegradedEntry[]`. This is a fan-out edit — every `degradedWorkers.push("...")` call site updates.

Conventional `kind` semantics:

- `actionable`: the user can do something about this. Fires the banner. Examples: "no embeddings — run `warden init`", "skipped sub-agent: 5,234 added files", "schema cache is newer than binary."
- `warning`: something failed but the review is still useful. Verbose-only by default. Examples: "consistency detector: failed to parse README.md", "sub-agent failed: <reason>".
- `info`: forensic / informational; never blocks. Verbose-only by default. Examples: "context: cold import-graph build", "osv: dropped 10 unverified advisories", "llm: dropped 2 citations without verifiable snippet."

Conventional `topic` values (open string, validated against a const array but extensible): `context`, `osv`, `gitignore`, `committability`, `scalability`, `deadcode`, `consistency`, `embeddings`, `schema`, `llm`, `vuln`. New workers add new topics.

Renderer: `packages/cli/src/render.ts` (or wherever banner rendering lives). The default mode shows only `actionable`-kind entries; `--verbose` shows all three kinds grouped by `kind`. The previous prefix-match on message strings is removed.

Migration ordering: this lands in Slice 1 (alongside items 1, 2, 8) so subsequent slices write the discriminated shape from the start, not the string shape.

### 5. Smoke harness (item 11)

`packages/cli/scripts/smoke-m7-init.mts`:

- Takes a target path argument (e.g., `node --import tsx/esm packages/cli/scripts/smoke-m7-init.mts ../scratch-repo`).
- Verifies fresh-repo init: deletes `.warden/cache.sqlite` if present; runs `runInit({ dryRun: false })`; asserts no `no such table` errors; asserts subsequent `db()` calls work; asserts `findRepoRoot()` resolved to the expected root (assertion config inline in the script).
- Validates banner: simulates a Phase-3 failure (skip embed phase via flag or env var) and asserts `computeBannerState()` returns `"no-embeddings"`.

`packages/cli/scripts/smoke-m7-detectors.mts`:

- Takes warden's own repo path; uses warden's M6 PR-#3 diff as the fixture.
- Runs each detector individually and asserts:
  - `scalability-detector` emits at least one finding citing `chunk-store.ts` (Copilot #6/#7) or `embedding-store.ts` (Copilot #8).
  - `deadcode-detector` emits a finding citing `computeBannerState`'s `stale` branch.
  - `consistency-detector` emits a finding citing the README's `VOYAGE_API_KEY` claim.
- Each detector's findings carry valid citations (substring-verifies against the actual file content).

`packages/cli/scripts/smoke-m7-subagent.mts`:

- Synthesizes a fixture diff that adds a `scripts-bootstrap-blair.mts`-shaped file with a `/Users/yash/...` path inside.
- Runs `committability-subagent` against the fixture; asserts at least one question with a filename-based citation and one with a content-based citation (line + snippet).
- Asserts substring-verifier drops a deliberately-malformed citation (e.g., LLM-quoted snippet that doesn't exist in the file).

All three smoke scripts are added to a new `pnpm smoke:m7` script in `packages/cli/package.json`. CI runs them.

### 6. npm-audit collapse-unless-manifest-touched (item 10)

In `packages/core/src/index.ts` (where `runVulnerabilityCheck` is called):

- Compute `manifestTouched: boolean` from `changedPaths`: `true` if any path matches `package.json` / `package-lock.json` / `pnpm-lock.yaml` / `yarn.lock` (any path, any depth — sub-package manifests count).
- If `manifestTouched`: today's behavior. Emit per-advisory `Comment`s as before.
- If `!manifestTouched`: aggregate the vuln runner's output into a single `Comment` with `category: "vulnerability"`, `tier: 3`, `file: "package.json"`, `line: 1`, body `\`Repo has ${count} known vulnerabilities; none introduced by this diff. Run \\\`pnpm audit\\\` (or your package manager's equivalent) for details.\``.
- Verbose mode (`--verbose`) restores the per-advisory output regardless of `manifestTouched` — users who want the volume can still get it.
- The verifier discipline (OSV citation per ADR-0008) is unchanged. What changed is the *aggregation*, not the detection.
- Acceptance: a diff that doesn't touch `package.json` produces 1 vuln Comment in default mode + N Comments in verbose mode. A diff that touches `package.json` produces N Comments in both.

### 7. Scalability detector (`packages/core/src/runners/scalability.ts`)

Public shape:

```ts
import type { SourceParser } from "../context/parser.js";
import type { ChangedFile } from "../diff/index.js";
import type { ToolFinding } from "./types.js";

export interface ScalabilityRunnerInput {
  repoRoot: string;
  changed: ChangedFile[];
  parser: SourceParser;
}

export interface ScalabilityRunnerOutput {
  findings: ToolFinding[];
  degraded: DegradedEntry[];
}

export async function runScalability(
  input: ScalabilityRunnerInput
): Promise<ScalabilityRunnerOutput>;
```

Detection patterns (TS Compiler API via `parser`):

- **Load-then-narrow**: `CallExpression` whose property access ends in `{ all, findMany, find }` on a query-builder-shaped receiver (chain ends in `.select()` / `.from()` / similar Drizzle / Prisma idioms — heuristic: the receiver chain contains `select`, `from`, `where`, `orderBy`, `limit`, or a method named like a builder), followed by an immediate next method call in `{ filter, find, length, some, every }`. Excludes `map` (projection — doesn't change cardinality).
- **Sequential-`await`-could-be-`Promise.all`**: `AwaitExpression` siblings in the same block whose awaited values don't depend on each other's results (heuristic: each `await` initializes a `const`-binding, and no later `await` references those bindings before the final use). Emit one finding per detected sequential cluster.

Per-finding shape:

```ts
{
  source: "scalability",
  ruleId: "load-then-narrow" | "sequential-await",
  file: relPath,
  line: startLine,
  endLine,
  severity: "warning",
  message: "<pattern-specific message>",
  evidence: [{ file, startLine, endLine, snippet: "<verbatim AST node text>" }],
}
```

Maps via `mapSeverity()` in `index.ts` to `{ tier: 2, category: "scalability", kind: "assertion" }`.

Triggers: only on diff-touched files. Repo-wide scanning is out of scope.

Failure modes: per-file parse error → emit `degraded: [{ kind: "warning", topic: "scalability", message: \`failed to parse \${file}: \${err.message}\` }]`; continue with remaining files.

False-positive posture: direct findings; the LLM triage layer (M4 formatter) downgrades severity or drops the finding when surrounding context (tight `where` clause, comment asserting bounded set size, JS-side type-narrowing the schema can't express) makes the smell harmless. Suppression in the detector requires schema introspection it doesn't have.

### 8. Deadcode detector (`packages/core/src/runners/deadcode.ts`)

Public shape mirrors the scalability detector. Additional input: the M5 `import_graph` connection (passed via DI; the runner queries `import_graph` for reverse lookups).

Detection algorithm:

1. For each diff-touched function (TS Compiler API: walk `FunctionDeclaration`, `MethodDeclaration`, `ArrowFunction` assigned to a `const`):
   - Identify optional parameters: parameters with `questionToken` set OR with a default value OR typed as `T | undefined` / `T | null`.
   - Identify presence-checking branches in the function body: `IfStatement` / `ConditionalExpression` / nullish-coalesce expressions whose condition references the optional param's identifier.
   - Skip if no optional params or no presence-check branches.
2. For each `(function, optionalParam, branch)` triple:
   - Query M5's `import_graph` (reverse: which files import the file containing this function?) — gives candidate caller files. M5 stores this as `(file_path, file_sha) → imports_json`; the reverse is a derived in-memory index.
   - Limit to one hop: only direct callers, not transitive.
   - For each caller file: parse it with `TsCompilerParser`; find all `CallExpression` nodes whose callee resolves to the function in question; inspect each callsite's argument list.
   - If the optional param's argument is *never* passed by any callsite: emit one finding.
3. Per-finding shape includes a 3-part `evidence` array: `[paramDecl, branch, representativeCallsite]`. Message: `\`Optional parameter '\${paramName}' is never passed by any of \${calleeCount} callsite(s); branch on L\${branchLine} is unreachable from review() callers.\``.

Maps to `{ tier: 2, category: "deadcode", kind: "assertion" }`.

Triggers: diff-touched functions plus one hop downstream (callers in `import_graph`). Repo-wide scanning is out of scope.

Known limitations (document as `degraded: { kind: "info", topic: "deadcode", message: "..." }` when relevant):

- **Dynamic dispatch**: `obj[methodName]()` callsites are invisible to AST-based callsite inspection. The detector won't flag a function whose only callers use dynamic dispatch. The LLM triage layer can downgrade if it sees dynamic-dispatch shape in the prompt context.
- **Re-exports**: M5's `import_graph` is file-level; re-exports flatten correctly, but transitive callers across multiple re-export hops are not enumerated. v0 catches the M6 PR's `computeBannerState` case (one hop); multi-hop is M8.

### 9. Consistency detector (`packages/core/src/runners/consistency.ts`)

Public shape mirrors the scalability detector. Additional input: the canonical doc set paths.

Doc set:

- `README.md` (repo root)
- `CLAUDE.md` (repo root)
- `AGENTS.md` (repo root)
- `docs/**/*.md` (recursive glob)

Out of scope: `node_modules/**/*.md`, `.github/**/*.md`, sub-package READMEs (deferred to a later milestone — per-package doc-to-package mapping needs a story M7 doesn't have).

Three structured claim types in v0:

- **Env var requirements**: extract via regex over the doc set: `\b(WARDEN_[A-Z_]+|ANTHROPIC_API_KEY|GOOGLE_GENERATIVE_AI_API_KEY|VOYAGE_API_KEY)\b` paired with `(required|optional|default\s+\S+)` predicates. Verify against `wardenEnv()` zod schema introspection: read `packages/env/src/index.ts`, parse the schema definition (use the `_def` field on zod schemas to inspect required-vs-optional + default values), compare. Emit findings on mismatches: doc says required + schema says optional → "README claims VOYAGE_API_KEY is required; schema treats it as optional"; default-value mismatches; env vars in docs that don't exist in schema (or vice versa).
- **CLI command shapes**: extract code blocks containing `warden <verb> [--flag <value>]` from the doc set. Verify against the commander surface in `packages/cli/src/`: enumerate registered verbs and their flag definitions; check that doc-mentioned verbs and flags exist. Mismatches: verbs that don't exist, flags that don't exist, required positional args missing in the doc example.
- **File path constants**: extract `\.warden/[\w./-]+`-shaped strings from the doc set. For each, grep the codebase for the same literal. If the path appears in docs but not in any `.ts` / `.js` / `.mts` source file, emit a finding ("doc references stale path X; not found in source").

Per-finding shape:

```ts
{
  source: "consistency",
  ruleId: "env-var-mismatch" | "cli-shape" | "stale-path",
  file: docPath,                  // the doc making the claim
  line: docLine,
  severity: "warning",
  message: "<claim-specific>",
  evidence: [
    { file: docPath, startLine: docLine, endLine: docLine, snippet: docClaimText },
    { file: codePath, startLine: codeLine, endLine: codeLine, snippet: codeRefText },
  ],
}
```

Maps to `{ tier: 2, category: "consistency", kind: "assertion" }`.

Triggers: the worker fires whenever any of the canonical docs OR the diff is non-empty. Per-claim verification only runs for claims that overlap with the diff (claim mentions a symbol / file / env var the diff also touches). Doc parsing is cheap; verification per claim is bounded by `O(claims × diff-size)`.

Free-form prose claim extraction is deferred to a later milestone. Open-slot LLM questions can still surface prose mismatches the LLM happens to spot — they slot under `consistency` via category tagging in the questions lane.

### 10. Committability sub-agent (`packages/core/src/runners/committability.ts`)

Public shape:

```ts
import type { ChangedFile } from "../diff/index.js";
import type { Comment } from "../schema.js";

export interface CommittabilityRunnerInput {
  repoRoot: string;
  changed: ChangedFile[];
  added: ChangedFile[];                // subset of changed where status === "added"
}

export interface CommittabilityRunnerOutput {
  questions: Comment[];                // kind: "question", category: "committability"
  degraded: DegradedEntry[];
}

export async function runCommittability(
  input: CommittabilityRunnerInput
): Promise<CommittabilityRunnerOutput>;
```

Pre-filter (Tier 1 hard-skip):

- Glob exclusions: `.git/**`, `**/*.pyc`, `**/*.swp`, `.DS_Store`, `Thumbs.db`, `.vscode/.history/**`. These are never intentional commits.
- Apply to the `changed` set; record `tier1Skipped: number` for the `degraded` log if non-zero.

Threshold (M7 placeholder per ADR-0022; full diff-level noise filter ships in M9):

The placeholder catches the "node_modules dump" signature (and other catastrophic concentration cases) via a single directory-concentration heuristic, without needing the ecosystem profiles + diff-tree representation that M9 will add. Supersedes ADR-0021 #2's original "above 500 files post-Tier-1, skip" gate; the Tier-1 hard-skip list above is unchanged.

- Compute concentration: for each top-level directory in the post-Tier-1 added set, count files. Let `topDir` = the directory with the largest count; `topShare` = `topDir.count / addedCount`.
- **Skip sub-agent if `topShare > 0.80` and `addedCount > 50`.** Emit `degraded: [{ kind: "actionable", topic: "committability", message: \`skipped sub-agent: \${topDir.count}/\${addedCount} added files concentrated in \${topDir.name}/ (likely vendored bulk-add — consider checking .gitignore for \${topDir.name}/)\` }]`. The 50-file floor prevents the heuristic from firing on small diffs where one directory naturally dominates.
- **Otherwise skip if `addedCount > 200`.** Emit `degraded: [{ kind: "actionable", topic: "committability", message: \`skipped sub-agent: \${addedCount} added files post-Tier-1 (above 200 with no dominant directory; consider triaging the diff or filtering by path before re-running)\` }]`.
- Below both thresholds: sub-agent runs normally on the post-Tier-1 set.

Sub-agent input shape (per file):

```ts
{
  path: string,                        // repo-relative
  sizeBytes: number,
  added: boolean,                      // status === "added"
  snippet: string,                     // first 20 lines of file content; whole file if smaller;
                                       // for binary files (sniffed via content type), snippet is "[binary; size=<N>B]"
}
```

Sub-agent prompt (system + user):

- System: lives in `packages/core/src/llm/prompts/committability-system.md`. Role: "You're a committability reviewer. Given a list of files added or modified in a code change, flag any whose name, location, or content suggests they shouldn't have been committed. Examples: dev-script names (`scripts-foo.ts`, `bootstrap-blair.mts`, `tmp-debug.ts`), hardcoded developer paths (`/Users/...`, `/home/...`, `C:\\Users\\...`), merge markers (`DO NOT MERGE`, `DO NOT COMMIT`, `DO NOT SUBMIT`), debug leftovers (top-level `console.log` in a non-script file), files outside conventional package layout. Be conservative — false positives are annoying. Each finding must cite filename + line for content-based findings, or just filename for name-based ones."
- User: structured JSON: `{ files: [...the structured triples above...] }`.
- Output schema (Zod-validated): `{ findings: Array<{ path, line?, snippet, reason, severity }> }`. Sub-agent failures (timeout, malformed JSON, both providers down per ADR-0017's fallback chain) → drop committability for the run with `degraded: [{ kind: "warning", topic: "committability", message: \`sub-agent failed: \${reason}\` }]`.

Per-question shape (mapped from sub-agent output):

```ts
{
  id: stableCommentId(...),
  kind: "question",
  category: "committability",
  tier: 2,
  file: finding.path,
  line: finding.line ?? 1,
  endLine: finding.line ?? 1,
  body: finding.reason,
  sources: [{
    type: "file",                                // SourceType
    path: finding.path,
    line: finding.line ?? 1,
    snippet: finding.snippet,
  }],
}
```

Sub-agent dispatch:

- `getWorkerCheapModel()` from `@warden/ai` (existing M4 dispatcher; routes through ADR-0017 fallback).
- Concurrency: one batch per review (the file list is bounded by 500).
- Cost accounting: log token usage for the close-out report's "per-review LLM call multiplication" caveat.

### 11. Question-citation substring-verifier (`packages/core/src/llm/verify-citations.ts`)

Runs as a post-pass over `Comment[]` (both `findings[]` and `questions[]`) before the final `CommentSet` is returned by `review()`.

Algorithm:

1. For each `Comment` whose `sources[]` is non-empty:
   - For each source whose `type === "file"`: read the cited file at `source.path` (if not already in memory; cache per review), slice to `source.line` ± 0 (exact line), normalize whitespace (collapse runs of `\s+` to a single space, trim).
   - Normalize `source.snippet` the same way.
   - Substring-match: does normalized `source.snippet` substring-appear in normalized cited line, OR in the line range `source.line ± 5` (allow the LLM to be off by a few lines)?
   - If yes: keep the source.
   - If no: drop the source from `sources[]`.
2. After source-pruning: if a `Comment` had ≥ 1 source originally and ends up with 0 sources, drop the whole Comment. Increment a `droppedCount`.
3. Emit `degraded: [{ kind: "info", topic: "llm", message: \`dropped \${droppedCount} citations without verifiable snippet\` }]` if `droppedCount > 0`.

Comments with empty `sources[]` from the start (e.g., the main review LLM's questions that don't carry citations) skip verification entirely — empty `sources[]` is the discipline, not a violation.

Failure modes: file read errors (file moved, permissions) → drop the source, log to `degraded` with topic `llm` + kind `info`.

### 12. Pipeline wiring (`packages/core/src/index.ts`)

Update `review()`:

```ts
const ecosystem = detectEcosystem(input.repoRoot);
// ...existing early-return on no package.json...

const changed = input.diff ? parseUnifiedDiff(input.diff) : undefined;
const changedPaths = changed?.map((c) => c.path) ?? [];
const addedFiles = changed?.filter((c) => c.status === "added") ?? [];

const parser = new TsCompilerParser();

// M5 selector
const selector: ContextSelector = new CheapSignalsSelector({ db, parser });

const [
  tscResult, eslintResult, vulnResult, selectorResult,
  scalabilityResult, deadcodeResult, consistencyResult, committabilityResult,
] = await Promise.all([
  runTsc(input.repoRoot, ecosystem.tsconfigPaths),
  ecosystem.hasEslint && changedPaths.length > 0
    ? runEslint(input.repoRoot, changedPaths)
    : Promise.resolve({ findings: [], degraded: [] }),
  ecosystem.lockfile
    ? runVulnerabilityCheck(input.repoRoot, ecosystem.lockfile)
    : Promise.resolve({ comments: [], degraded: [] }),
  selector.select({ repoRoot: input.repoRoot, changed: changed ?? [], ecosystem }),
  changed ? runScalability({ repoRoot: input.repoRoot, changed, parser }) : { findings: [], degraded: [] },
  changed ? runDeadcode({ repoRoot: input.repoRoot, changed, parser, db }) : { findings: [], degraded: [] },
  changed ? runConsistency({ repoRoot: input.repoRoot, changed, parser }) : { findings: [], degraded: [] },
  changed ? runCommittability({ repoRoot: input.repoRoot, changed, added: addedFiles }) : { questions: [], degraded: [] },
]);

// jscpd unchanged from M5
const candidatePaths = selectorResult.candidates.map((c) => c.path);
const scopedForJscpd = uniq([...changedPaths, ...candidatePaths]);
const jscpdResult = scopedForJscpd.length > 0
  ? await runJscpd(input.repoRoot, scopedForJscpd, new Set(changedPaths))
  : { findings: [], degraded: [] };

// npm-audit collapse (item 10)
const manifestTouched = changedPaths.some(isManifestPath);
const vulnComments = manifestTouched
  ? vulnResult.comments
  : collapseVulnComments(vulnResult.comments, vulnResult.degraded);

// Aggregate findings
const allFindings = [
  ...tscResult.findings,
  ...eslintResult.findings,
  ...jscpdResult.findings,
  ...scalabilityResult.findings,
  ...deadcodeResult.findings,
  ...consistencyResult.findings,
];

// Convert findings → assertions; sub-agent → questions
const toolComments = allFindings.map(toComment);
const subagentQuestions = committabilityResult.questions;

// Existing M4 formatter call (unchanged signature; takes the deterministic comments)
const formatted = await formatReview({
  diff: input.diff,
  toolComments,
  vulnComments,
  retrievedContext: candidatesToRetrievedContext(selectorResult.candidates, input.repoRoot),
  emit: input.emit,
});

// Merge: deterministic findings + LLM-formatted output + sub-agent questions
let comments = [
  ...applyHardRules([...formatted.comments, ...subagentQuestions], input.config),
];

// Substring-verifier post-pass (ADR-0021 #3)
const verifierResult = await verifyCitations(comments, input.repoRoot);
comments = verifierResult.comments;

// Discriminated degradedWorkers (item 7 — new shape)
const degradedWorkers: DegradedEntry[] = [
  ...tscResult.degraded,
  ...eslintResult.degraded,
  ...vulnResult.degraded,
  ...jscpdResult.degraded,
  ...selectorResult.degraded,
  ...scalabilityResult.degraded,
  ...deadcodeResult.degraded,
  ...consistencyResult.degraded,
  ...committabilityResult.degraded,
  ...verifierResult.degraded,
  ...bannerStateToDegraded(bannerState),
];
```

Banner placement (item 6): move the banner-render call from post-comments to pre-phase in `runReview()` per ADR-0019 #7's intent. One block-move.

### 13. Cheap polish items (5, 6, 12, 14)

- **Item 5** — `packages/core/src/init/index.ts`: split `summary.cachedChunks` from `summary.cachedEmbeddings`. Render line: `\`\${chunkCount} chunks (\${cachedChunks} cached) · \${newlyEmbedded}/\${chunkCount} embeddings · \${failed} failed\``. Three numbers instead of two; covers the "319 cached · 319 newly embedded" ambiguity from M6 dogfood.
- **Item 6** — banner placement: see §12 above (one block-move).
- **Item 12** — `packages/core/src/init/index.ts`: move `await ensureGitignore(repoRoot)` to *after* `readLockedModel(db)` (which is the call that triggers schema bootstrap via item 1's runtime migration). On a fresh repo, the order becomes: `db()` (auto-migrates) → `readLockedModel(db)` (now succeeds) → `ensureGitignore(repoRoot)`. If `db()` fails, `ensureGitignore` doesn't run; the side effect is atomic ("either everything happened or nothing did").
- **Item 14** — `packages/ai/src/embeddings/voyage.ts`: in `fetchOnce()`, after parsing the response JSON, assert `json.model === this._modelId`. On mismatch, throw a hard error with message `\`Voyage served '\${json.model}' but we requested '\${this._modelId}' — index integrity at risk; not embedding to avoid mixing vector spaces.\``. The thrown error propagates up through the embed phase as a normal failure (degraded entry, partial-init handling).

### 14. LLM system prompt update

`packages/core/src/llm/prompts/system.md`:

- The "Pattern shapes worth asking about" section (line 54+) currently lists scalability / consistency / deadcode / committability as questions for the LLM to look for. Update:
  - Remove scalability, consistency, deadcode from the list — detectors produce them now.
  - Keep committability as a fallback signal: "If the sub-agent missed an obvious dev-script or hardcoded-path file, you may still emit a question about it."
  - Add one paragraph: "Questions you emit may carry citations (file + line + snippet). Citations are mechanically verified against actual file content; unverifiable citations are dropped silently. Don't fabricate snippet text — quote it verbatim from the file."
- The committability sub-agent has its own prompt at `packages/core/src/llm/prompts/committability-system.md` (per §10). Keep separate — different role, different cheap-tier model.

## Conventions to enforce from day one (M7-specific)

- **Detectors emit findings with `kind: "assertion"`; sub-agent emits questions with `kind: "question"`.** No detector emits questions; no sub-agent emits assertions. The lane discipline is load-bearing.
- **Every citation across both lanes goes through the substring-verifier.** No detector or sub-agent emission bypasses the verifier. The verifier is a post-pass, not a per-detector concern.
- **`degradedWorkers` discriminated shape from day one.** Don't add a new detector emitting strings and migrate later. New code writes `{ kind, topic, message }` directly; the migration of existing call sites happens in Slice 1 before any detector lands.
- **Detectors are TS-only via `SourceParser` DI.** No detector imports `typescript` directly — only `parser.ts` does. This preserves M5's tree-sitter swap-in path for later-milestone multi-language work.
- **Sub-agent uses `getWorkerCheapModel()`, not `getBossModel()`.** The committability sub-agent is a worker, not the boss. The boss continues to be the M4 formatter.
- **Substring-verifier uses pattern-match only, not AST-aware verification.** AST-aware would require structurally-valid LLM snippets (LLMs don't produce them reliably). Substring-match catches 95% of hallucinations and is robust to LLM whitespace mangling, line-ending differences, indent drift.
- **No mid-stream re-tuning of detector thresholds.** v0 detector parameters (the trigger names, the threshold counts, the directory-concentration sub-agent skip per ADR-0022) are constants in their respective files. Configurability is later-milestone work tied to whatever per-repo config story Warden eventually grows.
- **No repo-wide deadcode scan.** The detector's reverse-import-graph queries are bounded by diff-touched + 1-hop. Repo-wide scanning is a separate audit verb (M8+).

## Slice ordering

Each slice is a coherent unit that should land + smoke before the next begins. The smoke gate isn't optional — items 1, 2, 8 are "engine-blocker" exactly because subsequent slices assume they're crossed.

| Slice | Scope | Smoke gate |
|---|---|---|
| **0** | Read this plan + ADR-0021. Confirm package boundaries against CLAUDE.md. | Plan reviewed. |
| **1** | Foundations: items 1 (runtime migration), 2 (no-embeddings banner), 7 (discriminated `degradedWorkers`), 8 (repo-root precedence), 11 (`smoke-m7-init.mts`). | Fresh repo `init` + `review` end-to-end. Phase-3-failure simulation produces the new banner state. `findRepoRoot` lands cache.sqlite at workspace root. `degradedWorkers` is fully migrated to discriminated shape across all existing call sites. |
| **2** | Item 10 (npm-audit collapse). | `warden review` on a non-manifest-touching diff returns 1 vuln Comment. Verbose mode preserves the per-advisory output. |
| **3** | Scalability detector (`runners/scalability.ts`) + system prompt update (remove scalability from "Pattern shapes worth asking about"). `smoke-m7-detectors.mts` covers it. | Run on warden's M6 PR diff. Confirm at least Copilot #6/#7/#8 fire. |
| **4** | Deadcode detector (`runners/deadcode.ts`). Smoke covers it. | Run on warden's M6 PR diff. Confirm `computeBannerState`'s `stale` branch finding fires. |
| **5** | Consistency detector (`runners/consistency.ts`). Smoke covers it. | Run on warden's M6 PR diff. Confirm README's `VOYAGE_API_KEY` claim fires. |
| **6** | Committability sub-agent (`runners/committability.ts`) + substring-verifier (`llm/verify-citations.ts`) + sub-agent dispatcher (`@warden/ai`). `smoke-m7-subagent.mts` covers it. | Run on synthesized fixture (added file matching `scripts-bootstrap-*.mts` shape with `/Users/...` content). Confirm filename-based + content-based questions fire. Confirm verifier drops a deliberately-malformed citation. |
| **7** | Polish: items 5 (init summary wording), 6 (banner placement), 12 (ensureGitignore atomicity), 14 (Voyage echo verify). | Final dogfood pass on warden's own M6 PR; on `blair`; on a third fresh repo. Validate at least 4 of the 6 Copilot-caught findings now surface. |
| **8** | Close-out: dogfood report, follow-up punch-list addendum (items 3, 4, 9, 13 from M7 plus the language-aware review guidance from Q17). ADR-0021 + this plan committed. | M7 ships. |

## Acceptance criteria for M7

When all of these pass, M7 is done:

1. `pnpm check-types` passes.
2. `pnpm lint` (oxlint) passes.
3. Fresh repo with no `.warden/cache.sqlite`: `pnpm warden init` completes without error; subsequent `pnpm warden review --stdin` completes without error. (Items 1, 8 crossed.)
4. Simulated Phase-3 failure (e.g., `WARDEN_SIMULATE_FAIL_EMBED=1` env or skipping the embed phase manually) produces the new `no-embeddings` banner state in `warden review`. (Item 2 crossed.)
5. `degradedWorkers` is `DegradedEntry[]` everywhere; the renderer reads `kind`; `--verbose` shows all three kinds. No `degradedWorkers.push("string")` call site remains. (Item 7 crossed.)
6. `pnpm smoke:m7` passes all three smoke scripts (`smoke-m7-init.mts`, `smoke-m7-detectors.mts`, `smoke-m7-subagent.mts`). (Item 11 crossed.)
7. `warden review` on a diff that doesn't touch `package.json` / lockfiles produces a single collapsed vuln summary; verbose mode preserves per-advisory output; manifest-touching diff produces full per-advisory output in both modes. (Item 10 crossed.)
8. Each of {scalability, deadcode, consistency} detector emits at least one finding on warden's M6 PR diff, matching the Copilot-caught case for that category. The findings carry valid citations that pass substring-verification.
9. Committability sub-agent emits a question on a fixture's `scripts-bootstrap-blair.mts`-shaped filename + a question on a `/Users/yash/...` content match. Both citations pass substring-verification.
10. Substring-verifier drops at least one deliberately-malformed citation (test fixture in `smoke-m7-subagent.mts`); emits the corresponding `degraded: { kind: "info", topic: "llm", message: "dropped 1 citation..." }` entry.
11. Init summary line reads as `\`319 chunks (319 cached) · 0/319 embeddings · 3 failed\`` (or analogous three-number form). Banner prints pre-phase. ensureGitignore runs after `readLockedModel`. Voyage echo verification fires on a model-mismatch test (manually flip `_modelId` after a successful API call to simulate). (Items 5, 6, 12, 14 crossed.)
12. **Dogfood validation gate**: rerun `warden review` against warden's own M6 PR (`#3`); confirm at least 4 of the 6 Copilot findings warden missed at M6 now surface as findings (the three scalability cases + the deadcode case at minimum). The 2 still-missed findings (if any) are documented in the close-out report — either as known limitations (with rationale) or as later-milestone punch-list candidates.
13. ADR-0021 + `m7-plan.md` committed. ADR-0020 namechecked as predecessor.

## What NOT to do in this milestone

- **Do not implement multi-language detector support.** All three deterministic detectors are TS-only via `TsCompilerParser`. Tree-sitter swap-in for Python / Rust / Go / Java is a later milestone.
- **Do not implement free-form prose claim extraction in consistency.** Structured-only (env vars + CLI commands + file paths). Free-form needs LLM extraction + LLM verification — entirely new worker shape; deferred.
- **Do not implement repo-wide deadcode scanning.** Diff-touched functions + one hop downstream via `import_graph`. Pre-existing dead branches in untouched code are out of scope.
- **Do not refactor `BannerState` to a discriminated-by-topic shape.** Add the `no-embeddings` peer state and align with the new `degradedWorkers` `kind` field. Broader refactor is deferred.
- **Do not implement an LLM-driven detector for scalability or deadcode.** Direct findings from deterministic AST detection only. The LLM triage layer downgrades; it doesn't author.
- **Do not ship punch-list items 3, 4, 9, 13.** Voyage retry classifier body-peek; embed-phase featureless spinner; pre-flight estimate refresh; `--simulate-fail-embed` test seam. All deferred polish.
- **Do not implement language-aware review guidance.** Total-TS-style code-quality opinions (SSOT, type reuse, `as const` / `satisfies`, avoid `any`) defer to a later milestone with their own grilling.
- **Do not implement BYOEmbedder, cross-repo retrieval, custom-code SAST worker, full `warden index export/import` CLI verbs, async/daemon `JobRunner`, cloud-hosted index, mid-stream key handling, or retrieval refinements.** All later milestones per ADR-0019.
- **Do not write tests** (per memory `user_no_tests_personal.md`: no test culture on personal repos). The smoke scripts are the validation surface.
- **Do not modify `CategoryEnum` or `KindEnum`.** Both are already correct (ADR-0020 added the four new categories; M4 added the `assertion | question` discriminator). M7 doesn't touch the schema beyond `degradedWorkers`.
- **Do not introduce a new workspace package.** All M7 code lives in `@warden/core`, `@warden/db`, `@warden/ai`, `@warden/cli`. Whether `@warden/context` or `@warden/index` ever exists is a later-milestone call when split-justification triggers fire (ADR-0019 #11).

If you reach for any of the above, stop and re-read ADR-0021 — the deferral is intentional.

## Design nuances captured during planning (for blog material)

These are the non-obvious insights from the design discussion. Worth preserving here because they're the kind of thing you only see by working through the design tree carefully — not the kind that appear in the final ADR text. Pull them into a blog post about category-extension under a citation-discipline thesis.

1. **The category list is *iterative*, not closed.** ADR-0020 added four; M7 promotes three of them to detector-asserted. Later milestones may add more (security-pattern, leverage, api-claim) and may upgrade existing categories. The architectural through-line is the *upgrade path* (categories ship as questions; promote to findings/sub-agent-citations as deterministic producers earn rent), not the specific list. Open-slot LLM questions remain a fallback for cases the detectors don't catch — and they're the *evidence corpus* for which category to add next. Every time another reviewer catches something warden missed, ask "what category did I miss?", not "what bug did I miss?" — the category answer informs future runs; the bug answer is just this PR's diff.

2. **Citation discipline generalizes from assertions to questions.** ADR-0008 said "assertions need verifiable sources." ADR-0021 strengthens to "any citation, regardless of lane, needs a verifiable source." Questions without citations stay frictionless (the common case from the main review LLM). Questions with citations (the new sub-agent shape) get the same mechanical verification assertions get. The discipline becomes uniform across lanes; only the *lane semantics* differ (questions ask, assertions claim — but both, when grounded, must echo the source). Substring-match is the cheapest possible verification; second-LLM verification reintroduces the LLM-checks-LLM trust loop.

3. **Detectors vs. sub-agents fit different points on the deterministic ↔ LLM spectrum.** The rule (canonicalised in `CONTEXT.md`): bounded *and* reliably structural across ecosystems → detector; open-ended *or* nominally bounded but context-dependent → sub-agent. Three categories satisfy the first clause (scalability via AST pattern-match, deadcode via AST + reverse import-graph, consistency via structured-verifier on env-var / CLI / file-path claims). Committability satisfies the second — supposedly-bounded subsets (dirname conventions, dev-script naming) are unreliable across ecosystems and call-sites, so an LLM sub-agent earns its keep. Treating all four uniformly (all detectors *or* all prompts) gets one of them wrong; treating each per its natural shape preserves ADR-0008 where deterministic detection is possible and acknowledges where LLM judgment is the right tool. The sub-agent path is also where later-milestone extensions of committability go (mid-file URLs, accidentally-committed `.env.local`, etc.) — regex sets saturate fast; sub-agents grow with the LLM. (Earlier drafts used a "Type 1 / Type 2 / Type 3" labelling; that taxonomy was dropped during the M7 follow-up grilling — the runner / detector / sub-agent cut in `CONTEXT.md` is the canonical vocabulary.)

4. **The committability "regex pre-filter" was almost a trap.** Initial sketch: hard-exclude `node_modules/`, `dist/`, `build/`, etc. via regex before the sub-agent sees them. User pushback: those directories *might* be intentional commits (published artifact, workaround for broken dependency). Refining to a Tier-1 hard-skip (only patterns that are *never* intentional: `.git/`, `*.pyc`, `*.swp`, OS temp files) plus letting the sub-agent decide for ambiguous cases is the principled answer. The general lesson: hard exclusions are a form of pre-judging that conflicts with "let the LLM use its judgment." Use exclusions only for *truly* universal noise; trust the sub-agent for the rest.

5. **The npm-audit collapse is M3 behavior leaking into M6 dogfood.** The 62-finding-on-`package.json:1` dump existed in M3 and never bothered anyone because there was no diff-relevance signal. M6's semantic signal made *relevant* code float to the top — and the dump drowns the relevance. M7 doesn't fix M3; M7 fixes M6's *visibility* of M3. The general lesson: a behavior is "fine" until a downstream change makes it user-visible in a way it wasn't before. Find the leaks by re-reading old behaviors under new visibility.

6. **`degradedWorkers` discriminated shape is more important than it looks.** The flat string array seemed adequate until Q4 + Q11 both demanded different `kind` semantics: actionable (banner-eligible), warning (verbose-only failure), info (forensic count). Substring-prefix matching on string content was the M6 workaround for the missing structure. The discriminated shape is the load-bearing primitive that lets the banner be a `kind`-filter, not a string-startsWith hunt. The renderer's prefix-match list was a code smell; the shape change retires it. Generalizing: when you find yourself substring-matching prefixes to drive control flow, the message is asking you to make the structure explicit.

7. **Item 1 (runtime migration) is the highest-leverage single change in M7.** One function call, gated behind a singleton promise. Without it, every fresh-repo path crashes. With it, M7's quality lift becomes visible to anyone trying warden on a new repo. The biggest gaps between "works for me" and "works for anyone" are usually one missing `migrate()` call, one missing `mkdir -p`, one missing default-config write — pre-installed bootstraps the author never noticed because their environment already had the bits. Worth dogfooding on at least three fresh repos to confirm the migration path works across pnpm-cached vs. npm-cached vs. fresh-install.

8. **The dogfood validation gate is the acceptance criterion that matters.** Items 1–11 are mechanical: they pass or fail. Item 12 (rerun against M6 PR; catch at least 4 of the 6 Copilot findings) is the qualitative gate that says M7 actually *closed the gap that motivated it*. Mechanical pass without qualitative pass means we shipped four detectors that don't, in practice, catch the cases they were built for. Validation against the original motivating evidence is the only honest acceptance signal.

9. **Sequencing detectors in increasing-novelty order is risk management.** Scalability is the simplest (single-file AST query). Deadcode adds reverse import-graph traversal. Consistency adds doc parsing + zod schema introspection. Committability adds the sub-agent — a new pipeline shape (LLM call as a worker). Landing them in this order means each new piece sits on top of a stable foundation; the most novel piece (sub-agent) lands last when the worker pipeline is well-exercised. The opposite ordering (sub-agent first) is faster to validate the new shape but compounds integration risk.

10. **Language-aware review guidance is a *separate* milestone, not M7 polish.** TS-quality opinions (Total-TS patterns, SSOT, type reuse) feel like they could ride along in M7's prompt update. Resisting that urge: the language-guidance design space (static prompt section vs. retrieval-augmented vs. hybrid; per-language scoping; corpus curation; how it interacts with M6's chunk store) is its own grilling. Folding a half-formed version into M7 either ships a saturating baseline that inhibits later redesign (the prompt-section trap) or balloons scope (retrieval-augmented at this stage). Deferring to a later milestone keeps the choice coherent. The general lesson: when a question deserves its own grilling, *don't sneak its half-answer into the current grilling's plan*.

11. **The M5 selector weight terminology trap.** Q3 of the M7 grilling proposed "flipping" the cheap-signals weights so blast-radius (`imported-by`) wins over contracts (`imports`). The proposal was sound; the labels in the proposal were inverted from the labels in the code. Reading the actual constants showed the desired state was already shipped. The trap: when the *direction* of an asymmetry is hidden behind English labels ("things that depend on" vs. "things depended on by"), it's easy to argue past oneself about which side has the higher weight. The fix: always check the code's actual constants before ratifying a weight change. Generalized: when proposing a numeric tuning, *quote the existing constants* in the proposal.

12. **ADR-0021 amends ADR-0008 by extending citation discipline to questions.** Until now, questions were citation-free by design (asking is not claiming). The committability sub-agent emits citations alongside its questions; ADR-0021 extends the discipline to those citations. The original ADR-0008 invariant ("the LLM cannot author findings without a tool source") is preserved — the sub-agent isn't asserting findings, it's asking grounded questions whose grounding is mechanically checkable. The general principle: when a new emission shape lands (sub-agent questions with citations), the relevant invariant either bends to accommodate it or stays invariant by extending uniformly to the new shape. Uniform extension is almost always the better choice.

13. **The "build the seam, don't fill it" temptation is sometimes just dead architecture.** The M7 grilling's first sketch had a doc-claim-extractor + verifier-phase architecture for consistency. Refining v0 to deterministic-only (env vars / CLI / file paths) collapsed to a single worker — the verifier phase had nothing to do. "Reserve the architectural slot for later-milestone free-form prose" sounds prudent; in practice, empty seams accumulate when there's no consumer testing them. The principle: build seams when you have a concrete consumer about to materialize, not when there's a hypothetical future use case. The relevant later milestone can add the seam itself when free-form prose claims earn rent.

Each of these came out of walking the M7 design tree question-by-question instead of writing the plan top-down. The point of grilling is that the eventual plan is the *survivor* of decisions, not the *first draft* of them.

## When you're done

- Hand back: a list of any deviations from this plan (with reasons) and confirmation all acceptance criteria pass.
- The next sessions are M8 (boss/worker orchestration) and M9 (diff-level noise filter per ADR-0022). Beyond those, residual deferred work includes: punch-list items 3/4/9/13 (polish carryover), language-aware review guidance (deferred from M7 Q17 with its own grilling), tree-sitter / multi-language detector support, free-form prose claim extraction in consistency, repo-wide deadcode scan as an audit verb, BYOEmbedder, cross-repo retrieval + leverage category, custom-code SAST worker (DeepSec-shaped per ADR-0015), full `warden index export/import` CLI verbs, async/daemon `JobRunner`, cloud-hosted index, mid-stream key-change handling, retrieval refinements. Each later milestone picks its slice via its own grilling.

---

## Lessons from M7 → M8 transition

*(Empty — append after M7 ships and dogfooding reveals real bugs / refinements / open seams that should inform M8. Mirrors the m5-plan.md / m6-plan.md pattern: the "Lessons from M5 → M6" section in m6-plan.md was populated post-M6-dogfood and became the M7 punch list; this section is the equivalent slot for M7's dogfood evidence.)*
