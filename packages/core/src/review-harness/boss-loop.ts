import {
  buildReviewTelemetry,
  createRetryable,
  error as anyError,
  getBossModel,
  getBossModelInfo,
  getModelKey,
  hasToolCall,
  stepCountIs,
  streamText,
  timeout as timeoutCondition,
  tool,
  transformSchemaForGemini,
  type LanguageModel,
  type Retries,
  type RetryContext,
  type SuccessContext,
} from "@warden/ai";
import { wardenEnv } from "@warden/env";
import { stableCommentId } from "../comment-id.js";
import type { FormatterListener } from "../llm/index.js";
import { CommentSchema, type Comment, type DegradedEntry } from "../schema.js";
import { z } from "zod";
import type { ChangedFile } from "../diff/index.js";
import type { ToolFinding } from "../runners/types.js";
import type { DetPriors } from "./det-priors.js";
import {
  loadBossSystemPrompt,
  type BossPromptVariant,
  type WorkerPromptVariant,
} from "./prompts/loader.js";
import type { ReviewScratchpad, TokenUsage } from "./scratchpad.js";
import {
  makeDispatchWorkerTool,
  type Concern,
  type DispatchConcurrency,
  type DispatchWorkerArgs,
  type DispatchWorkerResult,
  type WorkerRoute,
} from "./tools/dispatch-worker.js";

/**
 * Phase 2 of the M14 (ADR-0030) review harness. Single `streamText` boss
 * tool-use loop, capped at `WARDEN_REVIEW_BOSS_ROUNDS` steps (default 5,
 * clamped [1,10]). The boss dispatches workers via `dispatch_worker`,
 * reads their results round-by-round, and emits the final Comment[] by
 * calling the terminal `submit_review` tool in its last turn (tool-call
 * structured output is more robust across model versions than the
 * experimental `Output.object` channel under a tool-use loop — see
 * `BossOutputSchema` and the `submit_review` wiring below).
 *
 * Boss model is `getBossModel()` (Opus 4.6 per ADR-0030 §2). Per the
 * ADR-0017 2026-05-17 "tools + structured-output exception" amendment,
 * the boss cascade is **Anthropic primary + 1× transient retry, hard-fail
 * otherwise** — Gemini fallback is NOT registered at this call site
 * because Gemini's structured-output API rejects `tools[]` combined with
 * `responseMimeType: 'application/json'` (the `Output.object` setting).
 * On sustained Anthropic outage, `runBossLoop()` throws with a legible
 * message naming the cause; the review exits non-zero. Cascade
 * observability events surface via `emit` (same `FormatterListener` the
 * rest of the pipeline uses).
 */

const DEFAULT_BOSS_ROUNDS = 5;
const MIN_BOSS_ROUNDS = 1;
const MAX_BOSS_ROUNDS = 10;
const PROVIDER_TIMEOUT_MS = 240_000;
const RETRY_BACKOFF_MS = 1000;
const PRIMARY_RETRY_ATTEMPTS = 2;

