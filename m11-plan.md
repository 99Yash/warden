# Warden — M11 Plan (tool-augmented formatter + API claim verifier via `.d.ts` lookup)

This is the milestone brief for the agent (or future-me) implementing M11. Self-contained: read this plus `decisions.md` ADR-0026 and you have everything.

M11 picks one item from ADR-0019's M10+ deferral basket — `.d.ts` retrieval — and narrows it to the smallest credible cut that earns its rent. The architectural keystone framing: this single milestone unblocks two named M10+ items (the `leverage` review category and the API claim verifier from `project_warden_verify_api_claims.md`); M11 ships the verifier half. `leverage` stays deferred for its own M12+ grilling.

## Read first (in this order)

1. **`./decisions.md`** — focus on **ADR-0026** (the M11 design commit). Also: ADR-0008 (citation thesis — `api_def` is its extension to library API claims), ADR-0019 (M6 indexing storage discipline — M11's cache is the lookup-shaped analogue), ADR-0021 §3 (M10 substring-verifier — M11's verifier extension shares the algorithm), ADR-0023 (M8 orchestration spine — the formatter still lives at the same call site).
2. **`./CONTEXT.md`** — §2 (Findings, comments, citations) for `Source` / `sources[]` / citation discipline; §3 (Models + AI layer) for **boss model** and the LLM cascade; §5 (Runners) for the existing inline-vs-spine pattern.
3. **`./CLAUDE.md`** — package boundary table; AI SDK v6 notes.
4. **`./packages/core/src/schema.ts`** — `SourceTypeEnum` (lines 10–19) and `SourceSchema` (lines 51–86) with the M10 triple invariant. M11 adds **one enum value** (`'api_def'`); the schema body and refinement are unchanged.
5. **`./packages/core/src/llm/cascade.ts`** — the `streamText` call site. M11 adds `tools` + `stopWhen: stepCountIs(8)` to the existing call.
6. **`./packages/core/src/llm/formatter.ts`** — `formatReview()` and `computeCacheKey()`. M11 extends the cache key with `dependenciesHash`; everything else is unchanged.
7. **`./packages/core/src/llm/verify-citations.ts`** — the M10 substring-verifier. M11 extends the source-walk to handle `'api_def'` sources (re-using the same algorithm against `dts_file:line_start..line_end`).
8. **`./packages/core/src/llm/prompts/system.md`** — the formatter system prompt. M11 appends a "Verifying library API claims" section with four triggers.
9. **`./packages/ai/src/index.ts`** — re-export surface. M11 adds `tool` to the AI SDK re-exports.
10. **`./packages/db/src/schemas.ts`** — schema barrel. M11 adds `type-def-cache.ts`.

## Goal of this milestone

Land ADR-0026's design in a single coherent slice:

- **`api_def` source type** — extend `SourceTypeEnum` with one value. `SourceSchema` body unchanged: the new variant re-uses `path` / `line` / `snippet` for `dts_file` / `line_start` / `signature`, and `id` / `title` for the `package@version#symbol` identity.
- **`type_def_cache` table** — single new SQLite table holding lookup-on-demand results. Rows are content-addressed by `(package, version, symbol)`; `version` is read from `node_modules/<pkg>/package.json` at lookup time so `npm install`-driven version bumps invalidate transparently.
- **`lookupTypeDef` resolver** — pure function in `@warden/core/src/api/lookup-type-def.ts` that takes `(repoRoot, package, symbol)` and returns the discriminated `LookupTypeDefResult`. Resolves `package.json#types`, walks `.d.ts` re-exports + namespaces, handles `@types/<pkg>` fallback, caches results.
- **AI SDK tool descriptor** — `@warden/ai` re-exports `tool` from `ai`. `@warden/core/src/llm/tools/lookup-type-def.ts` wraps the resolver in `tool({ inputSchema, execute })` for the LLM to invoke.
- **Cascade integration** — `callWithCascade()` accepts `tools` + threads them into `streamText({ tools, stopWhen: stepCountIs(8) })`. `formatReview()`'s `computeCacheKey()` gains a `dependenciesHash` so cached output invalidates when `node_modules/` state changes.
- **Prompt extension** — append "Verifying library API claims" section to `system.md` with the four triggers from ADR-0026 §6.
- **Verifier extension** — `verify-citations.ts` dispatches on `source.type`: `'api_def'` sources verify against `dts_file:line_start..line_end` instead of `repoRoot + path`. Same substring-match algorithm; same drop semantics.
- **Degraded-entry shape** — when `node_modules/` is missing at the first tool-call attempt, emit one `degradedWorkers` entry per review with `kind: "actionable", topic: "api-claim-verifier", message: "no node_modules/ — library API verification unavailable; run npm install to enable."`

By the end:

- `warden review` on a fixture diff that mentions a library API (e.g., asserts "AI SDK v6 uses `inputSchema`") emits a Comment with an `api_def` source carrying the verified signature from the installed `ai` package's `.d.ts`.
- The verifier post-pass drops `api_def` sources whose signature doesn't substring-match the cited `.d.ts` content (e.g., the LLM hallucinated a method).
- The formatter system prompt encodes the four triggers; the tool exposes a discriminated-union result; the cap=8 prevents tool-call spirals.
- `pnpm smoke:m11` exercises both pieces (lookup + verifier); `pnpm check-types` + `pnpm lint` pass.
- ADR-0026 status snapshot row flips from `Direction` to `Done` (after dogfood acceptance — see Acceptance §4 below).
- CLAUDE.md M11 line lands as `[x]` above the M10+ deferred-items list.

**Stop at "lookup-on-demand + tool wiring + verifier extension + prompt update + smoke + close-out." Do NOT start: the `leverage` review category (own M12+ ADR); `node_modules/<pkg>/src` chunking (own future ADR — explicit out-of-scope per ADR-0026 §2); sibling-repo indexing (own future ADR — `--sibling-repo` flag stays deferred); embedding-based `.d.ts` retrieval (own future ADR when `leverage` schedules — additive `type_def_embeddings` table); webfetch fallback for uninstalled packages (own future ADR — supply-chain caveats); user-global cache (own future ADR — namespace-resolution conflicts); BYOEmbedder; daemon `JobRunner`; `warden index export/import`; custom-code SAST worker; cloud-hosted index; mid-stream key handling; retrieval refinements; self-aware boss; or any item from the M10+ deferred list in CLAUDE.md.** Those are later milestones.

## Repo additions

