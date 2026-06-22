# Warden — M13 Plan (`security` review category — ESLint security floor + Haiku triage sub-agent with DeepSec-borrowed prompt structure)

This is the milestone brief for the agent (or future-me) implementing M13. Self-contained: read this plus `decisions.md` ADR-0028 and you have everything.

M13 fills the long-empty `'security'` `CategoryEnum` slot with **two default-review producers** under one category, pattern-matching M12's leverage shape exactly. The detector half lives beside the existing ESLint runner but uses a Warden-owned ESLint invocation with off-the-shelf security plugins (`eslint-plugin-security` + `eslint-plugin-no-secrets`); the sub-agent half is a Haiku triage runner with a ~120-line DeepSec-borrowed system prompt covering 10 OWASP-ish v0 slugs. The on-demand deep tier (`warden security` verb + Sonnet specialist worker + dedicated orchestration harness) is M14's job; M13 stays in the existing M8 harness and earns its rent by shipping the new **per-category confidence-threshold subsystem** (CONTEXT.md §7 `[deferred]` since M4) — security is the first category whose default-review LLM output needs volume control.

## Read first (in this order)

1. **`./decisions.md`** — focus on **ADR-0028** (the M13 design commit). Also: ADR-0015 (DeepSec borrow-vs-reject framing — M13 cashes the borrow); ADR-0027 (M12 — structural twin: detector + sub-agent under one category); ADR-0026 (M11 — `lookupTypeDef`, `api_def` source, M13's Haiku is the third consumer); ADR-0021 §3 (M10 substring-verifier + question-citation discipline — security sub-agent rides this path unchanged); ADR-0023 (M8 orchestration spine — sub-agent rides the `Runner` contract); ADR-0020 + ADR-0012 (priority-order — `'security'` slotted since v0, no change here); ADR-0009 (ESLint as the pattern engine — M13 adds a Warden-owned security invocation, not target-config coupling).
2. **`./CONTEXT.md`** — §2 (Findings, comments, citations) for `kind`/`Source.type`/`tier`/`category`; §3 (Models + AI layer) for `getWorkerCheapModel()` + `lookupTypeDef`; §5 (Runners) for the detector-vs-sub-agent rule; §7 (Quality metrics — `confidence threshold` is the `[deferred]` entry M13 unblocks).
3. **`./CLAUDE.md`** — package boundary table; AI SDK v6 notes; current milestone status.
4. **`./packages/core/src/schema.ts`** — `CategoryEnum` (lines 28–47). M13 **does not modify** this — `'security'` is already at line 34.
5. **`./packages/core/src/index.ts`** — `PRIORITY_ORDER` (lines 576–590; `'security'` already at slot 2). `orchestrationRunners` registration (around line 326). `applyHardRules()` (around line 592). M13 adds the confidence-threshold filter step to `applyHardRules()`.
6. **`./packages/core/src/runners/eslint.ts`** — existing ESLint runner. M13 extends with a second invocation (`runEslintSecurity()`) using a Warden-managed config + bundled security plugins.
7. **`./packages/core/src/runners/types.ts`** + **`./packages/core/src/runners/to-comment.ts`** — `ToolFinding` shape + producer-to-category mapping. M13 adds rule-prefix routing: `security/*` and `no-secrets/*` → `{ category: "security", tier: 1 }`.
8. **`./packages/core/src/runners/leverage-libraries.ts`** — the sub-agent-shape precedent. M13's security sub-agent mirrors this end-to-end: Haiku via `getWorkerCheapModel()`, own prompt, own `lookupTypeDef` budget, lane discipline, graceful no-model fallback.
9. **`./packages/core/src/runners/committability.ts`** — second sub-agent precedent. Useful for the prompt-input-builder pattern (file-content excerpts around changed regions).
10. **`./packages/core/src/llm/prompts/leverage-system.md`** — the sub-agent-prompt structural precedent for tone + citation discipline language + canonical-examples section. M13's prompt is structurally similar but with DeepSec-borrowed sections (severity table + slug vocabulary + FP guidance + auth-bypass subtleties).
11. **`./packages/core/src/llm/prompt-loader.ts`** — M13 adds `loadSecuritySystemPrompt()` alongside existing loaders.
12. **`./packages/core/src/llm/tools/lookup-type-def.ts`** — the M11 tool descriptor. M13's sub-agent imports `makeLookupTypeDefTool()` (same pattern as M12 leverage).
13. **`./packages/core/src/llm/verify-citations.ts`** — the M10/M11 global verifier. M13 does **not** modify this — security sub-agent's `tool` sources flow through the existing per-line dispatch unchanged.
14. **`./packages/env/src/index.ts`** — `wardenEnv()` schema. M13 adds optional `WARDEN_SECURITY_CONFIDENCE_FLOOR` (numeric string parsed to `0.0`–`1.0`).
15. **`~/Developer/oss/deepsec/packages/processor/src/prompt/core.ts`** — DeepSec's investigation system prompt. M13's `security-system.md` is a structural mirror with Warden citation-discipline adaptations. Re-read line-by-line when drafting the prompt.

## Goal of this milestone

Land ADR-0028's design in a single coherent slice:

- **No `CategoryEnum` change** — `'security'` already exists (`packages/core/src/schema.ts:34`).
- **No `PRIORITY_ORDER` change** — `'security'` already slotted between `'correctness'` and `'vulnerability'` (`packages/core/src/index.ts:578`).
- **Detector half: add a Warden-owned ESLint security pass.** New `runEslintSecurity()` function in `packages/core/src/runners/eslint.ts` (or a sibling `eslint-security.ts` — pick one in implementation). Runs a second ESLint invocation through Warden's own pinned `eslint` binary and a Warden-managed flat config that loads only `eslint-plugin-security` + `eslint-plugin-no-secrets`. This pass is not gated by the target repo's ESLint config; it runs whenever the pruned diff contains JS/TS files. Rule IDs prefixed `security/*` or `no-secrets/*` map to `{ category: "security", tier: 1 }` in `to-comment.ts`. Runs in `check` + `review`.
- **Sub-agent half: new runner at `packages/core/src/runners/security.ts`.** Cheap-tier Haiku via `getWorkerCheapModel()` with own system prompt, `lookupTypeDef` tool access, `stopWhen: stepCountIs(8)` budget, lane discipline (drop findings whose `path` is outside the diff), per-finding `tool` source citation discipline. Emits `kind: "question"` Comments carrying source-line + sink-line `tool` sources, each substring-verified by the existing M10 dispatch. Gated to `review` mode only via `dispatch()` registration.
- **Sub-agent system prompt: `packages/core/src/llm/prompts/security-system.md`.** ~120 lines, structural mirror of DeepSec's `core.ts` with Warden citation-discipline adaptations. Sections: role framing, severity classification (mapped to Tier 1/2/3), 10-slug vocabulary, false-positive guidance, auth-bypass subtleties, citation discipline, worked examples (the 5 canonical examples — command injection, SQL injection, hardcoded secrets, weak crypto, missing auth), out-of-scope file note.
- **Prompt loader extension** — add `loadSecuritySystemPrompt()` to `packages/core/src/llm/prompt-loader.ts` mirroring `loadLeverageSystemPrompt()`.
- **Confidence-threshold subsystem (new).** New module `packages/core/src/confidence.ts` exporting `CATEGORY_CONFIDENCE_FLOOR: Record<Category, number>` (v0: `{ security: 0.8 }`, others implicit 0) and `applyConfidenceFloor(comments, env): { kept: Comment[]; dropped: number }`. Read by `applyHardRules()` _before_ the priority sort. Tier-1 findings bypass unconditionally. One `{ kind: "info", topic: "security", message: "Dropped N low-confidence security findings below floor 0.8" }` `DegradedEntry` per non-zero drop batch.
- **Env-var addition.** `WARDEN_SECURITY_CONFIDENCE_FLOOR` in `@warden/env` (optional, numeric string, validated `0.0`–`1.0`). When set, overrides the static map's `security` floor.
- **Dispatch registration** — security sub-agent joins `orchestrationRunners` in `packages/core/src/index.ts` around line 337, conditional on `input.config.mode === "review"`. Detector half stays in the inline deterministic runner block and records into the scratchpad separately from the user-config ESLint result.
- **Smoke harness** — `smoke-m13-eslint-security.mts` (asserts the detector fires on `eval(req.body)` / `child_process.exec(userCmd)` / `crypto.pseudoRandomBytes()` / hardcoded high-entropy API key); `smoke-m13-sub-agent.mts` (asserts the sub-agent calls `lookupTypeDef`, emits questions with verified `tool` sources, drops uncited findings, respects the confidence floor); `smoke-m13-confidence-floor.mts` (asserts low-confidence security comments are dropped + one degraded entry surfaces; Tier-1 bypasses).

By the end:

- `warden review` on a fixture diff with `exec(req.body.cmd)` emits a `category: "security"` question-kind Comment from the sub-agent, citing the source line (`req.body.cmd` reference) + sink line (`exec(` call), substring-verified.
- `warden review` on a fixture diff with `eval(userInput)` emits a `category: "security"` assertion-kind Comment from the ESLint detector via `security/detect-eval-with-expression`, Tier 1, with the rule's line as `tool` source.
- `warden review` with `WARDEN_SECURITY_CONFIDENCE_FLOOR=0.5` surfaces sub-agent findings the default `0.8` would drop — verified by smoke.
- `warden check` runs the detector but skips the sub-agent silently (no `degradedWorkers` entry for the skip).
- `pnpm smoke:m13` exercises all three smoke scripts; `pnpm check-types` + `pnpm lint` pass.
- ADR-0028 status snapshot row flips from `Direction` to `Done` (after dogfood acceptance — see Acceptance §4 below).
- CLAUDE.md M13 line lands as `[x]` above the M14+ deferred-items list (renamed from M13+); the umbrella `Custom-code SAST worker` bullet narrows to M14's worker-tier scope only.

**Stop at "ESLint security detector + Haiku sub-agent + confidence-threshold subsystem + env var + prompt + smoke + close-out." Do NOT start: a custom `@warden/eslint-plugin-security` package (ADR-0028 rejects); AST taint-tracer at `packages/core/src/runners/taint.ts` (ADR-0028 rejects — LLM does flow recognition); framework adapter table (ADR-0028 rejects); `warden security` verb or `--deep` flag (M14); Sonnet specialist worker (M14); dedicated security orchestration harness (M14); `@warden/eslint-plugin-no-unsanitized` integration (defer to dogfood evidence); slugs 11–26 from DeepSec's full set (M14+); post-pass `(path, line)` dedup between detector and sub-agent (ADR-0028 §6 — prompt-level scoping is sufficient); per-comment LLM-emitted threshold (ADR-0028 alternatives — overengineering); re-platforming the inline 6 runners (ADR-0023 deferred); BYOEmbedder; daemon `JobRunner`; semantic retrieval over `.d.ts`; multi-language security detection (gated on multi-ecosystem detector rewrite, M14+).** Those are later milestones.

## Repo additions

```
packages/core/src/runners/
├── security.ts                                   # NEW — Haiku sub-agent. Imports
│                                                 #   makeLookupTypeDefTool(),
│                                                 #   getWorkerCheapModel(),
│                                                 #   loadSecuritySystemPrompt().
│                                                 #   Exports `runSecurity()` (inner)
│                                                 #   and `securityRunner: Runner`
│                                                 #   (contract wrapper). Structural
│                                                 #   twin of leverage-libraries.ts.
│
└── eslint.ts                                     # MODIFIED — add `runEslintSecurity()`
                                                  #   second-invocation function +
                                                  #   Warden-owned ESLint binary
                                                  #   resolution + flat-config asset.
                                                  #   Do not rely on user-local
                                                  #   ESLint or user config for this
                                                  #   pass.

packages/core/src/llm/prompts/
└── security-system.md                            # NEW — sub-agent system prompt.
                                                  #   ~120 lines. DeepSec structural
                                                  #   borrow + Warden citation
                                                  #   discipline. Sections per ADR-0028 §4.

packages/core/src/confidence.ts                   # NEW — `CATEGORY_CONFIDENCE_FLOOR` map +
                                                  #   `applyConfidenceFloor()` function.
                                                  #   Reads `WARDEN_SECURITY_CONFIDENCE_FLOOR`
                                                  #   from `wardenEnv()` to override.

packages/core/src/llm/prompt-loader.ts            # MODIFIED — add
                                                  #   loadSecuritySystemPrompt()
                                                  #   alongside existing loaders.

packages/core/tsdown.config.ts                    # MODIFIED — copy prompt/config
                                                  #   assets needed at runtime
                                                  #   (`src/llm/prompts` and any
                                                  #   static ESLint security config).

packages/core/src/runners/to-comment.ts           # MODIFIED — add rule-prefix routing
                                                  #   `security/*` + `no-secrets/*`
                                                  #   → category: "security", tier: 1.
                                                  #   Sub-agent questions are already
                                                  #   `Comment[]`; they do not route
                                                  #   through `ToolFinding`.

packages/core/src/runners/types.ts                # Usually unchanged. Only add a new
                                                  #   source discriminant if the
                                                  #   implementation chooses a separate
                                                  #   `"eslint-security"` source; the
                                                  #   preferred path keeps `source:
                                                  #   "eslint"` and routes by rule prefix.

packages/core/src/index.ts                        # MODIFIED — register
                                                  #   securityRunner in
                                                  #   orchestrationRunners (review-only);
                                                  #   call `applyConfidenceFloor()` in
                                                  #   `applyHardRules()` before the
                                                  #   priority sort; call
                                                  #   `runEslintSecurity()` alongside
                                                  #   `runEslint()` (parallel via
                                                  #   `Promise.all`).

packages/env/src/index.ts                         # MODIFIED — add optional
                                                  #   WARDEN_SECURITY_CONFIDENCE_FLOOR
                                                  #   with z.string().regex(numeric) +
                                                  #   refinement 0.0–1.0.

.env.example                                      # MODIFIED — document the new env var
                                                  #   alongside ANTHROPIC_API_KEY +
                                                  #   WARDEN_THINKING_BUDGET.

packages/core/package.json                        # MODIFIED — dependencies gain
                                                  #   eslint + eslint-plugin-security +
                                                  #   eslint-plugin-no-secrets so the
                                                  #   Warden-managed pass can resolve
                                                  #   both the binary and plugins. These
                                                  #   are runtime dependencies for the
                                                  #   published CLI, not only dev deps.

packages/cli/scripts/
├── smoke-m13-eslint-security.mts                 # NEW — asserts detector fires on
│                                                 #   eval/child_process/weak-randomness/
│                                                 #   hardcoded-secret fixtures; emits
│                                                 #   category: "security", tier: 1.
│
├── smoke-m13-sub-agent.mts                       # NEW — asserts sub-agent calls
│                                                 #   lookupTypeDef, emits questions with
│                                                 #   substring-verified tool sources,
│                                                 #   drops uncited findings, skips in
│                                                 #   check mode.
│
└── smoke-m13-confidence-floor.mts                # NEW — asserts low-confidence security
                                                  #   sub-agent emissions dropped, one
                                                  #   degraded info entry surfaces,
                                                  #   Tier-1 bypasses the floor, env-var
                                                  #   override works.

packages/cli/package.json                         # MODIFIED — add smoke:m13 npm script
                                                  #   running all three smokes.
```

No new workspace package. No new commander verb. No new public `Comment` / `SourceType` schema migration. No new SQLite table. Internal updates: `to-comment.ts` learns the security rule-prefix mapping; `applyHardRules` learns the confidence-floor filter step. `ToolFinding.source` should stay unchanged unless the implementation explicitly chooses a separate `"eslint-security"` source for the detector.

## Package boundaries to honor

- All M13 runner code lives in `@warden/core`. No new workspace package; `@warden/ai` and `@warden/db` are untouched.
- `@warden/core` stays I/O-pure per ADR-0013. The sub-agent reads files via the existing diff-content path (mirrors committability + leverage-libraries). The new ESLint security pass shells out via `spawnCapture` from `_shared.ts` — same pattern as the existing ESLint runner; no new I/O primitive.
- The sub-agent uses `getWorkerCheapModel()` + `streamText` + `tool` + `stepCountIs` re-exported from `@warden/ai`. No new re-exports.
- The sub-agent imports M11's `makeLookupTypeDefTool` from `@warden/core/src/llm/tools/lookup-type-def.ts` (intra-package import). Same call-shape as M12 leverage-libraries.
- The confidence-floor module imports `wardenEnv()` from `@warden/env`. Env reads happen once per `applyConfidenceFloor()` invocation (per-review); no caching beyond `wardenEnv`'s own singleton.
- `WARDEN_SECURITY_CONFIDENCE_FLOOR` is read through `wardenEnv()` — never `process.env` directly in app code (CLAUDE.md "Environment variables" rule).

## What to build

### 1. Confidence-threshold subsystem (`packages/core/src/confidence.ts`)

New file. Two exports + one internal helper.

```ts
import { type Category, type Comment, type DegradedEntry } from "./schema.js";
import { wardenEnv } from "@warden/env";

// ADR-0028 §5 + CONTEXT.md §7. v0 ships exactly one non-zero floor; future
// categories opt in by adding a key here. Style is the natural next candidate
// per CONTEXT.md §7's note. Per-category env-var overrides are added on
// demand when future categories ship with non-zero floors.
export const CATEGORY_CONFIDENCE_FLOOR: Partial<Record<Category, number>> = {
  security: 0.8,
};

export interface ConfidenceFloorResult {
  kept: Comment[];
  drops: Map<Category, { count: number; floor: number }>; // per-category drop counts + effective floor
}

export function applyConfidenceFloor(
  comments: Comment[],
  opts: { securityFloor?: number } = {},
): ConfidenceFloorResult {
  const env = wardenEnv();
  const floors: Partial<Record<Category, number>> = {
    ...CATEGORY_CONFIDENCE_FLOOR,
    ...(opts.securityFloor !== undefined
      ? { security: opts.securityFloor }
      : env.WARDEN_SECURITY_CONFIDENCE_FLOOR !== undefined
        ? { security: Number(env.WARDEN_SECURITY_CONFIDENCE_FLOOR) }
        : {}),
  };
  const kept: Comment[] = [];
  const drops = new Map<Category, { count: number; floor: number }>();
  for (const c of comments) {
    if (c.tier === 1) {
      kept.push(c);
      continue;
    } // Tier-1 bypass per ADR-0028 §5
    const floor = floors[c.category];
    if (floor === undefined || c.confidence >= floor) {
      kept.push(c);
      continue;
    }
    const prev = drops.get(c.category);
    drops.set(c.category, { count: (prev?.count ?? 0) + 1, floor });
  }
  return { kept, drops };
}

export function dropsToDegraded(
  drops: Map<Category, { count: number; floor: number }>,
): DegradedEntry[] {
  const entries: DegradedEntry[] = [];
  for (const [cat, { count, floor }] of drops) {
    entries.push({
      kind: "info",
      topic: cat,
      message: `Dropped ${count} low-confidence ${cat} ${count === 1 ? "finding" : "findings"} below floor ${floor}`,
    });
  }
  return entries;
}
```

Pattern-matches the M12 leverage runner's lane-drop counting: drops are counted by category, then surfaced as a single degraded entry per category at the end (not one entry per dropped Comment).

The optional `securityFloor` parameter is for smoke coverage and internal callers that already resolved env once. Production code should omit it so the override still flows through `wardenEnv()` rather than `process.env`. This also avoids a same-process smoke false negative caused by `wardenEnv()` caching after the first parse.

### 2. Wire confidence-floor into `applyHardRules()` (`packages/core/src/index.ts`)

The current `applyHardRules()` filters Tier-3 in review mode and sorts by priority/tier/confidence. M13 adds the floor filter as a new first step.

```ts
function applyHardRules(comments: Comment[], config: ReviewConfig): Comment[] {
  // M13 / ADR-0028: confidence-floor filter runs first. Tier-1 bypasses
  // unconditionally. Per-category map; default-zero for categories without
  // a floor.
  const { kept, drops } = applyConfidenceFloor(comments);
  // (degraded entries from drops are pushed into the CommentSet by the
  // caller — see review() / runCheck() integration below.)

  const shouldGateTier3 = config.mode === "review" && config.verbose !== true;
  const filtered = shouldGateTier3 ? kept.filter((c) => c.tier !== 3) : kept;
  return [...filtered].sort((a, b) => {
    /* unchanged */
  });
}
```

The drops returned by `applyConfidenceFloor()` need to flow into the `CommentSet.degradedWorkers` of the caller. Simplest path: `applyHardRules` returns `{ comments: Comment[]; floorDrops: Map<Category, number> }` and the call sites in `review()` + `runCheck()` push `dropsToDegraded(floorDrops)` into the degraded list. (Or thread the degraded array as a mutable parameter — pick one in implementation; match the surrounding style.)

### 3. Env-var addition (`packages/env/src/index.ts`)

Add to `envSchema`:

```ts
WARDEN_SECURITY_CONFIDENCE_FLOOR: z
  .string()
  .regex(/^\d+(\.\d+)?$/)
  .refine((s) => {
    const n = Number(s);
    return n >= 0 && n <= 1;
  }, { message: "WARDEN_SECURITY_CONFIDENCE_FLOOR must be a number between 0.0 and 1.0" })
  .optional(),