/**
 * M15 (ADR-0031) boss-loop calibration knobs.
 *
 * **Defaults (post-ADR-0031 close-out, 2026-05-16):** `programmaticDispatch:
 * true`, `roundZeroExtraConcerns: ['correctness']`, `bossPromptVariant:
 * 'rules'`. The PD-multi shape (Round 0 fan-out + universal correctness
 * extra) is the M15 winning config — strictly dominates M14 baseline on
 * dispatch behavior (≥1 worker on every substantive file) and ties on
 * plant catch in the eval suite (5/6). Pass `programmaticDispatch: false`
 * to opt out and recover pre-M15 boss-agency-only behavior.
 *
 * - `programmaticDispatch`: when true (default), the harness computes
 *   substantive files via det-priors + a `≥10 substantive lines`
 *   heuristic, runs a deterministic Round 0 fan-out BEFORE invoking the
 *   boss's `streamText` loop, and seeds the boss's initial user message
 *   with the Round 0 outputs under a `<round_0_outputs>` block. Round 1+
 *   dispatch dynamism is unchanged.
 *
 * - `roundZeroExtraConcerns`: extra concerns to dispatch on every
 *   substantive file BEYOND the det-prior-routed one. Defaults to
 *   `['correctness']` (the PD-multi shape). Set to `[]` to recover plain
 *   PD (single-concern-per-file routing) — strictly worse on the eval
 *   suite, kept as an opt-in for cost-sensitive callers. Deduped against
 *   the routed concern (a leverage-routed file with extras `['leverage']`
 *   dispatches leverage once). Ignored when `programmaticDispatch` is
 *   false.
 *
 * - `bossPromptVariant`: 'rules' (default) loads `boss-system.md` — the
 *   rules-based prompt that shipped with M14. 'examples' loads
 *   `boss-system-examples.md`, an examples-first rewrite driven by worked
 *   examples from the synthetic fixture set + M14 close-out labels.
 *   ADR-0031 eval surfaced examples-first as a strict regression (1/6
 *   plants vs PD-multi's 5/6) — kept as opt-in only.
 */
export interface BossLoopConfig {
  programmaticDispatch?: boolean;
  bossPromptVariant?: BossPromptVariant;
  roundZeroExtraConcerns?: Concern[];
  /**
   * Worker prompt variant. `'baseline'` (default) loads each worker's
   * `<concern>-system.md`. `'sentry-borrow'` tries
   * `<concern>-system.sentry-borrow.md` first with silent fallback to
   * baseline. Threaded to `makeWorkerRoute()` by the harness; captured in
   * the route closure so every worker dispatch sees the same variant.
   */
  workerPromptVariant?: WorkerPromptVariant;
  /**
   * ADR-0044 eval seam. `legacy-sources-required` preserves the shipped M14
   * behavior: worker output schema requires at least one `sources[]` entry
   * and the runtime drops uncited findings. `allow-empty-sources` permits
   * evidence-only reasoned findings for measurement before the public
   * `Comment.evidence` migration lands.
   */
  reasonedFindingMode?: ReasonedFindingMode;
}

export type ReasonedFindingMode = "legacy-sources-required" | "allow-empty-sources";

/**
 * Post-ADR-0031 defaults. `applyBossLoopDefaults()` resolves the user-
 * supplied (or absent) config to a fully-populated `BossLoopConfig` with
 * the PD-multi shape applied unless the caller explicitly opts out. The
 * exported `BOSS_LOOP_DEFAULTS` constant doubles as both the default
 * source for the resolver and the documented contract for callers that
 * want to inspect "what does an unconfigured harness do?" without
 * reading `boss-loop.ts`.
 */
export const BOSS_LOOP_DEFAULTS: Required<BossLoopConfig> = {
  programmaticDispatch: true,
  bossPromptVariant: "rules",
  roundZeroExtraConcerns: ["correctness"],
  workerPromptVariant: "baseline",
  reasonedFindingMode: "legacy-sources-required",
};

function applyBossLoopDefaults(config: BossLoopConfig | undefined): Required<BossLoopConfig> {
  return {
    programmaticDispatch: config?.programmaticDispatch ?? BOSS_LOOP_DEFAULTS.programmaticDispatch,
    bossPromptVariant: config?.bossPromptVariant ?? BOSS_LOOP_DEFAULTS.bossPromptVariant,
    roundZeroExtraConcerns:
      config?.roundZeroExtraConcerns ?? BOSS_LOOP_DEFAULTS.roundZeroExtraConcerns,
    workerPromptVariant: config?.workerPromptVariant ?? BOSS_LOOP_DEFAULTS.workerPromptVariant,
    reasonedFindingMode: config?.reasonedFindingMode ?? BOSS_LOOP_DEFAULTS.reasonedFindingMode,
  };
}