```
packages/core/src/api/                           # NEW directory
└── lookup-type-def.ts                           # NEW — pure resolver:
                                                 #   (repoRoot, package, symbol) → LookupTypeDefResult.
                                                 #   Walks node_modules/<pkg>/package.json#types,
                                                 #   parses .d.ts via TsCompilerParser,
                                                 #   follows re-exports + namespaces,
                                                 #   falls back to @types/<pkg>,
                                                 #   reads + writes the type_def_cache table.

packages/core/src/llm/tools/                     # NEW directory
└── lookup-type-def.ts                           # NEW — AI SDK tool descriptor.
                                                 #   Wraps the resolver as tool({
                                                 #     inputSchema: { package, symbol },
                                                 #     execute(args) → resolver(repoRoot, ...)
                                                 #   }).
                                                 #   Owns the once-per-review
                                                 #   "no node_modules/" detection +
                                                 #   degradedWorkers emission.

packages/core/src/schema.ts                      # MODIFIED — one line:
                                                 #   add 'api_def' to SourceTypeEnum.
                                                 #   (SourceSchema body + refinement unchanged.)

packages/core/src/llm/cascade.ts                 # MODIFIED — accept tools arg,
                                                 #   thread into streamText, add
                                                 #   stopWhen: stepCountIs(8).

packages/core/src/llm/formatter.ts               # MODIFIED — construct tools,
                                                 #   pass to cascade, extend
                                                 #   computeCacheKey with
                                                 #   dependenciesHash.

packages/core/src/llm/cache.ts                   # MODIFIED — computeCacheKey
                                                 #   gains `dependenciesHash`.

packages/core/src/llm/verify-citations.ts        # MODIFIED — dispatch source-walk
                                                 #   on source.type. 'api_def'
                                                 #   verifies against dts_file
                                                 #   (absolute path under
                                                 #   node_modules/); other types
                                                 #   unchanged (M10 path remains
                                                 #   the default).

packages/core/src/llm/prompts/system.md          # MODIFIED — append
                                                 #   "Verifying library API
                                                 #   claims" section + 4 triggers.

packages/ai/src/index.ts                         # MODIFIED — re-export `tool`
                                                 #   from `ai`.

packages/db/src/schema/type-def-cache.ts         # NEW — Drizzle table:
                                                 #   (package, version, symbol)
                                                 #   primary key; kind/signature/
                                                 #   jsdoc/dts_file/line_start/
                                                 #   line_end/found/reason fields;
                                                 #   retrievedAt timestamp.

packages/db/src/schemas.ts                       # MODIFIED — export the new
                                                 #   table from the schema barrel.

packages/db/drizzle/                             # NEW migration file generated
                                                 #   by pnpm db:generate.

packages/cli/scripts/
├── smoke-m11-lookup.mts                         # NEW — runs lookupTypeDef
│                                                #   against a fixture repo
│                                                #   with drizzle-orm, react,
│                                                #   @types/node, zod installed;
│                                                #   asserts found:true on real
│                                                #   symbols, found:false with
│                                                #   correct reason on absent.
└── smoke-m11-verifier.mts                       # NEW — runs verify-citations
                                                 #   on a Comment[] with one
                                                 #   verifiable api_def + one
                                                 #   bogus api_def; asserts the
                                                 #   bogus one drops, degraded
                                                 #   line lands.
```

No new workspace package. No new commander verb. No new env var.

## Package boundaries to honor

- All M11 code lives in `@warden/core` + `@warden/ai` + `@warden/db`. No new workspace package.
- `@warden/core` stays I/O-pure per ADR-0013: the resolver reads files under `repoRoot + '/node_modules/'` (already-allowed pattern — M6's chunker does the same); the tool descriptor calls the resolver. None write to stdout or read `process.argv`.
- `@warden/ai` adds **one line** — re-export `tool` from `ai`. Mirror precedent: `streamText`, `generateText`, `Output` are already re-exported (`packages/ai/src/index.ts:8`).
- `@warden/db` adds the new schema; the schema is content-addressed (compound primary key `(package, version, symbol)`); no FKs.
- `@warden/core` may import `tool` from `@warden/ai` (allowed). `@warden/ai` does not import `@warden/core` (forbidden) — the tool descriptor in `@warden/core/src/llm/tools/` wraps the resolver in `@warden/core/src/api/`; the descriptor is constructed _inside_ core using the re-exported `tool` factory.
- The resolver uses `TsCompilerParser` (already in `@warden/core/src/context/parser.ts`) to parse `.d.ts` AST — same parser the M5 selector + M10 consistency detector use. No new parsing dependency.
- The resolver reads `node_modules/<pkg>/package.json` via `node:fs/promises` (already-allowed I/O pattern). No `require('npm-package-arg')` or similar — the resolver is a direct file walker.

## What to build

### 1. `SourceTypeEnum` extension (`packages/core/src/schema.ts`)

One-line change:

```ts
export const SourceTypeEnum = z.enum([
  "cve",
  "advisory",
  "changelog",
  "documentation",
  "web",
  "tool",
  "repo_convention",
  "api_def", // NEW — M11: type-definition citation from .d.ts lookup.
]);
```

`SourceSchema`'s body and refinement are unchanged. The `api_def` variant re-uses `path` / `line` / `snippet` for `dts_file` / `line_start` / `signature`. The all-or-nothing refinement (lines 77–85) treats `api_def` like any other source — populate all three or none.

**No new fields, no new refinement, no schema migration.** This is the M10 dividend paying out.

### 2. `type_def_cache` table (`packages/db/src/schema/type-def-cache.ts`)

```ts
import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core";

export const typeDefCache = sqliteTable(
  "type_def_cache",
  {
    // The literal import path the LLM queried — e.g. 'drizzle-orm',
    // 'drizzle-orm/sqlite-core', '@radix-ui/react-dialog', or
    // '@radix-ui/react-dialog/internal'. Subpath-aware: 'drizzle-orm' and
    // 'drizzle-orm/sqlite-core' are independent cache rows even at the same
    // version, because they could expose overlapping symbol names.
    package: text("package").notNull(),
    // The installed version of the *root* package (the part before the first
    // subpath segment). Read from `node_modules/<packageName>/package.json`.
    version: text("version").notNull(),
    symbol: text("symbol").notNull(),

    // `found: true` columns (populated on hit):
    kind: text("kind"), // TypeDefKind | null
    signature: text("signature"),
    jsdoc: text("jsdoc"), // null = looked, none present
    dts_file: text("dts_file"), // relative to repoRoot
    line_start: integer("line_start"),
    line_end: integer("line_end"),

    // `found: false` columns:
    reason: text("reason"), // NotFoundReason | null

    // Universal:
    found: integer("found", { mode: "boolean" }).notNull(),
    retrievedAt: text("retrieved_at").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.package, t.version, t.symbol] }),
  }),
);
```

Re-export from `packages/db/src/schemas.ts`.

Run `pnpm db:generate` → produces `packages/db/drizzle/<NNNN>_<name>.sql`. Run `pnpm db:migrate` to apply to local `.warden/cache.sqlite`.

**Why a compound primary key, not a synthetic id**: content-addressed per ADR-0016. Same triple re-resolving is idempotent; no FKs to other tables (chunks/embeddings are independent indexes).

### 3. `LookupTypeDefResult` type + resolver (`packages/core/src/api/lookup-type-def.ts`)

Public types (export from `packages/core/src/api/index.ts` for re-use in the tool descriptor):

```ts
export type TypeDefKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "variable"
  | "namespace"
  | "method"
  | "property";

export type NotFoundReason =
  | "package_not_installed"
  | "no_types"
  | "symbol_not_found"
  | "lookup_error";

/**
 * Pre-shaped `Source` object the LLM copies verbatim into `Comment.sources[]`.
 * Eliminates a class of LLM-reconstruction failure modes:
 *   - `SourceSchema`'s all-or-nothing refinement rejects partial triples.
 *   - Manual `id` / `title` formatting drifts under prompt pressure.
 *   - `path` / `line` / `snippet` field-name confusion.
 * The resolver constructs this object; the LLM does not assemble fields.
 */
export interface SuggestedApiDefSource {
  type: "api_def";
  id: string; // `${package}@${version}#${symbol}`
  title: string; // `${kind} ${symbol}`
  path: string; // = dts_file (repoRoot-relative)
  line: number; // = line_start
  snippet: string; // = signature, already whitespace-normalized to one line
  retrievedAt: string; // ISO 8601
}