```

Document it in `CLAUDE.md`'s "Environment variables" table alongside `WARDEN_THINKING_BUDGET` + `WARDEN_LOG_LEVEL`.

### 4. ESLint security detector (`packages/core/src/runners/eslint.ts`)

New function `runEslintSecurity()` alongside the existing `runEslint()`. Same `EslintRunResult` shape. The key difference: this invocation **does not use the user's eslint config or eslint binary**. It resolves Warden's pinned ESLint binary from `@warden/core`'s own dependencies and runs it with `--no-config-lookup --config <warden-internal-security-config>`.

Do **not** pass the legacy `--no-eslintrc` flag in the Warden-owned pass. Current ESLint flat-config CLI docs use `--no-config-lookup` to disable config discovery and `--config` to point at an alternate config. Pinning Warden's ESLint version lets this pass avoid cross-version flag drift from target repos.

The Warden-internal flat config bundles `eslint-plugin-security` + `eslint-plugin-no-secrets` (Warden's own dependencies, pinned in `packages/core/package.json`). Two implementation paths:

- **A. Write the config to a temp file** in `os.tmpdir()` at first invocation; pass `--config <tempfile>` to ESLint.
- **B. Inline the config via `--rule` flags** — fragile for plugin rules; rejected.
- **C. Ship a static `.warden-eslint-security.config.mjs`** in `packages/core/dist/` or similar, referenced relative to `import.meta.url`.

Option C is cleanest (no temp-file management, no first-invocation latency). If you choose C, update `packages/core/tsdown.config.ts` to copy the config file, and use the same pass to copy `src/llm/prompts` so the new `security-system.md` survives published builds. If you choose A, generate ESM that imports the resolved plugin file URLs explicitly; a temp config with bare `import "eslint-plugin-security"` will resolve relative to `os.tmpdir()` and fail.

The bundled config enables (v0):

```js
{
  plugins: { security: pluginSecurity, "no-secrets": pluginNoSecrets },
  rules: {
    "security/detect-eval-with-expression": "error",
    "security/detect-child-process": "error",
    "security/detect-non-literal-fs-filename": "error",
    "security/detect-non-literal-regexp": "error",
    "security/detect-pseudoRandomBytes": "error",
    "security/detect-buffer-noassert": "error",
    "security/detect-disable-mustache-escape": "error",
    "security/detect-object-injection": "off",    // too broad for unconditional Tier-1 v0 mapping
    "no-secrets/no-secrets": ["error", { tolerance: 4.5 }],
  },
}
```

`detect-object-injection` flags broad `obj[key]` shapes. Because M13 maps every `security/*` finding to Tier 1, v0 leaves it off rather than shipping warn-level output that still bypasses the confidence floor. Dogfood can enable it later as a deliberate rule-level decision.

`runEslintSecurity()` is called in parallel with `runEslint()` from the review/check dispatch path (around `packages/core/src/index.ts:300+`), but it is **not** gated by `ecosystem.hasEslint`. The target repo does not need an ESLint config for Warden's security pass. Both invocations are short; the Warden-managed pass uses its own config and dependency graph, while the existing user-config pass remains unchanged.

Populate `ToolFinding.evidence` for Warden-security findings by reading the cited line from the target file. Existing generic ESLint findings may continue without snippet evidence; security findings should flow through the current M10 verifier as snippet-bearing `tool` sources.

### 5. `to-comment.ts` rule-prefix routing

The existing `toComment()` maps `ToolFinding.source` discriminants to `{ category, tier }`. ESLint findings carry the rule ID; M13 adds a prefix check for rules from the security pass:

```ts
if (finding.source === "eslint") {
  const rule = finding.ruleId ?? "";
  if (rule.startsWith("security/") || rule.startsWith("no-secrets/")) {
    return { category: "security", tier: 1 /* ... */ };
  }
  // ... existing non-security ESLint routing unchanged
}
```

If the existing ESLint runner is split into two emit paths (`source: "eslint"` for user-config + `source: "eslint-security"` for Warden-config) — that's also fine; pick the simpler. The mapping logic lands in `to-comment.ts` either way.

### 6. `ToolFinding.source` stays narrow unless the detector chooses a separate source

Preferred implementation: keep security-detector findings as `source: "eslint"` and route by `ruleId` prefix in `to-comment.ts`. The security sub-agent emits `Comment[]` in `RunnerOutput.questions`, exactly like `leverage-libraries.ts`; it does **not** need a `ToolFinding.source = "security"` variant.

Only extend the union if the implementation deliberately chooses a separate detector source such as `"eslint-security"`. If you do that, update `to-comment.ts`, smoke assertions, and any formatter text that names tool sources in one pass. Do not add `"committability"` or `"vuln"` to `ToolFinding.source`; those lanes already bypass `ToolFinding` today.

### 7. Security sub-agent (`packages/core/src/runners/security.ts`)

Structural twin of `leverage-libraries.ts`. The end-to-end flow:

1. `runSecurity({ changedFiles, repoRoot, ... })` is called from `dispatch()`.
2. If `getWorkerCheapModel()` returns null (no env keys), return `{ findings: [], questions: [], degraded: [{ kind: "info", topic: "security", message: "Security sub-agent skipped — no model available" }], durationMs: 0 }`.
3. Build the prompt input: for each changed file, include the file path + a diff-localised content window (mirrors committability's `buildFileInput`). No deps preamble — security is library-agnostic; the prompt is framework-agnostic; `lookupTypeDef` resolves library APIs on-demand.
4. Call `streamText` with `model: getWorkerCheapModel()`, `system: loadSecuritySystemPrompt()`, `messages: [{ role: "user", content: input }]`, `tools: { lookupTypeDef: makeLookupTypeDefTool({ repoRoot, packageSearchRoots, degraded }) }`, `stopWhen: stepCountIs(8)`, `output: Output.array(SecurityFindingSchema)` (or equivalent structured output — match committability/leverage's pattern).
5. Each emitted finding carries `{ slug, tier, lineStart, lineEnd, sources: [{ type: "tool", id, url?, title, retrievedAt, path, line, snippet }] }` shape. The runner:
   - Drops findings whose `path` is outside the diff (lane discipline; count drops → degraded info entry).
   - Drops findings with empty `sources[]` (citation discipline; count drops → degraded info entry).
   - For findings citing `api_def` sources via `lookupTypeDef`'s `suggestedSource`, copy verbatim per M12 leverage pattern. (The Haiku may emit `tool` sources for diff-local citations and `api_def` sources for library-API claims; both flow through the existing global verifier.)
6. Convert surviving findings directly into `Comment` shapes via a local `toQuestion()` helper, mirroring `leverage-libraries.ts`. Do not route sub-agent output through `ToolFinding` / `toComment()`.
7. Return `RunnerOutput` with `findings: []`, `questions: Comment[]`, `degraded[]`, `durationMs`.

Expose as `securityRunner: Runner` via the standard contract wrapper.

```ts
export const securityRunner: Runner = {
  name: "security",
  async run(input: RunnerInput): Promise<RunnerOutput> {
    const start = Date.now();
    const { questions, degraded } = await runSecurity(input);
    return { name: "security", findings: [], questions, degraded, durationMs: Date.now() - start };
  },
};
```

### 8. Sub-agent system prompt (`packages/core/src/llm/prompts/security-system.md`)

~120 lines. DeepSec structural mirror with five Warden adaptations (per ADR-0028 §4). Outline:

```markdown
# Warden security sub-agent — system prompt