export interface BossLoopInput {
  repoRoot: string;
  diff: string;
  detPriors: DetPriors;
  scratchpad: ReviewScratchpad;
  /** Worker-routing function — built by the harness via `makeWorkerRoute()`. */
  route: WorkerRoute;
  /**
   * Optional cap on total workers dispatched across the boss loop. Unset =
   * unbounded; the round cap × max-tools-per-step is the only ceiling.
   * Sourced from `wardenEnv().WARDEN_REVIEW_WORKER_BUDGET` by the caller.
   */
  workerBudget?: number;
  /**
   * Per-tier dispatch concurrency cap (ADR-0033). Forwarded into
   * `makeDispatchWorkerTool()` so both Round 0's `Promise.all` and the
   * boss's in-loop dispatches throttle through the same boundary.
   * Omitted → no cap (unit tests, smokes that want raw timing).
   */
  concurrency?: DispatchConcurrency;
  /** M15 (ADR-0031) calibration knobs; defaults preserve M14 behavior. */
  config?: BossLoopConfig;
  emit?: FormatterListener;
  /**
   * ADR-0048 §2 review-run id. When set (and Langfuse keys present), the boss
   * `streamText` loop emits OTEL spans tagged with the run-id — the
   * trace-grouping key shared with every dispatched worker. Absent → telemetry
   * off (no-op).
   */
  runId?: string;
}

export interface BossLoopOutput {
  comments: Comment[];
  bossTokens?: TokenUsage;
  degraded: DegradedEntry[];
  /** Wall-clock ms across all boss rounds (including provider retries). */
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Programmatic dispatch (M15 / ADR-0031) — deterministic Round 0 fan-out.
// ---------------------------------------------------------------------------

/**
 * Minimum non-test/non-doc added lines a file needs before Round 0
 * dispatches a worker against it. Below the threshold the file is treated
 * as cosmetic and skipped — the boss can still dispatch in Round 1+ if it
 * decides the file matters. Tuned to skip whitespace-only diffs / tiny
 * tweaks while catching anything that materially touches code.
 */
const SUBSTANTIVE_LINE_THRESHOLD = 10;

const ROUND_0_PHASE: DispatchWorkerArgs["phase"] = "plan";

/**
 * Files in this set never trigger Round 0 dispatch. The runtime is the
 * `BASELINE_NOISE` exclusion list shape (test files, doc files, OS junk)
 * mirrored from `diff/prune.ts`; rather than re-import the prune internals
 * we apply the same heuristic via path-extension + filename pattern. The
 * full noise filter has already run upstream of `runDetPriors()`; this
 * exists only to gate Round 0 fan-out, not to re-prune.
 */
function isNonSubstantivePath(p: string): boolean {
  const lower = p.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".mdx")) return true;
  if (
    lower.endsWith(".test.ts") ||
    lower.endsWith(".test.tsx") ||
    lower.endsWith(".test.js") ||
    lower.endsWith(".spec.ts") ||
    lower.endsWith(".spec.tsx") ||
    lower.endsWith(".spec.js")
  ) {
    return true;
  }
  if (lower.endsWith(".json") || lower.endsWith(".yml") || lower.endsWith(".yaml")) {
    return true;
  }
  if (lower.endsWith(".snap") || lower.endsWith(".lock")) return true;
  return false;
}

/**
 * Route a file's first det-prior finding to a worker concern. Mapping is
 * source-name → concern: scalability/consistency/leverage map to their
 * own concerns; tsc/eslint/jscpd/deadcode fall back to `correctness`.
 * Files with no det-prior finding default to `correctness` (the catch-all
 * the boss-system prompt already routes the bulk of the diff through).
 *
 * Special case: the M13 ESLint security detector (`eslint-security.ts`)
 * shares the `"eslint"` source value with the user-config ESLint runner,
 * but always carries a `ruleId` prefixed `security/` or `no-secrets/`.
 * Route those to the `security` concern so PD-multi's Round 0 actually
 * dispatches a security worker on planted vulnerabilities like
 * `eval(req.body.code)`.
 */
