import {
  createRetryable,
  error as anyError,
  getBossFallbackModel,
  getBossModel,
  getModelKey,
  Output,
  streamText,
  timeout as timeoutCondition,
  type LanguageModel,
  type Retries,
  type RetryContext,
  type SuccessContext,
} from "@warden/ai";
import type { DegradedEntry } from "../schema.js";
import type { FormatterListener } from "./events.js";
import { LlmOutputSchema, type LlmOutput } from "./schema.js";

/**
 * The ADR-0017 cascade: try Anthropic → retry once on transient → fall back
 * to Google → hard fail. Implemented on top of `ai-retry`, which expresses
 * the same control flow declaratively while preserving ADR-0017's invariant
 * that cascade transitions are observable at the call site — `onRetry` /
 * `onError` / `onSuccess` callbacks translate into the same FormatterEvents
 * and DegradedEntry messages the hand-rolled cascade produced.
 */

const RETRY_BACKOFF_MS = 1000;
const PRIMARY_RETRY_ATTEMPTS = 2; // 1 initial + 1 retry on transient

export interface CascadeOptions {
  systemPrompt: string;
  userPrompt: string;
  /** Anthropic extended-thinking budget in tokens. Default 4096 per Q12-C. */
  thinkingBudget: number;
  /** Hard timeout per provider attempt (ms). */
  timeoutMs: number;
  emit?: FormatterListener;
}

export interface CascadeResult {
  output: LlmOutput;
  provider: "anthropic" | "google";
  modelId: string;
  durationMs: number;
  /** degradedWorkers entries to surface — empty when primary succeeded on first try. */
  degraded: DegradedEntry[];
}