export type LookupTypeDefResult =
  | {
      found: true;
      package: string; // The literal import path the LLM queried.
      version: string; // Root-package version from node_modules/<root>/package.json.
      symbol: string;
      signature: string; // Whitespace-normalized to a single line.
      kind: TypeDefKind;
      jsdoc: string | null;
      dts_file: string; // Relative to repoRoot.
      line_start: number;
      line_end: number;
      suggestedSource: SuggestedApiDefSource;
    }
  | {
      found: false;
      package: string;
      symbol: string;
      reason: NotFoundReason;
    };

export async function lookupTypeDef(
  repoRoot: string,
  pkg: string, // Literal import path: 'drizzle-orm', 'drizzle-orm/sqlite-core', '@scope/pkg/sub'.
  symbol: string,
): Promise<LookupTypeDefResult>;
```

Resolver algorithm:

1. **Split the import path into `(packageName, subpath)`.**
   - If `pkg.startsWith('@')`: `packageName` = first two `/`-segments (`@scope/name`); `subpath` = the remainder (empty string if none). Reject malformed scoped names (`@foo` without second segment) → `{ found: false, reason: 'package_not_installed' }`.
   - Else: `packageName` = first segment; `subpath` = the remainder.
   - The cache key keeps the **full literal `pkg`** so subpath variants stay independent rows.
2. **Cache lookup.** Read installed version: `fs.readFile(repoRoot + '/node_modules/' + packageName + '/package.json')` → `JSON.parse(...).version`. If file missing → return `{ found: false, package: pkg, symbol, reason: 'package_not_installed' }` (do not cache — version isn't known).
3. **Cache check.** `SELECT * FROM type_def_cache WHERE package = ? AND version = ? AND symbol = ?`. If hit, reconstruct the discriminated union from the row (including rebuilding `suggestedSource` from the columns — it's not stored, just rematerialized).
4. **`.d.ts` resolution.** Two paths depending on `subpath`:
   - **Root entry (`subpath === ''`):**
     - `package.json#types` (preferred) or `package.json#typings` (older).
     - `package.json#exports['.']` — walk conditional keys (`types`, `default`, `import`, `require`) preferring `types`; accept either string-shaped or `{ types: '...' }` shapes.
     - `@types/<packageName>/index.d.ts` fallback.
   - **Subpath (`subpath !== ''`):**
     - `package.json#exports['./<subpath>']` — same conditional-walk as above, preferring `types`.
     - `package.json#typesVersions[*][<subpath>]` — older convention; honor first matching version range.
     - Direct fallback: `node_modules/<packageName>/<subpath>.d.ts` (file) then `node_modules/<packageName>/<subpath>/index.d.ts` (directory).
     - `@types/<packageName>/<subpath>.d.ts` / `@types/<packageName>/<subpath>/index.d.ts` fallback.
   - If none resolve → cache + return `{ found: false, ..., reason: 'no_types' }`.
5. **Parse `.d.ts`.** Use `TsCompilerParser` (already a `@warden/core` dependency). Walk top-level statements + their member declarations. Build a symbol table: `Map<symbolPath, { kind, signature, jsdoc, line_start, line_end }>`. The `signature` field is **stored already whitespace-normalized to one line** (collapse `\s+` → ` `, trim) — this is what the verifier matches against and what the LLM cites. Handle:
   - **Re-exports** (`export * from 'sub'`, `export { X } from 'sub'`) — recursively resolve the source file relative to the current `.d.ts`. Cap recursion depth at 8 to avoid pathological loops (rare but possible with malformed types).
   - **Namespaces** (`namespace Drizzle { function with(...) }`) — `symbol` matches dotted path: `'Drizzle.with'` resolves the namespace member.
   - **Default exports** (`export default class X`) — accessible as both `'default'` and the class's own name when bound.
   - **Class / interface members** (`class X { method(): void }`) — accessible as `'X.method'`.
6. **Symbol lookup.** Match `symbol` against the symbol table. If hit → build the `SuggestedApiDefSource` object (`id = '${pkg}@${version}#${symbol}'`, `title = '${kind} ${symbol}'`, `path = dts_file`, `line = line_start`, `snippet = signature`, `retrievedAt = new Date().toISOString()`), cache the row, return `{ found: true, ..., suggestedSource }`. If miss → cache + return `{ found: false, ..., reason: 'symbol_not_found' }`.
7. **Error handling.** Any unexpected exception during steps 4–6 → catch, log via FormatterListener (info-level), cache + return `{ found: false, ..., reason: 'lookup_error' }`. Do not surface the raw error to the LLM — the discriminated union is the contract.

