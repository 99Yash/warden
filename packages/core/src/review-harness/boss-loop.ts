import {
  Output,
  createRetryable,
  error as anyError,
  getBossFallbackModel,
  getBossModel,
  getModelKey,
  stepCountIs,
  streamText,
  timeout as timeoutCondition,
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
import type { DetPriors } from "./det-priors.js";
import { loadBossSystemPrompt } from "./prompts/loader.js";
import type { ReviewScratchpad, TokenUsage } from "./scratchpad.js";
import {
  makeDispatchWorkerTool,
  type WorkerRoute,
} from "./tools/dispatch-worker.js";

/**
 * Phase 2 of the M14 (ADR-0030) review harness. Single `streamText` boss
 * tool-use loop, capped at `WARDEN_REVIEW_BOSS_ROUNDS` steps (default 5,
 * clamped [1,10]). The boss dispatches workers via `dispatch_worker`,
 * reads their results round-by-round, and emits the final Comment[] via
 * `Output.array(CommentSchema)` in its last turn.
 *
 * Boss model is `getBossModel()` (Opus 4.6 per ADR-0030 §2). Provider
 * cascade mirrors the M4 formatter (`cascade.ts`): Anthropic → retry on
 * transient → Google fallback → hard fail. Cascade observability events
 * surface via `emit` (same `FormatterListener` the rest of the pipeline
 * uses).
 */

const DEFAULT_BOSS_ROUNDS = 5;
const MIN_BOSS_ROUNDS = 1;
const MAX_BOSS_ROUNDS = 10;
const PROVIDER_TIMEOUT_MS = 240_000;
const RETRY_BACKOFF_MS = 1000;
const PRIMARY_RETRY_ATTEMPTS = 2;

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
  emit?: FormatterListener;
}

export interface BossLoopOutput {
  comments: Comment[];
  bossTokens?: TokenUsage;
  degraded: DegradedEntry[];
  /** Wall-clock ms across all boss rounds (including provider retries). */
  durationMs: number;
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

  const dispatchTool = makeDispatchWorkerTool({
    repoRoot: input.repoRoot,
    scratchpad: input.scratchpad,
    ...(input.workerBudget !== undefined ? { workerBudget: input.workerBudget } : {}),
    route: input.route,
  });

  const systemPrompt = loadBossSystemPrompt();
  const userPrompt = renderBossUserPrompt(input);
  const stepCap = resolveBossRounds();

  const primary = getBossModel();
  const primaryKey = getModelKey(primary);
  const primaryId = modelLabel(primary);
  const fallback = getBossFallbackModel();
  const fallbackKey = fallback ? getModelKey(fallback) : undefined;
  const fallbackId = fallback ? modelLabel(fallback) : undefined;

  const errorSummaries: string[] = [];
  let lastPrimarySummary: string | undefined;
  let servedBy: LanguageModel = primary;

  input.emit?.({
    type: "phase-start",
    phase: "llm",
    provider: "anthropic",
    modelId: primaryId,
  });

  const transientCondition = anyError.isRetryable(true).or(timeoutCondition());

  const retries: Retries<LanguageModel> = [
    transientCondition.retry({
      delay: RETRY_BACKOFF_MS,
      maxAttempts: PRIMARY_RETRY_ATTEMPTS,
      timeout: PROVIDER_TIMEOUT_MS,
    }),
  ];