You are a security-aware code reviewer. An automated detector (ESLint with
security plugins) has already flagged the obvious patterns (eval, child_process,
weak crypto primitives, hardcoded secrets via entropy detection). Your job is
the **subtler** half — auth bypasses, missing authorization, parameter
manipulation, cross-tenant ID leakage, SSRF, path traversal in non-canonical
sinks, secret-in-log — that pattern-bounded rules cannot reliably catch.

You think like an attacker but report like an engineer: every claim cites
specific code, every cited line must actually exist in the file.

## Static analysis only

[per DeepSec — copy almost verbatim]

## Severity classification

| Severity | Tier | Examples                                                                                                                        |
| -------- | ---- | ------------------------------------------------------------------------------------------------------------------------------- |
| CRITICAL | 1    | RCE, auth bypass (full access), SQL injection on sensitive data, RCE via file upload, SSRF to internal services                 |
| HIGH     | 2    | XSS, SSRF, privilege escalation, hardcoded secrets in source, insecure deserialization, missing authorization on sensitive ops  |
| MEDIUM   | 3    | Open redirect, weak crypto, missing rate limiting, info disclosure, IDOR, race conditions, logic bugs in auth/permission checks |

## v0 slug vocabulary

| Slug             | What it means                                                                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| auth-bypass      | Authentication checks that can be circumvented                                                                                                                      |
| missing-auth     | HTTP endpoints without authentication                                                                                                                               |
| rce              | Remote code execution via exec/eval/spawn — ESLint catches the obvious; you handle the indirect (template injection into a command builder, etc.)                   |
| sql-injection    | SQL injection via string interpolation/concatenation — including ORM raw-query escape hatches                                                                       |
| ssrf             | Server-side request forgery via user-controlled URLs                                                                                                                |
| path-traversal   | File operations with user-controlled paths                                                                                                                          |
| secrets-exposure | Hardcoded secrets — ESLint's `no-secrets` catches entropy-detectable strings; you handle structural cases (secrets in logs, in error responses, in fallback values) |
| insecure-crypto  | Weak hash/cipher algorithms — ESLint catches `pseudoRandomBytes`; you handle the rest (MD5, ECB mode, hardcoded IVs, key reuse)                                     |
| xss              | Cross-site scripting via innerHTML, dangerouslySetInnerHTML, etc.                                                                                                   |
| open-redirect    | Redirects bypassing validation functions                                                                                                                            |

