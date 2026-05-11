# Warden — M10 Plan (close M7: consistency detector + global citation verifier)

This is the milestone brief for the agent (or future-me) implementing M10. Self-contained: read this plus `decisions.md` ADR-0021 (M7 direction) — particularly §1c (consistency detector design) and §3 (substring-verifier) — and you have everything.

M10 is a **close-out milestone**: it ships the two items ADR-0021's status table currently lists as `Open` (consistency detector) and `Open — gated on #2` (global substring-verifier post-pass). No new ADR is required — this is M7 finishing the job per its existing decision. M7's milestone bar in `CLAUDE.md` flips from `[~]` to `[x]` when M10 lands.

## Read first (in this order)

1. **`./decisions.md`** — focus on **ADR-0021 §1c (consistency detector — deterministic structured-verifier) and §3 (substring-verifier post-pass)**. Also: ADR-0008 (citation thesis — the verifier is its mechanical enforcement on the question lane), ADR-0023 (M8 orchestration spine — consistency stays inline like deadcode, not contract-migrated), ADR-0025 (M9 noise filter — consistency consumes the already-pruned `ChangedFile[]`).
2. **`./CONTEXT.md`** — §5 (Runners) for detector vs. sub-agent vocabulary; §2 for citation discipline; **substring-verifier** entry.
3. **`./CLAUDE.md`** — package boundary table.
4. **`./m7-plan.md`** — §9 (consistency detector spec) and §11 (substring-verifier algorithm). The M7 plan's `Source.path/line/snippet` assumption is **wrong** against the current `SourceSchema` — M10 fixes that gap by extending the schema first.
5. **`./packages/core/src/index.ts`** — current `review()` pipeline. M10 wires `runConsistency` into the inline `Promise.all` alongside deadcode, and inserts the verifier post-pass between `synthesize()` / `deterministicSynthesize()` and `applyHardRules()`.
6. **`./packages/core/src/schema.ts`** — `SourceSchema` (lines 51–58). M10 extends it with three optional fields.
7. **`./packages/core/src/runners/deadcode.ts`** — the inline-detector pattern consistency mirrors. Same shape as `scalability.ts`-but-not-contract-migrated.
8. **`./packages/core/src/runners/committability.ts`** — `verifyCitation()` (lines 437–488) and `toQuestion()` (lines 518–540). M10 migrates the source-emission shape and removes the internal verifier (now redundant with the global post-pass).
9. **`./packages/core/src/runners/to-comment.ts`** — `mapSeverity()` already routes `source: "consistency"` to `{ tier: 2, category: "consistency" }`. No changes needed there.

## Goal of this milestone

Close M7's two `Open` items per ADR-0021's status table, in a single coherent slice:

- **Consistency detector** (ADR-0021 §1c) — deterministic structured-verifier with three claim types (env-var requirements / CLI command shapes / `.warden/*` file path constants) against canonical doc set. Emits assertion-lane findings via `ToolFinding` → `Comment`-with-`kind: "assertion"`.
- **Global substring-verifier post-pass** (ADR-0021 §3) — runs over every `Comment` after `synthesize()` / `deterministicSynthesize()`; drops sources whose `{path, line, snippet}` triple doesn't substring-match cited file content; drops Comments left with all sources stripped (only if they had ≥1 source originally — empty `sources[]` is still discipline-conformant per ADR-0008).
- **`SourceSchema` extension** — add optional `path`, `line`, `snippet` to carry grounded citations uniformly. Migrate `committability.ts` to emit through `sources[]`; remove its internal verifier (now redundant). Other producers (TSC / ESLint / vuln / jscpd / scalability / deadcode) leave the new fields undefined — they have tool-grounded sources, not LLM-quoted snippets.

By the end:

- `warden review` on the canonical doc-vs-code mismatch fixture catches: README claiming `VOYAGE_API_KEY` is "required" while the schema treats it as optional; a doc-referenced `warden <verb>` that doesn't exist on the commander surface; a `.warden/*` path mentioned in docs but absent from source.
- `Comment` whose `sources[]` carries `{path, line, snippet}` triples is mechanically verified pre-render; unverifiable triples drop silently with a forensic `degraded: { kind: "info", topic: "llm", message: "dropped N citations..." }` line.
- `committability.ts:verifyCitation()` is deleted; committability emits `sources[]` with `{path, line, snippet}` and lets the global verifier handle it.
- `pnpm smoke:m10` exercises both pieces; `pnpm check-types` + `pnpm lint` pass.
- ADR-0021 status table updated (#1 → Done, #3 → Done, #12 → Done). `CLAUDE.md` M7 bullet flips to `[x]`; an `[x]` M10 bullet lands above the M10+ deferred-items list.

**Stop at "consistency detector lands + verifier post-pass lands + schema extension + committability migration + smoke + close-out." Do NOT start: free-form prose claim extraction (ADR-0021 §1c explicitly defers); multi-language consistency (TS-only via parser hop); sub-agent variant of consistency (a future ADR may flip §1c, but M10 is the §1c-as-written path); generic source-schema validators for the new fields beyond the substring path; or any item from the M10+ deferred list in `CLAUDE.md`.** Those are later milestones.

## Repo additions

```
packages/core/src/runners/
└── consistency.ts            # NEW — deterministic structured-verifier;
                              # env-var + CLI + file-path claims.

packages/core/src/llm/
└── verify-citations.ts       # NEW — post-pass over Comment[] sources[];
                              # substring-match each {path, line, snippet}
                              # triple against cited file content.

packages/core/src/schema.ts   # MODIFIED — SourceSchema gains optional
                              # path / line / snippet.

packages/core/src/runners/committability.ts
                              # MODIFIED — emit sources[] with the new
                              # triples; remove `verifyCitation()` (now
                              # handled by the global verifier).

packages/core/src/index.ts    # MODIFIED — wire runConsistency() into the
                              # inline Promise.all (next to deadcode);
                              # invoke verifyCitations() between
                              # synthesize()/deterministicSynthesize()
                              # and applyHardRules().

packages/core/src/runners/types.ts
                              # UNCHANGED — `source: "consistency"` already
                              # in the union (M7 left it ready).

packages/cli/scripts/
├── smoke-m10-consistency.mts # NEW — runs the detector against a fixture
│                             # with three deliberate doc-vs-code mismatches.
└── smoke-m10-verifier.mts    # NEW — runs the verifier against a fixture
                              # Comment[] with one verifiable + one bogus
                              # citation; asserts the bogus one drops and
                              # the `degraded` line lands.
```

No new workspace package. No new database table. No new commander verb.

## Package boundaries to honor

- All M10 code lives in `@warden/core` + `@warden/cli`. No new workspace package.
- `@warden/core` stays I/O-pure per ADR-0013: the verifier reads cited files (input via `Comment[]`); the consistency detector reads doc files + introspects schema/commander surfaces (via DI for the commander surface — see §3 below). None write to stdout or read `process.argv`.
- The consistency detector reads `wardenEnv()`'s zod schema **statically by re-parsing `packages/env/src/index.ts` as source**, not by importing the schema object. Reason: importing `wardenEnv()` would invoke the env validator, which fails when required vars are absent — and the detector must run regardless of the user's `.env` state. Re-parsing the source file (zod predicates are syntactically detectable: `.optional()`, `.default(...)`, `.min(1, ...)`) avoids the side-effect.
- The consistency detector reads `packages/cli/src/index.ts` (and `commands/*.ts`) as source to enumerate commander verbs + flags. Same reasoning — running `commander` via `program.commands` would require executing the CLI's startup path. Static parse via `TsCompilerParser` is the principled path. (The detector lives in `@warden/core`, which doesn't depend on `@warden/cli` — this is a one-directional file read, not an import.)
- The verifier reads cited files via `node:fs/promises`. Bounded read (line range + ±5 drift, not whole file) — same posture as `committability.ts:verifyCitation()`.

## What to build

### 1. `SourceSchema` extension (`packages/core/src/schema.ts`)

```ts
export const SourceSchema = z.object({
  type: SourceTypeEnum,
  url: z.url().optional(),
  id: z.string().optional(),
  title: z.string().optional(),
  retrievedAt: z.string(),
  // M10: grounded citation triple. Producers that quote file content
  // (committability sub-agent, future LLM workers, consistency detector's
  // code-side evidence) populate all three. Tool-grounded sources (TSC /
  // ESLint / npm-audit / OSV) leave them undefined — their grounding is
  // the tool's exit code, not a snippet to substring-verify.
  path: z.string().optional(),
  line: z.number().int().positive().optional(),
  snippet: z.string().optional(),
});
```

Invariant: a source either has all three of `{path, line, snippet}` populated or all three undefined. The verifier skips sources where any of the three is undefined (mixed-population means "intentionally not snippet-citing"). Encode this as a zod refinement (`refine(s => (s.path && s.line && s.snippet) || (!s.path && !s.line && !s.snippet), { message: "..." })`); only the verifier reads it, so failure surfaces as a dropped source, not a hard parse error.

### 2. Global substring-verifier (`packages/core/src/llm/verify-citations.ts`)