Caching the negative cases (`no_types`, `symbol_not_found`, `lookup_error`) is intentional — re-resolving the same triple in the same install state is wasted work. Only the positive (cache miss + `package_not_installed`) skips caching, because version isn't known.

Cache invalidation: there is no explicit prune step in M11. Old rows for previous package versions become unreachable (queries filter on current `version`); storage grows with usage, which is fine (<1 MB per repo per ADR-0026 §3).

### 4. AI SDK re-export (`packages/ai/src/index.ts`)

One-line addition:

```ts
export { Output, streamText, generateText, tool } from "ai";
```

No new file, no abstraction.

### 5. Tool descriptor (`packages/core/src/llm/tools/lookup-type-def.ts`)

```ts
import { z } from "zod";
import { tool } from "@warden/ai";
import { lookupTypeDef, type LookupTypeDefResult } from "../../api/lookup-type-def.js";
import * as fs from "node:fs";
import * as path from "node:path";
import type { DegradedEntry } from "../../schema.js";

const InputSchema = z.object({
  package: z
    .string()
    .describe(
      "The literal import path as it appears in source code. Supports subpaths: " +
        '"drizzle-orm", "drizzle-orm/sqlite-core", "@radix-ui/react-dialog", ' +
        '"next/server". Do not strip the subpath — `drizzle-orm/sqlite-core` and ' +
        "`drizzle-orm` resolve to different .d.ts files.",
    ),
  symbol: z.string().describe('The symbol path (e.g., "with" or "Drizzle.with" or "User.method").'),
});

export function makeLookupTypeDefTool(opts: {
  repoRoot: string;
  /** Mutable collector — the tool pushes one entry the first time `node_modules/` is found missing. */
  degraded: DegradedEntry[];
}) {
  let noNodeModulesEmitted = false;

  return tool({
    description: [
      "Look up a type definition from an installed npm package. Use this",
      'BEFORE asserting facts about a library API — see the "Verifying',
      'library API claims" section in the system prompt for triggers.',
      "Returns a discriminated union; on found:false, do not assert.",
    ].join(" "),
    inputSchema: InputSchema,
    execute: async (args): Promise<LookupTypeDefResult> => {
      const nmDir = path.join(opts.repoRoot, "node_modules");
      if (!fs.existsSync(nmDir)) {
        if (!noNodeModulesEmitted) {
          opts.degraded.push({
            kind: "actionable",
            topic: "api-claim-verifier",
            message:
              "no node_modules/ directory — library API verification unavailable; run `npm install` to enable.",
          });
          noNodeModulesEmitted = true;
        }
        return {
          found: false,
          package: args.package,
          symbol: args.symbol,
          reason: "package_not_installed",
        };
      }
      return lookupTypeDef(opts.repoRoot, args.package, args.symbol);
    },
  });
}
```

The collector pattern (`opts.degraded`) keeps the tool stateless across reviews while letting it emit one entry per review. The `FormatInput` (in `formatter.ts`) passes the collector through; `cascade.ts` returns it via `CascadeResult.degraded`; `FormatResult.degraded` aggregates.

### 6. Cascade integration (`packages/core/src/llm/cascade.ts`)

Three changes:

**(a) Accept `tools` in `CascadeOptions`:**

```ts
import { tool, stepCountIs } from "@warden/ai"; // add `tool` to types if needed
// ...
export interface CascadeOptions {
  // ... existing fields ...
  tools?: Record<string, ReturnType<typeof tool>>;
}
```