function routeFindingToConcern(finding: ToolFinding | undefined): Concern {
  if (!finding) return "correctness";
  switch (finding.source) {
    case "scalability":
      return "scalability";
    case "consistency":
      return "consistency";
    case "leverage":
      return "leverage";
    case "eslint":
      if (finding.ruleId?.startsWith("security/") || finding.ruleId?.startsWith("no-secrets/")) {
        return "security";
      }
      return "correctness";
    // ADR-0046: react-doctor findings route off the carried `rdCategory`.
    // Security → a security worker (matches ESLint-security); Performance →
    // scalability. Bugs and the clarity-mapped categories (Maintainability /
    // Accessibility) fall back to `correctness` — clarity findings post
    // directly as sourced det-priors and should not *drive* an LLM dispatch,
    // but Round 0 still needs a concern when one is a file's sole signal.
    case "react-doctor":
      if (finding.rdCategory === "Security") return "security";
      if (finding.rdCategory === "Performance") return "scalability";
      return "correctness";
    case "tsc":
    case "jscpd":
    case "deadcode":
      return "correctness";
  }
}

interface RunRound0DispatchInput {
  detPriors: DetPriors;
  dispatch: (args: DispatchWorkerArgs) => Promise<DispatchWorkerResult>;
  workerBudget?: number;
  /** Extra concerns to dispatch alongside the det-routed one. Deduped. */
  extraConcerns?: Concern[];
}

interface Round0DispatchOutput {
  /** Pre-rendered block to splice into the boss user prompt, or undefined when no dispatches ran. */
  block: string | undefined;
  /** Per-(file, concern) dispatch results, in dispatch order. */
  results: { file: string; concern: Concern; result: DispatchWorkerResult }[];
}

/**
 * Compute substantive files + dispatch one worker per (file, routed
 * concern) before the boss streamText loop. Workers run in parallel; the
 * boss is later seeded with their outputs via a `<round_0_outputs>` block
 * in its initial user message. Shares budget counting with the AI SDK
 * tool path via `dispatch()` (see `makeDispatchWorkerTool()`'s shared
 * closure), so Round 0 dispatches deplete the same `workerBudget` the
 * boss would see in Round 1+.
 */
async function runRound0Dispatch(input: RunRound0DispatchInput): Promise<Round0DispatchOutput> {
  const { detPriors, dispatch, workerBudget, extraConcerns = [] } = input;

  const findingsByPath = new Map<string, ToolFinding>();
  for (const f of detPriors.findings) {
    const key = f.file.replace(/\\/g, "/");
    if (!findingsByPath.has(key)) findingsByPath.set(key, f);
  }

  const substantiveFiles: ChangedFile[] = [];
  for (const cf of detPriors.changed) {
    if (isNonSubstantivePath(cf.path)) continue;
    if (cf.addedLines.length < SUBSTANTIVE_LINE_THRESHOLD) continue;
    substantiveFiles.push(cf);
  }

  if (substantiveFiles.length === 0) {
    return { block: undefined, results: [] };
  }

  // Build the full (file, concern) plan first, then apply the worker
  // budget once across the lot. With extraConcerns set, each file becomes
  // N dispatches; budget-slicing by file would unfairly over-dispatch on
  // earlier files.
  const plan: { file: ChangedFile; concern: Concern }[] = [];
  for (const cf of substantiveFiles) {
    const normalized = cf.path.replace(/\\/g, "/");
    const routed = routeFindingToConcern(findingsByPath.get(normalized));
    const concerns = new Set<Concern>([routed, ...extraConcerns]);
    for (const concern of concerns) {
      plan.push({ file: cf, concern });
    }
  }

  // Budget cap across the planned dispatches. The tool path surfaces the
  // budget-exhausted degraded entry on its own if Round 0 exhausts the
  // budget before the boss runs.
  const capped = workerBudget !== undefined ? plan.slice(0, workerBudget) : plan;
  if (capped.length === 0) {
    return { block: undefined, results: [] };
  }

  const dispatches = capped.map(({ file, concern }) => {
    const args: DispatchWorkerArgs = {
      files: [file.path],
      concern,
      phase: ROUND_0_PHASE,
    };
    return dispatch(args).then((result) => ({ file: file.path, concern, result }));
  });

  const results = await Promise.all(dispatches);
  const block = renderRound0Block(results);
  return { block, results };
}