## False positive guidance

Before classifying an issue, check for mitigations:

- Is the input sanitized or escaped before use? (parameterized queries, HTML escaping, allowlists)
- Is there middleware or a framework guard that **wraps the handler directly**? (Express middleware, Fastify hooks, NestJS guards, Spring filters, Rails before_action, Django decorators, FastAPI Depends). Edge/proxy/CDN/WAF rules are NOT sufficient on their own.
- Is the vulnerable pattern only used with trusted/internal data?
- For redirects: is there an explicit allowlist or origin check before the redirect?

If fully mitigated, do not flag it. Report only genuine, exploitable patterns.

## Auth bypass patterns to look for

Beyond missing auth, look for subtle bypasses:

### Query string & URL manipulation

- Parameter pollution
- URL-encoded / double-encoded / Unicode-normalized paths
- Route param injection
- Token refresh abuse

### Auth flow bypasses

- OAuth callback manipulation
- Session/JWT weaknesses (missing algorithm pinning, stub sessions, test tokens reachable in prod)
- Header injection (`X-Forwarded-For`, `Authorization` blindly trusted)

### Authorization gaps (has auth, wrong auth)

- Cross-tenant access (user-supplied `teamId`/`userId` in DB queries instead of authenticated identity)
- Missing resource-level checks
- Negated permission checks (`!(await auth.can(...))`)