`@warden/ai` may need to re-export `stepCountIs` too (it's an AI SDK v6 export). Add alongside `tool` if so.

**(b) Thread into `streamText`:**

```ts
const result = streamText({
  model: retryable,
  system: opts.systemPrompt,
  prompt: opts.userPrompt,
  output: Output.object({ schema: LlmOutputSchema }),
  tools: opts.tools, // NEW
  stopWhen: opts.tools ? [stepCountIs(8)] : undefined, // NEW
  providerOptions: {
    anthropic: {
      thinking: { type: "enabled", budgetTokens: opts.thinkingBudget },
    },
  },
});
```

**(c) Surface tool-call events (optional polish):** the `fullStream` reasoning-delta loop can also emit `tool-call` / `tool-result` events to the FormatterListener for live UI. v0 ships without — the existing reasoning-delta surface is sufficient. Re-visit if dogfood UX wants it.

**Retry semantics with tool calls.** AI SDK v6's tool-use loop runs _inside_ a single `streamText` call as multiple steps; ai-retry sees the whole call as one attempt. If a tool execution throws and isn't caught inside `execute()`, the whole step fails and ai-retry's `transientCondition` decides whether to retry. The resolver swallows its own errors and returns `lookup_error` instead of throwing — so the retry path is unaffected by tool internals.

### 7. Cache key extension (`packages/core/src/llm/cache.ts` + `formatter.ts`)

Compute `dependenciesHash` at the top of `formatReview()`:

```ts
function readDependenciesHash(repoRoot: string): string {
  for (const file of ["pnpm-lock.yaml", "package-lock.json", "yarn.lock"]) {
    try {
      const content = fs.readFileSync(path.join(repoRoot, file), "utf8");
      return hashString(content);
    } catch {
      // try next
    }
  }
  return ""; // no lockfile found
}
```

Pass into `computeCacheKey`:

```ts
const cacheKey = computeCacheKey({
  modelId: "anthropic-primary",
  systemPromptHash: hashString(systemPrompt),
  userTemplateHash: hashString(userPrompt),
  inputCommentIds: allInputComments.map((c) => c.id),
  diffHash: hashString(input.diff),
  dependenciesHash: readDependenciesHash(input.repoRoot), // NEW
});
```

`FormatInput` gains a `repoRoot: string` field (currently not threaded through — derive from `ReviewInput.repoRoot` in `index.ts` and pass into `formatReview()`).

`computeCacheKey()` in `cache.ts` gains the new field in its input type and concatenates it into the hash material. Old M4 cache entries miss on the first M11 review (the new field shifts all keys) and refill on the next.

### 8. Prompt extension (`packages/core/src/llm/prompts/system.md`)

Append a new section near the bottom of the system prompt, after the citation-discipline section. Exact text:

```markdown
## Verifying library API claims

You have a tool `lookupTypeDef({ package, symbol })`. Use it sparingly, only when you are about to make a verifiable claim about a library's API. Concrete triggers:

1. **A TSC diagnostic mentions a library type, method, or property** and you want to refine or contradict the diagnostic.
2. **You are about to assert that a library has (or lacks) a specific method, field, type, parameter, or behavior.**
3. **You are about to recommend refactoring toward a library primitive** (e.g., "replace this manual JOIN with Drizzle's `with:` clause").
4. **You are about to contradict the user's library usage** (e.g., "you wrote `parameters:` but the AI SDK uses `inputSchema:`").

Do **not** call the tool for every imported symbol or every library reference. Only when you are about to make a verifiable assertion _about_ the library.

`package` accepts the **literal import path** as it appears in source code, including subpaths: `'drizzle-orm/sqlite-core'`, `'@radix-ui/react-dialog'`, `'next/server'`. Do not collapse subpaths to the root package name — `drizzle-orm/sqlite-core` and `drizzle-orm` are different `.d.ts` surfaces.

When a `lookupTypeDef` call returns `found: true`, **copy `result.suggestedSource` verbatim** into the resulting Comment's `sources[]` array. Do not reconstruct any of its fields, do not rename, do not edit. The resolver pre-formats the source object so it parses against the schema and verifies against the cited `.d.ts` automatically.

If `lookupTypeDef` returns `found: false`, drop the claim. Do not substitute speculation. If the `reason` is `package_not_installed`, do not mention the package in your output at all — the user may be reviewing without `node_modules/` present.

You may make at most 8 tool calls per review (the orchestration layer enforces this; if you hit the cap, the LLM-end of the tool-use loop terminates and you must finish synthesizing without further lookups).
```

`user-template.md` does not need to mention the tool — system prompts are the right place for capability declarations.

### 9. Verifier extension (`packages/core/src/llm/verify-citations.ts`)

Dispatch on `source.type`. The path-resolution step is shared (both source variants store `path` as repoRoot-relative — `api_def` paths point into `node_modules/`, still under repoRoot, so `resolveWithinRoot()` accepts them unchanged). The **matching algorithm diverges**: M10 sources match snippet-against-each-single-line within `line ± 5`; `api_def` sources must handle multi-line `.d.ts` signatures (generics + JSDoc-decorated overloads routinely span 10+ lines in a `.d.ts`), so the verifier concatenates a wider line window before substring-matching.

```ts
// Existing constant (M10):
const LINE_DRIFT = 5;
// NEW for api_def sources — covers typical .d.ts signature spans:
const API_DEF_DRIFT = 30;

// inside the per-source verifier loop:
const absolutePath = resolveWithinRoot(repoRoot, source.path!);
if (absolutePath === null) {
  /* drop */
}

if (source.type === "api_def") {
  // Wider window + concat: signatures span multiple lines in .d.ts.
  // The resolver stores `signature` already whitespace-normalized to one line,
  // so we normalize the file window the same way and substring-match once.
  const start = Math.max(1, source.line! - API_DEF_DRIFT);
  const end = source.line! + API_DEF_DRIFT;
  const entry = await ensureLinesUpTo(absolutePath, end, cache);
  if (entry === null) {
    /* drop */
  }
  const window = entry.lines.slice(start - 1, Math.min(entry.lines.length, end)).join(" ");
  const ok = normalizeWhitespace(window).includes(normalizeWhitespace(source.snippet!));
  // keep / drop accordingly.
} else {
  // M10 default path — unchanged: per-line match within line ± 5.
  // (existing verifyOne() logic)
}
```

**Why a wider drift + concat for `api_def` only**: M10's per-line match is correct for runner-emitted snippets (single-line excerpts from repo code). `.d.ts` signatures are different — `function with<T extends Selection>(\n  config: Config<T>,\n  ...rest: Rest<T>\n): Query<T>` collapses to a single-line `signature` in the resolver but spans 4+ lines in the file. Per-line match would never find a line containing the whole collapsed signature. Concat-then-normalize-then-match handles this; the symbol name being part of the snippet (and the tight `API_DEF_DRIFT` window) keeps cross-declaration false-positive risk negligible. Non-`api_def` sources keep M10's semantics unchanged — single-line snippets work fine line-by-line, and widening their drift would loosen verification for no benefit.

**`API_DEF_DRIFT = 30`** covers signatures up to 61 lines; real-world `.d.ts` signatures (even with JSDoc + generics + overload sets) almost always fit. Larger outliers fail to verify and the source drops — same drop semantics as any other unverifiable citation. Tunable in M12+ if dogfood shows the bound is wrong.

`degradedWorkers` topic: drops surface under `topic: "llm"` per M10's pattern. Count-batched message (matches M10's existing shape) — e.g., `"verify-citations: dropped 2 citations without verifiable snippet"` — not per-source-id, to avoid the verbosity middle-ground rejected in ADR-0026 §10. If forensic distinction between `api_def` and other drops becomes useful in dogfood, split the count into a second info line.

### 10. Smoke harness

**`packages/cli/scripts/smoke-m11-lookup.mts`**: fixture repo under `packages/cli/scripts/fixtures/m11-lookup/` with a real `package.json` + `node_modules/` (committed for test reproducibility — small dummy `.d.ts` files, not real npm installs). Asserts:

1. `lookupTypeDef(fixture, 'drizzle-orm-fake', 'with')` returns `found: true` with correct signature **and a well-formed `suggestedSource` object** (`type === 'api_def'`, `id` matches `${pkg}@${version}#${symbol}`, `snippet` is single-line normalized, `path` equals `dts_file`).
2. `lookupTypeDef(fixture, 'nonexistent-pkg', 'foo')` returns `found: false, reason: 'package_not_installed'`.
3. `lookupTypeDef(fixture, 'pkg-without-types', 'foo')` returns `found: false, reason: 'no_types'`.
4. `lookupTypeDef(fixture, 'drizzle-orm-fake', 'nonexistent_method')` returns `found: false, reason: 'symbol_not_found'`.
5. Re-exports work: `lookupTypeDef(fixture, 'pkg-with-reexports', 'X')` resolves through `export * from './sub'`.
6. Namespaces work: `lookupTypeDef(fixture, 'pkg-with-namespace', 'NS.foo')` resolves.
7. **Subpath via `exports`**: `lookupTypeDef(fixture, 'pkg-with-subpath/sub', 'foo')` resolves via `package.json#exports['./sub']` (preferring the `types` conditional).
8. **Scoped + subpath**: `lookupTypeDef(fixture, '@scope/pkg/internal', 'bar')` resolves with the two-segment scope detection + non-empty subpath.
9. **Direct-fallback subpath**: `lookupTypeDef(fixture, 'pkg-no-exports/sub', 'baz')` resolves via `node_modules/pkg-no-exports/sub.d.ts` (no `exports` map, no `typesVersions`).
10. **Subpath cache independence**: `lookupTypeDef(fixture, 'pkg-with-subpath', 'shared')` and `lookupTypeDef(fixture, 'pkg-with-subpath/sub', 'shared')` write separate cache rows even when both succeed.