Public shape:

```ts
import type { Comment, DegradedEntry } from "../schema.js";

export interface VerifyCitationsInput {
  comments: Comment[];
  repoRoot: string;
}

export interface VerifyCitationsOutput {
  comments: Comment[];
  degraded: DegradedEntry[];
}

export async function verifyCitations(
  input: VerifyCitationsInput,
): Promise<VerifyCitationsOutput>;
```

Algorithm (per ADR-0021 §3, refined for the extended schema):

1. For each `Comment` whose `sources[]` contains at least one source with all three of `{path, line, snippet}` populated:
   - For each such source: read `path` (cached per `(repoRoot, path)` for the call), slice to `line ± 5`, normalize whitespace (`s.replace(/\s+/g, " ").trim()`) on both candidate lines and the snippet, substring-match. Mirror `committability.ts:verifyCitation()` exactly: strip a stray `<n>: ` line-number prefix from the snippet first; bounded read (a single `open`/`read`/`close` against the file).
   - Keep the source if any candidate line contains the normalized snippet; drop the source otherwise.
2. After source-pruning: if a Comment had ≥1 snippet-bearing source originally and ends up with 0 of them, drop the whole Comment. Comments whose sources never carried snippets (all undefined) pass through untouched — they're not citation-asserting, so there's nothing to verify.
3. Emit one `degraded: { kind: "info", topic: "llm", message: "dropped N citations without verifiable snippet" }` entry when N > 0; one `degraded: { kind: "info", topic: "llm", message: "dropped M comments after citation pruning" }` entry when M > 0. Separate lines so the forensic count is unambiguous.

Failure modes:
- File-read error (file moved between detector emit and verifier read) → drop the source; emit `degraded: { kind: "info", topic: "llm", message: "..." }`.
- Symbolic-link / out-of-repo path → defense-in-depth via `resolveWithinRoot()` lifted from `committability.ts` (or extracted to `packages/core/src/_shared/path.ts` if the duplication bothers).

Determinism: same input → same output. No timestamps, no random ordering.

### 3. Consistency detector (`packages/core/src/runners/consistency.ts`)