  if (fallback) {
    retries.push({
      model: fallback,
      timeout: PROVIDER_TIMEOUT_MS,
      // Strip Anthropic-scoped providerOptions on Google fallback. Boss does
      // not use extended-thinking in M14 — adjudication happens through the
      // tool-use loop, not provider-side reasoning.
      options: { providerOptions: {} },
    });
  }

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
    onRetry: (ctx: RetryContext<LanguageModel>) => {
      const nextKey = getModelKey(ctx.current.model);
      if (fallbackKey && nextKey === fallbackKey) {
        input.emit?.({
          type: "fallback-engaged",
          from: `anthropic/${primaryId}`,
          to: `google/${fallbackId ?? "unknown"}`,
          reason: lastPrimarySummary ?? "unknown",
        });
        input.emit?.({
          type: "phase-start",
          phase: "llm",
          provider: "google",
          modelId: fallbackId ?? "unknown",
        });
      }
    },
    onSuccess: (ctx: SuccessContext<LanguageModel>) => {
      servedBy = ctx.current.model;
    },
  });

  try {
    const result = streamText({
      model: retryable,
      system: systemPrompt,
      prompt: userPrompt,
      tools: { dispatch_worker: dispatchTool },
      stopWhen: [stepCountIs(stepCap)],
      output: Output.object({ schema: BossOutputSchema }),
    });

    // Drain the reasoning + tool-call stream so the renderer sees boss
    // progress in real time. Text deltas (the structured-output JSON) stay
    // invisible — same posture as cascade.ts.
    (async () => {
      try {
        for await (const part of result.fullStream) {
          if (part.type === "reasoning-delta") {
            input.emit?.({ type: "reasoning-delta", text: part.text });
          }
        }
      } catch {
        // surfaced via awaited result.output below.
      }
    })();

    const output = await result.output;
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

    const servedKey = getModelKey(servedBy);
    const provider: "anthropic" | "google" =
      servedKey === primaryKey ? "anthropic" : "google";
    const modelId = modelLabel(servedBy);

    if (provider === "anthropic" && errorSummaries.length > 0) {
      degraded.push({
        kind: "warning",
        topic: "llm",
        message: `llm: anthropic ${errorSummaries[0]}, retried successfully`,
      });
    } else if (provider === "google") {
      degraded.push({
        kind: "warning",
        topic: "llm",
        message: `llm: anthropic ${lastPrimarySummary ?? "failed"}, served from google`,
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
    const primarySummary =
      lastPrimarySummary ?? errorSummaries[0] ?? errorSummary(err);
    if (!fallback) {
      throw new Error(
        `review-harness boss: anthropic failed (${primarySummary}); GOOGLE_GENERATIVE_AI_API_KEY not set, no fallback available`,
      );
    }
    const fallbackSummary = errorSummaries.at(-1) ?? errorSummary(err);
    throw new Error(
      `review-harness boss: anthropic failed (${primarySummary}); google fallback also failed (${fallbackSummary})`,
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

function renderBossUserPrompt(input: BossLoopInput): string {
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
            (f, i) =>
              `${i + 1}. [${f.source}] ${f.file}:${f.line} — ${truncate(f.message, 240)}`,
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
          .map(
            (c, i) =>
              `${i + 1}. ${c.file}:${c.lineStart} — ${truncate(c.claim, 240)}`,
          )
          .join("\n");

  const degraded = dp.degraded.slice(0, DEGRADED_CAP);
  const degradedBlock =
    degraded.length === 0
      ? "(none)"
      : degraded
          .map((d) => `- [${d.kind}] ${d.topic}: ${truncate(d.message, 240)}`)
          .join("\n");

  const truncatedDiff =
    input.diff.length > DIFF_CHAR_CAP
      ? `${input.diff.slice(0, DIFF_CHAR_CAP)}\n…[diff truncated at ${DIFF_CHAR_CAP} chars; ${input.diff.length - DIFF_CHAR_CAP} chars hidden]`
      : input.diff;

  return [
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
    ``,
    `Plan workers per the system prompt's "How to spend your rounds" guide. Dispatch via dispatch_worker; emit the final Comment[] in your last turn via Output.array(CommentSchema).`,
  ].join("\n");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

// ---------------------------------------------------------------------------
// Output shape + post-processing.
// ---------------------------------------------------------------------------

/**
 * Boss output wraps `Comment[]` in a `comments` field so AI SDK v6's
 * structured-output channel sees a top-level object (it parses object
 * schemas more reliably than raw arrays via `Output.object`). The boss
 * prompt names the field; the post-pass unwraps to `Comment[]`.
 */
const BossOutputSchema = z.object({
  comments: z
    .array(CommentSchema)
    .describe(
      "Final review-comment array. Sources must be copied verbatim from worker outputs.",
    ),
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