const ROUND_0_FINDING_CAP_PER_WORKER = 8;
const ROUND_0_CLAIM_CHAR_CAP = 240;

function renderRound0Block(
  results: { file: string; concern: Concern; result: DispatchWorkerResult }[],
): string {
  const blocks = results.map(({ file, concern, result }) => {
    if (result.findings.length === 0) {
      return [`- worker(${concern}) on ${file}: no findings.`].join("\n");
    }
    const lines = [`- worker(${concern}) on ${file}:`];
    for (const finding of result.findings.slice(0, ROUND_0_FINDING_CAP_PER_WORKER)) {
      const claim = truncate(finding.claim, ROUND_0_CLAIM_CHAR_CAP);
      lines.push(
        `    · [${finding.kind}/T${finding.tier}] ${finding.file}:${finding.lineStart} — ${claim}`,
      );
    }
    if (result.findings.length > ROUND_0_FINDING_CAP_PER_WORKER) {
      lines.push(`    · …and ${result.findings.length - ROUND_0_FINDING_CAP_PER_WORKER} more`);
    }
    return lines.join("\n");
  });

  return [
    `<round_0_outputs>`,
    `Workers were dispatched deterministically per substantive file before this round (programmatic dispatch — see system prompt). Their outputs are already in the scratchpad; you may adjudicate them, dispatch further workers in Round 1+ to fill gaps, or synth directly when satisfied.`,
    ``,
    ...blocks,
    `</round_0_outputs>`,
  ].join("\n");
}

/**
 * Resolve the boss round cap from env at call time. Inputs already in the
 * env shape (string) pass through `wardenEnv()`'s zod validation, so this
 * is just the cast + default. Clamping is belt-and-suspenders — the env
 * schema already refines to [1,10].
 */
function resolveBossRounds(): number {
  const raw = wardenEnv().WARDEN_REVIEW_BOSS_ROUNDS;
  if (!raw) return DEFAULT_BOSS_ROUNDS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_BOSS_ROUNDS;
  return Math.min(MAX_BOSS_ROUNDS, Math.max(MIN_BOSS_ROUNDS, Math.trunc(n)));
}

