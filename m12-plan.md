# Warden — M12 Plan (`leverage` review category — bounded stdlib detector + Haiku sub-agent)

This is the milestone brief for the agent (or future-me) implementing M12. Self-contained: read this plus `decisions.md` ADR-0027 and you have everything.

M12 cashes the architectural keystone framing from ADR-0026. M11 shipped the API claim verifier half of "extend ADR-0008's citation thesis to library API claims"; M12 ships the producer half — a sixth `CategoryEnum` slot for "this hand-rolled code duplicates a library or stdlib primitive," realised as **two runners under one category**. The detector handles the bounded, ecosystem-independent stdlib idiom misses (`JSON.parse(JSON.stringify)` → `structuredClone`, etc.); the sub-agent handles the open-ended library-specific suggestions (Drizzle `with:`, Elysia `.guard()`, AI SDK `Output.array`, etc.) using M11's `lookupTypeDef` to verify whatever library API it cites.

## Read first (in this order)

1. **`./decisions.md`** — focus on **ADR-0027** (the M12 design commit). Also: ADR-0026 (M11 keystone — `lookupTypeDef`, `api_def` source, verifier behaviour); ADR-0021 §3 (M10 substring-verifier + question-citation discipline — leverage sub-agent rides this path unchanged); ADR-0023 (M8 orchestration spine — both runners ride the `Runner` contract); ADR-0020 (priority-order extension precedent).
2. **`./CONTEXT.md`** — §2 (Findings, comments, citations) for the `kind: "assertion"` vs `kind: "question"` split + `Source.type` variants; §3 (Models + AI layer) for `getWorkerCheapModel()` + `lookupTypeDef`; §5 (Runners) for the detector-vs-sub-agent rule the M12 fork honours.
3. **`./CLAUDE.md`** — package boundary table; AI SDK v6 notes; current milestone status.
4. **`./packages/core/src/schema.ts`** — `CategoryEnum` (lines 28–43). M12 adds **one enum value** (`'leverage'`).
5. **`./packages/core/src/index.ts`** — `PRIORITY_ORDER` (near `applyHardRules`). M12 adds **one slot** between `'style'` and `'dedup'`. Also: `orchestrationRunners` registration — M12 wires both new runners here.
6. **`./packages/core/src/runners/types.ts`** + **`./packages/core/src/runners/to-comment.ts`** — M12 adds the internal `ToolFinding.source === "leverage"` producer and maps it to `category: "leverage"`, `tier: 2`. If the detector carries snippet evidence, `toComment()` copies it into the existing `SourceSchema` `{path,line,snippet}` triple.
7. **`./packages/core/src/runners/scalability.ts`** — the detector-shape precedent. M12's leverage detector mirrors the AST-visitor + `Runner`-contract wrapper pattern.
8. **`./packages/core/src/runners/committability.ts`** — the sub-agent-shape precedent. M12's leverage sub-agent mirrors the Haiku fallback + cheap-tier-model + own-prompt + per-finding citation pattern.
9. **`./packages/core/src/llm/prompts/committability-system.md`** — the sub-agent-prompt precedent for tone, structure, and how to wire questions through to the schema.
10. **`./packages/core/src/llm/prompt-loader.ts`** — M12 adds `loadLeverageSystemPrompt()` alongside the existing `loadCommittabilitySystemPrompt()` + formatter-system loader.
11. **`./packages/core/src/llm/tools/lookup-type-def.ts`** — the M11 tool descriptor. M12's sub-agent imports `makeLookupTypeDefTool()` and passes the tool through its own `streamText` call.
12. **`./packages/core/src/api/lookup-type-def.ts`** — M12 may harden package-root lookup for pnpm workspaces by trying the nearest touched package roots before declaring `package_not_installed`; no cache-table shape changes.
13. **`./packages/core/src/llm/verify-citations.ts`** — the M10/M11 verifier. M12 does **not** modify this file — the detector's optional `tool` snippet sources and the sub-agent's `api_def` sources flow through the existing dispatch unchanged.

## Goal of this milestone

Land ADR-0027's design in a single coherent slice:

- **`'leverage'` in `CategoryEnum`** — one enum value; no new fields, no schema migration.
- **`'leverage'` slotted in `PRIORITY_ORDER`** — between `'style'` and `'dedup'` (per ADR-0027 §5).
- **Leverage detector** — pure AST runner at `packages/core/src/runners/leverage.ts`. Three v0 patterns (`JSON.parse(JSON.stringify)` → `structuredClone`; `indexOf !== -1` → `includes`; `filter(p).length > 0` / `find(p) !== undefined` → `some(p)`). Emits `ToolFinding[]` with `source: "leverage"` and optional snippet evidence that `toComment()` carries as a `type: "tool"` source triple. Rides the M8 `Runner` contract.
- **Leverage sub-agent** — cheap-tier (Haiku) runner at `packages/core/src/runners/leverage-libraries.ts`. Mirrors committability's harness: own system prompt, own `streamText` call with cheap-tier fallback, own per-finding citation discipline. Receives a dependency preamble from the root package plus touched workspace package manifests and the four canonical library examples in its system prompt. Has access to M11's `lookupTypeDef` tool. Emits `Comment[]` of `kind: "question"` carrying `api_def` sources verified post-pass by the existing global verifier.
- **Sub-agent system prompt** — `packages/core/src/llm/prompts/leverage-system.md`. Library-agnostic with four canonical examples (Drizzle `with:`, Elysia `.guard()`, AI SDK `Output.array(...)`, Drizzle `onConflictDoNothing()`). Instructs the LLM to consult `lookupTypeDef` before asserting a library API and to copy `result.suggestedSource` verbatim into `sources[]`.
- **Prompt loader extension** — add `loadLeverageSystemPrompt()` to `packages/core/src/llm/prompt-loader.ts` mirroring `loadCommittabilitySystemPrompt()`.
- **Dispatch registration** — both runners join `orchestrationRunners` in `packages/core/src/index.ts`. Detector unconditional; sub-agent gated to `input.config.mode === "review"`.
- **Smoke harness** — `smoke-m12-detector.mts` (asserts the three patterns fire + don't double-fire with scalability/dedup) and `smoke-m12-sub-agent.mts` (asserts the sub-agent calls `lookupTypeDef`, emits questions with verified `api_def` sources, drops on hallucination).

By the end:

- `warden review` on a fixture diff containing `JSON.parse(JSON.stringify(x))` emits an assertion-kind Comment with category `leverage`, suggesting `structuredClone(x)`, carrying a `type: "tool"` source citing the AST line.
- `warden review` on a fixture diff with a hand-rolled JOIN against a Drizzle import emits a question-kind Comment with category `leverage`, citing the Drizzle relational primitive via an `api_def` source verified by `verify-citations.ts`.
- `warden check` runs the detector but skips the sub-agent silently (no `degradedWorkers` entry).
- `pnpm smoke:m12` exercises both runners; `pnpm check-types` + `pnpm lint` pass.
- ADR-0027 status snapshot row flips from `Direction` to `Done` (after dogfood acceptance — see Acceptance §4 below).
- CLAUDE.md M12 line lands as `[x]` above the M11+ deferred-items list, which loses its `leverage review category` bullet.

**Stop at "two runners + enum + priority slot + dispatch + prompt + smoke + close-out." Do NOT start: a third detector pattern (revisit M13+ once dogfood reveals which substitutions the sub-agent consistently misses); a curated library table in the sub-agent prompt (ADR-0027 §3 rejects this); the `type_def_embeddings` table for semantic retrieval over `.d.ts` (ADR-0026 §14 + ADR-0027 §10 defer); an inline `// warden-ignore-leverage` suppression marker (ADR-0027 §9 rejects); exposing `lookupTypeDef` to the leverage *detector* (ADR-0027 alternatives — detector is stdlib-only); a new confidence-threshold subsystem or per-category threshold tuning; re-platforming the remaining 6 inline runners through the `Runner` contract (ADR-0023 deferred); BYOEmbedder; daemon `JobRunner`; or any other M11+ deferred item.** Those are later milestones.

## Repo additions

```
packages/core/src/runners/
├── leverage.ts                                  # NEW — pure AST detector:
│                                                #   three visitor functions for
│                                                #   the v0 pattern set. Exports
│                                                #   `runLeverage()` (inner) and
│                                                #   `leverageRunner: Runner`
│                                                #   (contract wrapper). Mirrors
│                                                #   scalability.ts:86-100 pattern.
│
└── leverage-libraries.ts                        # NEW — Haiku sub-agent. Imports
                                                 #   makeLookupTypeDefTool(),
                                                 #   getWorkerCheapModel(),
                                                 #   loadLeverageSystemPrompt().
                                                 #   Exports `runLeverageLibraries()`
                                                 #   (inner) and
                                                 #   `leverageLibrariesRunner: Runner`
                                                 #   (contract wrapper). Mirrors
                                                 #   committability.ts structure.

packages/core/src/llm/prompts/
└── leverage-system.md                           # NEW — sub-agent system prompt.
                                                 #   Library-agnostic + 4 canonical
                                                 #   examples + tool usage discipline.
                                                 #   Injected via prompt loader.

packages/core/src/llm/prompt-loader.ts           # MODIFIED — add
                                                 #   loadLeverageSystemPrompt()
                                                 #   alongside existing loaders.

packages/core/src/llm/tools/lookup-type-def.ts   # MODIFIED — optional
                                                 #   packageSearchRoots support
                                                 #   for package-level
                                                 #   node_modules in workspaces.

packages/core/src/api/lookup-type-def.ts         # MODIFIED — resolver tries
                                                 #   package search roots before
                                                 #   returning package_not_installed.

packages/core/src/schema.ts                      # MODIFIED — one line:
                                                 #   add 'leverage' to CategoryEnum.

packages/core/src/runners/types.ts               # MODIFIED — add 'leverage' to
                                                 #   ToolFinding.source and add an
                                                 #   optional evidence triple for
                                                 #   snippet-citing detectors.

packages/core/src/runners/to-comment.ts          # MODIFIED — map source
                                                 #   'leverage' to
                                                 #   { category: 'leverage',
                                                 #     tier: 2 } and copy optional
                                                 #   evidence into SourceSchema's
                                                 #   {path,line,snippet} triple.

packages/core/src/index.ts                       # MODIFIED — two edits:
                                                 #   (1) PRIORITY_ORDER: insert
                                                 #       'leverage' between 'style'
                                                 #       and 'dedup'.
                                                 #   (2) orchestrationRunners: push
                                                 #       leverageRunner (always),
                                                 #       leverageLibrariesRunner
                                                 #       (mode === 'review' only).

packages/cli/scripts/
├── smoke-m12-detector.mts                       # NEW — fixture diff with the
│                                                #   three patterns; asserts each
│                                                #   fires once + no overlap with
│                                                #   scalability/dedup.
│
└── smoke-m12-sub-agent.mts                      # NEW — fixture diff with a
                                                 #   plausible library-substitution
                                                 #   site; asserts the sub-agent
                                                 #   calls lookupTypeDef, emits
                                                 #   a question with verified
                                                 #   api_def source, and survives
                                                 #   the global verifier post-pass.
```

No new workspace package. No new commander verb. No new env var. No public `Comment` / `SourceType` schema migration. No new SQLite table. There is one internal runner-shape update: `ToolFinding.source` and `toComment()` must learn `leverage`.

## Package boundaries to honor

- All M12 code lives in `@warden/core`. No new workspace package; `@warden/ai` and `@warden/db` are untouched.
- `@warden/core` stays I/O-pure per ADR-0013. The detector reads files via `TsCompilerParser` (already a `@warden/core` dependency, used by every existing AST detector). The sub-agent reads `package.json` via `node:fs/promises` (already-allowed pattern — same as M11's `lookupTypeDef` resolver). Neither runner writes to stdout or reads `process.argv`.
- The sub-agent uses `getWorkerCheapModel()` + `streamText` + `tool` + `stepCountIs` re-exported from `@warden/ai` (`packages/ai/src/index.ts`). No new re-exports.
- The sub-agent imports M11's `makeLookupTypeDefTool` from `@warden/core/src/llm/tools/lookup-type-def.ts` (intra-package import). It passes a shared `degraded[]` collector through to capture the once-per-review "no `node_modules/`" entry; the existing collector pattern works unchanged.
- The sub-agent does **not** import the M11 formatter's cascade — it makes its own `streamText` call following committability's pattern. Reason: each LLM-call site has its own prompt, its own cap budget, and its own retry semantics; sharing the cascade entry-point would conflate concerns. (The M11 formatter and the leverage sub-agent both consume `getWorkerCheapModel`/`getBossModel` and `tool` via the shared `@warden/ai` re-exports — that's the shared seam.)
- Monorepo dependency discovery is part of M12's runner, not a future retrieval milestone. Build the dependency preamble from `repoRoot/package.json` plus the nearest package manifests for the changed files (for Warden, `packages/core/package.json`, `packages/db/package.json`, etc.). If `lookupTypeDef` still only checks `repoRoot/node_modules`, harden the tool/resolver to try those package roots' `node_modules` directories before returning `package_not_installed`. This is package-resolution correctness, not `node_modules/<pkg>/src` indexing.

## What to build

### 1. `CategoryEnum` extension (`packages/core/src/schema.ts`)

One-line change:

```ts
export const CategoryEnum = z.enum([
  'correctness',
  'clarity',
  'style',
  'dedup',
  'tests',
  'security',
  'vulnerability',
  'contract',
  // ADR-0020: Copilot-delta categories (M6). The LLM emits these only as
  // questions — there are no deterministic producers yet (M7+ work).
  'scalability',
  'consistency',
  'deadcode',
  'committability',
  // ADR-0027: M12 — second producer pair against the ADR-0008 citation thesis.
  // The leverage detector emits assertions for bounded stdlib patterns; the
  // leverage sub-agent emits questions for library-substitution suggestions.
  'leverage',
]);
```

No new `SourceType`. No schema migration. No new field on `Comment`.

### 2. `PRIORITY_ORDER` slot (`packages/core/src/index.ts`)

Insert `'leverage'` between `'style'` and `'dedup'`:

```ts
const PRIORITY_ORDER: Category[] = [
  "correctness",
  "security",
  "vulnerability",
  "contract",
  "scalability",
  "consistency",
  "deadcode",
  "committability",
  "clarity",
  "style",
  "leverage",   // NEW — ADR-0027 §5
  "dedup",
  "tests",
];
```

`applyHardRules()`'s sort uses `indexOf` against this array; new slot is picked up transparently. No test changes (no tests in this project per `user_no_tests_personal.md`).

### 2.5. `ToolFinding` + `toComment()` mapping

`packages/core/src/runners/types.ts` must add `leverage` to the internal producer union and carry optional snippet evidence for detectors that want the global verifier to check a concrete source excerpt:

```ts
export interface ToolFinding {
  source:
    | "tsc"
    | "eslint"
    | "jscpd"
    | "scalability"
    | "deadcode"
    | "consistency"
    | "leverage";
  file: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  severity: FindingSeverity;
  ruleId?: string;
  message: string;
  evidence?: {
    path: string;
    line: number; // 1-indexed; must satisfy SourceSchema's positive line invariant
    snippet: string;
  };
}
```

`packages/core/src/runners/to-comment.ts` must map `source === "leverage"` to `{ tier: 2, category: "leverage" }`. When `f.evidence` is present, copy it into the single `type: "tool"` source:

```ts
sources: [
  {
    type: "tool",
    id: f.ruleId ?? f.source,
    title: f.source,
    retrievedAt: new Date().toISOString(),
    ...(f.evidence
      ? { path: f.evidence.path, line: f.evidence.line, snippet: f.evidence.snippet }
      : {}),
  },
],
```

This is not a public schema change: `SourceSchema` already supports `{path,line,snippet}` for any source type. It just lets the leverage detector produce mechanically-verifiable AST evidence instead of an uncited tool envelope.

### 3. Leverage detector (`packages/core/src/runners/leverage.ts`)

Mirror the scalability detector's shape (`packages/core/src/runners/scalability.ts`). Three visitor functions, one inner `runLeverage()`, one `leverageRunner: Runner` contract wrapper.

Inner function shape:

```ts
import ts from "typescript";
import type { ChangedFile } from "../diff/index.js";
import type { Runner, RunnerInput, RunnerOutput } from "../orchestration/runner.js";
import type { DegradedEntry } from "../schema.js";
import { anyAddedInRange, parseChangedSourceFile } from "./_shared.js";
import type { ToolFinding } from "./types.js";

export interface LeverageRunnerInput {
  repoRoot: string;
  changed: ChangedFile[];
}

export interface LeverageRunnerOutput {
  findings: ToolFinding[];
  degraded: DegradedEntry[];
}

export async function runLeverage(
  input: LeverageRunnerInput,
): Promise<LeverageRunnerOutput> {
  const findings: ToolFinding[] = [];
  const degraded: DegradedEntry[] = [];

  for (const cf of input.changed) {
    const result = await parseChangedSourceFile(input.repoRoot, cf, "leverage");
    if (result.kind === "skip") continue;
    if (result.kind === "degraded") {
      degraded.push(result.entry);
      continue;
    }
    const { sf, addedLines } = result.parsed;
    findStructuredClone(sf, cf.path, addedLines, findings);
    findIncludes(sf, cf.path, addedLines, findings);
    findSome(sf, cf.path, addedLines, findings);
  }

  return { findings, degraded };
}

export const leverageRunner: Runner = {
  name: "leverage",
  async run(input: RunnerInput): Promise<RunnerOutput> {
    const result = await runLeverage({
      repoRoot: input.repoRoot,
      changed: input.changed,
    });
    return {
      name: "leverage",
      findings: result.findings,
      degraded: result.degraded,
      durationMs: 0, // dispatcher overrides
    };
  },
};
```

Pattern matchers:

**(a) `findStructuredClone`** — match `JSON.parse(JSON.stringify(<expr>))`. Visitor predicate: `ts.isCallExpression(node)` && callee is `JSON.parse` && exactly one argument && that argument is `ts.isCallExpression` of `JSON.stringify` with one argument. Emit one finding per match. Evidence: `(path, line, snippet)` where `snippet` is the substring from the source file at the call expression's start..end positions (single-line normalised — collapse newlines + repeated whitespace). `claim`: `"Consider structuredClone(...) instead of JSON.parse(JSON.stringify(...)) when you want a general deep clone — structuredClone preserves Maps, Sets, Dates, RegExps, and typed arrays that the JSON roundtrip strips."` Keep the wording conditional; `structuredClone` changes behaviour for intentional JSON-normalisation, custom `toJSON`, functions, cycles, and older runtimes.

**(b) `findIncludes`** — match `<receiver>.indexOf(<x>) <comp> <num>` where `<comp>` is one of `!==` / `!=` / `>` / `>=` and `<num>` is `-1` (for `!==`/`!=`) or `-1` (for `>`) or `0` (for `>=`). Visitor predicate: `ts.isBinaryExpression(node)` && operator in `{!==, !=, >, >=}` && left side is `ts.isCallExpression` with `.indexOf(...)` && right side matches the numeric literal pattern. Emit for arrays and strings; both `Array.prototype.includes` and `String.prototype.includes` express membership/readability better than an index comparison. Evidence: same shape. `claim`: `"Replace indexOf(...) !== -1 with includes(...) — includes is the idiomatic membership check."`

**(c) `findSome`** — two sub-patterns:
- `<arr>.filter(<pred>).length > 0` / `.length >= 1` / `.length !== 0`. Visitor predicate: `ts.isBinaryExpression(node)` with appropriate comparison && left side is `<call>.length` && that call is `.filter(...)`.
- `<arr>.find(<pred>) !== undefined` / `<arr>.find(<pred>) != null`. Visitor predicate: `ts.isBinaryExpression(node)` with `!==`/`!=` && one side is `.find(...)` call && other side is `undefined` / `null` literal.

Emit one finding per match. `claim`: `"Replace arr.filter(...).length > 0 with arr.some(...) — some short-circuits on the first match and reads as a boolean check."` (Adapt wording per sub-pattern.)

**Diff-localness.** Every visitor computes a 1-indexed line range from the AST node and calls `anyAddedInRange(startLine, endLine, addedLines)` so the detector only fires on changed code. Do not pass character offsets to `anyAddedInRange()`; its signature is line-based. Same posture as scalability/deadcode.

**Severity / tier.** All three patterns default to **tier 2** (should-fix). The detector emits `ToolFinding` shape; the synthesiser maps it to a Comment with `kind: "assertion"` + `category: "leverage"` + `tier: 2`. Tier override per-finding is not needed — these are uniformly should-fix suggestions.

**Why exactly these three.** Per ADR-0027 §2: AST-decidable single-call substitutions, zero overlap with scalability's `sequential-await` / `load-then-narrow`, zero overlap with jscpd (which works on code similarity, not pattern substitution). Other candidates (`Object.entries`, `Array.from(new Set(...))`, optional-chaining replacements) are deferred to M13+ pending dogfood evidence.

### 4. Leverage sub-agent (`packages/core/src/runners/leverage-libraries.ts`)

Mirror the committability sub-agent's structural shape (`packages/core/src/runners/committability.ts`). Key differences from committability:

- Reads `package.json` manifests (root + nearest touched workspace/package roots; top-level `dependencies` + `devDependencies` + `peerDependencies`) to build the deps preamble.
- Has the `lookupTypeDef` tool available via `tools: { lookupTypeDef: makeLookupTypeDefTool({ repoRoot, degraded }) }` passed into `streamText`.
- Owns its own `stopWhen: stepCountIs(8)` budget — separate budget from the M11 formatter's 8 calls per review (per ADR-0027 caveats).
- Emits Comments of `kind: "question"` carrying `api_def` sources copied verbatim from `result.suggestedSource` per the M11 contract.

Skeleton:

```ts
import {
  Output,
  getWorkerCheapFallbackModel,
  getWorkerCheapModel,
  stepCountIs,
  streamText,
  type LanguageModel,
} from "@warden/ai";
import { z } from "zod";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { stableCommentId } from "../comment-id.js";
import type { ChangedFile } from "../diff/index.js";
import { loadLeverageSystemPrompt } from "../llm/prompt-loader.js";
import { makeLookupTypeDefTool } from "../llm/tools/lookup-type-def.js";
import type { Runner, RunnerInput, RunnerOutput } from "../orchestration/runner.js";
import type { Comment, DegradedEntry, Source } from "../schema.js";
import { formatErr } from "./_shared.js";

const DEFAULT_TIMEOUT_MS = 60_000; // wider than committability — tool-use loops take longer
const STEP_CAP = 8;

const SubAgentSourceSchema = z.object({
  type: z.literal("api_def"),
  id: z.string(),
  title: z.string(),
  path: z.string(),
  line: z.number().int().positive(),
  snippet: z.string(),
  retrievedAt: z.string(),
});

const SubAgentFindingSchema = z.object({
  path: z.string(),
  line: z.number().int().positive(),
  snippet: z.string(),
  claim: z.string().min(1),
  explanation: z.string().min(1),
  suggestedAction: z.string().min(1),
  sources: z.array(SubAgentSourceSchema).default([]),
  tier: z.union([z.literal(2), z.literal(3)]).default(2),
  confidence: z.number().min(0).max(1).default(0.75),
});

const SubAgentOutputSchema = z.object({
  findings: z.array(SubAgentFindingSchema).default([]),
});

export interface LeverageLibrariesRunnerInput {
  repoRoot: string;
  changed: ChangedFile[];
  /** Override per-provider timeout (ms). */
  timeoutMs?: number;
}

export interface LeverageLibrariesRunnerOutput {
  questions: Comment[];
  degraded: DegradedEntry[];
}

export async function runLeverageLibraries(
  input: LeverageLibrariesRunnerInput,
): Promise<LeverageLibrariesRunnerOutput> {
  const degraded: DegradedEntry[] = [];
  const questions: Comment[] = [];

  // 1. Build the deps preamble + package roots. Shallow reads; failures
  //    degrade silently.
  const dependencyContext = await buildDependencyContext(input.repoRoot, input.changed);

  // 2. Build the diff snippet (use committability's approach — added lines +
  //    ±CONTEXT_LINES, capped at SNIPPET_LINE_CAP per file, MAX_READ_BYTES floor).
  const diffSnippet = await buildDiffSnippet(input.changed, input.repoRoot);
  if (diffSnippet.trim().length === 0) {
    return { questions, degraded }; // nothing to suggest against
  }

  // 3. Construct the tool. The collector pattern from M11 means the
  //    "no node_modules/" entry lands at most once across whatever runners
  //    share the collector — but the sub-agent has its own degraded[] here;
  //    the entry duplicates if both formatter and sub-agent miss node_modules.
  //    Acceptable verbosity middle ground (one extra entry per review).
  const lookupTool = makeLookupTypeDefTool({
    repoRoot: input.repoRoot,
    packageSearchRoots: dependencyContext.packageRoots,
    degraded,
  });

  // 4. Make the LLM call. Cheap-tier (Haiku) with provider fallback per
  //    ADR-0017's cascade. Pattern matches committability.ts's harness.
  const systemPrompt = loadLeverageSystemPrompt();
  const userPrompt = renderUserPrompt(dependencyContext.preamble, diffSnippet);
  const llmResult = await callLeverageSubAgent({
    systemPrompt,
    userPrompt,
    tools: { lookupTypeDef: lookupTool },
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  if (llmResult.kind === "degraded") {
    degraded.push(...llmResult.entries);
    return { questions, degraded };
  }

  // 5. Map sub-agent findings → Comments. Lane discipline (per committability):
  //    drop findings whose `path` is outside the diff (set-membership against
  //    input.changed paths).
  const changedPaths = new Set(input.changed.map((cf) => cf.path));
  let droppedUnknownPath = 0;
  let droppedUncited = 0;
  for (const f of llmResult.output.findings) {
    if (!changedPaths.has(f.path)) {
      droppedUnknownPath += 1;
      continue;
    }
    if (f.sources.length === 0) {
      droppedUncited += 1;
      continue;
    }
    questions.push({
      id: stableCommentId(`leverage-libraries:${f.path}:${f.line}:${f.claim}`),
      file: f.path,
      lineStart: f.line,
      lineEnd: f.line,
      kind: "question",
      category: "leverage",
      tier: f.tier,
      confidence: f.confidence,
      claim: f.claim,
      explanation: f.explanation,
      suggestedAction: f.suggestedAction,
      sources: f.sources as Source[],
    });
  }
  if (droppedUnknownPath > 0) {
    degraded.push({
      kind: "info",
      topic: "leverage-libraries",
      message: `leverage-libraries: dropped ${droppedUnknownPath} finding(s) citing files outside the diff`,
    });
  }
  if (droppedUncited > 0) {
    degraded.push({
      kind: "info",
      topic: "leverage-libraries",
      message: `leverage-libraries: dropped ${droppedUncited} uncited finding(s)`,
    });
  }
  return { questions, degraded };
}

export const leverageLibrariesRunner: Runner = {
  name: "leverage-libraries",
  async run(input: RunnerInput): Promise<RunnerOutput> {
    const result = await runLeverageLibraries({
      repoRoot: input.repoRoot,
      changed: input.changed,
    });
    return {
      name: "leverage-libraries",
      findings: [], // sub-agent emits questions only
      questions: result.questions,
      degraded: result.degraded,
      durationMs: 0,
    };
  },
};
```

**Internal helpers** (private to the module):

- `buildDependencyContext(repoRoot, changed)` — reads `repoRoot/package.json` plus the nearest ancestor `package.json` for each changed file (bounded to `repoRoot`), parses top-level `dependencies` + `devDependencies` + `peerDependencies`, de-dupes package names, and returns `{ preamble, packageRoots }`. `preamble` is a single string like `"Installed libraries: drizzle-orm, @anthropic-ai/sdk, ai, elysia, ..."`. `packageRoots` includes `repoRoot` plus every touched package root so `makeLookupTypeDefTool()` can resolve package-level `node_modules` in pnpm workspaces. Falls back to an empty section on read/parse failure; do not surface a degraded entry because missing/malformed package manifests are not actionable mid-review.
- `buildDiffSnippet(changed, repoRoot)` — mirrors committability's per-file added-lines + ±CONTEXT_LINES bundling. Same `SNIPPET_LINE_CAP = 20`, `CONTEXT_LINES = 2`, `MAX_READ_BYTES = 16_384` constants. Same binary-file + sensitive-path handling (path-only transmission). Re-use committability's helper functions if extractable; otherwise duplicate inline (the M8 spine's purpose is to absorb runner-shaped duplication later — don't preemptively extract).
- `renderUserPrompt(depsPreamble, diffSnippet)` — concat with sentinel sections (`<deps>...</deps>\n<diff>...</diff>`) so the LLM can parse the two halves cleanly.
- `callLeverageSubAgent(...)` — wraps the `streamText` call with the same cascade-style retry pattern committability uses; returns a discriminated union (`{ kind: "ok", output }` or `{ kind: "degraded", entries }`). Tool calls flow through the `streamText({ tools, stopWhen: [stepCountIs(STEP_CAP)] })` config.

**Why not share committability's helpers?** Committability's harness is closely tied to its lane-discipline + sensitive-path semantics; lifting helpers into a shared `_subagent.ts` would commit to the abstraction surface before two more sub-agents prove the shape. Per the ADR-0026 §11 "no premature `WardenTool` abstraction" precedent, M12 duplicates the bits it needs and lets M13+ extract if a third sub-agent earns it.

### 5. Sub-agent system prompt (`packages/core/src/llm/prompts/leverage-system.md`)

```markdown
You are a focused code reviewer scanning a TypeScript / JavaScript diff for **leverage opportunities** — places where the developer hand-rolled logic that an installed library already provides cleanly.

Your job is narrow: emit a question for each plausible substitution. You are not a general code reviewer; you only flag library-substitution opportunities.

## What counts as a leverage opportunity

A leverage finding requires *all four* to be true:

1. The diff contains code that does something a library function would do directly.
2. The library is in the **Installed libraries** list below (do not suggest libraries the user doesn't have).
3. The substitution would reduce code volume, improve clarity, or both — not merely shift the implementation.
4. You can **verify the library exposes the substitute primitive** via `lookupTypeDef`.

Canonical examples (illustrative, not exhaustive):

- **Drizzle relational `with:`** — manual JOIN-and-collect against `select().from(users).leftJoin(posts...)` collapsing to `.with({ posts: true })` on the relational builder.
- **Elysia `.guard()`** — per-route `{ beforeHandle: requireAuth }` repeated across routes collapsing into `.guard({ beforeHandle: requireAuth }, app => app.get(...).post(...))`.
- **AI SDK `Output.array(schema)`** — `generateText` followed by `JSON.parse(text)` plus zod parsing collapsing into `streamText({ output: Output.array(schema) })`.
- **Drizzle `onConflictDoNothing()` / `onConflictDoUpdate()`** — pattern of `SELECT...INSERT IF NOT FOUND` collapsing to one `INSERT ... onConflictDoNothing()` call.

These examples anchor the *shape* of a leverage finding. Other libraries (and other primitives in these libraries) are fair game when the four conditions above hold.

## Citation discipline

Before emitting any finding that asserts a library has a specific API, you **must** call `lookupTypeDef({ package, symbol })`:

- `package` is the literal import path as it appears in source code, including subpaths (`drizzle-orm/sqlite-core`, `@radix-ui/react-dialog`, `next/server`). Do not collapse subpaths to the root package.
- `symbol` is the symbol path (e.g., `"with"` or `"Drizzle.with"` or `"User.method"`).

When `lookupTypeDef` returns `found: true`, **copy `result.suggestedSource` verbatim** into the resulting finding's `sources[]` array. Do not reconstruct any of its fields. The resolver pre-formats the source so the verifier accepts it automatically.

When `lookupTypeDef` returns `found: false`:

- `reason: "package_not_installed"` — do not mention this library at all. The user may be reviewing without `node_modules/` present.
- `reason: "no_types"` — do not assert about this library's API in this review.
- `reason: "symbol_not_found"` — drop the suggestion. This sub-agent is not a missing-API detector; it only posts verified substitution opportunities.
- `reason: "lookup_error"` — treat like `package_not_installed`. Move on.

You may make **at most 8 `lookupTypeDef` calls per review** (the orchestration layer enforces this). Budget them — each call should target a library whose substitute you're already confident about.

## What to ignore

- **Stdlib idiom misses** (`JSON.parse(JSON.stringify(...))`, `arr.indexOf(...) !== -1`, `arr.filter(p).length > 0`). A separate detector handles these — do not duplicate.
- **Style preferences** — formatting, naming, comments.
- **Substitutions you can't verify** — if `lookupTypeDef` can't confirm the primitive exists, do not assert it does.
- **Library version differences** — the resolver returns the actually-installed version's API. Do not speculate about features in other versions.

## Output shape

Emit a `findings[]` array. Each finding:

- `path`: the diff file path the hand-rolled code lives in.
- `line`: the line number of the call site (1-indexed).
- `snippet`: a single-line excerpt of the hand-rolled code at that site.
- `claim`: one-sentence statement of the substitution (e.g., `"This manual JOIN can be a Drizzle relational query with `with: { posts: true }`."`).
- `explanation`: one or two sentences explaining why the library primitive fits this specific diff site.
- `suggestedAction`: one-sentence imperative (e.g., `"Replace the join-then-group block with `db.query.users.findFirst({ with: { posts: true } })`."`).
- `sources`: array of one `api_def` source object, **copied verbatim from `lookupTypeDef`'s `suggestedSource` field**.
- `tier`: `2` for substitutions that materially improve the code; `3` for purely stylistic improvements.
- `confidence`: a number between 0 and 1 — your confidence in the substitution given the diff context.

If no leverage opportunities exist in this diff, return `{ "findings": [] }`. This is the right answer most of the time — leverage findings are uncommon.
```

The prompt is `.md` per ADR-0015's prompts-as-files discipline. Loaded by `loadLeverageSystemPrompt()`.

### 6. Prompt loader extension (`packages/core/src/llm/prompt-loader.ts`)

Add a sibling function next to `loadCommittabilitySystemPrompt`:

```ts
export function loadLeverageSystemPrompt(): string {
  return load("leverage-system");
}
```

Also extend the local `PromptName` union to include `"leverage-system"`. No `packages/core/src/llm/index.ts` re-export is needed unless the implementation decides to expose prompt loaders publicly; the existing committability loader is not re-exported there.

### 7. Dispatch registration (`packages/core/src/index.ts:324–332`)

Update the `orchestrationRunners` block to register both new runners:

```ts
const orchestrationRunners: Runner[] = [];
if (changed && changed.length > 0) {
  orchestrationRunners.push(scalabilityRunner);
  orchestrationRunners.push(leverageRunner);     // NEW — runs in check + review
  // Committability + leverage-libraries fire only in `review` mode. `check` is
  // deterministic-only per ADR-0011 — no LLM calls.
  if (input.config.mode === "review") {
    orchestrationRunners.push(committabilityRunner);
    orchestrationRunners.push(leverageLibrariesRunner);   // NEW — review only
  }
}
```

Order within the array doesn't matter for correctness (`dispatch()` runs in parallel via `Promise.all`). Listing the deterministic runners first is a readability convention.

Import the two new runners at the top of `index.ts` (`import { leverageRunner } from "./runners/leverage.js"; import { leverageLibrariesRunner } from "./runners/leverage-libraries.js";`).

### 8. Smoke harness

**`packages/cli/scripts/smoke-m12-detector.mts`**: fixture diff with three planted patterns + control surface (lines outside the diff). Asserts:

1. `JSON.parse(JSON.stringify(payload))` site in `<fixture>/clone.ts` produces exactly one `category: "leverage"` finding with `kind: "assertion"`, `claim` mentioning `structuredClone`.
2. `users.indexOf(targetId) !== -1` site produces exactly one finding mentioning `includes`.
3. `entries.filter(isActive).length > 0` site produces exactly one finding mentioning `some`.
4. A scalability-pattern line (`await fetchOne(); await fetchTwo()`) in the same diff produces a `scalability` finding but **no** `leverage` finding (zero overlap regression-guard).
5. A jscpd-shaped duplication block in the diff produces a `dedup` finding but no `leverage` finding (same).
6. Lines that match the three patterns but live **outside** the changed range produce zero findings (diff-localness regression-guard).
7. The runner's `degraded` entries are empty on the happy path.

**`packages/cli/scripts/smoke-m12-sub-agent.mts`**: fixture diff with one planted library-substitution site against a fixture `package.json` listing `drizzle-orm` as a dep. Asserts:

1. The sub-agent's `streamText` call fires (assert via spying on `getWorkerCheapModel`'s invocation or via output-only — pick whichever existing committability smoke uses for symmetry).
2. The sub-agent calls `lookupTypeDef` at least once (assert via a mock that records calls and returns a synthetic `found: true` result).
3. The returned Comment has `category: "leverage"`, `kind: "question"`, non-empty `explanation`, and exactly one `api_def` source whose `path` / `line` / `snippet` match the mock's `suggestedSource`.
4. Running the comment through `verify-citations.ts` accepts the source (mock returns a `dts_file` whose content includes the `signature` within the `API_DEF_DRIFT = 30` window).
5. A second fixture diff with **no installed libraries** in any discovered package manifest produces zero sub-agent findings (the deps preamble correctly empty-gates the LLM's suggestions — confirm via output, not via mocking the prompt construction).
6. The sub-agent skips silently when `input.config.mode === "check"` (assert dispatch registration honors the gate — no `degradedWorkers` entry, no LLM call recorded).
7. A pnpm-workspace fixture where the touched file lives under `packages/db/` and the dependency exists only in `packages/db/package.json` still includes that dependency in the preamble and resolves its `.d.ts` from the package-level `node_modules`.

Run via `pnpm smoke:m12` (add to `packages/cli/package.json` scripts).

If mocking `getWorkerCheapModel` is awkward in the existing test harness, the sub-agent smoke can degrade to a hand-rolled end-to-end test against a real Haiku call (`ANTHROPIC_API_KEY` required, ~$0.001 cost per run). Acceptable for v0 dogfood pacing; not a CI dependency.

### 9. Dogfood pass

After implementation, run `warden review` on the warden tree itself with the M12 branch checked in. Expect:

- The detector fires zero false positives on warden's own code (warden uses `structuredClone` / `includes` / `some` idiomatically already — if it didn't, the detector would have fired on existing code; the diff-localness gate means it only fires on changed lines).
- The sub-agent emits at most a handful of questions; manually triage each as Useful / Not Useful per memory `feedback_review_priority.md`.
- No regressions on M10 / M11 smoke scripts (`pnpm smoke:m10` + `pnpm smoke:m11`).
- The `category: "leverage"` priority slot lands between style and dedup in the sorted comment output.

Then test the `warden check` path: confirm the detector still runs but the sub-agent doesn't (verify by reading the output's `comments[]` — no `kind: "question"` comments with `category: "leverage"`).

### 10. Close-out

- Update ADR-0027 status row in `decisions.md` snapshot from `Direction` to `Done` (after dogfood acceptance).
- Update CLAUDE.md: insert `[x] M12 — leverage review category per ADR-0027. Bounded stdlib detector (3 patterns) + Haiku sub-agent (library substitutions via lookupTypeDef). Both runners ride the M8 Runner contract. CategoryEnum + PRIORITY_ORDER one-line extensions. Plan: m12-plan.md.` line above the M11+ deferred-items list.
- Update CLAUDE.md M11+ deferred items list: drop the `leverage review category` bullet (now scheduled and shipped). The bullet's content is no longer accurate (it predates the M12 grilling).
- Update CONTEXT.md with the additions in the "CONTEXT.md additions" section below.
- Refresh memory `project_warden_leverage_category.md` to point at ADR-0027 + this plan; mark its M4-era design speculation as superseded (memories are next-session continuity, not in-session planning artifacts — refresh post-implementation).

## Acceptance criteria for M12

1. `pnpm check-types` passes across all packages.
2. `pnpm lint` (oxlint) passes.
3. `pnpm smoke:m12` passes both smoke scripts (detector + sub-agent).
4. `warden review` on the warden tree (dogfood acceptance):
   - Runs without crash.
   - Surfaces zero false-positive leverage findings on existing warden idioms (verify by listing the leverage findings and manually accepting each).
   - At least one full sub-agent execution path completes — i.e., the sub-agent makes its LLM call and either emits a verified `api_def`-cited question or emits an empty `findings[]`. (Both are acceptable for the first dogfood pass; the empty case proves the gate behaves correctly, not a regression.)
   - No regressions: M10 / M11 verifier, vuln, TSC, ESLint, committability, scalability, deadcode, consistency all unchanged.
   - Comments with `category: "leverage"` sort between `style` and `dedup` in the output.
5. `warden check` runs the detector but does not invoke the sub-agent — verify by reading the output for absence of `kind: "question"` + `category: "leverage"` comments.
6. ADR-0027 status row flips `Direction` → `Done`. CLAUDE.md M12 `[x]` line added. CONTEXT.md gains the four new terms (per "CONTEXT.md additions" below).

## What NOT to do in this milestone

- **Do not ship a fourth (or more) detector pattern.** ADR-0027 §2 locks the v0 set at three. M13+ adds patterns based on dogfood evidence of which substitutions the sub-agent consistently misses — not speculative additions.
- **Do not add a curated library table to the sub-agent prompt.** ADR-0027 §3 + Alternatives reject this. Library-agnostic + four examples + `package.json` deps preamble is the design.
- **Do not build the `type_def_embeddings` table.** ADR-0026 §14 + ADR-0027 §10 defer this to M13+ when (and if) dogfood reveals the LLM's library-symbol recall is the bottleneck. The M11 exact-match `lookupTypeDef` path is sufficient for v0.
- **Do not add a `// warden-ignore-leverage` marker or any other inline suppression.** ADR-0027 §9 rejects this. Tighten the detector patterns if dogfood reveals false positives.
- **Do not expose `lookupTypeDef` to the leverage detector.** ADR-0027 alternatives: the detector is stdlib-only; library lookups are the sub-agent's job.
- **Do not modify `verify-citations.ts`.** The sub-agent's `api_def` sources flow through the existing M10/M11 dispatch unchanged. No verifier changes.
- **Do not change the formatter's cap=8 in `cascade.ts`.** The leverage sub-agent owns a separate `STEP_CAP = 8` in `leverage-libraries.ts`; M12 does not centralise the cap.
- **Do not migrate the inline 6 runners (TSC, ESLint, jscpd, vuln, deadcode, consistency) through the `Runner` contract.** ADR-0023 deferred this; M12 just adds two new runners on the contract.
- **Do not add per-category confidence-threshold overrides or a new confidence gate.** Leverage uses the existing `confidence` field, priority sort, and tier-3 verbose gate; confidence-threshold work is a separate backlog item.
- **Do not write tests.** Per memory `user_no_tests_personal.md`. Smoke scripts are the validation surface.
- **Do not change the formatter system prompt.** The M11 "Verifying library API claims" section stays unchanged. The sub-agent has its own system prompt.
- **Do not extract a shared `_subagent.ts` helper module preemptively.** ADR-0027 caveats: duplicate from committability what M12 needs; M13+ extracts if a third sub-agent earns the abstraction.
- **Do not extend `Source` / `SourceTypeEnum` / `Comment`.** Reuse `type: "tool"` for detector findings and `type: "api_def"` for sub-agent questions. No new schema fields.
- **Do not add a `package.json`-watcher / re-read on changes.** The deps preamble is read once at the top of `runLeverageLibraries()`; the next review re-reads naturally.

If you reach for any of the above, stop and re-read ADR-0027 — the deferral is intentional.

## CONTEXT.md additions

Update §2 (Findings, comments, citations) — add to the `category` entry:

> **category** — What kind of concern a comment represents. Shipped: `correctness`, `clarity`, `style`, `dedup`, `tests`. M7 additions: `scalability`, `consistency`, `deadcode`, `committability`. **M12 addition: `leverage`** (this hand-rolled code duplicates a library or stdlib primitive — ADR-0027). Categories drive prompt shape, worker routing, and the feedback signal used for category promotion. → ADR-0012, ADR-0020, ADR-0027.

Update §2 — `priority order`:

> **priority order** — The reading order enforced on the output, orthogonal to tier: `correctness → clarity → style → dedup → tests`. M7 inserts `scalability`, `consistency`, `deadcode`, `committability` between correctness and clarity. **M12 inserts `leverage` between style and dedup** (per ADR-0027 §5 — leverage swaps can dissolve downstream dedup findings entirely). → ADR-0012, ADR-0020, ADR-0027.

Add to §5 (Runners) — two new entries:

> **leverage detector** — `[M12]` Deterministic AST detector at `packages/core/src/runners/leverage.ts` emitting `kind: "assertion"` findings for three v0 stdlib idiom-miss patterns: `JSON.parse(JSON.stringify(x))` → `structuredClone(x)`; `arr.indexOf(x) !== -1` → `arr.includes(x)`; `arr.filter(p).length > 0` / `arr.find(p) !== undefined` → `arr.some(p)`. Findings use `ToolFinding.source = "leverage"` and can carry `type: "tool"` sources with `(path, line, snippet)` evidence from the matched call expression. Runs in both `check` and `review`. Rides the M8 `Runner` contract. Pattern set expands in M13+ as dogfood reveals which substitutions the sub-agent consistently misses. → ADR-0027.

> **leverage sub-agent** — `[M12]` Cheap-tier (Haiku) sub-agent at `packages/core/src/runners/leverage-libraries.ts` emitting `kind: "question"` Comments for library-specific substitution suggestions (Drizzle relational `with:`, Elysia `.guard()`, AI SDK `Output.array(...)`, Drizzle `onConflictDoNothing()`, etc.). Prompt is library-agnostic with four canonical examples + a dependency preamble from the root and touched package manifests that gates suggestions to installed packages. Has access to M11's `lookupTypeDef` tool with its own `stepCountIs(8)` budget. Emits questions carrying `api_def` sources copied verbatim from `result.suggestedSource`; the runner drops uncited findings before they become Comments and the global verifier post-pass drops hallucinations transparently. Gated to `review` mode only (skipped silently in `check`). → ADR-0027.

Update §8 (Deferred concepts) — narrow the existing **leverage** entry to acknowledge that M12 ships it:

> ~~**leverage** (review category)~~ — Removed from deferred list as of M12. See §2 categories + §5 runners. The `[deferred]` half of the original entry — semantic retrieval over `.d.ts` for "find Drizzle's join-related primitives" queries — stays deferred; gates on dogfood evidence the exact-match `lookupTypeDef` path hits recall limits. → ADR-0027.

(Alternative: delete the §8 entry outright and add a footnote near §2's `leverage` mention. Editor's discretion.)

## Design nuances captured during planning

1. **The M11 keystone framing pays out twice.** ADR-0026 was designed around two named M10+ items the keystone unblocked: the API claim verifier and the `leverage` review category. M11 shipped the verifier — half the dividend. M12 ships leverage — full dividend. The keystone was a bet on "ship the cross-cutting primitive first; the consumers slot in additively." M12 confirms the bet pays: zero new schema, zero new tables, zero verifier changes, zero new tool-API design — leverage runs on M11's surface.

2. **"Both" Q1 answer is structurally honest, not a hedge.** The grilling-pass Q1 ("detector vs. sub-agent") offered three options; the user picked "Both." Easy to read as risk-aversion ("ship both to cover the case"); actually a substantive design choice — the citation shapes are different (`type: "tool"` AST evidence vs. `type: "api_def"` lookup result), the cost tiers are different (microsecond AST visit vs. Haiku call + tool budget), the anti-pattern sets are disjoint (stdlib idioms vs. library substitutions). Bundling them into one runner would either waste tokens (stdlib through Haiku) or break the bounded-set rule (libraries through AST). The two-runner split lets each half earn its rent independently.

3. **The three detector patterns are honest-tightenable.** ADR-0027 §9 + caveats: each pattern has a known intentional use or semantic edge (`JSON.parse(JSON.stringify)` for deep-strip / `toJSON` / older runtime behaviour; `indexOf !== -1` for `NaN`-sensitive code; `find(...) !== undefined` / `find(...) != null` when the matched element itself can be nullish). The v0 detector emits uniformly with conditional wording; if dogfood shows specific FP patterns, the fix is *narrowing the detector* (e.g., AST-time check that the input type doesn't contain `Map`/`Set`/`Date` before suggesting `structuredClone`, or that the array element type excludes nullish values before suggesting `some` for `find`). Mirrors M7-committability → M9 deletion philosophy.

4. **Detector + sub-agent don't double-fire.** The detector's patterns are stdlib-only (`JSON.parse`, `Array.prototype.indexOf`, `Array.prototype.filter`); the sub-agent's prompt explicitly excludes stdlib idiom misses ("A separate detector handles these — do not duplicate"). The disjointness is enforced at the prompt level + the AST level — there's no AST pattern the detector flags that the sub-agent would also flag, and vice versa. Verified by the smoke harness's regression-guard cases (smoke §1 + §4-5 + §6).

5. **The deps preamble gates suggestions to installed libraries.** Without it, the LLM might suggest "use Lodash's `chunk`" against a repo that doesn't install Lodash. With it, the prompt explicitly says "do not suggest libraries the user doesn't have" and the preamble enumerates what they have. The gate is soft (the LLM might still hallucinate); the verifier catches hallucinations at `lookupTypeDef` time via `package_not_installed`. Soft gate + hard verifier = robust.

6. **The sub-agent doesn't share the formatter's tool-call budget.** Each LLM-call site gets its own `stopWhen: stepCountIs(8)`. If both the formatter and the sub-agent fire on the same review, total tool calls cap at 16 — bounded; not centralised. Centralising the cap would force coupling between runners that the M8 spine deliberately keeps independent. If dogfood evidence shows the combined call count exceeds Anthropic's rate-limit headroom, the cap moves to a config — but that's M13+ work, not v0.

7. **Library-agnostic prompt inverts the maintenance burden.** A curated library table requires hand-updating per library version bump. Library-agnostic + 4 examples + deps preamble + `lookupTypeDef` verifier shifts the burden: the LLM names libraries from its training data (updates as the model updates); the preamble narrows to installed ones; the verifier drops hallucinations. Warden's maintenance load is the prompt's four examples (stable for years) + the four-trigger structure (stable across milestones).

8. **`kind: "question"` is the right shape for sub-agent emissions.** The LLM is suggesting a substitution; even with `api_def` verifying the API exists, the *substitution itself* has unstated tradeoffs (bundle size, perf, ergonomics, opt-in features) the LLM can't assess. Questions invite the developer to decide; assertions overclaim. The detector's `kind: "assertion"` is appropriate because the AST pattern *is* mechanically present — there's no intent layer. Mixing assertion + question kinds within a category (`leverage`) is fine; vulnerability + committability already establish the precedent.

9. **Lane discipline (dropping citations outside the diff) prevents the sub-agent from "wandering."** Committability does this; M12's sub-agent does the same. If the LLM cites a substitution opportunity at a path outside the changed files, drop the finding silently (info-level degraded entry counting the drops, no per-finding noise). The post-pass verifier in `verify-citations.ts` independently substring-checks each `api_def` source, so the lane filter is belt-and-suspenders — but it catches a different failure mode (LLM cites the right `.d.ts` for the wrong diff) than the verifier (LLM cites the wrong `.d.ts`).

10. **Skipping the sub-agent in `check` mode is silent.** ADR-0027 §8 + caveats: surfacing "leverage suggestions unavailable in check mode" every run would be the noise pattern ADR-0025 explicitly rejected. The user chose the fast verb; they know what it excludes. The detector running in `check` is the half that earns rent — bounded stdlib substitutions are deterministically AST-decidable and worth surfacing in pre-commit gates.

11. **Future semantic-retrieval path is additive, not a rewrite.** ADR-0026 §14 designed the schema for it: an additive `type_def_embeddings` table keyed on `(package, version, symbol, model_id, model_version)` layered on M11's `type_def_cache`. M12 doesn't build it; M13+ does when dogfood shows the sub-agent hits recall limits. The exact-match path stays useful even after embeddings exist — it's the fast path for known-name lookups; semantic retrieval is the fallback for "I know it has *something* like this but I can't name it."

12. **The M8 contract migration debt does not grow.** Both new runners land on the `Runner` contract; the six inline runners (TSC, ESLint, jscpd, vuln, deadcode, consistency) stay inline as before. M12 doesn't migrate them; that's a separate milestone (loosely targeted to the noise-filter / orchestration touch in M13+ per ADR-0023's deferral note). The contract earns rent by absorbing the new code with zero structural friction.

## When you're done

- Update ADR-0027's status row in `decisions.md` (line ~77 of the status snapshot table): `Direction` → `Done`. Add a one-line note describing what shipped: "`leverage` in `CategoryEnum` + `PRIORITY_ORDER` slot + `ToolFinding` / `toComment()` mapping + `leverageRunner` (3 stdlib patterns) + `leverageLibrariesRunner` (Haiku sub-agent with `lookupTypeDef` access and workspace-aware deps preamble) + `leverage-system.md` prompt. Both runners ride the M8 contract; dispatch gates the sub-agent to `review` mode. Implementation in `packages/core/src/`."
- Update `CLAUDE.md`: insert `[x] M12 — leverage review category per ADR-0027...` line above the `[ ] M11+ — Deferred items...` bullet. Drop the `leverage review category` sub-bullet from the M11+ deferred items list.
- Update `CONTEXT.md` with the additions in the "CONTEXT.md additions" section above.
- Refresh memory `project_warden_leverage_category.md` post-implementation — replace its M4-era design speculation with a pointer to ADR-0027 + this plan.
- Hand back a list of deviations from this plan (with reasons) plus confirmation all acceptance criteria pass.

The next milestone after M12 is genuinely open. Likely candidates per the M11+ basket (now lighter by one): the remaining-cross-repo-retrieval bag (`node_modules/<pkg>/src` chunking + sibling repos + embedding-based `.d.ts` retrieval — each its own ADR); BYOEmbedder (engine-maturity / NDA use cases); daemon `JobRunner` (skip-init UX); custom-code SAST worker (capability gap); contract-migration of the inline 6 runners (orchestration spine debt). Each gets its own ADR + plan when scheduled.