## Citation discipline

**You cannot assert anything you cannot cite.** Every finding's `sources[]` must contain at least one `tool` source whose `(path, line, snippet)` triple substring-matches the cited file at `line ± 5` after whitespace normalization. If you cannot cite a source line + sink line in the diff, drop the finding silently — the substring-verifier will drop it anyway, and emitting unverifiable findings wastes tokens.

For library API claims ("this `validator.escape(x)` doesn't actually escape" / "this `bcrypt.compare(x, y)` is timing-safe"), call `lookupTypeDef({ package, symbol })` and copy `result.suggestedSource` verbatim into `sources[]`.

You have an 8-call budget for `lookupTypeDef`. Use it only when the finding hinges on a library API claim.

## Worked examples

[The 5 canonical examples — command injection, SQL injection, hardcoded secrets, weak crypto, missing auth — each with: diff snippet, source-line + sink-line `tool` sources, slug, severity/tier, body shape.]

## Output shape

Emit JSON matching the SecurityFindingSchema:
```

{
"slug": "<one of the 10 v0 slugs>",
"tier": 1 | 2 | 3,
"lineStart": <number>,
"lineEnd": <number>,
"path": "<changed-file-path>",
"body": "<≤2 sentences naming the pattern, citing source+sink>",
"suggestedAction": "<≤1 sentence>",
"confidence": <0.0–1.0>,
"sources": [
{ "type": "tool", "id": "security-sub-agent", "title": "source",
"retrievedAt": "<ISO>", "path": "<file>", "line": <num>, "snippet": "<exact line>" },
{ "type": "tool", "id": "security-sub-agent", "title": "sink",
"retrievedAt": "<ISO>", "path": "<file>", "line": <num>, "snippet": "<exact line>" }
]
}

```

## Out-of-scope files

Skip files that are gitignored, generated, vendored, or not production code (`dist/`, `node_modules/`, `vendor/`, `generated/`, `__generated__/`). Return an empty findings array for those files. The M9 noise filter already prunes most, but defence-in-depth.

## Stay disciplined

- Find subtler patterns ESLint cannot catch — that's your rent.
- Cite or drop. Never assert without a source.
- One finding per location. No "this could also be X" hedging.
```

### 9. Prompt loader extension (`packages/core/src/llm/prompt-loader.ts`)

Add `security-system` to the existing `PromptName` union and expose the same generic loader pattern as the other prompts:

```ts
type PromptName =
  | "system"
  | "user-template"
  | "committability-system"
  | "leverage-system"
  | "security-system";

export function loadSecuritySystemPrompt(): string {
  return load("security-system");
}
```

Same pattern as `loadCommittabilitySystemPrompt()` + `loadLeverageSystemPrompt()`.

### 10. Dispatch registration (`packages/core/src/index.ts` around line 326–337)

Add `securityRunner` registration conditional on review mode:

```ts
const orchestrationRunners: Runner[] = [];
if (true /* scalability runs everywhere */) {
  orchestrationRunners.push(scalabilityRunner);
}
orchestrationRunners.push(leverageRunner);
if (input.config.mode === "review") {
  orchestrationRunners.push(committabilityRunner);
  orchestrationRunners.push(leverageLibrariesRunner);
  orchestrationRunners.push(securityRunner); // NEW — ADR-0028 §11
}
```

The detector (`runEslintSecurity()`) is wired into the existing initial `Promise.all` deterministic-runner block alongside `runEslint()` / `runTsc()` — not through `orchestrationRunners`. Preserve the current jscpd sequencing: `runJscpd()` still runs **after** the selector because it consumes `changed ∪ candidates`.

```ts
const [tscOut, eslintOut, eslintSecOut /* vuln/selector/deadcode/consistency ... */] =
  await Promise.all([
    runTsc(repoRoot, changedFiles),
    ecosystem.hasEslint ? runEslint(repoRoot, changedFiles) : emptyEslint,
    runEslintSecurity(repoRoot, changedFiles), // NEW — ADR-0028 §2, not gated by hasEslint
    // ...
  ]);