Public shape mirrors deadcode (inline, not contract-migrated — matches §1c's intent and the M8 leftover-inline pattern):

```ts
import type { ChangedFile } from "../diff/index.js";
import type { DegradedEntry } from "../schema.js";
import type { ToolFinding } from "./types.js";

export interface ConsistencyRunnerInput {
  repoRoot: string;
  changed: ChangedFile[];
}

export interface ConsistencyRunnerOutput {
  findings: ToolFinding[];
  degraded: DegradedEntry[];
}

export async function runConsistency(
  input: ConsistencyRunnerInput,
): Promise<ConsistencyRunnerOutput>;
```

Doc set (per M7 plan §9 + the user's confirmed scope):

- `README.md` (repo root)
- `CLAUDE.md` (repo root)
- `AGENTS.md` (repo root)
- `docs/**/*.md` (recursive glob, depth ≤ 4)

Out of scope: `node_modules/**/*.md`, `.github/**/*.md`, sub-package READMEs (`packages/*/README.md`), `decisions.md` / `CONTEXT.md` / `vision.md` / `m*-plan.md` (those are design docs, not user-facing API claims — adding them risks false positives on intentional historical/aspirational claims).

#### Trigger condition

The runner fires whenever `changed.length > 0` AND any of:
- A doc file is in `changed` (doc edit — verify against current code).
- A code file is in `changed` and any doc claim references a symbol/path/env-var the diff touches (overlap-only verification — bounded `O(claims × diff-size)`).

No diff → no run (per `index.ts`'s existing `changed && changed.length > 0` guard pattern).

#### Three claim types

##### a. Env-var claims

Extract via regex over the doc set:

```ts
const ENV_CLAIM_RE = /\b(WARDEN_[A-Z_]+|ANTHROPIC_API_KEY|GOOGLE_GENERATIVE_AI_API_KEY|VOYAGE_API_KEY|NODE_ENV)\b[^.\n]{0,80}?\b(required|optional|defaults?\s+to\s+`?([A-Za-z0-9_./-]+)`?|default\s+`?([A-Za-z0-9_./-]+)`?)\b/gi;
```

Pair each match with `(envVar, predicate: "required"|"optional"|"default-VALUE")`. Cap the line gap to 80 chars to keep adjacency tight; multiline claims are out of scope (false-positive ceiling).

Verify by re-parsing `packages/env/src/index.ts` with `TsCompilerParser`:

- Walk the `envSchema = z.object({...})` literal.
- For each property, determine: required (any `.string().min(1, ...)` chain without `.optional()` / `.default(...)`), optional (chain contains `.optional()`), default-bearing (chain contains `.default(X)`; extract `X` as the value literal).
- Compare doc claim against schema reality. Mismatches:
  - doc says "required" + schema says optional → `{ruleId: "env-required-mismatch", message: "README claims VOYAGE_API_KEY is required; schema treats it as optional"}`.
  - doc says "optional" + schema says required → symmetric.
  - doc default value ≠ schema default value → `{ruleId: "env-default-mismatch", message: "..."}`.
  - doc names env var not in schema → `{ruleId: "env-not-in-schema"}`.
  - schema names env var not in any doc → **out of scope for v0** (false-positive risk: not every env var deserves doc mention).

##### b. CLI command shapes

Extract from triple-fenced code blocks in the doc set:

```ts
const CLI_CLAIM_RE = /\bwarden\s+([a-z][a-z0-9-]*)\b(?:\s+(--[a-z][a-z0-9-]*(?:\s+\S+)?))*/g;
```

Pair each match with `(verb, flags: string[])`.

Verify by re-parsing `packages/cli/src/index.ts` and `packages/cli/src/commands/*.ts` with `TsCompilerParser`:

- Find `program.command("X")` and `.option("--flag <value>", "...")` chains.
- Enumerate `{verb, flags: string[]}` tuples from the AST.
- Compare doc claim against the registered surface. Mismatches:
  - Doc references `warden <verb>` that doesn't exist → `{ruleId: "cli-unknown-verb"}`.
  - Doc passes `--flag` to a verb that doesn't register it → `{ruleId: "cli-unknown-flag"}`.

Out of scope: positional-arg validation (commander's positional surface is sparse in this codebase); `--flag <value>` value-shape checks.

##### c. File-path constants

Extract:

```ts
const PATH_CLAIM_RE = /\.warden\/[\w./-]+/g;
```

Verify by grepping `packages/*/src/**/*.{ts,mts,tsx}` for the same literal. Use `node:fs` + a bounded directory walk (mirrors the doc set walker — depth ≤ 6 under each package's `src/`). Mismatches:
- Doc references `.warden/<path>` that doesn't appear in any source file → `{ruleId: "stale-path"}`.

Why not extend to general `<package>/<path>` strings: too noisy. `.warden/` is the cache anchor and the only path-constant family that's load-bearing in user-facing docs.

#### Per-finding shape

```ts
{
  source: "consistency",
  file: docPath,
  line: docLine,
  column: 1,
  endLine: docLine,
  severity: "warning",
  ruleId: "env-required-mismatch" | "env-default-mismatch" | "env-not-in-schema"
        | "cli-unknown-verb" | "cli-unknown-flag" | "stale-path",
  message: "<claim-specific>",
}
```

Maps via `mapSeverity()` (already wired) to `{tier: 2, category: "consistency", kind: "assertion"}`.

The detector does **not** populate the new `{path, line, snippet}` on `sources[]` for v0 — its citations are doc-line + code-line pairs, naturally encoded in the `Comment`'s `file`/`lineStart` (doc side) and `message` body (which names the code-side symbol). The dual-line shape on `sources[]` is a future enhancement if a consumer needs structured access to both sides; today's renderers (CLI text + JSON) consume `file:line` + `message` directly. The verifier handles `sources[]` triples uniformly when present, so this is forward-compatible.

#### Failure modes

- Doc parse error (rare — `.md` is line-based, regex-driven) → emit `degraded: {kind: "warning", topic: "consistency", message: \`failed to parse \${doc}: \${err.message}\`}`; continue.
- `env/src/index.ts` parse error → emit `degraded: {kind: "warning", topic: "consistency", message: "failed to parse env schema; env claims skipped"}`; CLI + path claims still run.
- `cli/src/index.ts` parse error → symmetric; env + path claims still run.

### 4. Pipeline wiring (`packages/core/src/index.ts`)

Three edits:

1. **Import + inline call.** Add `import { runConsistency } from "./runners/consistency.js";` next to the deadcode import. Add a new entry to the inline `Promise.all` (same shape as deadcode's `.catch()` fallback):

   ```ts
   changed && changed.length > 0
     ? runConsistency({ repoRoot: input.repoRoot, changed }).catch((err: unknown) => ({
         findings: [] as ToolFinding[],
         degraded: [
           {
             kind: "warning",
             topic: "consistency",
             message: `consistency: detector failed (${formatErr(err)})`,
           },
         ] as DegradedEntry[],
       }))
     : Promise.resolve({ findings: [] as ToolFinding[], degraded: [] as DegradedEntry[] }),
   ```

   Destructure the new `consistencyResult` from the array. Record into the scratchpad:

   ```ts
   scratchpad.record({
     name: "consistency",
     findings: consistencyResult.findings,
     degraded: consistencyResult.degraded,
     durationMs: 0,
   });
   ```

2. **Verifier post-pass.** Between `synthOutput` resolution and `applyHardRules()`:

   ```ts
   const verified = await verifyCitations({
     comments: synthOutput.comments,
     repoRoot: input.repoRoot,
   });
   const finalComments = applyHardRules(verified.comments, input.config);
   ```

   The `verified.degraded` entries fold into the final `degradedWorkers[]` aggregation.

3. **`degradedWorkers[]` aggregation.** Add `...verified.degraded` to the existing return spread.

### 5. Committability migration (`packages/core/src/runners/committability.ts`)

Two edits:

1. **`toQuestion()` emits the new triple on `sources[]`** (line 518–540):

   ```ts
   sources: [
     {
       type: "repo_convention",
       id: "committability-subagent",
       title: f.path,
       retrievedAt: new Date().toISOString(),
       // M10: grounded citation triple. The verifier post-pass substring-
       // matches `snippet` against `path:line ± 5`.
       path: f.path,
       line: f.line ?? undefined,
       snippet: f.line != null ? f.snippet : undefined,
     },
   ],
   ```

   Note the `f.line != null` guard: name-only findings (committability flags a suspicious filename without a content line) carry no snippet — the triple stays empty for those, and the verifier skips them. The Comment still surfaces (filename + reason in `claim`), just without a verifier-checked snippet.

2. **Remove the internal `verifyCitation()` flow** (lines 154–187). Findings flow through to `toQuestion()` directly; the global verifier in `runReview()` handles substring verification uniformly. Keep `verifyCitation` and `normalizeWhitespace` deleted; the global verifier in `verify-citations.ts` will reimplement them (extracting to a shared util is optional polish — preserve only if the verifier and any future producer both need it).

   The `droppedUnknownPath` guard (line 161–164) **stays** — that's not citation verification, that's "did the LLM cite a path outside the diff?" which is a separate discipline (lane integrity, not citation accuracy). Keep that check inline; only the snippet verification moves to the global pass.

### 6. Smoke harness

`packages/cli/scripts/smoke-m10-consistency.mts`:

- Builds a fixture in a temp directory: `README.md` with `VOYAGE_API_KEY` claimed "required" (schema says optional); a `## Usage` code-fence with `warden frobnicate --bogus` (verb doesn't exist); a paragraph mentioning `.warden/legacy-cache.bin` (no source file).
- Copies `packages/env/src/index.ts` + `packages/cli/src/index.ts` verbatim (the detector reads them).
- Runs `runConsistency({repoRoot: fixtureRoot, changed: <fixture diff>})`.
- Asserts three findings with the expected `ruleId`s.
- Asserts each finding's `message` contains the offending claim text.

`packages/cli/scripts/smoke-m10-verifier.mts`:

- Synthesizes a `Comment[]` with:
  - Comment A: one source with valid `{path, line, snippet}` triple (snippet substring-appears at `line ± 5` in `path`).
  - Comment B: one source with invalid triple (snippet does NOT appear).
  - Comment C: one source with no triple (legacy tool-grounded source).
- Runs `verifyCitations({comments, repoRoot})`.
- Asserts A passes through unchanged; B's source is dropped → B itself is dropped (since the bogus source was its only source); C passes through unchanged.
- Asserts `degraded` contains exactly two `kind: "info"` entries (one for "dropped 1 citation", one for "dropped 1 comment").

Wire both into a new `pnpm smoke:m10` script in `packages/cli/package.json`. CI runs them.

## Conventions to enforce from day one

- **The consistency detector emits `kind: "assertion"`** via the `ToolFinding` → `toComment()` path. No detector emits questions; this is lane discipline (CONTEXT.md §2, §5).
- **Every snippet-bearing source goes through the global verifier.** The committability runner's removal of its internal verifier is the migration; no other emitter creates snippet-bearing sources today, but if M11+ adds a free-form prose consistency sub-agent or any other snippet producer, they automatically inherit the verifier — that's why the post-pass design is "iterate `Comment[]`," not "have producer call verifier."
- **Source-schema triple is all-or-nothing.** Either populate `{path, line, snippet}` together or leave all three undefined. Mixed shapes silently fail verification.
- **Doc set is fixed.** No glob extension. If a docs/ subdir or root-level planning doc is missing claims, M11+ can debate adding it; M10 ships the M7-plan scope verbatim.
- **No new commander surface.** No `--verify-citations` flag, no `--skip-consistency` flag. Detectors and the verifier are unconditional; users who want to skip a runner can already gate it via diff scope.
- **TS-only.** The detector parses `env/src/index.ts` and `cli/src/index.ts` via `TsCompilerParser` (the M5 abstraction). Multi-language env / CLI surfaces (Python `argparse`, Go `flag`, etc.) are not in scope; deferred to whatever later milestone owns multi-language detector support.

## Slice ordering

| Slice | Scope | Smoke gate |
|---|---|---|
| **0** | Read this plan + ADR-0021 §1c/§3. | Plan reviewed. |
| **1** | Schema extension (§1). Migrate `committability.ts:toQuestion()` to emit the triple; remove the internal `verifyCitation()` flow. `pnpm check-types` passes. | No behavioral change yet (verifier doesn't exist) — committability still emits questions, but they now carry triples on `sources[]` and the internal verifier is gone. Manual: run `warden review` on a small diff; committability questions still render correctly. |
| **2** | Global verifier (§2). Wire into `runReview()` between `synthOutput` and `applyHardRules()`. `smoke-m10-verifier.mts`. | Verifier drops a deliberately-malformed citation; emits the forensic line; the rest of the review is unaffected. |
| **3** | Consistency detector (§3, §4). `smoke-m10-consistency.mts`. | Runs on fixture with three planted mismatches; surfaces three findings; each carries the expected `ruleId`. |
| **4** | Dogfood pass: run `warden review` against warden's own working tree (with no diff changes, just a content audit) — does the detector surface any genuine doc-vs-code drift? If yes: document each one in the close-out report and decide which to fix in this branch vs. punch-list. | At least one genuine drift caught (or documented absence: "the docs are already consistent with the schema/CLI/paths"). |
| **5** | Close-out: ADR-0021 status table updated; `CLAUDE.md` M7 bullet → `[x]`; new `[x]` M10 bullet added above the M10+ deferred-items list. Commit message references closing M7. | M10 ships. |

## Acceptance criteria for M10

1. `pnpm check-types` passes.
2. `pnpm lint` (oxlint) passes.
3. `pnpm smoke:m10` passes both smoke scripts.
4. `warden review` on the dogfood pass (Slice 4) produces no unhandled crashes and surfaces either genuine drift or a clean "no findings" result; either outcome is acceptable.
5. ADR-0021 status table (decisions.md lines 759–772): #1 row → "Done" (all three detectors shipped); #3 row → "Done — global verifier ships in `packages/core/src/llm/verify-citations.ts`"; #12 row → "Done — `smoke-m10-{consistency,verifier}.mts` shipped".
6. `CLAUDE.md` M7 bullet: `[~]` → `[x]`. New `[x]` M10 line added: `M10 — close M7: consistency detector + global citation verifier per ADR-0021 §1c + §3. Schema extension to carry `{path, line, snippet}` on sources; committability migrated to emit through `sources[]` (internal verifier removed). Plan: m10-plan.md.`
7. The committability runner's `verifyCitation` and `normalizeWhitespace` private functions are removed (or, if extracted to a shared util, called from a single site).
8. `Source` zod schema parse on the existing committability fixtures continues to pass (the new fields are optional — no regression on producers that don't populate them).

## What NOT to do in this milestone

- **Do not implement free-form prose consistency.** §1c is deterministic-only by ADR-0021's explicit decision. The M11+ free-form-prose sub-agent (if it ever ships) gets its own ADR.
- **Do not add a sub-agent variant of consistency.** Earlier conversation considered this; the user confirmed §1c-as-written. Reverting to a sub-agent path requires amending ADR-0021.
- **Do not expand the doc set.** No `decisions.md`, `CONTEXT.md`, `vision.md`, or `m*-plan.md` parsing. Those docs contain intentional historical/aspirational claims that would produce false positives.
- **Do not import `wardenEnv()` at detector runtime.** Side effect (env validation) crashes the detector on a fresh repo without `.env`. Re-parse `env/src/index.ts` as source instead.
- **Do not migrate the consistency detector through the M8 orchestration spine.** It stays inline like deadcode/jscpd/tsc/eslint/vuln. Contract migration is M11+ work tied to its own ADR.
- **Do not extract a shared `verifyCitation` util preemptively.** If `verify-citations.ts` and a removed-from-committability `verifyCitation` end up nearly identical, fold the committability copy out — but only the one consumer. Don't build `packages/core/src/_shared/snippet-verify.ts` for hypothetical M11 use.
- **Do not change `SourceTypeEnum`.** The existing seven values (`cve`, `advisory`, `changelog`, `documentation`, `web`, `tool`, `repo_convention`) cover the consistency detector's emissions (`tool` for tool-grounded; `documentation` if a future consistency producer wants to cite the doc side as its own source — but v0 doesn't).
- **Do not write tests.** Per memory `user_no_tests_personal.md`. Smoke scripts are the validation surface.
- **Do not modify `CategoryEnum`, `KindEnum`, or `mapSeverity()`.** All three already route `consistency` correctly.
- **Do not touch the M8 `Runner` contract, dispatch, scratchpad, or synthesizer.** Consistency is inline; the verifier is a post-pass on `Comment[]` after synthesis completes. No orchestration-tier change.

If you reach for any of the above, stop and re-read ADR-0021 §1c/§3 — the deferral is intentional.

## Design nuances captured during planning

1. **The schema extension is the load-bearing primitive.** Without `{path, line, snippet}` on `Source`, the verifier has nothing to verify — committability's snippet currently lives in `Comment.explanation`, which the LLM authored, not the runner. Migrating committability first means M10's "verifier post-pass" actually has data to chew on; reversing the order would leave the verifier a no-op until a producer fills it.

2. **Committability's internal verifier becomes redundant, not wrong.** The internal `verifyCitation()` runs *before* `toQuestion()` produces the Comment; the global verifier runs *after* `synthesize()`. Same substring algorithm; same drop semantics. Keeping both means double-verification at runtime cost; removing the internal one centralizes the discipline at the only post-pass that can serve future producers uniformly. The lane invariant (citation discipline applies to all citation-bearing comments) is preserved either way; the choice is "where in the pipeline."

3. **The consistency detector is the *only* M7 detector that *parses sibling-package source as text*.** Scalability + deadcode read diff-touched code; the LLM formatter reads cited snippets. Consistency reads `env/src/index.ts` and `cli/src/index.ts` to extract structured surfaces (zod schema properties, commander verbs+flags) — those files aren't in the diff, so the standard `ChangedFile`-based `parseChangedSourceFile` helper doesn't apply. A small `parseTsFile(absPath, "consistency")` utility lifted from the M5 parser infrastructure handles it; same `TsCompilerParser` lineage, different input source.

4. **The all-or-nothing source-triple invariant is structural, not validated upstream.** `SourceSchema` declares all three optional; the producer is trusted to populate them coherently. The verifier enforces by skipping mixed sources entirely (any of the three undefined → not a snippet-citation, not subject to verification). The alternative — zod refinement that fails parse on mixed — would force the orchestration layer to drop comments with malformed sources before they hit the verifier; cleaner separation but heavier engineering for a contract today's only consumer (committability) controls end-to-end. Re-evaluate if a second snippet-source producer lands and inconsistency becomes a real risk.

5. **The consistency detector's three claim types intentionally exclude "schema names env var not in any doc."** Symmetric on its face (parity between doc and code), but the false-positive rate is unbounded: not every internal env var deserves a doc mention (some are intentionally undocumented). v0 catches *contradiction*, not *omission*. Adding omission detection is a future-milestone tuning concern; the deterministic shape is the same, only the directionality differs.

6. **Re-parsing `env/src/index.ts` instead of importing it is a "no side effects at detector time" principle.** Import would invoke zod's parser on `process.env`, which crashes if `ANTHROPIC_API_KEY` is unset. A detector running against an arbitrary fixture must not depend on the host env state; static source parse is the only side-effect-free option. Generalizes to: detectors that introspect first-party packages should parse, not import.

7. **The verifier's drop semantics differ between "source had no snippet" (silent passthrough) and "snippet didn't match" (dropped + counted).** Empty `sources[]` and snippet-less sources are *valid* under the citation discipline (asking is not claiming; tool grounding doesn't quote). Only sources that *claim a verifiable echo* and fail to deliver get dropped. The forensic count surfaces only the failures, never the legitimate snippet-less sources — otherwise every TSC/ESLint finding would inflate the count uselessly.

8. **The post-pass position (after `synthesize()`, before `applyHardRules()`) is deliberate.** The synthesizer is where LLM-authored citations enter; placing the verifier after it catches both deterministic-runner citations (e.g., a future consistency producer with snippet triples) and LLM-authored ones in a single pass. Placing it *inside* the synthesizer would couple verification to LLM-pass-only — wrong, because the check-mode `deterministicSynthesize()` should also enforce citation discipline if a deterministic detector ever emits snippets. Placing it *after* `applyHardRules()` would mean priority-sorted comments get pruned post-sort, breaking the "what does the user see" → "what was the verified set" parity.

## When you're done

- Update ADR-0021's status table (decisions.md lines 759–772): #1 to "Done", #3 to "Done", #12 to "Done".
- Update `CLAUDE.md`: M7 bullet `[~]` → `[x]`; insert a new `[x] M10 — close M7: consistency detector + global citation verifier per ADR-0021 §1c + §3...` line above the `[ ] M10+ — Deferred items...` line.
- Hand back a list of deviations from this plan (with reasons) plus confirmation all acceptance criteria pass.

The next milestone is genuinely M11 — picking one item from the M10+ deferred-items list in `CLAUDE.md` (BYOEmbedder, custom-code SAST worker, `warden index export/import` verbs, etc.) with its own ADR + plan.

---

## Lessons from M10 → M11 transition

### Dogfood pass — real drift surfaced against warden's own tree

Running the detector against the warden repo (with a synthetic "all three root docs touched" diff so the doc-edit trigger fires) surfaced 5 genuine findings:

| ruleId | doc:line | finding |
|---|---|---|
| `env-required-mismatch` | `README.md:54` | README claims `VOYAGE_API_KEY` is "required for `warden init`"; schema marks it `.optional()`. Technically the README's claim is context-conditional ("for init") but the regex matches the bare predicate word — both interpretations are defensible since the schema doesn't encode the context, so a tightening of the docs ("required when running `warden init`") would be the right read. |
| `env-not-in-schema` | `README.md:56`, `CLAUDE.md:103`, `AGENTS.md:103` | All three docs document `WARDEN_THINKING_BUDGET` (an Anthropic extended-thinking budget knob). The env schema does **not** define it. Either the var was removed from the schema (drift) or it was never added (intent was to read `process.env` directly via `wardenEnv()`-bypass somewhere in `@warden/ai`). Worth resolving in the M10+ doc-cleanup punch list, not in this branch — M10's job is to *detect*, not fix. |
| `stale-path` | `README.md:108` | README mentions `.warden/cache.sqlite.bak` (likely a documented backup convention) but no source file under `packages/*/src` uses that literal. Same disposition: documented but unimplemented; either remove the doc reference or wire the convention. |

**Decision: none fixed in this branch.** The dogfood pass exercises the detector against a real codebase; fixing the surfaced drift is a separate doc-quality commit. The findings are the point — the detector earned rent.

### Deviations from this plan

1. **No `parseTsFile()` shared util.** The detector calls `ts.createSourceFile()` directly with file content read via `node:fs/promises` — the plan suggested lifting a helper from M5's parser infrastructure, but the env + CLI parses are shaped differently enough (no module resolution, no `TsCompilerParser` lifecycle) that a shared helper added abstraction without payoff. The two parse sites are ~5 lines each.
2. **CLI flag-binding is program-global, not per-verb.** Plan §3b §"Out of scope" allows positional-arg + value-shape skips; v0 also accepts the looser flag-to-verb binding (a flag known to any verb counts as "registered"). Tightening to per-verb requires walking commander chains; deferred until a dogfood finding exposes the gap.
3. **`SourceSchema` refinement is structural only.** The all-or-nothing invariant is enforced via `z.refine()` on the schema — but only the global verifier reads it, so partial triples surface as silently-skipped citations rather than parse failures (matches plan §1's "Encode this as a zod refinement; only the verifier reads it, so failure surfaces as a dropped source").
4. **AGENTS.md is a symlink to CLAUDE.md.** Editing CLAUDE.md was sufficient; no separate edit needed.

### Open seams worth M11+ attention

- **Regex-based env-claim extraction is fragile.** The 80-char gap window catches table-cell prose ("Required for ...") and inline `.env` examples but misses multi-line claims and any phrasing the regex doesn't anticipate. A free-form prose extraction sub-agent (per ADR-0021 §1c's deferred clause) is the principled future direction.
- **Context-conditional claims ("required for X").** `VOYAGE_API_KEY` is the canonical example: the schema treats it as optional unconditionally, but the README's "required for `warden init`" is also true. A more sophisticated detector would carry a context predicate. v0's read is acceptable — flagging is better than missing, and the user disambiguates.
- **The verifier post-pass is `Comment`-uniform.** When a future producer (free-form prose worker, custom-code SAST) emits snippet-bearing sources, it inherits substring verification automatically — that's the architectural win. M11+ producers don't need to call the verifier; they just emit the triple.