export async function runBossLoop(input: BossLoopInput): Promise<BossLoopOutput> {
  const startedAt = Date.now();
  const degraded: DegradedEntry[] = [];

  const dispatchHandle = makeDispatchWorkerTool({
    repoRoot: input.repoRoot,
    scratchpad: input.scratchpad,
    ...(input.workerBudget !== undefined ? { workerBudget: input.workerBudget } : {}),
    route: input.route,
    ...(input.concurrency !== undefined ? { concurrency: input.concurrency } : {}),
    ...(input.runId !== undefined ? { runId: input.runId } : {}),
  });

  const resolved = applyBossLoopDefaults(input.config);
  const systemPrompt = loadBossSystemPrompt(resolved.bossPromptVariant);

  // M15 (ADR-0031) close-out: programmatic dispatch is ON by default with
  // a `['correctness']` extra-concerns fan-out (PD-multi). Shares dispatch
  // state with the AI SDK tool via the returned `dispatch()` helper, so
  // the workerBudget counter sees Round 0 dispatches and the scratchpad
  // records them identically to tool-driven ones. Pass
  // `{ programmaticDispatch: false }` to opt out and recover pre-M15
  // boss-agency-only behavior.
  let round0Block: string | undefined;
  if (resolved.programmaticDispatch) {
    const round0 = await runRound0Dispatch({
      detPriors: input.detPriors,
      dispatch: dispatchHandle.dispatch,
      ...(input.workerBudget !== undefined ? { workerBudget: input.workerBudget } : {}),
      extraConcerns: resolved.roundZeroExtraConcerns,
    });
    round0Block = round0.block;
  }

  const userPrompt = renderBossUserPrompt(input, round0Block);
  const stepCap = resolveBossRounds();

  const primaryInfo = getBossModelInfo();
  const primary = getBossModel();
  const primaryKey = getModelKey(primary);
  const primaryId = primaryInfo.modelId;

  const errorSummaries: string[] = [];
  let lastPrimarySummary: string | undefined;
  let servedBy: LanguageModel = primary;

  input.emit?.({
    type: "phase-start",
    phase: "llm",
    provider: primaryInfo.provider,
    modelId: primaryId,
  });

  const transientCondition = anyError.isRetryable(true).or(timeoutCondition());

  // Per ADR-0017 2026-05-17 amendment: cascade for tool-using
  // `streamText` call sites is primary + 1× transient retry only. No
  // Gemini fallback step is registered.
  const retries: Retries<LanguageModel> = [
    transientCondition.retry({
      delay: RETRY_BACKOFF_MS,
      maxAttempts: PRIMARY_RETRY_ATTEMPTS,
      timeout: PROVIDER_TIMEOUT_MS,
    }),
  ];

  const retryable = createRetryable<LanguageModel>({
    model: primary,
    retries,
    onError: (ctx: RetryContext<LanguageModel>) => {
      if (ctx.current.type === "error") {
        const summary = errorSummary(ctx.current.error);
        errorSummaries.push(summary);
        if (getModelKey(ctx.current.model) === primaryKey) {
          lastPrimarySummary = summary;
        }
      }
    },
    onSuccess: (ctx: SuccessContext<LanguageModel>) => {
      servedBy = ctx.current.model;
    },
  });

  // Adapter is vestigial post-ADR-0017 2026-05-17 amendment (Gemini fallback
  // is no longer registered at this call site — see the cascade comment
  // above). Kept wired so the reversal block from `git log` re-enables
  // fallback in a single edit; the adapter is universal (Anthropic accepts
  // string-form enums identically — boss never sees the schema literally)
  // so it costs nothing on the Anthropic-only happy path.
  // `responseTransform` coerces strings back to numbers before downstream
  // Comment[] typing applies. When the adapter detects no numeric-literal-
  // union in the schema (no-op case), `requestSchema === BossOutputSchema`
  // and `responseTransform` is identity.
  const geminiPair = transformSchemaForGemini(BossOutputSchema);

  // The boss emits its final comment set by calling a terminal `submit_review`
  // tool, not via the AI SDK's experimental `Output.object` channel. Tool-call
  // structured output composes far more reliably with a tool-use loop across
  // model versions: opus-4-8 deterministically failed `Output.object` here with
  // "No object generated: could not parse the response", while opus-4-6 did
  // not. The tool's `execute` captures the SDK-validated input;
  // `hasToolCall("submit_review")` ends the loop as soon as it fires.
  let submittedRaw: unknown;
  const submitReviewTool = tool({
    description: [
      "Submit the final review. Call this exactly once, as your LAST action,",
      "with the complete review as `{ comments: Comment[] }`. Copy each",
      "Comment's `sources` verbatim from worker findings. Calling this ends",
      "the review; an empty `comments` array is the correct submission for a",
      "clean diff.",
    ].join(" "),
    inputSchema: geminiPair.requestSchema,
    execute: (args: unknown) => {
      submittedRaw = args;
      const comments = (args as { comments?: unknown[] }).comments;
      return { received: Array.isArray(comments) ? comments.length : 0 };
    },
  });

  try {
    const result = streamText({
      model: retryable,
      system: systemPrompt,
      prompt: userPrompt,
      tools: {
        dispatch_worker: dispatchHandle.tool,
        submit_review: submitReviewTool,
      },
      stopWhen: [stepCountIs(stepCap), hasToolCall("submit_review")],
      ...(primaryInfo.providerOptions !== undefined
        ? { providerOptions: primaryInfo.providerOptions }
        : {}),
      // ADR-0048 §3 — auto-emit OTEL spans (LLM + every tool call) under the
      // run-id's Langfuse trace. No-op unless Langfuse keys are present.
      ...(input.runId !== undefined
        ? { experimental_telemetry: buildReviewTelemetry({ runId: input.runId, role: "boss" }) }
        : {}),
    });

    // Drain the full stream to completion. This surfaces reasoning deltas to
    // the renderer in real time AND guarantees the `submit_review` execute has
    // run (so `submittedRaw` is populated) before we read it below. Stream
    // errors propagate to the catch block.
    for await (const part of result.fullStream) {
      if (part.type === "reasoning-delta") {
        input.emit?.({ type: "reasoning-delta", text: part.text });
      }
    }

    if (submittedRaw === undefined) {
      throw new Error("boss ended without calling submit_review (no final comment set emitted)");
    }
    // Coerce string-form numeric literals back to numbers. No-op when the
    // schema contained no numeric-literal-union (geminiPair is identity).
    const output = geminiPair.responseTransform(submittedRaw) as z.infer<typeof BossOutputSchema>;
    let bossTokens: TokenUsage | undefined;
    try {
      const usage = await result.usage;
      bossTokens = {
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        ...(usage.cachedInputTokens !== undefined
          ? { cachedInputTokens: usage.cachedInputTokens }
          : {}),
      };
    } catch {
      bossTokens = undefined;
    }
    if (bossTokens) input.scratchpad.recordBossTokens(bossTokens);

    const modelId = modelLabel(servedBy);

    // Post-amendment, the only served path is Anthropic primary — fallback
    // wiring is compile-time deleted. The retried-successfully degraded
    // entry surfaces when a transient retry rescued the primary call.
    if (errorSummaries.length > 0) {
      degraded.push({
        kind: "warning",
        topic: "llm",
        message: `llm: ${primaryInfo.label} ${errorSummaries[0]}, retried successfully`,
      });
    }

    const comments = normalizeBossComments(output.comments);

    input.emit?.({
      type: "phase-complete",
      phase: "llm",
      revisedCount: 0,
      questionCount: comments.filter((c) => c.kind === "question").length,
      durationMs: Date.now() - startedAt,
    });

    void modelId; // currently unused downstream but kept for future render hooks.
    return {
      comments,
      ...(bossTokens !== undefined ? { bossTokens } : {}),
      degraded,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    const primarySummary = lastPrimarySummary ?? errorSummaries[0] ?? errorSummary(err);
    // Per ADR-0017 2026-05-17 amendment: tool-using call sites do not fall
    // back to Gemini. Hard-fail cleanly with a legible message.
    throw new Error(
      `review-harness boss: ${primaryInfo.label} failed (${primarySummary}); Gemini fallback skipped (tools required)`,
    );
  }
}

// ---------------------------------------------------------------------------
// User prompt assembly.
// ---------------------------------------------------------------------------

const TOOL_FINDINGS_CAP = 60;
const DEGRADED_CAP = 20;
const FILE_LIST_CAP = 80;
const DIFF_CHAR_CAP = 32_000;

function renderBossUserPrompt(input: BossLoopInput, round0Block: string | undefined): string {
  const dp = input.detPriors;
  const fileList = dp.changedPaths.slice(0, FILE_LIST_CAP);
  const fileListTrailer =
    dp.changedPaths.length > FILE_LIST_CAP
      ? `\n…and ${dp.changedPaths.length - FILE_LIST_CAP} more`
      : "";

  const findings = dp.findings.slice(0, TOOL_FINDINGS_CAP);
  const findingsBlock =
    findings.length === 0
      ? "(no deterministic findings)"
      : findings
          .map(
            (f, i) => `${i + 1}. [${f.source}] ${f.file}:${f.line} — ${truncate(f.message, 240)}`,
          )
          .join("\n");
  const findingsTrailer =
    dp.findings.length > TOOL_FINDINGS_CAP
      ? `\n…and ${dp.findings.length - TOOL_FINDINGS_CAP} more det-prior findings`
      : "";

  const vulnBlock =
    dp.vulnComments.length === 0
      ? "(no vulnerabilities)"
      : dp.vulnComments
          .slice(0, 20)
          .map((c, i) => `${i + 1}. ${c.file}:${c.lineStart} — ${truncate(c.claim, 240)}`)
          .join("\n");

  const degraded = dp.degraded.slice(0, DEGRADED_CAP);
  const degradedBlock =
    degraded.length === 0
      ? "(none)"
      : degraded.map((d) => `- [${d.kind}] ${d.topic}: ${truncate(d.message, 240)}`).join("\n");

  const truncatedDiff =
    input.diff.length > DIFF_CHAR_CAP
      ? `${input.diff.slice(0, DIFF_CHAR_CAP)}\n…[diff truncated at ${DIFF_CHAR_CAP} chars; ${input.diff.length - DIFF_CHAR_CAP} chars hidden]`
      : input.diff;

  const sections = [
    `<files>`,
    `${dp.changedPaths.length} changed file${dp.changedPaths.length === 1 ? "" : "s"} after noise filter:`,
    fileList.map((p) => `- ${p}`).join("\n") + fileListTrailer,
    `</files>`,
    ``,
    `<det-priors>`,
    `Tool findings (TSC, ESLint user, ESLint security, jscpd, scalability, consistency, deadcode, leverage):`,
    findingsBlock + findingsTrailer,
    ``,
    `Vulnerabilities (npm audit + OSV):`,
    vulnBlock,
    ``,
    `Degraded entries from Phase 1:`,
    degradedBlock,
    `</det-priors>`,
    ``,
    `<diff>`,
    truncatedDiff,
    `</diff>`,
  ];

  if (round0Block !== undefined) {
    sections.push(``, round0Block);
  }

  sections.push(
    ``,
    `Plan workers per the system prompt's "How to spend your rounds" guide. Dispatch via dispatch_worker; then emit the final result by calling \`submit_review\` with \`{ comments: Comment[] }\` as your last action.`,
  );

  return sections.join("\n");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

// ---------------------------------------------------------------------------
// Output shape + post-processing.
// ---------------------------------------------------------------------------

/**
 * Boss output wraps `Comment[]` in a `comments` field so the `submit_review`
 * tool's input schema is a top-level object (object schemas validate more
 * reliably than top-level arrays as tool input). The boss prompt names the
 * field; the post-pass unwraps to `Comment[]`.
 */
const BossOutputSchema = z.object({
  comments: z
    .array(CommentSchema)
    .describe("Final review-comment array. Sources must be copied verbatim from worker outputs."),
});

function normalizeBossComments(comments: Comment[]): Comment[] {
  // The boss-emitted ids are LLM-authored placeholders; re-derive stable
  // content-addressed ids so duplicate review runs produce the same
  // identity (per `comment-id.ts`'s contract).
  return comments.map((c) => {
    const lineStart = Math.max(0, c.lineStart);
    const lineEnd = Math.max(lineStart, c.lineEnd);
    return {
      ...c,
      id: stableCommentId(`boss:${c.file}:${lineStart}:${c.category}:${c.claim}`),
      lineStart,
      lineEnd,
    };
  });
}

// ---------------------------------------------------------------------------
// Provider-error formatting (mirrors cascade.ts).
// ---------------------------------------------------------------------------

function errorSummary(err: unknown): string {
  const status = httpStatus(err);
  if (status !== undefined) return `HTTP ${status}`;
  if (err instanceof Error) {
    return err.message.length > 80 ? `${err.message.slice(0, 80)}…` : err.message;
  }
  return "unknown error";
}

function httpStatus(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const direct = (err as { statusCode?: unknown }).statusCode;
  if (typeof direct === "number") return direct;
  const status = (err as { status?: unknown }).status;
  if (typeof status === "number") return status;
  const response = (err as { response?: { status?: unknown } }).response;
  if (response && typeof response.status === "number") return response.status;
  return undefined;
}

function modelLabel(model: LanguageModel): string {
  if (typeof model === "string") return model;
  if (model && typeof model === "object" && "modelId" in model) {
    const v = (model as { modelId?: unknown }).modelId;
    if (typeof v === "string") return v;
  }
  return "unknown";
}