```

Record `eslintSecOut` as its own scratchpad output (`name: "eslint-security"`) or merge its findings into the existing `eslint` scratchpad record. Prefer a separate scratchpad name so degraded entries can say `eslint-security` and dogfood can distinguish user-config lint failures from Warden-security lint failures. `to-comment.ts` does the category routing by rule prefix either way.

### 11. Smoke harness

Three smoke scripts under `packages/cli/scripts/`:

**`smoke-m13-eslint-security.mts`** — synthesise a diff with:

- `eval(req.body.code)` → expects `security/detect-eval-with-expression` finding, category=`security`, tier=1.
- `crypto.pseudoRandomBytes(16)` → expects `security/detect-pseudoRandomBytes`, category=`security`, tier=1.
- `child_process.exec(userCmd)` → expects `security/detect-child-process` finding.
- A hardcoded high-entropy API key string → expects `no-secrets/no-secrets` finding.

**`smoke-m13-sub-agent.mts`** — synthesise a diff with:

- A cross-tenant ID leak (`db.users.find({ id: req.body.userId })` without ownership check) → expects sub-agent emits a question with slug=`auth-bypass` or `missing-auth` (the v0 slug list deliberately does not include `cross-tenant-id`), citation of source+sink lines, substring-verifier passes.
- A diff that would tempt the sub-agent to cite a non-existent path → expects the finding to be dropped by lane discipline (info-level degraded entry counts it).
- A diff with a library API claim (`bcrypt.compare(x, y)` shown as "this is timing-safe") → expects sub-agent calls `lookupTypeDef`, emits an `api_def` source verified by the global verifier.

**`smoke-m13-confidence-floor.mts`** — synthesise sub-agent emissions at varying confidence:

- A 0.95-confidence security question → kept.
- A 0.6-confidence security question → dropped; one degraded info entry surfaces (`Dropped 1 low-confidence security finding below floor 0.8`).
- A Tier-1 0.5-confidence security finding → kept (Tier-1 bypass).
- With `WARDEN_SECURITY_CONFIDENCE_FLOOR=0.5` → the 0.6 question is kept.

Add `smoke:m13` script to `packages/cli/package.json` running all three.

### 12. Dogfood pass

After implementation, run `git diff HEAD~10 | pnpm warden review --stdin --verbose` (or against the current uncommitted state). Verify:

- `warden review` runs without crash.
- Zero false-positive security findings on warden's own code. The codebase doesn't have a web-handler surface, so most slugs won't fire — but verify the sub-agent makes its LLM call and either emits empty findings or substring-verified ones (both acceptable).
- ESLint security plugins fire on Warden's own code, if at all, only on intentional patterns (e.g., `spawnCapture`'s `child_process.spawn` usage — if it fires, document the false-positive class and either suppress in code or note for M14 prompt-tightening).
- No regressions: M10 / M11 / M12 verifier, vuln, TSC, ESLint (user config), committability, scalability, deadcode, consistency, leverage all unchanged.
- Comments with `category: "security"` sort second in the priority order (after `correctness`, before `vulnerability` + `contract`).

### 13. Close-out

Update ADR-0028 status row in `decisions.md`: `Direction` → `Done`. Add a one-line shipped-surface summary: "`security` slot filled with Warden-owned ESLint security detector + Haiku triage sub-agent. Confidence-threshold subsystem ships in `packages/core/src/confidence.ts`; `WARDEN_SECURITY_CONFIDENCE_FLOOR` env override added to `@warden/env`. Detector remains inline with the ESLint runner path; sub-agent rides the M8 Runner contract; M14 introduces the dedicated security orchestration harness + `warden security` verb."

Update `CLAUDE.md`: insert `[x] M13 — security category default-review producers per ADR-0028 (...)` line above the `[ ] M14+ — Deferred items...` bullet. Rename the deferred section's heading from M13+ to M14+. Trim the `Custom-code SAST worker` deferred-item bullet to scope to the M14 worker tier + verb + dedicated harness only.

Update `CONTEXT.md` per the "CONTEXT.md additions" section below.

Refresh memory `project_warden_security_depth_tiers.md` post-implementation — note that M13 ships the default-review tier of the three-tier framing; M14 will ship the on-demand-deep tier.

## Acceptance criteria for M13

1. `pnpm check-types` passes across all packages.
2. `pnpm lint` (oxlint) passes.
3. `pnpm smoke:m13` passes all three smoke scripts (eslint-security + sub-agent + confidence-floor).
4. `warden review` on the warden tree (dogfood acceptance):
   - Runs without crash.
   - Surfaces zero false-positive security findings on existing warden idioms (verify by listing the security findings and manually accepting each, or noting class-of-FP for M14 prompt-tightening).
   - At least one full sub-agent execution path completes — i.e., the sub-agent makes its LLM call and either emits a verified question or empty findings. Both are acceptable for the first dogfood pass; the empty case proves the gate behaves correctly, not a regression.
   - No regressions: M10 / M11 / M12 verifier, vuln, TSC, ESLint, committability, scalability, deadcode, consistency, leverage all unchanged.
   - Comments with `category: "security"` sort between `correctness` and `vulnerability` in the output.
   - `WARDEN_SECURITY_CONFIDENCE_FLOOR=0.5` produces a different (larger) output than the default `0.8` — verified by running the same diff twice with different env values.
5. `warden check` runs the ESLint security detector but does not invoke the sub-agent — verify by reading the output for absence of `kind: "question"` + `category: "security"` comments.
6. `WARDEN_SECURITY_CONFIDENCE_FLOOR` validation works: setting it to `"-1"` or `"2.0"` or `"abc"` causes `wardenEnv()` to throw with a clear error message.
7. Confidence-floor drops surface as one info-level `degradedWorkers` entry per non-zero drop count, never per-comment.
8. Tier-1 security findings bypass the floor — verified by smoke 3.
9. ADR-0028 status row flips `Direction` → `Done`. CLAUDE.md M13 `[x]` line added. CONTEXT.md gains the new terms (per "CONTEXT.md additions" below).

## What NOT to do in this milestone

- **Do not ship the `warden security` verb or `--deep` flag.** ADR-0028 §1 + §11 lock the M14 split.
- **Do not introduce the Sonnet specialist worker tier.** ADR-0028 §11. M14 owns this.
- **Do not build a dedicated security orchestration harness.** ADR-0028 §11. M13 stays in the existing M8 harness.
- **Do not build an AST taint-tracer.** ADR-0028 alternatives — the LLM does flow recognition. Path-traversal / SSRF / SQL-injection taint patterns are handled by the sub-agent's prompt guidance, not a bespoke runner.
- **Do not build a framework adapter table.** ADR-0028 alternatives. The LLM identifies frameworks from training data; the prompt is framework-agnostic.
- **Do not add slugs 11–26 from DeepSec's full vocabulary.** ADR-0028 alternatives — v0 ships 10 slugs; M14+ adds more based on dogfood signal.
- **Do not build a post-pass `(path, line)` dedup between detector and sub-agent.** ADR-0028 §6 — prompt-level scoping is the v0 disjointness mechanism.
- **Do not extend `Source` / `SourceTypeEnum` / `Comment`.** Reuse `type: "tool"` for both halves. No new SQLite table. No `verify-citations.ts` changes.
- **Do not modify the M11 formatter's prompt or cap.** The security sub-agent has its own prompt + its own `stepCountIs(8)` budget.
- **Do not modify the M10/M11 global verifier (`verify-citations.ts`).** The substring-verifier dispatches on `type` as today; M13's `tool` sources flow through unchanged.
- **Do not write a custom `@warden/eslint-plugin-security` package.** Off-the-shelf plugins are sufficient v0.
- **Do not add `eslint-plugin-no-unsanitized` or `@microsoft/eslint-plugin-sdl` in v0.** Defer to dogfood evidence.
- **Do not migrate the inline 6 runners (TSC, ESLint, jscpd, vuln, deadcode, consistency) through the `Runner` contract.** ADR-0023 deferred; M13 just adds two new producers.
- **Do not add per-comment LLM-emitted thresholds.** ADR-0028 alternatives — overengineering. Map + env override is sufficient.
- **Do not add a teaser pointing at `warden security` in M13's output.** ADR-0028 §10 — the verb doesn't exist yet.
- **Do not write tests.** Per memory `user_no_tests_personal.md`. Smoke scripts are the validation surface.
- **Do not extract a shared `_subagent.ts` helper module preemptively.** Duplicate from leverage what M13 needs; M14+ extracts if a third call site earns the abstraction.
- **Do not change the formatter system prompt.** The M11 "Verifying library API claims" section stays unchanged. The sub-agent has its own system prompt.
- **Do not centralise the per-call-site `stepCountIs(8)` cap.** Each LLM call site owns its budget — formatter, leverage sub-agent, security sub-agent. Total per-review tool calls cap at 24 (8×3); bounded; not centralised.

If you reach for any of the above, stop and re-read ADR-0028 — the deferral is intentional.

## CONTEXT.md additions

Update §2 (Findings, comments, citations) — append to the `category` entry's shipped list:

> **category** — What kind of concern a comment represents. Shipped: `correctness`, `clarity`, `style`, `dedup`, `tests`, `vulnerability`. M7 additions: `scalability`, `consistency`, `deadcode`, `committability`. M12 addition: `leverage`. **M13 addition: `security`** — custom-code SAST findings via the ESLint security detector half and the Haiku triage sub-agent half (ADR-0028). Categories drive prompt shape, worker routing, and the feedback signal used for category promotion. → ADR-0012, ADR-0020, ADR-0027, ADR-0028.

Update §3 (Models + AI layer) — append to `worker cheap` entry's list of consumers:

> **worker cheap** / **worker haiku** — Haiku-class (`claude-haiku-4`) for contract, best-practices, the M7 **committability sub-agent**, the M12 **leverage sub-agent**, and the M13 **security triage sub-agent**. Cheap, sufficient for pattern-matching and triage tasks. → ADR-0006, m7-plan.md, m13-plan.md.

Add to §5 (Runners) — two new entries:

> **ESLint security detector** — `[M13]` Extension of the existing ESLint runner via a second invocation (`runEslintSecurity()` in `packages/core/src/runners/eslint.ts`) using a Warden-managed flat config that loads `eslint-plugin-security` + `eslint-plugin-no-secrets`. Rule IDs prefixed `security/*` or `no-secrets/*` are routed to `{ category: "security", tier: 1 }` in `to-comment.ts`. Runs in both `check` and `review`. The detector handles bounded patterns (eval, child_process, weak randomness, hardcoded secrets via entropy); the sub-agent handles the subtler residue. → ADR-0028.

> **security sub-agent** — `[M13]` Cheap-tier (Haiku via `getWorkerCheapModel()`; graceful when env keys missing) sub-agent at `packages/core/src/runners/security.ts` emitting `kind: "question"` Comments for security concerns the ESLint detector cannot catch (cross-tenant ID, missing-auth on route handlers, parameter-pollution bypasses, SSRF, path-traversal in non-canonical sinks, secret-in-log, auth-bypass via encoded characters, etc.). Prompt at `packages/core/src/llm/prompts/security-system.md` — ~120-line DeepSec-borrowed structure (severity classification + 10-slug vocabulary + pre-emptive FP guidance + auth-bypass subtleties section + 5 canonical examples + citation discipline) per ADR-0028 §4. Has access to M11's `lookupTypeDef` tool with its own `stepCountIs(8)` budget (third consumer after the formatter and leverage sub-agent). Emits questions carrying source-line + sink-line `tool` sources verified by the existing M10 substring-verifier; lane discipline drops findings whose `path` is outside the diff. Gated to `review` mode only (skipped silently in `check`). Subject to the new confidence-threshold floor (`{ security: 0.8 }`) — see §7. → ADR-0028.

Update §7 (Quality metrics) — flip the `confidence threshold` entry from `[deferred]` to live:

> **confidence threshold** — Per-category numeric floor for silently dropping low-confidence findings before render. Implemented in `packages/core/src/confidence.ts` as `CATEGORY_CONFIDENCE_FLOOR: Partial<Record<Category, number>>` consumed by `applyConfidenceFloor()` (called from `applyHardRules()` before the priority sort). v0 floors: `{ security: 0.8 }`; other categories implicit 0 (no filtering). **Tier-1 findings bypass the floor unconditionally** — the critical-finding short-circuit. One info-level `degradedWorkers` entry per non-zero drop count per category. Override: `WARDEN_SECURITY_CONFIDENCE_FLOOR` env var (other categories add their own env vars on demand). Future-tunable per category as dogfood reveals volume-control need — style is the natural next candidate. → ADR-0028.

Add to §8 (Deferred concepts) — new `[deferred, M14]` entry for the second harness:

> **security harness** — `[deferred, M14]` Dedicated orchestration spine for `warden security` (M14) per the two-harness vision from M13 grilling (Ronit's agent-orch framing, vision.md §3). Separate from the M8 spine `warden review` rides: own dispatch, own scratchpad, own synthesizer, own Sonnet specialist multi-step pipeline (DeepSec-shaped scan → reason → cite with substring-verifier replacing LLM-judges-LLM revalidation). M13's Haiku sub-agent stays in the existing M8 spine on purpose; M14's ADR introduces the second harness greenfield. → ADR-0028 §11.

Add to §8 — new `[deferred, M14]` entry for the verb:

> **`warden security`** — `[deferred, M14]` On-demand deep SAST verb per the security-depth-tiers memory (`project_warden_security_depth_tiers.md`). Invokes the dedicated security harness (see above) with a Sonnet specialist worker; opt-in cost. Discoverability via docs + `--help`; M13 deliberately ships no teaser pointing at this verb. The `--deep` flag on `warden review` is an alternative shape considered during M13 grilling; M14's ADR picks one. → ADR-0028 §10.

Update §8 — narrow the existing `custom-code SAST worker` entry to acknowledge M13 ships the default-review producers:

> **custom-code SAST worker** — `[narrowed by M13 to the deep-mode worker]` M13 ships the default-review tier (ESLint security detector + Haiku triage sub-agent). M14 ships the on-demand deep tier — Sonnet specialist worker per vision.md §3, DeepSec-shaped per ADR-0015 (borrow pipeline, reject grounding model). Gated on M13 dogfood evidence of which slugs the Haiku consistently misses. → ADR-0015, ADR-0028, memory: `project_warden_deepsec_reference.md`.

## Design nuances captured during planning

1. **The M12 leverage shape is reusable, not coincidental.** M13's detector + sub-agent split is structurally identical to M12's: bounded patterns earn the detector; open-ended residue earns the sub-agent; one category, two producers, disjoint by prompt convention. The pattern stuck because it cleanly resolves the bounded-vs-open question CONTEXT.md §5 names. M14+ categories should pattern-match this when applicable (and explicitly reject it when not — e.g., M14's deep tier doesn't fit this shape because it's a single Sonnet worker, not a detector + sub-agent under one category).

2. **DeepSec's prompt structure is the value-add; the grounding model is the replaceable layer.** Reading DeepSec's `core.ts` line-by-line (~94 lines), the severity table + slug vocabulary + FP guidance + auth-bypass subtleties are pipeline value that took someone real effort to derive. Replacing the grounding (free-form `description` → citation-discipline) preserves the value and fixes the failure mode. ADR-0015's "borrow pipeline, reject grounding" framing was right; M13 cashes it precisely.

3. **The confidence threshold subsystem unblocks future categories.** §7 has been `[deferred]` since M4; v0's five categories didn't need it. Security is the first whose default-review LLM output is inherently noisy. Shipping the subsystem now means style (CONTEXT.md §7's next-likely candidate), future LLM-driven categories, and the on-demand deep mode's confidence handling all inherit the same primitive. The subsystem's API surface is intentionally minimal — a map + a filter function — so adding a category's floor is one map entry, not a feature.

4. **Tier-1 bypass is a policy, not a schema field.** The floor filter inspects `comment.tier === 1` and short-circuits before checking confidence. No schema field, no LLM-emitted "I'm critical" signal — the policy reads structurally from `tier`. The Haiku prompt is instructed to reserve Tier-1 for clear-cut patterns; the substring-verifier still applies. Mirrors the critical-finding short-circuit named in `project_warden_security_depth_tiers.md`.

5. **The Haiku sub-agent gets its own `lookupTypeDef` budget — not centralised.** Each LLM-call site owns its 8-call budget. Total per-review tool calls cap at 24 (formatter 8 + leverage sub-agent 8 + security sub-agent 8). Bounded; not centralised. Centralising would force coupling between independent runners that the M8 spine deliberately keeps separate. M14+'s deep mode adds another LLM call site with its own budget; the cap stays per-site.

6. **The library API claims path is the same as M12's leverage but with a security framing.** When the Haiku says "this `validator.escape(x)` doesn't actually escape" or "this `bcrypt.compare(x, y)` is timing-safe", `lookupTypeDef` resolves the package's `.d.ts`; the resulting `api_def` source flows through the same M11 verifier dispatch leverage uses. Security claims that involve library APIs benefit from the same citation discipline leverage suggestions do. The keystone (ADR-0026) pays out again — third producer in three milestones (M11 formatter, M12 leverage sub-agent, M13 security sub-agent).

7. **Lane discipline (dropping findings outside the diff) prevents the sub-agent from "wandering."** Same pattern as M12 leverage + M7 committability: if the LLM cites a security pattern at a path outside the changed files, drop the finding silently (info-level degraded entry counting the drops, no per-finding noise). The global verifier in `verify-citations.ts` independently substring-checks each source — the lane filter is belt-and-suspenders, catching the case where the LLM cites the right file for the wrong diff.

8. **Detector + sub-agent disjointness is by prompt convention.** The Haiku prompt's slug list explicitly notes which slugs ESLint already handles deterministically (`rce` partial, `secrets-exposure` partial, `insecure-crypto` partial) and instructs the LLM to focus on subtler subtypes. Pattern-matches M12 leverage's scoping-by-example. If dogfood reveals consistent double-fire, tighten the prompt — don't add a post-pass dedup pipeline.

9. **The on-demand deep tier is named, scoped, and deferred.** ADR-0028 §11 + §10 + the new `security harness` / `warden security` CONTEXT.md entries make M14's scope explicit: dedicated harness, Sonnet specialist worker, multi-step pipeline, verb-or-flag-shape TBD. M13 leaves M14 a clean greenfield by staying in the existing M8 harness. The grilling pass on M14 starts fresh with M13 dogfood evidence in hand.

10. **Skipping the sub-agent in `check` mode is silent.** ADR-0028 §9 + ADR-0027 §8 + ADR-0025: surfacing "security suggestions unavailable in check mode" every run is the noise pattern explicitly rejected. The user chose the fast verb; they know what it excludes. The detector running in `check` is the half that earns rent — ESLint security plugins are deterministic and fast.

11. **The `WARDEN_SECURITY_CONFIDENCE_FLOOR` env var is the only escape hatch v0 ships.** No inline `// warden-ignore-security` marker, no per-category overlay, no flag, no config file. Mirrors ADR-0027 §9's "tighten the detection; the right escape hatch emerges from dogfood evidence" philosophy. If dogfood reveals real FPs at the floor 0.8 default, the user can lower it via env var while the team investigates whether to tighten the prompt or raise the slug threshold.

12. **The Tier-1 ESLint mapping is unconditional.** All `security/*` and `no-secrets/*` ESLint rule findings map to Tier-1 in `to-comment.ts`, regardless of the rule's ESLint severity. The reasoning: ESLint's security plugins exist because the patterns they detect _are_ security issues; relegating them to Tier-2 or Tier-3 would invite the LLM formatter to suppress them via the Tier-3 verbose gate. If dogfood reveals specific rules that produce Tier-2-class noise (e.g., `detect-object-injection` is notoriously noisy), narrow at the rule level — disable the rule in the Warden-managed config — rather than relaxing the Tier-1 mapping for the whole prefix.

## When you're done

- Update ADR-0028's status row in `decisions.md`: `Direction` → `Done`. Add a one-line shipped-surface summary (template in §13 above).
- Update `CLAUDE.md`: insert `[x] M13 — security category default-review producers per ADR-0028 (...)` line above the `[ ] M14+ — Deferred items...` bullet. Rename the deferred section's heading from M13+ → M14+. Trim the `Custom-code SAST worker` deferred-item bullet to M14's worker-tier scope only.
- Update `CONTEXT.md` with the additions in the "CONTEXT.md additions" section above.
- Update `.env.example` to document `WARDEN_SECURITY_CONFIDENCE_FLOOR`.
- Refresh memory `project_warden_security_depth_tiers.md` — note that M13 ships the default-review tier of the three-tier framing; M14 ships the on-demand-deep tier.
- Hand back a list of deviations from this plan (with reasons) plus confirmation all acceptance criteria pass.

The next milestone after M13 is M14: the worker tier proper. ADR-0029 will commit on the verb shape (`warden security` vs. `warden review --deep`), the dedicated security harness shape, the Sonnet specialist worker's multi-step pipeline, and the M13→M14 dogfood-driven slug expansion. Until then, M13's default-review producers are the security signal warden has been waiting on.
