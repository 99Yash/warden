# Warden — M14 Plan (dedicated security harness — Opus apex boss + per-file Sonnet investigators + Haiku classifiers + deterministic triage gate)

This is the milestone brief for the agent (or future-me) implementing M14. Self-contained: read this plus `decisions.md` ADR-0029 and you have everything.

M14 ships the **on-demand deep tier** of `project_warden_security_depth_tiers.md` and closes the architectural arc ADR-0028 opened. It introduces a **dedicated security orchestration harness** at `packages/core/src/security/` alongside the M8 spine (not a refactor; not a synthesizer swap; not a shared scratchpad). The harness runs a six-phase pipeline — **Det Priors → Triage Gate → Boss Plan → Worker Fan-Out → Boss Synth → Citation Verify** — with a new apex model tier (Opus 4.7), per-file Sonnet investigators that the boss equips with slug subsets + retrieved context, and Haiku classifiers for cheap subtasks. Two CLI surfaces ship with **different semantics, not aliases**: `warden security` (focused SAST verb, runs only the new harness) and `warden review --deep` (flag that runs the M8 spine minus M13's Haiku security sub-agent plus the M14 harness; outputs unioned). Schema impact zero — `'security'` already in `CategoryEnum`; all citations flow through existing `tool` / `api_def` source types; the substring-verifier dispatches unchanged.

## Read first (in this order)

1. **`./decisions.md`** — focus on **ADR-0029** (the M14 design commit). Also: **ADR-0028** (M13 — direct predecessor; M14 reads M8's scratchpad populated by M13's runners when `--deep`); **ADR-0015** (DeepSec borrow/reject framing — M14 cashes the pipeline borrow on the worker tier and rejects LLM-judges-LLM revalidation cleanly); **ADR-0023** (M8 orchestration spine — pattern reference for `dispatch()` + scratchpad shape, but M14's `SecurityScratchpad` is a different type); **ADR-0026** (M11 — `lookupTypeDef` tool, third consumer pattern); **ADR-0017** (multi-provider cascade — M14's apex tier cascade follows the same shape); **ADR-0013** (I/O-pure core — `readFile`/`grepRepo` tools must honor); **ADR-0011** (`warden check` vs `warden review` separation — `warden security` is a third verb with its own semantics); **ADR-0008** (citation thesis — every M14 finding must carry a verified source); **ADR-0006** (model tier helpers — M14 adds apex tier).
2. **`./CONTEXT.md`** — §1 `warden security` (flips to direction in M14); §3 new apex tier + `security harness` direction + worker tier finally shipping; §5 new M14 runners (boss plan, boss synth, security investigator worker, security classifier worker, triage gate); §7 confidence floor carve-out note; §8 `custom-code SAST worker` + `security harness` flip from deferred to direction.
3. **`./CLAUDE.md`** — package boundary table; AI SDK v6 notes; M14 status line; new env var.
4. **`./vision.md` §3** — boss/worker architecture vision. M14 ships the worker tier `vision.md §3` predicted; the apex-tier boss and Haiku classifier path are M14 upgrades beyond `vision.md`'s sketch.
5. **`./packages/core/src/schema.ts`** — `CategoryEnum` (line 34 `'security'`). M14 **does not modify** this. `SourceTypeEnum` (no changes either — M14 uses existing `tool` + `api_def`).
6. **`./packages/core/src/index.ts`** — `PRIORITY_ORDER` (line 578 `'security'`, no change). `applyHardRules()` (around line 592) gains the harness-context discriminator. `orchestrationRunners` registration is **not** the M14 entry point — M14 has its own dispatch.
7. **`./packages/core/src/confidence.ts`** — `applyConfidenceFloor()` stays unchanged; the new `applyHardRules()` skips it on the `m14-security` branch.
8. **`./packages/core/src/runners/eslint-security.ts`** — M13's ESLint security detector. M14 calls `runEslintSecurity()` in Phase 1; standalone `warden security` reuses the same function (the runner is contextless — no scratchpad coupling).
9. **`./packages/core/src/runners/security.ts`** — M13's Haiku security sub-agent. M14 **does not modify** this directly, but the M8 dispatch registration is gated on `!deep` so it skips when `--deep` is set.
10. **`./packages/core/src/runners/leverage-libraries.ts`** — M12 sub-agent harness; the structural twin for `streamText` tool-use loops, graceful no-model fallback, lane discipline. M14 workers follow the same pattern but with `SecurityWorkerInput`/`Output` shapes.
11. **`./packages/core/src/llm/tools/lookup-type-def.ts`** — M11 tool descriptor. M14 imports `makeLookupTypeDefTool()` for workers (third consumer; same pattern as M12 leverage and M13 security sub-agent).
12. **`./packages/core/src/llm/verify-citations.ts`** — M10/M11 global substring-verifier. M14 calls it in Phase 5 unchanged.
13. **`./packages/core/src/llm/cascade.ts`** — multi-provider cascade. M14's apex calls reuse the same retry shape via `getApexModel()` + `getApexFallbackModel()`.
14. **`./packages/core/src/orchestration/`** (`runner.ts`, `scratchpad.ts`, `dispatch.ts`, `synthesizer.ts`) — pattern reference only. M14 does **not** reuse these directly; the new `SecurityScratchpad` has different content shape (Plan + worker outputs, not generic `RunnerOutput[]`).
15. **`./packages/ai/src/models.ts`** — current `getBossModel()` / `getWorkerStrongModel()` / `getWorkerCheapModel()`. M14 adds `getApexModel()` + `getApexFallbackModel()` alongside.
16. **`./packages/env/src/index.ts`** — `wardenEnv()`. M14 adds optional `WARDEN_SECURITY_WORKER_BUDGET` (numeric string, positive integer; unset = unbounded).
17. **`./packages/db/src/schema/`** — Drizzle schema. M14 adds new `securityRuns` table.
18. **`./packages/cli/src/index.ts`** — commander entry. M14 registers `warden security` as a new verb + adds `--deep` flag to `warden review`.
19. **`./packages/cli/src/render.ts`** — phase-log + reasoning-tail UX. M14 extends to render the six-phase pipeline (Phase 1, 1.5, 2, 3, 4, 5) and the final cost line.
20. **`~/Developer/oss/deepsec/packages/processor/src/index.ts` + `./agents/claude-agent-sdk.ts`** — DeepSec's investigator + revalidator pattern. M14's design borrows the investigation shape (per-file/per-batch fan-out with tool access) and explicitly rejects the LLM-judges-LLM revalidate pass (per ADR-0015); read for inspiration on tool-loop UX, quota-aware concurrency, error handling.

## Goal of this milestone

Land ADR-0029's design in a single coherent slice:

- **No `CategoryEnum` change.** `'security'` already at `packages/core/src/schema.ts:34`.
- **No `PRIORITY_ORDER` change.** `'security'` already at slot 2 in `packages/core/src/index.ts:578`.
- **No new `Source.type`.** Workers emit existing `tool` (source-line + sink-line) and `api_def` (when a finding hinges on a library API claim) sources.
- **No verifier changes.** `packages/core/src/llm/verify-citations.ts` dispatches on `type` exactly as today; M14 adds no new branch.
- **Apex model tier in `@warden/ai`.** New `getApexModel()` (Anthropic `claude-opus-4-7`) + `getApexFallbackModel()` (Google `gemini-2.5-pro`). Existing helpers unchanged.
- **Env var.** `WARDEN_SECURITY_WORKER_BUDGET` (optional, positive integer; unset = unbounded). Documented in `.env.example` + CLAUDE.md env table.
- **New SQLite table.** `securityRuns` in `@warden/db` carrying `(id, timestamp, mode, modelBoss, modelWorkerStrong, modelWorkerCheap, inputTokens, outputTokens, costUsd, commentsEmitted)`. Generate migration via `pnpm db:generate`; apply via `pnpm db:migrate`.
- **Dedicated harness module.** New `packages/core/src/security/` directory: `harness.ts` (entry), `triage-gate.ts` (Phase 1.5), `plan.ts` (Phase 2 + Plan schema), `worker.ts` (Phase 3 investigator + classifier), `synth.ts` (Phase 4), `scratchpad.ts` (`SecurityScratchpad` class), `cost.ts` (post-hoc cost computation + static per-model rate table), `tools/read-file.ts`, `tools/grep-repo.ts`, `prompts/plan-system.md`, `prompts/synth-system.md`, `prompts/investigator-system.md`, `prompts/classifier-system.md`. Prompt loaders in `packages/core/src/llm/prompt-loader.ts`.
- **`applyHardRules()` harness-context discriminator.** Signature gains `{ harness: 'm8-review' | 'm14-security' }`. The `m14-security` branch skips `applyConfidenceFloor()`. M8 call sites pass `harness: 'm8-review'` (default); M14 passes `harness: 'm14-security'`.
- **CLI: `warden security` verb + `--deep` flag on `warden review`.** Both invoke the M14 harness. `--deep` additionally gates the M13 Haiku security sub-agent on `!deep` in M8's dispatch.
- **M13 Haiku sub-agent gate.** `packages/core/src/index.ts` dispatch registration adds `mode === 'review' && !config.deep` predicate around the security sub-agent registration.
- **Smoke harness.** `smoke-m14-triage-gate.mts` (asserts the gate skips on a README-only diff + on a diff with no det priors + no path matches; asserts the gate proceeds when either signal positive); `smoke-m14-plan.mts` (asserts the boss emits a valid Plan + empty Plan when no security signal slips past the gate); `smoke-m14-worker.mts` (asserts an investigator worker round-trips with `readFile`/`grepRepo`/`lookupTypeDef`; asserts secret-deny list blocks `.env`; asserts path-traversal blocked); `smoke-m14-synth.mts` (asserts boss synth dedupes overlapping worker findings + drops uncited claims); `smoke-m14-deep-composition.mts` (asserts `warden review --deep` skips M13 Haiku and unions M8 + M14 outputs; asserts standalone `warden security` runs the harness alone); `smoke-m14-cost.mts` (asserts `security_runs` row written per invocation; asserts post-hoc cost line emitted).

By the end:

- `warden security HEAD~1..HEAD` on a diff touching `src/auth.ts` with a planted auth-bypass pattern: emits a `category: "security"` question-kind Comment from a Sonnet investigator worker, citing source + sink lines, substring-verified.
- `warden security HEAD~1..HEAD` on a README-only diff: emits zero Comments + one info `degradedWorkers` entry ("Deep security analysis skipped — diff has no security-relevant content"). Zero LLM calls. Sub-second wall-clock.
- `warden review --deep HEAD~1..HEAD` on a mixed diff: M8 produces non-security findings (M13 Haiku skipped silently); M14 produces security findings; output unions them; final cost line breaks down spend per model.
- `pnpm smoke:m14` exercises all six smoke scripts; `pnpm check-types` + `pnpm lint` pass.
- ADR-0029 status snapshot row stays `Direction` until dogfood acceptance, then flips to `Done`.
- CLAUDE.md M14 line flips to `[x]` above the renamed M15+ deferred-items list.

**Stop at "apex tier helper + dedicated harness module + triage gate + Plan + workers + synth + verifier reuse + `--deep` composition + `securityRuns` table + smoke + close-out." Do NOT start:** weekly USD cap or `--max-cost <usd>` flag (M15+); slug expansion beyond M13's 10 (M15+); init-time security inventory (`.warden/security-inventory.json`) (M15+); AST candidate-scanner expansion of Phase 1 (M15+); per-worker output caching (M15+); repo-wide audit mode (`--all`) (M15+); boss-side tool access (M15+); Claude Agent SDK adoption (ADR-0029 alternatives — rejected); BYO apex model flag (`--apex-model`) (deferred to ADR-0006 BYOLLM milestone); bash/exec worker tool (ADR-0029 alternatives — hard no); pre-flight cost estimate (ADR-0029 alternatives — rejected); per-call confidence threshold for M14 (ADR-0029 §10 — verifier is the sole gate); new `Source.type` for taint flows (ADR-0029 alternatives — rejected, ship workers emitting source/sink as two `tool` sources); re-platforming the inline M8 runners (ADR-0023 deferred); multi-language security detection beyond TS/JS (tied to ADR-0008 multi-ecosystem rewrite). Those are later milestones.

## Repo additions

```
packages/core/src/security/
├── harness.ts                                    # NEW — entry point.
│                                                 #   Exports `runSecurityHarness(input):
│                                                 #   Promise<SecurityHarnessOutput>`.
│                                                 #   Orchestrates Phases 1–5 sequentially;
│                                                 #   reads input.precomputedDetPriors when
│                                                 #   present (--deep path reads M8 scratchpad),
│                                                 #   else calls runEslintSecurity()/runVuln()
│                                                 #   itself. Records cost into securityRuns
│                                                 #   table.
│
├── triage-gate.ts                                # NEW — Phase 1.5 deterministic gate.
│                                                 #   Exports `evaluateTriageGate(detPriors,
│                                                 #   changedFiles): TriageGateResult`. Returns
│                                                 #   { proceed: true } or { proceed: false,
│                                                 #   reason: string }. Hosts
│                                                 #   SECURITY_SENSITIVE_PATTERNS constant.
│
├── plan.ts                                       # NEW — Phase 2 boss Plan.
│                                                 #   `generatePlan(input)` calls Opus apex
│                                                 #   via cascade. Uses `generateText` with
│                                                 #   `output: Output.object(PlanSchema)`. Plan
│                                                 #   schema includes subtasks[],
│                                                 #   skipped_files[], rationale.
│
├── worker.ts                                     # NEW — Phase 3 worker dispatch +
│                                                 #   investigator/classifier implementations.
│                                                 #   Investigator: `streamText` tool-use loop,
│                                                 #   getWorkerStrongModel(), stopWhen:
│                                                 #   stepCountIs(8), tools = lookupTypeDef +
│                                                 #   readFile + grepRepo. Classifier:
│                                                 #   single-shot generateText,
│                                                 #   getWorkerCheapModel(), no tools.
│                                                 #   Parallel via Promise.all gated on
│                                                 #   WARDEN_SECURITY_WORKER_BUDGET.
│
├── synth.ts                                      # NEW — Phase 4 boss Synth.
│                                                 #   `synthesize(scratchpad)` calls Opus apex
│                                                 #   via cascade. Reads scratchpad's worker
│                                                 #   outputs + det priors; emits CommentSet
│                                                 #   for category=security.
│
├── scratchpad.ts                                 # NEW — SecurityScratchpad class.
│                                                 #   Holds detPriors, plan, workerOutputs[],
│                                                 #   tokenUsage, costUsd, degraded[]. Methods:
│                                                 #   recordDet(), recordPlan(),
│                                                 #   recordWorker(), recordCost(),
│                                                 #   recordDegraded(), all().
│
├── cost.ts                                       # NEW — post-hoc cost computation.
│                                                 #   `computeCost(usage, modelMap):
│                                                 #   { totalUsd, breakdownByModel }`.
│                                                 #   Hosts static MODEL_PRICING table (input/
│                                                 #   output $/1M tokens per model id).
│
├── types.ts                                      # NEW — shared types.
│                                                 #   SecurityWorkerInput, SecurityWorkerOutput,
│                                                 #   PlanSchema, TriageGateResult,
│                                                 #   SecurityHarnessInput,
│                                                 #   SecurityHarnessOutput,
│                                                 #   SecurityFinding (worker-internal pre-
│                                                 #   Comment shape).
│
├── tools/
│   ├── read-file.ts                              # NEW — `makeReadFileTool({ repoRoot })`.
│   │                                             #   Path-traversal check; secret-deny list;
│   │                                             #   gitignore-honored; 1000-line cap.
│   │
│   └── grep-repo.ts                              # NEW — `makeGrepRepoTool({ repoRoot })`.
│                                                 #   Literal-substring pattern in v0; max 200
│                                                 #   results; secret-deny list; gitignore-
│                                                 #   honored. Implementation may shell out to
│                                                 #   ripgrep if available, else fall back to
│                                                 #   a Node-side walker.
│
└── prompts/
    ├── plan-system.md                            # NEW — Opus boss Plan prompt.
    │                                             #   Sections: role; planning task; Plan
    │                                             #   schema overview; slug vocabulary (10
    │                                             #   slugs from M13); FP-pre-empt guidance
    │                                             #   (DeepSec-borrowed); worker selection
    │                                             #   heuristics (when sonnet vs haiku); cost
    │                                             #   ceiling instruction (if budget set).
    │
    ├── synth-system.md                           # NEW — Opus boss Synth prompt.
    │                                             #   Sections: role; synthesis task; dedup
    │                                             #   rules (file+line range overlap); citation
    │                                             #   discipline; Tier 1/2/3 assignment;
    │                                             #   `kind: 'question' | 'assertion'` rules.
    │
    ├── investigator-system.md                    # NEW — Sonnet investigator prompt.
    │                                             #   Sections: role; per-slug guidance (10
    │                                             #   slugs); tool usage instructions; FP
    │                                             #   guidance; auth-bypass subtleties;
    │                                             #   citation discipline (source line + sink
    │                                             #   line as two tool sources, or one
    │                                             #   api_def); 5 worked examples (matching
    │                                             #   M13's security-system.md examples).
    │
    └── classifier-system.md                      # NEW — Haiku classifier prompt.
                                                  #   Sections: role; classification task
                                                  #   (one-shot, no tools); slug vocabulary;
                                                  #   output schema (Output.object).

packages/core/src/index.ts                        # MODIFIED — `applyHardRules` gains
                                                  #   harness-context discriminator;
                                                  #   `orchestrationRunners` gates M13 Haiku
                                                  #   sub-agent on `!config.deep`.

packages/core/src/llm/prompt-loader.ts            # MODIFIED — add loadPlanSystemPrompt(),
                                                  #   loadSynthSystemPrompt(),
                                                  #   loadInvestigatorSystemPrompt(),
                                                  #   loadClassifierSystemPrompt(). Each
                                                  #   mirrors the existing loaders.

packages/core/tsdown.config.ts                    # MODIFIED — copy the four new prompt
                                                  #   files into the published bundle.

packages/ai/src/models.ts                         # MODIFIED — add getApexModel() →
                                                  #   anthropicProvider()('claude-opus-4-7')
                                                  #   and getApexFallbackModel() →
                                                  #   googleProvider()?.('gemini-2.5-pro').

packages/env/src/index.ts                         # MODIFIED — add optional
                                                  #   WARDEN_SECURITY_WORKER_BUDGET (string,
                                                  #   parsed to positive integer; refinement
                                                  #   error if non-integer or ≤0).

.env.example                                      # MODIFIED — document new env var.

packages/db/src/schema/security-runs.ts           # NEW — Drizzle schema for securityRuns
                                                  #   table. Columns: id (text, ulid),
                                                  #   timestamp (integer, unix ms),
                                                  #   mode (text, 'security' | 'review-deep'),
                                                  #   modelBoss (text), modelWorkerStrong
                                                  #   (text), modelWorkerCheap (text),
                                                  #   inputTokens (integer), outputTokens
                                                  #   (integer), costUsd (real),
                                                  #   commentsEmitted (integer).

packages/db/src/schemas.ts                        # MODIFIED — re-export securityRuns.

packages/db/drizzle/<timestamp>_security_runs.sql # NEW — generated migration.

packages/cli/src/index.ts                         # MODIFIED — register `warden security`
                                                  #   verb + add `--deep` flag to `warden
                                                  #   review`. Both invoke the same
                                                  #   runSecurityHarness; security verb
                                                  #   re-runs det priors itself, --deep reads
                                                  #   M8 scratchpad.

packages/cli/src/render.ts                        # MODIFIED — extend phase-log renderer
                                                  #   to cover Phase 1.5 (gate decision),
                                                  #   Phase 2 (plan summary), Phase 3 (per-
                                                  #   worker progress with file + slug
                                                  #   labels), Phase 4 (synth summary),
                                                  #   Phase 5 (verifier drops); render
                                                  #   final cost line with per-model
                                                  #   breakdown.

packages/cli/scripts/
├── smoke-m14-triage-gate.mts                     # NEW
├── smoke-m14-plan.mts                            # NEW
├── smoke-m14-worker.mts                          # NEW
├── smoke-m14-synth.mts                           # NEW
├── smoke-m14-deep-composition.mts                # NEW
└── smoke-m14-cost.mts                            # NEW

packages/cli/package.json                         # MODIFIED — add `smoke:m14` script that
                                                  #   chains the six smoke scripts.
```

## Package boundaries (M14 additions)

| Package          | M14 additions                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `@warden/cli`    | `warden security` verb; `--deep` flag on `warden review`; render extensions; smoke harness.                               |
| `@warden/core`   | `packages/core/src/security/` module; `applyHardRules()` discriminator; M13 Haiku gate.                                   |
| `@warden/ai`     | `getApexModel()` + `getApexFallbackModel()`.                                                                              |
| `@warden/db`     | `securityRuns` table + schema + migration.                                                                                |
| `@warden/env`    | `WARDEN_SECURITY_WORKER_BUDGET`.                                                                                          |
| `@warden/config` | No changes.                                                                                                               |

`@warden/core/src/security/` may import `@warden/ai` (for models + tools) and `@warden/db` (for `securityRuns`); it must not import `commander`, `picocolors`, or `ora` (ADR-0013 invariant). Worker tools (`read-file.ts`, `grep-repo.ts`) read files via Node's `node:fs` directly — they're I/O-impure tools but the impurity is bounded to the tool implementation; the surrounding harness remains pure relative to the LLM context (no `console.log`, no `process.stdout`).

## What to build — phase by phase

### Phase 1 — Det Priors

- **Standalone `warden security` path:** the harness's entry function calls `runEslintSecurity()` + the vuln/OSV runner directly, populates `SecurityScratchpad.detPriors`.
- **`warden review --deep` path:** the harness's entry function receives the M8 scratchpad as `precomputedDetPriors` and copies the relevant entries (ESLint security findings + vuln/OSV findings) into its own `SecurityScratchpad`. No re-execution.
- `runEslintSecurity()` is already shipped (M13, `packages/core/src/runners/eslint-security.ts`); use it as-is.
- The vuln/OSV runner is already shipped; use it as-is.

### Phase 1.5 — Triage Gate

- `evaluateTriageGate({ detPriors, changedFiles, repoRoot }): TriageGateResult`.
- Signal A: `detPriors.findings.length > 0 || detPriors.candidates.length > 0`.
- Signal B: `changedFiles.some(f => matchesAny(f.path, SECURITY_SENSITIVE_PATTERNS))`. Use micromatch or a hand-rolled glob matcher; do not pull a new heavy dep just for this.
- `SECURITY_SENSITIVE_PATTERNS` (constant, exported for testability):
  ```
  **/{auth,login,signin,signup,session,oauth}/**
  **/api/**
  **/routes/**
  **/middleware/**
  **/crypto/**
  **/encrypt/**
  **/db/**
  **/database/**
  **/queries/**
  **/migrations/**
  **/*.sql
  **/package-lock.json
  **/pnpm-lock.yaml
  **/yarn.lock
  **/.env*
  ```
- If both signals negative: return `{ proceed: false, reason: 'no det findings; no security-sensitive path matches' }`.
- If either positive: return `{ proceed: true }`.
- Harness on `proceed: false`: emit `degradedWorkers` entry, return empty `CommentSet`.

### Phase 2 — Boss Plan

- `generatePlan({ diff, detPriors, retrievedContext, workerBudget? })`.
- Use AI SDK v6 `generateText` with `output: Output.object(PlanSchema)` and `model: getApexModel()` wrapped in the cascade helper from `packages/core/src/llm/cascade.ts` (extend the cascade to support the apex tier — single line: pass `fallbackModel: getApexFallbackModel()`).
- Prompt: `prompts/plan-system.md` (system) + user message with diff + det priors + retrieved context + optional `workerBudget` instruction.
- `PlanSchema` (Zod):
  ```ts
  z.object({
    subtasks: z.array(z.object({
      kind: z.enum(['investigate', 'classify']),
      worker: z.enum(['sonnet', 'haiku']),
      files: z.array(z.string()).min(1),    // repo-relative
      slugs: z.array(SecuritySlugEnum).min(1),
      retrievedContext: z.string().optional(),
      // classify-only:
      line: z.number().int().positive().optional(),
      candidates: z.array(SecuritySlugEnum).min(2).optional(),
    })),
    skipped_files: z.array(z.string()),
    rationale: z.string(),
  });
  ```
- If `subtasks.length === 0`: skip Phase 3 entirely (boss decided no work warranted); proceed to Phase 4 with empty worker outputs (Phase 4 still runs to emit the final empty CommentSet + record cost).
- Record `plan` + cost into scratchpad.

### Phase 3 — Worker Fan-Out

- For each subtask in the Plan: dispatch the appropriate worker via `Promise.all`.
- Worker dispatch respects `WARDEN_SECURITY_WORKER_BUDGET`: if set and `subtasks.length > budget`, run the first `budget` subtasks and emit one info `degradedWorkers` entry (`{ kind: "info", topic: "security", message: "Worker budget ${budget} exceeded; ran ${budget} of ${subtasks.length} planned workers" }`). The boss's planning prompt already included the budget instruction, so this is a belt-and-suspenders cap.
- **Investigator worker** (Sonnet):
  - `streamText` with `model: getWorkerStrongModel()`, `tools: { lookupTypeDef, readFile, grepRepo }`, `stopWhen: stepCountIs(8)`.
  - System prompt: `prompts/investigator-system.md`.
  - User message: per-subtask — file paths + slug subset + retrieved context excerpt.
  - Output: array of `SecurityFinding` (Zod-typed; carries `claim`, `path`, `line`, `kind: 'assertion' | 'question'`, `slug`, `tier`, `sources[]`).
  - Mirror M12 leverage-libraries.ts patterns for graceful no-model fallback (one info `degradedWorkers` entry, return empty findings).
  - Mirror M12 lane discipline: drop findings whose `path` is not in `subtask.files` (one info entry per non-zero drop count).
  - Drop findings with no `sources[]` (uncited claims) before they become Comments.
- **Classifier worker** (Haiku):
  - `generateText` with `model: getWorkerCheapModel()`, no tools, `output: Output.object(ClassifierResultSchema)`.
  - System prompt: `prompts/classifier-system.md`.
  - User message: per-subtask — file path + line + candidate slugs.
  - Output: `{ slug: SecuritySlug, confidence: number, brief: string }`.
  - Used by the synthesizer in Phase 4 to disambiguate borderline cases (does not directly produce Comments).
- Record per-worker output + per-worker cost into scratchpad. Capture `error?` per worker on failure; one warning `degradedWorkers` entry per non-zero failure count.

### Phase 4 — Boss Synth

- `synthesize({ scratchpad, repoRoot })`.
- `generateText` with `model: getApexModel()` wrapped in cascade, `output: Output.array(CommentSchema)` (existing `CommentSchema` from `packages/core/src/schema.ts`).
- System prompt: `prompts/synth-system.md`.
- User message: serialize the scratchpad's findings + classifier results + det priors + diff context; instruct boss to (a) dedupe findings whose `(path, line)` overlap, (b) assign `kind: 'question' | 'assertion'` per finding, (c) assign `tier: 1 | 2 | 3` per finding, (d) preserve source citations verbatim (do not invent new sources).
- Record cost into scratchpad; assemble final `CommentSet` carrying all surviving Comments + accumulated `degradedWorkers`.

### Phase 5 — Citation Verify

- Call existing `verifyComments(comments, repoRoot)` from `packages/core/src/llm/verify-citations.ts`. Drops Comments whose sources fail substring-match; emits info `degradedWorkers` entries per failure mode.
- No changes to the verifier in M14.

### Post-pipeline — `applyHardRules` + cost recording

- `applyHardRules(comments, { harness: 'm14-security' })`:
  - Skip `applyConfidenceFloor()` for the `m14-security` branch.
  - Apply Tier-3 verbose gate (unchanged from M8 path).
  - Apply priority sort (unchanged — all M14 output is `category: 'security'`, so sort is a no-op intra-category by confidence + tier).
- Compute total cost via `computeCost(scratchpad.tokenUsage, MODEL_PRICING)`; insert one row into `securityRuns`; print post-hoc cost line to CLI (rendered via `packages/cli/src/render.ts`).

### CLI: `warden security` verb

- `warden security [base..head]` mirrors `warden review`'s diff-resolution path (auto-detect HEAD vs default branch when no arg; honor `--base`, `--stdin`).
- Output flags: `--json`, `--verbose` (Tier-3 visibility, same as `warden review`).
- No new flags in v0 beyond the inherited `warden review` shape.

### CLI: `warden review --deep` flag

- Adds boolean `--deep` to the `warden review` command in commander.
- When set: M8 dispatch skips M13 Haiku sub-agent; after M8 emits its CommentSet, the M14 harness runs reading M8's scratchpad as `precomputedDetPriors`; outputs unioned; single cost line covers both M8 + M14.

## Acceptance criteria

1. `pnpm check-types` passes; `pnpm lint` passes; `pnpm db:generate` produces the `securityRuns` migration cleanly.
2. `pnpm smoke:m14` runs all six smoke scripts to completion (each script self-asserts; non-zero exit = failure).
3. Standalone `warden security HEAD~1..HEAD` on the m14 branch diff: ships zero false positives on warden itself (dogfood pass); cost line printed at end.
4. `warden review --deep HEAD~1..HEAD` on the m14 branch diff: M8 still produces non-security findings (e.g. committability, leverage); M14 produces zero security findings on warden itself; M13 Haiku skipped silently; cost line covers both.
5. `warden security` on a README-only diff: zero LLM calls; one info `degradedWorkers` entry; sub-second wall-clock.
6. `WARDEN_SECURITY_WORKER_BUDGET=2` on a diff that would otherwise spawn 5 workers: only first 2 run; one info `degradedWorkers` entry surfaces.
7. `applyHardRules({ harness: 'm14-security' })` skips `applyConfidenceFloor()` — verified by smoke (planted low-confidence finding survives M14 path; same finding would drop on M8 path).
8. A planted `eval(req.body.cmd)` in a touched file: M14 investigator emits a Tier-1 Comment citing source + sink lines; verifier passes; final output includes it.
9. A planted false-positive (e.g. `readFile('/tmp/' + req.user.id)` in a test fixture) flagged by the FP-pre-empt section of the investigator prompt as benign: investigator either skips it or emits Tier-3; not a Tier-1.
10. `securityRuns` table contains one row per invocation; each row's `costUsd` is non-zero and matches the printed cost line.
11. Path-traversal: a planted attempt by the LLM to call `readFile({ path: '../../../../etc/passwd' })` blocked at tool level; tool returns error; LLM receives "permission denied" message; investigation continues.
12. Secret-file deny: a planted attempt by the LLM to call `readFile({ path: '.env' })` blocked at tool level; same error path.
13. Dogfood: run `warden review --deep` on the M14 PR itself; verify outputs are sensible; no Tier-1 false positives on warden's own code.
14. ADR-0029 status row flips from `Direction` to `Done` after acceptance.
15. CLAUDE.md M14 line flips to `[x]`; M15+ deferred list reorganised.

## What NOT to do

Listed near the top of the "Goal" section; collected here for emphasis:

- ❌ Weekly USD cap or `--max-cost` flag (M15+).
- ❌ Slug expansion beyond M13's 10 slugs (M15+).
- ❌ Init-time security inventory (M15+).
- ❌ AST candidate-scanner expansion of Phase 1 (M15+).
- ❌ Per-worker output caching (M15+).
- ❌ Repo-wide audit mode `--all` (M15+).
- ❌ Boss-side tool access (M15+).
- ❌ Claude Agent SDK (ADR-0029 — rejected).
- ❌ `bashExec` worker tool (ADR-0029 — hard no).
- ❌ Pre-flight cost estimate (ADR-0029 — rejected).
- ❌ Per-call confidence threshold for M14 (ADR-0029 §10 — verifier is sole gate).
- ❌ New `Source.type` for taint flows (ADR-0029 — rejected).
- ❌ Re-platform inline M8 runners (ADR-0023 deferred).
- ❌ Multi-language security detection beyond TS/JS (tied to ADR-0008 multi-ecosystem rewrite).
- ❌ BYO apex model flag (deferred to ADR-0006 BYOLLM).
- ❌ Three-step apex cascade (Opus → Sonnet → Gemini Pro) — rejected per ADR-0029 alternatives (silent downgrade defeats opt-in deep tier).
- ❌ M14 reusing M8's `Runner` contract — workers have a different input/output shape; new `SecurityWorker*` types.

## CONTEXT.md additions / updates (do in same PR)

- **§1 `warden security`** — flip `[deferred, M14]` to `[direction, M14]` once ADR-0029 lands; flip to live when M14 ships.
- **§3 new entry `apex model`** — Opus-class (`claude-opus-4-7`) for M14 boss seat (Phase 2 Plan + Phase 4 Synth); separate tier from boss/strong/cheap; first call sites are M14 only.
- **§3 update `worker strong` / `worker sonnet`** — flip `[deferred]` to live; M14 ships specialist Sonnet workers as the worker tier (investigators).
- **§3 update `boss/worker orchestration`** — flip `[worker tier still deferred]` to `[worker tier shipped in M14 via dedicated security harness]`; note M14 is the first vision-tier worker proper.
- **§5 new entries**: `security investigator worker` (Sonnet, per-file, slug subset, tools); `security classifier worker` (Haiku, per-line, candidate slugs, no tools); `triage gate` (Phase 1.5 deterministic gate); `boss plan` (Phase 2 Opus call); `boss synth` (Phase 4 Opus call); `security harness` (entry orchestration).
- **§7 update `confidence threshold`** — add M14 carve-out note: harness-context discriminator skips the floor for `m14-security` output; substring-verifier is the sole gate; M13 floor unchanged for M8 path.
- **§8 update `custom-code SAST worker`** — flip `[narrowed by M13 to the deep-mode worker]` to `[shipped in M14 per ADR-0029]`.
- **§8 update `security harness`** — flip `[deferred, M14]` to `[direction, M14]` when ADR-0029 lands; flip to live when M14 ships.

## Design nuances (gotchas + judgment calls)

- **`SecurityScratchpad` vs M8 `Scratchpad`:** intentionally different types. M8's `Scratchpad` holds `Map<runnerName, RunnerOutput>`; M14's holds `{ detPriors, plan, workerOutputs[], tokenUsage, costUsd, degraded[] }`. Do not try to share — the M8 type is the wrong shape for M14's structured Plan + worker output.
- **Cost computation precision:** `MODEL_PRICING` in `cost.ts` is the source of truth for $/1M tokens. Update on price changes via a one-line PR. v0 values (as of M14 ship date — check Anthropic/Google pricing pages before shipping): Opus 4.7 = $15 input / $75 output per 1M; Sonnet 4.6 = $3 / $15; Haiku 4.5 = $1 / $5; Gemini 2.5 Pro = $2.50 / $10 (sub-128k context tier). These rates are illustrative — verify current pricing at ship time and document in the file as "as of YYYY-MM-DD".
- **AI SDK v6 token usage:** `usage` object is returned per `generateText`/`streamText` call. Sum across all calls per invocation; record per-model breakdown.
- **Tool error handling:** wrap each tool's `execute()` body in try/catch; return `{ error: '...' }` instead of throwing. The LLM receives the error message in the tool result; cascade retry is unaffected.
- **`readFile` truncation marker:** when a file exceeds 1000 lines, return the first 1000 lines + `\n[… truncated. File has N total lines; request a specific range with startLine/endLine.]`. Don't silently truncate.
- **`grepRepo` literal vs regex:** v0 ships literal-substring matching only (faster, simpler, avoids ReDoS). If dogfood evidence shows regex is needed, M15+ adds a `regex: boolean` flag with bounded complexity.
- **`SECURITY_SENSITIVE_PATTERNS`:** intentionally over-broad in v0 (better false-proceed than false-skip — the gate's job is to filter the obvious-skip cases). Tightening happens in M15+ when the init-time inventory provides better signal.
- **Plan empty case:** when the boss emits `subtasks: []`, Phase 3 is skipped but Phase 4 still runs (empty input, empty output). This ensures cost is recorded and the final CommentSet shape is consistent.
- **`--deep` skipping M13 Haiku:** the gate predicate goes inside the M8 dispatch registration for the security sub-agent: `if (mode === 'review' && !config.deep) { runners.push(securityRunner); }`. The M13 sub-agent code itself doesn't change.
- **Standalone `warden security` outside git:** error loudly. The verb requires a diff source. M15+ may add a `--all` mode that works without git.
- **Prompts are prompts-as-files (ADR-0015):** all four new prompts live in `packages/core/src/security/prompts/*.md` and load via the existing prompt-loader pattern (`packages/core/src/llm/prompt-loader.ts`). Do not embed prompts inline in TS code.
- **Worker prompt + system-prompt vs user-message split:** system prompts contain stable role + guidance; user messages contain per-invocation diff + file content + slug subset. Keep the split clean so caching at the AI SDK level is effective.
- **Smoke harness env keys:** smoke tests that exercise the LLM path require valid `ANTHROPIC_API_KEY`. Document this in the smoke script header; print a clear "skipping — no key" message when missing rather than failing.
- **Phase 5 ordering vs `applyHardRules`:** the verifier runs first (drops uncited Comments), then `applyHardRules` (priority sort + Tier-3 gate; floor is skipped for M14). Match the order M11/M12/M13 use.
- **Render UX:** the phase log should clearly differentiate the six phases. Phase 1.5 gets a one-line "Triage Gate: proceeding" or "Triage Gate: skipped (reason: …)". Phase 2 emits a one-line plan summary ("Plan: 8 Sonnet investigators on 12 files + 3 Haiku classifiers"). Phase 3 streams per-worker progress as workers complete.

## Close-out checklist

- [ ] `pnpm check-types` + `pnpm lint` clean.
- [ ] `pnpm db:generate` produces clean migration; `pnpm db:migrate` applies cleanly to a fresh `.warden/cache.sqlite`.
- [ ] `pnpm smoke:m14` all green.
- [ ] Dogfood: `warden security HEAD~1..HEAD` on the M14 branch — zero FPs.
- [ ] Dogfood: `warden review --deep HEAD~1..HEAD` on the M14 branch — M8 + M14 outputs union correctly; M13 Haiku skipped silently.
- [ ] Dogfood: `warden security` on a README-only diff — zero LLM calls; info entry; sub-second.
- [ ] ADR-0029 status row → `Done`.
- [ ] CLAUDE.md M14 line → `[x]`; M15+ deferred list reorganised; `WARDEN_SECURITY_WORKER_BUDGET` documented in env table.
- [ ] CONTEXT.md updates landed (§1, §3, §5, §7, §8 per the list above).
- [ ] Journal entry written under `~/journal/YYYY-MM-DDTHHMMSSZ.md`.
