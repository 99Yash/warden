# Warden — M5 Plan (cheap-signals context selector + jscpd dedup runner)

This is the milestone brief for the agent (or future-me) implementing M5. Self-contained: read this plus `decisions.md` ADR-0016 + ADR-0018 and you have everything.

## Read first (in this order)

1. **`./decisions.md`** — focus on ADR-0008 (citation thesis), ADR-0012 (priority order, `dedup` category), ADR-0013 (I/O-pure core), ADR-0016 (storage discipline), and ADR-0018 (this milestone's direction). Skim the rest.
2. **`./CLAUDE.md`** — repo orientation. The package boundaries table is load-bearing; M5 must not violate it.
3. **`./packages/core/src/index.ts`** — current pipeline. Note that `RetrievedContext` is *already* a typed seam in `ReviewInput` (M4 left it as `{ chunks: [] }` for forward-compat). M5 populates it; the surrounding contract doesn't change.
4. **`./packages/db/src/schema/external-knowledge.ts`** — schema-file convention. M5's two new schemas mirror this shape.
5. The "Design nuances captured during planning" section at the bottom of this doc — captures the non-obvious refinements from the planning grilling. Worth reading before writing code, not after.

## Goal of this milestone

Implement **M5: cheap-signals context selector + jscpd dedup runner**. By the end:

- `warden review` against a TS Turborepo runs the selector in parallel with TSC/ESLint/vuln, then runs jscpd scoped to `changedFiles ∪ selector.candidates`, then passes selector output to the LLM formatter via the existing `retrievedContext` field.
- The LLM prompt includes evidence ranges (±5 lines) for evidence-bearing reasons and a path-only list for same-folder neighbors.
- Two new tables in `@warden/db`: `import_graph` (content-addressed cache) and `file_state` (git-driven staleness pointer). Generated via `pnpm db:generate` and applied via `pnpm db:migrate`.
- `pnpm check-types` passes.
- First `warden review` after install surfaces `"context: cold import-graph build…"` in `degradedWorkers`. Subsequent reviews are fast (cache hits).
- `dedup` category Comments now appear in `--verbose` mode for repos with cross-file clones.
- All M4 behavior preserved (no regression in TSC/ESLint/vuln/LLM flow).

**Stop at "selector + jscpd + cache work end-to-end on Alfred / milkpod / blair." Do NOT start implementing embeddings, Merkle, `warden init`, or the limitation banner.** Those are M6.

## Repo additions

```
packages/core/src/context/
├── index.ts                 # exports ContextSelector interface, default impl, types
├── selector.ts              # CheapSignalsSelector implementation
├── parser.ts                # SourceParser interface + TsCompilerParser impl
├── signals/
│   ├── imports.ts           # direct-importer + direct-import signals
│   ├── same-folder.ts       # same-folder-siblings signal
│   └── symbol-refs.ts       # symbol-name grep signal
└── prompt.ts                # evidence-range prompt-assembly helper

packages/core/src/runners/jscpd.ts   # jscpd programmatic-API runner

packages/db/src/schema/
├── import-graph.ts          # content-addressed parsed-imports cache
└── file-state.ts            # path → current-sha pointer for git-driven staleness
```

No new workspace package. Whether `@warden/context` exists is a M6 decision (see ADR-0018 alternatives).

## Package boundaries to honor

- All M5 code lives in `@warden/core`. No new workspace package — that happens at M6 when the embedding layer earns the boundary.
- `@warden/core` stays I/O-pure per ADR-0013: the selector reads files (it has to, to parse imports) but never writes to stdout, never assumes a TTY, never reads `process.argv`. All output flows through the function return value.
- The jscpd runner mirrors the existing runner shape from `packages/core/src/runners/types.ts`. `jscpd` is added to `@warden/core`'s `dependencies` (programmatic API, not a CLI subprocess).
- `@warden/db` gets two new schema files. `pnpm db:generate` produces a migration. **Never `db:push`** outside local exploration (CLAUDE.md rule).

## What to build

### 1. `SourceParser` interface + TS Compiler API impl (`context/parser.ts`)

Public shape:

```ts
export interface ImportRef {
  module: string;          // 'react' | './session' | '@warden/core'
  resolved?: string;       // absolute path; undefined for unresolved external (e.g. node_modules)
  kind: "value" | "type"; // import vs import type
  symbols: string[];       // [] for default/namespace-only; ['foo','bar'] for named imports
  startLine: number;
  endLine: number;
}

export interface ExportRef {
  symbol: string;          // 'login' | 'default'
  startLine: number;
  endLine: number;
}

export interface SourceParser {
  imports(absPath: string, content: string): Promise<ImportRef[]>;
  exports(absPath: string, content: string): Promise<ExportRef[]>;
}
```

`TsCompilerParser` impl:

- Use `ts.createSourceFile(path, content, ts.ScriptTarget.Latest, /*setParentNodes*/ false)` — pure parse, no type-check, fast (~few ms per file).
- Walk for `ImportDeclaration`, `ExportDeclaration`, `ExportAssignment`, `ImportEqualsDeclaration` nodes. Collect refs.
- Resolve module paths via `ts.resolveModuleName(...)` against `tsconfig.json`'s `compilerOptions.paths` (load + cache `tsconfig` once per `select()` call).
- External modules (resolution lands in `node_modules` or fails) get `resolved: undefined`. They still occupy edges in the graph but don't enter the candidate set.

Why this interface, not direct `ts.*` calls inside the selector: the entire point is that the tree-sitter swap-in for multi-ecosystem (M6+) drops in alongside `TsCompilerParser` without rewriting selector code. **No selector signal file should ever import `typescript` directly** — only `parser.ts` does.

### 2. Cache schemas

`packages/db/src/schema/import-graph.ts`:

```ts
import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core";

export const importGraph = sqliteTable("import_graph", {
  filePath: text("file_path").notNull(),
  fileSha: text("file_sha").notNull(),
  importsJson: text("imports_json").notNull(),       // JSON.stringify(ImportRef[])
  exportsJson: text("exports_json").notNull(),       // JSON.stringify(ExportRef[])
  computedAt: integer("computed_at", { mode: "timestamp" }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (t) => ({
  pk: primaryKey({ columns: [t.filePath, t.fileSha] }),
}));
```

`packages/db/src/schema/file-state.ts`:

```ts
export const fileState = sqliteTable("file_state", {
  filePath: text("file_path").primaryKey(),
  currentSha: text("current_sha").notNull(),
  observedAt: integer("observed_at", { mode: "timestamp" }).notNull().default(sql`CURRENT_TIMESTAMP`),
});
```

Re-export both from `packages/db/src/schemas.ts`. Run `pnpm db:generate` — commits a `*.sql` file to `packages/db/src/migrations/`. Run `pnpm db:migrate` to apply locally.

### 3. ContextSelector + types (`context/index.ts`)

```ts
import type { ChangedFile } from "../diff/index.js";
import type { EcosystemContext } from "../ecosystem/index.js";

export type Evidence = { startLine: number; endLine: number };

export type Reason =
  | { kind: "imported-by"; from: string; evidence?: Evidence[] }     // lines in candidate where exported symbols live
  | { kind: "imports"; target: string; evidence?: Evidence[] }       // import-statement line(s) + usage call sites in candidate
  | { kind: "same-folder"; sibling: string }                         // path-only signal, no evidence
  | { kind: "symbol-ref"; symbol: string; evidence: Evidence[] };    // grep-hit lines in candidate

export type ContextCandidate = {
  path: string;            // repo-relative
  score: number;           // 0..1, higher = more relevant
  reasons: Reason[];
};

export type SelectorOutput = {
  candidates: ContextCandidate[];
  degraded: string[];      // surfaced via metadata.degradedWorkers
};

export interface ContextSelector {
  select(input: {
    repoRoot: string;
    changed: ChangedFile[];
    ecosystem: EcosystemContext;
  }): Promise<SelectorOutput>;
}
```

### 4. `CheapSignalsSelector` flow

Pseudocode for one `select()` invocation:

```ts
// 1. Source-file universe via git ls-files (skip node_modules, dist, .next, .turbo, .git automatically)
const allFiles = await gitLsFiles(repoRoot);  // ['packages/cli/src/index.ts', ...]

// 2. Refresh staleness pointer for git-modified + untracked files
const dirty = await gitLsModifiedAndUntracked(repoRoot);  // git ls-files --modified --others --exclude-standard
for (const path of dirty) {
  const sha = await sha256(absPath(repoRoot, path));
  await db.upsert(fileState, { filePath: path, currentSha: sha, observedAt: new Date() });
}

// 3. For every source file, look up (path, currentSha) in import_graph; cache miss → parse + insert.
//    Parallelized via Promise.all chunked by N=20 to avoid file-handle exhaustion.
//    Files whose currentSha is unknown to file_state get hashed on the fly (first-run case).
const graph: Record<string, { imports: ImportRef[]; exports: ExportRef[] }> = await buildGraph(allFiles);

// 4. Compute reverse import index per-run (cheap, derived).
const reverse: Record<string, Set<string>> = deriveReverse(graph);

// 5. Run signals against the changed files.
//    - Direct importers: for each changed file F, reverse[F] yields candidate paths.
//    - Direct imports:   for each changed file F, graph[F].imports → resolved paths.
//    - Same-folder:      dirname(F) glob; capped at e.g. 12 paths.
//    - Symbol refs:      for each exported symbol S in changed files, regex \bS\b across allFiles.
const signalHits: PerCandidateReasons = aggregate(...);

// 6. Score: sum(reasonWeight) where weights are
//    imported-by: 1.0, imports: 0.8, symbol-ref: 0.6, same-folder: 0.3.
//    Normalize by max possible (sum of all weights) → 0..1.
//    Exclude changed files themselves from the candidate set.
const ranked: ContextCandidate[] = score(signalHits);

// 7. Cap: top-8 content-bearing (any reason except same-folder-only) + top-12 same-folder-only paths.

// 8. degraded[]: surface partial failures
//    - "context: tsconfig paths unresolved — symbol search reduced"
//    - "context: cold import-graph build (parsed N files in Ts)"  ← only on first run / cold cache
//    - "context: zero imports found in changed files — falling back to same-folder + symbol-ref"
return { candidates: ranked, degraded };
```

### 5. jscpd runner (`runners/jscpd.ts`)

```ts
import { JSCPD } from "jscpd";

export async function runJscpd(
  repoRoot: string,
  scopedPaths: string[],          // changed ∪ selector.candidates
  changedPaths: Set<string>,
): Promise<{ findings: ToolFinding[]; degraded: string[] }> {
  if (scopedPaths.length === 0) return { findings: [], degraded: [] };

  const jscpd = new JSCPD({
    minTokens: 50,
    minLines: 5,
    silent: true,
  });
  const clones = await jscpd.detectInFiles(scopedPaths.map(p => path.join(repoRoot, p)));

  const findings: ToolFinding[] = [];
  for (const clone of clones) {
    const aRel = relFromRepoRoot(clone.duplicationA.sourceId);
    const bRel = relFromRepoRoot(clone.duplicationB.sourceId);
    const aChanged = changedPaths.has(aRel);
    const bChanged = changedPaths.has(bRel);
    if (!aChanged && !bChanged) continue;        // pair must touch the diff

    // Side that touches the diff is the "site" of the comment.
    const site  = aChanged ? clone.duplicationA : clone.duplicationB;
    const other = aChanged ? clone.duplicationB : clone.duplicationA;
    findings.push({
      source: "jscpd",
      ruleId: undefined,
      file: relFromRepoRoot(site.sourceId),
      line: site.start.line,
      endLine: site.end.line,
      severity: "warning",
      message: `Duplicate of ${relFromRepoRoot(other.sourceId)}:${other.start.line}-${other.end.line}`,
    });
  }
  return { findings, degraded: [] };
}
```

The category mapper in `packages/core/src/index.ts`'s `mapSeverity()` adds a case for `f.source === "jscpd"` → `{ tier: 3, category: "dedup" }`.

### 6. Pipeline wiring (`packages/core/src/index.ts`)

Update `review()`:

```ts
const ecosystem = detectEcosystem(input.repoRoot);
// ...existing early-return on no package.json...

const changed = input.diff ? parseUnifiedDiff(input.diff) : undefined;
const changedPaths = changed?.map((c) => c.path);

const selector: ContextSelector = new CheapSignalsSelector({ db, parser: new TsCompilerParser() });

const [tscResult, eslintResult, vulnResult, selectorResult] = await Promise.all([
  runTsc(input.repoRoot, ecosystem.tsconfigPaths),
  ecosystem.hasEslint && changedPaths && changedPaths.length > 0
    ? runEslint(input.repoRoot, changedPaths)
    : Promise.resolve({ findings: [], degraded: [] }),
  ecosystem.lockfile
    ? runVulnerabilityCheck(input.repoRoot, ecosystem.lockfile)
    : Promise.resolve({ comments: [], degraded: [...] }),
  selector.select({ repoRoot: input.repoRoot, changed: changed ?? [], ecosystem }),
]);

const candidatePaths = selectorResult.candidates.map(c => c.path);
const scopedForJscpd = uniq([...(changedPaths ?? []), ...candidatePaths]);
const jscpdResult = scopedForJscpd.length > 0
  ? await runJscpd(input.repoRoot, scopedForJscpd, new Set(changedPaths ?? []))
  : { findings: [], degraded: [] };

const allFindings = [
  ...tscResult.findings,
  ...eslintResult.findings,
  ...jscpdResult.findings,
];
// (remainder identical to M4: scopeToDiff, toComment, vulnComments aggregation, etc.)

if (input.config.mode === "review" && comments.length > 0) {
  const formatted = await formatReview({
    diff: input.diff,
    toolComments,
    vulnComments,
    retrievedContext: candidatesToRetrievedContext(selectorResult.candidates, input.repoRoot),
    emit: input.emit,
  });
  // ...
}

const degraded = [
  ...tscResult.degraded,
  ...eslintResult.degraded,
  ...vulnResult.degraded,
  ...jscpdResult.degraded,
  ...selectorResult.degraded,
];
```

`candidatesToRetrievedContext()` lives in `context/prompt.ts`:

- For each evidence-bearing candidate, read the file content once, slice to evidence ranges with ±5 lines, dedupe/merge overlapping ranges.
- For same-folder-only candidates, emit path entries (no content).
- Returns the existing `RetrievedContext` shape that `formatReview` already accepts.

### 7. LLM prompt update

`packages/core/src/llm/prompts/user-template.md` (or whichever file M4 settled on per ADR-0015's prompts-as-files rule) gets a new section before the diff. Sketch:

```
## Adjacent files (with evidence)
{{#each contentBearing}}
{{this.path}}
  {{#each this.reasons}}
  [{{this.kind}}{{#if this.label}} {{this.label}}{{/if}}] L{{this.startLine}}–L{{this.endLine}}
  ```{{this.languageHint}}
  {{this.codeExcerpt}}
  ```
  {{/each}}
{{/each}}

## Same-folder neighbors (paths only)
{{#each sameFolder}}
- {{this}}
{{/each}}
```

The system prompt grows a paragraph instructing the LLM to:

1. Cite adjacent-file evidence ranges by `path:line` when claims reference them.
2. Never invent details about non-evidence files; same-folder neighbors are awareness signal only — do not claim things about them.
3. Treat absence of context as absence of evidence: if a file isn't shown, the LLM doesn't know what's in it, so it shouldn't speculate.

(Templating engine choice is whatever M4 used. The key concern is that the prompt is a file, per ADR-0015.)

## Conventions to enforce from day one (M5-specific)

- **Selector emits paths + reasons; never reads file content for prompt assembly.** File I/O for content excerpts happens in `candidatesToRetrievedContext` (the prompt-assembly layer), not in the selector. Keeps the selector pure-ranking and easy to test in isolation.
- **Cache rows are immutable.** Never `UPDATE` a row in `import_graph`; always `INSERT OR IGNORE` keyed by `(file_path, file_sha)`. Stale rows for the same path with old SHAs are harmless — content-addressing guarantees correctness.
- **Per-review staleness check is git-driven.** Default impl uses `git ls-files --modified --others --exclude-standard`. If git is unavailable (rare, but possible in pristine CI containers), fall back to hashing every source file with a `degraded[]` line surfacing the cost.
- **Score weights are constants in v1.** No flag plumbing for weight tuning. Defer config surface until dogfooding shows the defaults are wrong.
- **No repo-wide jscpd, ever.** If `scopedForJscpd` is empty, skip jscpd entirely. Never call `detectInFiles(allFiles)`.
- **No `typescript` import outside `parser.ts`.** Selector signal files import only from `parser.ts`'s exported interface and types. This is what makes the tree-sitter swap-in cheap when multi-ecosystem lands.

## Acceptance criteria for M5

When all of these pass, M5 is done:

- `pnpm check-types` passes.
- `pnpm lint` (oxlint) passes.
- `pnpm db:generate` produces a migration containing the two new tables; `pnpm db:migrate` applies cleanly to a local `.warden/cache.sqlite`.
- `pnpm warden review` on a TS Turborepo:
  1. Runs the selector visibly (phase log, if M4's render UX shows phases).
  2. First run surfaces `"context: cold import-graph build (parsed N files in Ts)"` in `degradedWorkers`.
  3. Subsequent runs hit the cache (no cold-start line).
  4. Returns `Comment`s in the existing schema with no schema breakage.
- `pnpm warden review --verbose` on a repo with cross-file clones surfaces tier-3 `dedup` Comments (jscpd-sourced).
- LLM prompt includes evidence ranges for evidence-bearing reasons and a path-only same-folder list. Inspect by enabling whatever debug surface M4 provides for prompts (or temporarily logging).
- `pnpm warden check` (deterministic-only) is unchanged in behavior. Selector and jscpd may run, but the LLM is not invoked. (Or: `check` skips the selector entirely. Either is acceptable since `check`'s output is fixed-format. Pick whichever results in simpler code.)
- No regression in M4 behavior on diffs that produce zero adjacent context (selector returns empty; pipeline degrades gracefully).
- Run on Alfred, milkpod, blair (or any other dogfood Turborepo). Confirm review-quality improvement vs. M4 baseline by reading the comments produced. (Subjective — the user is the eval signal per ADR-0001.)

## What NOT to do in this milestone

- **Do not implement embeddings, chunk store, Merkle store, `JobRunner`, or any vector-DB integration.** All M6.
- **Do not ship `warden init`.** Lazy population per review is the M5 UX; M6 lands `init` as a real verb.
- **Do not ship the limitation banner.** `degraded[]` lines are sufficient surface for M5's cold-start cost.
- **Do not index `node_modules` or any cross-repo source.** `import` resolution may *touch* `node_modules` to resolve module IDs, but external imports are recorded as `{ resolved: undefined, module: 'react' }` opaque edges; they don't enter the candidate set.
- **Do not add the `leverage` review category.** Depends on cross-repo indexing (deferred to M6) and the API claim verifier (M6+).
- **Do not introduce tree-sitter.** TS Compiler API behind `SourceParser` is the v1 plan; tree-sitter swap-in is for the multi-ecosystem milestone.
- **Do not refactor `@warden/core` into multiple packages.** Whether `@warden/context` ever exists is M6's call.
- **Do not pre-compute or pre-cache embeddings, Merkle hashes, or LLM-generated summaries.** Cheap signals don't need them.
- **Do not surface heuristic-dir signals (`utils/`, `lib/`, `shared/`) or test-pairing signals.** Defer.
- **Do not write tests** (per memory: no test culture on personal repos). Smoke scripts under `scripts/smoke-*.ts` if needed.

If you reach for any of the above, stop and re-read ADR-0016 + ADR-0018 — those are explicitly deferred.

## Design nuances captured during planning (for blog material)

These are the non-obvious insights from the design discussion. Worth preserving here because they're the kind of thing you only see by working through the design tree carefully — not the kind that appear in the final ADR text. Pull them into a blog post about implementing context selection in a one-shot CLI without committing to embeddings on day one.

1. **Content-addressing turns "cache invalidation" into "cache lookup."** A `(path, sha)`-keyed row is forever-valid for that exact content; the row never goes stale, only unreachable. Invalidation reduces to: *given a path, how do I cheaply know the current SHA?* For M5, the answer is `git`, which is already a hard prereq. Merkle trees are useful at chunk-level granularity (M6); for file-level, `git ls-files --modified` is precisely the right cost/granularity tradeoff. The instinct that "we have to invalidate the cache" was right — but the answer wasn't a Merkle tree. It was *picking a different change-detection oracle*.

2. **Evidence ranges beat full-file dumps for the LLM.** First draft: top-N candidates × full file content (capped 500 lines) → ~12k tokens of context. Refined: each `Reason` carries `Evidence: { startLine, endLine }[]` pointing at the trigger lines, and the prompt emits only those ranges with ±5 surrounding lines → ~3–5k tokens. Better grounding (the lines that *caused* the candidate to surface), better citation precision (LLM can quote specific evidence ranges), lower cost. Surfaced by the user during grilling, not pre-conceived. The principle: every signal already knows *why* it fired; carry that *why* into the artifact downstream consumers see.

3. **Same-folder is path-only because folders are noisy.** Dropping same-folder content from the prompt was non-obvious: same-folder is high-recall but low-precision (a 50-file `auth/` folder has plenty of unrelated files). Treating it as a tertiary signal — feeding jscpd by path, listing names in the LLM prompt without content — preserves the value while avoiding context-window pollution. The general lesson: a signal can be *useful for ranking* without being *useful as content*.

4. **`warden init` would have semantic drift if shipped in M5.** A subcommand named "init" that warms only the import-graph cache is a thin verb whose contract has to expand at M6 (also building chunks, embeddings, Merkle). Users running M5's `init` once and assuming "I'm done indexing" would be wrong by M6. The right answer: defer the verb until its full meaning lands, surface M5's cold-start cost via `degraded[]` instead. Verbs are commitments; reduced-meaning versions of them are usability debt.

5. **Tree-sitter is the next-ecosystem decision, not the next-milestone decision.** Tempting because Cursor uses it and ADR-0016 references it as prior art, but inside a TS-only stack tree-sitter is a heavy WASM dep with no upside over the TypeScript Compiler API (already a transitive dep). Putting parsing behind a `SourceParser` interface lets the swap happen when Python/Go arrive, not earlier. Choosing tools by *which problem they solve* (multi-language) instead of *which problem looks like them* (parsing TS).

6. **Separating ranking from I/O lets v2 swap in without touching consumers.** Selector emits paths + reasons; the prompt-assembly layer reads files and slices evidence ranges. That means the v2 embedding-backed selector — which produces a `{ kind: "semantic"; chunkHash }` reason variant — drops in without changing prompt assembly, jscpd integration, or the cache schema. ADR-0016's "interface design happens with the implementation, not now" caveat is honored: M5's interface shape is determined by M5's actual consumers, not pre-guessed for M6's hypothetical ones.

7. **jscpd's value is the dedup category, not raw clone detection.** The naive read of jscpd is "find duplicate code." The Warden-shaped read: jscpd is the runner that finally fills the `dedup` category ADR-0012 created two milestones ago. The selector's path set is precisely what jscpd needs (changed-file-relevant scope, not repo-wide noise) — without the selector, jscpd produces too much output to be useful; with the selector, it produces exactly the dedup signal the LLM should triage. Two unrelated-seeming pieces of work — context selection and dedup — turn out to be the same milestone because their inputs are the same set.

8. **The LLM doesn't need to "search" — it needs to be *given*.** A tempting alternative for context retrieval is agentic: emit paths, let the LLM use a `Read` tool to fetch files. Rejected because it adds multi-turn latency, conflicts with the one-shot pipeline shape (ADR-0014), and shifts hallucination risk to a layer where it's harder to audit. Pre-resolving evidence ranges and putting them directly in the prompt keeps the citation surface deterministic.

Each of these came out of a single planning session by walking the design tree question-by-question instead of writing the plan top-down. The point of grilling is that the eventual plan is the *survivor* of decisions, not the *first draft* of them.

## When you're done

- Hand back: a list of any deviations from this plan (with reasons) and confirmation all acceptance criteria pass.
- The next session picks up at M6 (embedding-backed selector, chunk/Merkle/embedding stores, `JobRunner` queue, `warden init`, limitation banner).

---

## Lessons from M5 → M6 transition

*(Empty — append after M5 ships and dogfooding reveals real bugs / refinements / open seams that should inform M6. Mirrors Alfred's pattern.)*