**`packages/cli/scripts/smoke-m11-verifier.mts`**: synthetic `Comment[]` with four `api_def` sources:

1. Single-line signature pointing at a real `.d.ts` line — asserts: source survives the verifier.
2. **Multi-line signature**: an `api_def` source whose `snippet` is the single-line-normalized form of a 6-line signature in the fixture `.d.ts`; the cited `line` is `line_start` of the signature; asserts the concat-and-match verifier accepts it (regression-guards the `API_DEF_DRIFT = 30` behavior).
3. Bogus signature (`snippet` doesn't appear in `dts_file` anywhere within drift) — asserts: source dropped, `degradedWorkers` count entry lands.
4. Comment whose only source is a dropped `api_def` — asserts: whole Comment drops (M10 drop semantics preserved).

Run via `pnpm smoke:m11` (add to `packages/cli/package.json` scripts).

### 11. Dogfood pass

After implementation, run `warden review` on the warden tree itself with the M11 branch checked in. Expect:

- At least one tool call fires (the formatter encounters a library API claim it wants to verify).
- The resulting Comment carries an `api_def` source that the verifier accepts.
- No regressions on M10 smoke scripts (`pnpm smoke:m10`).
- The `node_modules/`-missing degraded entry does _not_ fire (warden's own tree has `node_modules/`).

Then test the degraded path: temporarily move `node_modules/` aside, run `warden review`, confirm the single `degradedWorkers` entry surfaces.

### 12. Close-out

- Update ADR-0026 status row in `decisions.md` snapshot from `Direction` to `Done` (after dogfood acceptance).
- Update CLAUDE.md: add `[x] M11 — tool-augmented formatter + API claim verifier via .d.ts lookup per ADR-0026. lookupTypeDef tool exposed to formatter; api_def source variant on SourceTypeEnum; type_def_cache table for lookup-on-demand; verifier extension in verify-citations.ts; system prompt gains four triggers + cap=8. Plan: m11-plan.md.` line above the M10+ deferred-items list.
- Update CONTEXT.md with the four new terms (`lookupTypeDef`, `api_def`, **API claim verifier**, `type_def_cache`) — see `m11-plan.md`'s CONTEXT additions notes below.
- ADR-0019's M10+ list note in CLAUDE.md gains a parenthetical: "cross-repo / `node_modules` / `.d.ts` retrieval — narrowed to `.d.ts` only in M11 (ADR-0026); `node_modules/<pkg>/src` + sibling-repo + embedding-based retrieval all stay deferred."

## Acceptance criteria for M11

1. `pnpm check-types` passes across all packages.
2. `pnpm lint` (oxlint) passes.
3. `pnpm smoke:m11` passes both smoke scripts (lookup + verifier).
4. `warden review` on the warden tree (dogfood acceptance):
   - Runs without crash.
   - Surfaces zero `topic: "api-claim-verifier"` `kind: "actionable"` entries (node_modules/ present).
   - Either (a) at least one `api_def` source verified successfully, or (b) zero library claims attempted — both outcomes acceptable for the first dogfood pass.
   - No regressions: M10 consistency detector still fires; vuln / TSC / ESLint / committability / scalability / deadcode all unchanged.
5. Move `node_modules/` aside; run `warden review`; assert exactly one `kind: "actionable", topic: "api-claim-verifier"` degraded entry lands; restore.
6. ADR-0026 status row flips `Direction` → `Done`. CLAUDE.md M11 `[x]` line added. CONTEXT.md gains the four new terms.

## What NOT to do in this milestone

- **Do not ship the `leverage` review category.** ADR-0026 §4 explicitly defers it. Adding `'leverage'` to `CategoryEnum` or `PRIORITY_ORDER` is M12+ work tied to its own ADR.
- **Do not index `node_modules/<pkg>/src`.** ADR-0026 §2 explicitly excludes source-code indexing. Only `.d.ts` lookup ships.
- **Do not embed `.d.ts` via Voyage.** ADR-0026 §3 + Caveat: Voyage is not invoked for `.d.ts` in M11. The M6 storage layer (`chunks`, `embeddings`, `merkle`, `index_meta`) is untouched.
- **Do not add a `WardenTool` abstraction.** ADR-0026 §11: re-export `tool` from `@warden/ai`; build the descriptor in `@warden/core` using the re-export. One line, no abstraction.
- **Do not expose the tool to the committability sub-agent or future sub-agents.** ADR-0026 §13: formatter-only in M11. Each sub-agent's tool exposure is its own decision.
- **Do not implement webfetch fallback for uninstalled packages.** ADR-0026 alternatives: rejected for I/O posture + supply-chain caveats.
- **Do not implement user-global cache at `~/.warden/`.** ADR-0026 alternatives: ADR-0007 invariant holds; per-repo cache stays.
- **Do not add `Comment.api_claims[]` self-tagging field.** ADR-0026 §7: rejected as too ambitious.
- **Do not change the four triggers in the prompt.** ADR-0026 §6 locks them; M12+ may revisit based on dogfood evidence.
- **Do not change cap=8.** ADR-0026 §6 + Caveat: code constant, tunable later.
- **Do not pre-resolve symbols upfront from imports/TSC findings.** ADR-0026 §6 alternative C: rejected.
- **Do not extract a shared verifier util preemptively.** The M10 + M11 verifier paths share substring-match logic; if they end up nearly identical, fold the M11 branch out — but only after both ship; do not build `packages/core/src/_shared/snippet-verify.ts` for hypothetical M12 use.
- **Do not write tests.** Per memory `user_no_tests_personal.md`. Smoke scripts are the validation surface.
- **Do not modify `CategoryEnum`, `KindEnum`, or `mapSeverity()`.** No new categories, no new kinds.
- **Do not modify the orchestration spine** (`Runner` contract, dispatch, scratchpad, synthesizer wrapper). The tool integrates at the cascade level, below the synthesizer.
- **Do not extend `Source` with new fields.** Re-use `path` / `line` / `snippet` / `id` / `title`. ADR-0026 §9.

If you reach for any of the above, stop and re-read ADR-0026 — the deferral is intentional.

## CONTEXT.md additions

Add to §2 (Findings, comments, citations) `sources[]` entry — add `api_def` to the `type` list:

> Source `type` is one of `cve` (NVD/OSV), `advisory` (GitHub Advisory), `changelog`, `documentation`, `web`, `tool` (TSC / ESLint output), `repo_convention`, `api_def` (type definition from a `node_modules/<pkg>/*.d.ts` lookup, M11+).

Add a new entry in §2:

> **`api_def` source** — `[M11+]` Source variant carrying a type definition citation from `lookupTypeDef`. Re-uses `SourceSchema`'s M10 triple: `path` = `dts_file` (repoRoot-relative path under `node_modules/`), `line` = `line_start` of the signature, `snippet` = the signature string. `id` carries `${package}@${version}#${symbol}`, `title` carries `${kind} ${symbol}`. Verified by the **API claim verifier** post-pass — same substring algorithm as M10's snippet verification, dispatched on `type`. → ADR-0026.

Add in §3 (Models + AI layer) — new entries:

> **`lookupTypeDef`** — `[M11+]` AI SDK tool descriptor exposed to the formatter LLM. Input `{ package, symbol }`; output `LookupTypeDefResult` (discriminated union on `found: boolean`, `found: false` carries `reason: "package_not_installed" | "no_types" | "symbol_not_found" | "lookup_error"`). Lives at `packages/core/src/llm/tools/lookup-type-def.ts`; resolver at `packages/core/src/api/lookup-type-def.ts`. Cap: 8 calls per review. Triggered by the four trigger conditions in the formatter system prompt's "Verifying library API claims" section. → ADR-0026.

Add in §5 (Runners) — new entry (verifier sits alongside the M10 substring-verifier):

> **API claim verifier** — `[M11+]` Post-pass extension of M10's **substring-verifier**, dispatched on `source.type === "api_def"`. Reads the `.d.ts` file at `dts_file:line_start..line_end ± DRIFT`; substring-matches the `signature` against the file content after whitespace normalization. Failed matches drop the source; if all sources drop, the Comment drops. Same drop semantics + `degradedWorkers` surfacing as M10. → ADR-0026.

Add in §4 (Context selection + indexing) — new entry:

> **`type_def_cache`** — `[M11+]` SQLite table caching results of `lookupTypeDef` lookups. Compound primary key `(package, version, symbol)`; content-addressed in the sense that re-resolving the same triple in the same install state is idempotent. Rows store the discriminated-union result (positive rows carry `signature` / `kind` / `jsdoc` / `dts_file` / `line_start` / `line_end`; negative rows carry `reason`). Grows with usage, not with `node_modules/` size — <1 MB per repo typical. → ADR-0026.

Update §8 (Deferred concepts) — narrow the existing **cross-repo retrieval** entry:

> **cross-repo retrieval** — `[narrowed by M11 to `.d.ts` lookup]` Indexing sibling repos + `node_modules` + `.d.ts` files. M11 ships the `.d.ts` lookup subset (per ADR-0026) via `lookupTypeDef`; the rest of the bag — `node_modules/<pkg>/src` chunking, sibling-repo indexing, embedding-based `.d.ts` retrieval, webfetch fallback — stays deferred for its own future ADR. Unblocks the `leverage` category and the API claim verifier (M11 ships the verifier half).

## Design nuances captured during planning

1. **The M10 triple invariant pays its second dividend.** M10's `{path, line, snippet}` on `SourceSchema` was framed as "the architectural primitive future producers inherit verification through." M11's `api_def` source is the first such producer, and proves the design: zero new schema fields, zero new verifier algorithm, just one branch in the verifier's source walk + one enum value. If the M10 grilling had not extracted the triple, M11 would need to design schema + verifier from scratch.

2. **The keystone framing required narrowing twice.** Q1 framed M11 as "the architectural keystone — cross-repo retrieval." Q2 narrowed to `.d.ts` only + verifier consumer. Q4 narrowed again — from "indexing" to "lookup-on-demand." Each narrowing was forced by the consumer: the verifier needs exact lookup, not retrieval; exact lookup doesn't need bulk indexing. The keystone _name_ (cross-repo retrieval) misleads slightly — what M11 actually ships is _cross-repo lookup_, not retrieval in the M6 semantic-similarity sense. The naming inheritance from ADR-0019's deferral list is acknowledged; future ADRs can rename if the gap matters.

3. **The discriminated union in the tool result is load-bearing.** Q5 grilling: the user explicitly pushed for a discriminated union over an all-optional bag. The win isn't just type cleanliness — `reason` on the miss variant gives the LLM enough information to act differently per failure mode. `package_not_installed` → silent degrade. `symbol_not_found` → defensible "no such API" claim. `lookup_error` → treat like `package_not_installed`. Without the discriminator, all misses would be indistinguishable and the LLM's response logic would have to be uniform.

4. **The "four triggers" prompt addition is articulation, not bloat.** The user's Q6 pushback ("we can't look up every package; humans only check when something feels off") forced a real articulation of _when_ the tool fires. Compressing to two triggers (Q7 alternative) loses signal — refactor-toward-primitive and TSC-refining are distinct scenarios with distinct prompt-time recognition. The 4-trigger explicit form costs ~400 bytes of prompt; the implicit alternative costs prompt clarity. Explicit wins.

5. **`stopWhen: stepCountIs(8)` is the only guardrail against tool-call spirals.** AI SDK v6's native tool-use loop will happily loop indefinitely if the LLM keeps requesting tool calls; `stopWhen` is the structural cap. 8 is a guess based on "a typical PR has at most ~5 library API claims worth verifying" — the cap is loose enough that real reviews don't hit it, tight enough that pathological loops terminate. Dogfood evidence in M12+ tunes.

6. **`dependenciesHash` invalidation is the cleanest cache invalidation strategy.** Tool-using calls produce results that depend on `node_modules/` state. Without the hash, cached output would include claims about now-removed library symbols. Lockfile hash is the canonical proxy for "what packages and versions are installed" — single file, single hash, single read. Old M4 cache entries miss exactly once on the first M11 review (the new field shifts all keys); refill on the next; not a regression. Alternative: hash all of `node_modules/`'s contents — slow; `package.json` of the consumer — incomplete (transitive deps matter). Lockfile is right.

7. **The cap-8 trade-off lives in the prompt, not the code.** Two ways to enforce the cap: structural (`stopWhen`), and pedagogical (tell the LLM the cap exists so it self-rations). M11 does both. `stopWhen` is the hard backstop; the prompt's last line ("at most 8 tool calls per review") tells the LLM to budget. Without the prompt mention, the LLM may discover the cap by hitting it (the SDK terminates the tool-use loop) and then truncate mid-thought. With the mention, the LLM can plan within the budget.

8. **The "no `node_modules/`" degraded entry is once-per-review, not once-per-call.** A review with 8 tool calls into an empty `node_modules/` would emit 8 entries if the detection were per-call. The collector pattern (`opts.degraded` with the `noNodeModulesEmitted` boolean) makes the first call emit + subsequent calls silently return `package_not_installed`. Mirrors M9's noise-filter pattern — surface system-level issues _once_ per session, regardless of how many runners noticed.

9. **The resolver swallows its own errors.** Any exception thrown in steps 3–5 of the resolver becomes `{ found: false, reason: 'lookup_error' }`. This is intentional: the discriminated union is the contract; raw exceptions thrown into the AI SDK's tool-use loop would surface as model-side errors and trigger ai-retry's retry path, which doesn't help. The LLM treating `lookup_error` like `package_not_installed` is the correct fallback. The error itself can be logged via FormatterListener (info-level) for forensic purposes; it doesn't need to bubble.

10. **The verifier's drop semantics are unchanged from M10.** A Comment with one `api_def` source that drops doesn't drop the Comment if other sources survive. A Comment whose _only_ source is a dropped `api_def` drops the Comment entirely. Empty `sources[]` (no citation at all — e.g., the formatter made a claim without using the tool, in violation of the prompt) does _not_ trigger the verifier — that's the accepted gap per ADR-0026 §7. Same posture as M10 for unverifiable triples.

11. **`@types/<pkg>` fallback is non-trivial.** Many JS-only packages have separate `@types/<pkg>` packages providing the `.d.ts`. The resolver checks `package.json#types` / `#typings` / `#exports['.']['types']` on the primary package first; only on miss does it fall back to `node_modules/@types/<pkg>/index.d.ts`. Cache key uses the _primary_ package's version (the `@types/*` package may have its own version, but the user calls `lookupTypeDef('lodash', 'merge')` — they don't know whether the types come from `lodash` or `@types/lodash`). If the `@types/*` package version diverges from the primary, the lookup result may include a signature that the runtime package doesn't expose — that's a real edge case for hand-written types, but rare enough to accept in v0.

12. **Re-export depth cap of 8 is the same shape as `stopWhen: 8`.** Coincidence in number, not in semantics — re-export depth caps the resolver's recursive walk through `export * from 'sub'` chains, which can loop pathologically on malformed types. 8 is "deep enough for real re-export trees (typically 1–3 levels)" and "shallow enough to terminate quickly." If a real package fails to resolve a symbol because of the cap, the test surface (smoke fixture or dogfood) will surface it and we bump.

13. **Subpath imports are the dominant real-world shape.** Modern JS heavily uses subpath imports — `drizzle-orm/sqlite-core`, `next/server`, `react-dom/client`, `@radix-ui/react-dialog`. The root-only resolver would fail on the first dogfood review. M11 accepts the literal import path in the tool input (no separate `subpath` argument) because that matches the LLM's mental model: the LLM sees `import { sqliteTable } from 'drizzle-orm/sqlite-core'` and calls `lookupTypeDef('drizzle-orm/sqlite-core', 'sqliteTable')` — string equality with the import statement, no decomposition. The resolver internally splits `(packageName, subpath)` for `node_modules/` traversal but the cache key stays as the literal `pkg` so subpath rows stay independent. The version-extraction step always reads `node_modules/<packageName>/package.json` (the root package owns the version) — `drizzle-orm/sqlite-core` doesn't have its own `package.json`. Resolution order — `exports['./<subpath>']` → `typesVersions` → direct `.d.ts` fallback → `@types/*` fallback — matches Node's own ESM resolution closely enough that real packages resolve cleanly; the smoke fixtures pin the edge cases.

14. **Multi-line signature verification: concat-the-window, not match-each-line.** M10's verifier per-line-matches single-line snippets (runner-emitted code excerpts). `.d.ts` signatures span lines routinely — generics, JSDoc, overload sets — so per-line match would never find a candidate. M11 takes option (a) of three considered: concatenate `lines[line - DRIFT .. line + DRIFT]`, normalize whitespace once, substring-match. Picked over option (c) "match prefix-only against any line" because (a) verifies the _full signature_ is present (semantically stronger than "the symbol appears nearby") and avoids the "how many prefix chars" tuning knob (c) requires. False-positive risk in (a) is bounded by `API_DEF_DRIFT = 30` (61-line window max) and pinned by the symbol name being part of the signature — random matches across unrelated declarations require a token sequence real `.d.ts` files don't produce. The drift number is widened from M10's 5 to 30 _only_ for the `api_def` branch — M10's narrower window stays correct for its consumer.

15. **`suggestedSource` removes a class of LLM-reconstruction failure modes.** The all-or-nothing `SourceSchema.refine()` rejects partial `{path, line, snippet}` triples at parse time → the entire `LlmOutput` fails Zod validation → the cascade throws → ai-retry kicks → eventual hard fail. An LLM constructing the source field-by-field from tool-result fields will, under prompt pressure, occasionally rename `dts_file → path`, forget `snippet`, or mis-format `id`. Pre-shaping the entire Source inside the tool result and instructing the LLM to copy _verbatim_ converts the failure mode from "parse-time hard fail" to "the LLM ignored the instruction and emits no source" — which the verifier-discipline floor already handles cleanly (uncited claim → accepted gap per ADR-0026 §7). The cost is one extra interface (`SuggestedApiDefSource`) and ~80 bytes per positive tool result; the benefit is removing a Zod-parse cliff that previously gated every M11 review.

## When you're done

- Update ADR-0026's status row in `decisions.md` (line ~76 of the status snapshot table): `Direction` → `Done`. Add a note describing what shipped: "`api_def` source + `type_def_cache` table + `lookupTypeDef` resolver + tool descriptor + cascade integration + 4-trigger system prompt + cap=8 + verifier extension. Implementation across `packages/{core,ai,db}/src/`."
- Update `CLAUDE.md`: insert `[x] M11 — tool-augmented formatter + API claim verifier via .d.ts lookup per ADR-0026...` line above the `[ ] M10+ — Deferred items...` bullet.
- Update `CONTEXT.md` with the additions in the "CONTEXT.md additions" section above.
- Hand back a list of deviations from this plan (with reasons) plus confirmation all acceptance criteria pass.

The next milestone after M11 is genuinely open. Likely candidates per the M10+ basket (now lighter by one item): BYOEmbedder (engine-maturity), `leverage` review category (extends M11's verifier with a category producer), daemon `JobRunner` (skip-init UX), custom-code SAST worker (capability gap). Each gets its own ADR + plan when scheduled.