export async function callWithCascade(opts: CascadeOptions): Promise<CascadeResult> {
  const startedAt = Date.now();

  const primary = getBossModel();
  const primaryKey = getModelKey(primary);
  const primaryId = modelLabel(primary);
  const fallback = getBossFallbackModel();
  const fallbackKey = fallback ? getModelKey(fallback) : undefined;
  const fallbackId = fallback ? modelLabel(fallback) : undefined;

  // Observability state captured by the callbacks. The library decides retry
  // control flow; we translate its callbacks into the FormatterEvent + degraded
  // shapes ADR-0017 requires.
  const errorSummaries: string[] = [];
  // Tracked separately so degraded + hard-fail messages can quote the *latest*
  // anthropic failure after a transient retry — matches the hand-rolled
  // cascade's `first.error = retry.error` overwrite.
  let lastPrimarySummary: string | undefined;
  let servedBy: LanguageModel = primary;

  opts.emit?.({ type: "phase-start", phase: "llm", provider: "anthropic", modelId: primaryId });

  // Transient = anything the AI SDK's APICallError marks as retryable (408,
  // 409, 429, 5xx, network errors, plus Anthropic's `overloaded_error` via the
  // provider's `isRetryable` override) OR an AbortSignal.timeout() firing.
  const transientCondition = anyError.isRetryable(true).or(timeoutCondition());

  const retries: Retries<LanguageModel> = [
    // 1) On transient against primary: retry the same model once with backoff
    //    and a fresh per-attempt timeout.
    transientCondition.retry({
      delay: RETRY_BACKOFF_MS,
      maxAttempts: PRIMARY_RETRY_ATTEMPTS,
      timeout: opts.timeoutMs,
    }),
  ];

  if (fallback) {
    // 2) Static Google fallback for any remaining Anthropic failure. Strips
    //    Anthropic-scoped `thinking` providerOptions (replacement semantics —
    //    `options.providerOptions` overrides the call's, not merges with it).
    retries.push({
      model: fallback,
      timeout: opts.timeoutMs,
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
      // Cross-provider transition — emit the same fallback-engaged + phase-start
      // pair the hand-rolled cascade used to.
      if (fallbackKey && nextKey === fallbackKey) {
        opts.emit?.({
          type: "fallback-engaged",
          from: `anthropic/${primaryId}`,
          to: `google/${fallbackId ?? "unknown"}`,
          reason: lastPrimarySummary ?? "unknown",
        });
        opts.emit?.({
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
      system: opts.systemPrompt,
      prompt: opts.userPrompt,
      output: Output.object({ schema: LlmOutputSchema }),
      // Per-attempt deadlines live on the retry entries above. We deliberately
      // do NOT set an outer `abortSignal: AbortSignal.timeout(...)` here: it
      // would flow through ai-retry's `resolveAbortSignal` and compose with
      // each retry's fresh signal via `AbortSignal.any`, shortening the retry
      // budget to `min(remaining-base, opts.timeoutMs)` on non-timeout
      // transients. The initial attempt is bounded by the first retry entry's
      // `timeout` (ai-retry applies the next-attempt timeout when issuing the
      // call after a failure; the very first attempt relies on the provider
      // client's own request deadline to surface an error that the retry
      // policy can then react to).
      providerOptions: {
        anthropic: {
          thinking: { type: "enabled", budgetTokens: opts.thinkingBudget },
        },
      },
    });

    // Forward reasoning tokens to the UI in real time. Text-deltas (the JSON
    // payload) stay invisible — Q5/H2 says we render reasoning live, not the
    // raw structured output.
    (async () => {
      try {
        for await (const part of result.fullStream) {
          if (part.type === "reasoning-delta") {
            opts.emit?.({ type: "reasoning-delta", text: part.text });
          }
        }
      } catch {
        // fullStream errors surface via the awaited result.output below.
      }
    })();

    const output = await result.output;

    // Project the served model down to ADR-0017's two-value provider
    // discriminator. Anything not the primary key is the Google fallback —
    // it's the only other entry in `retries`.
    const servedKey = getModelKey(servedBy);
    const provider: "anthropic" | "google" = servedKey === primaryKey ? "anthropic" : "google";
    const modelId = modelLabel(servedBy);

    const degraded: DegradedEntry[] = [];
    if (provider === "anthropic" && errorSummaries.length > 0) {
      // Retried-successfully path: only one primary failure was observed
      // (transient → retry succeeded), so first == last; keep `errorSummaries[0]`
      // to match the hand-rolled cascade's `first.error.summary` here.
      degraded.push({
        kind: "warning",
        topic: "llm",
        message: `llm: anthropic ${errorSummaries[0]}, retried successfully`,
      });
    } else if (provider === "google") {
      // Served-from-google path: the hand-rolled cascade overwrote `first.error`
      // with the retry-failure summary before engaging fallback, so the
      // degraded message reflected the *last* primary failure.
      degraded.push({
        kind: "warning",
        topic: "llm",
        message: `llm: anthropic ${lastPrimarySummary ?? "failed"}, served from google`,
      });
    }

    return {
      output,
      provider,
      modelId,
      durationMs: Date.now() - startedAt,
      degraded,
    };
  } catch (err) {
    // ai-retry throws `RetryError` (from `ai`) with `.errors[]` when every
    // attempt fails; we re-shape to ADR-0017's expected message so downstream
    // formatting + degradedWorkers tests don't have to learn a new shape.
    // `lastPrimarySummary` matches the hand-rolled cascade's `first.error`
    // semantic (overwritten by the retry failure when the transient retry
    // ran), so the message quotes the latest primary failure rather than the
    // initial one.
    const primarySummary = lastPrimarySummary ?? errorSummaries[0] ?? errorSummary(err);
    if (!fallback) {
      throw new Error(
        `llm: anthropic failed (${primarySummary}); GOOGLE_GENERATIVE_AI_API_KEY not set, no fallback available`,
      );
    }
    const fallbackSummary = errorSummaries.at(-1) ?? errorSummary(err);
    throw new Error(
      `llm: anthropic failed (${primarySummary}); google fallback also failed (${fallbackSummary})`,
    );
  }
}

function errorSummary(err: unknown): string {
  const status = httpStatus(err);
  if (status !== undefined) return `HTTP ${status}`;
  const code = errorCode(err);
  if (code) return code;
  if (err instanceof Error) {
    return err.message.length > 80 ? `${err.message.slice(0, 80)}…` : err.message;
  }
  return "unknown error";
}

function errorCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err) {
    const v = (err as { code?: unknown }).code;
    return typeof v === "string" ? v : undefined;
  }
  return undefined;
}

function httpStatus(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const o = err as Record<string, unknown>;
  for (const key of ["status", "statusCode"]) {
    const v = o[key];
    if (typeof v === "number") return v;
  }
  // AI SDK error subtypes commonly nest the response.
  const resp = o["response"];
  if (resp && typeof resp === "object" && "status" in resp) {
    const v = (resp as { status?: unknown }).status;
    if (typeof v === "number") return v;
  }
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
