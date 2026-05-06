import {
  getBossFallbackModel,
  getBossModel,
  Output,
  streamText,
  type LanguageModel,
} from "@warden/ai";
import type { FormatterListener } from "./events.js";
import { LlmOutputSchema, type LlmOutput } from "./schema.js";

/**
 * The ADR-0017 cascade: try Anthropic → retry once on transient → fall back
 * to Google → hard fail. Caller-side rather than AI SDK middleware so the
 * failure mode is visible at this call site (degradedWorkers messages are
 * naturally produced; cascade transitions are observable).
 */

const RETRY_BACKOFF_MS = 1000;

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
  degraded: string[];
}

export async function callWithCascade(opts: CascadeOptions): Promise<CascadeResult> {
  const degraded: string[] = [];

  // Attempt 1: Anthropic primary.
  const primary = getBossModel();
  const primaryId = modelLabel(primary);
  opts.emit?.({ type: "phase-start", phase: "llm", provider: "anthropic", modelId: primaryId });
  const first = await tryProvider({
    model: primary,
    provider: "anthropic",
    opts,
  });
  if (first.ok) {
    return { ...first.value, degraded };
  }

  // Attempt 2: retry once on transient.
  if (isTransient(first.error)) {
    await sleep(RETRY_BACKOFF_MS);
    const retry = await tryProvider({ model: primary, provider: "anthropic", opts });
    if (retry.ok) {
      degraded.push(`llm: anthropic ${first.error.summary}, retried successfully`);
      return { ...retry.value, degraded };
    }
    first.error = retry.error;
  }

  // Attempt 3: Google fallback if configured.
  const fallback = getBossFallbackModel();
  if (!fallback) {
    throw new Error(
      `llm: anthropic failed (${first.error.summary}); GOOGLE_GENERATIVE_AI_API_KEY not set, no fallback available`,
    );
  }
  const fallbackId = modelLabel(fallback);
  opts.emit?.({
    type: "fallback-engaged",
    from: `anthropic/${primaryId}`,
    to: `google/${fallbackId}`,
    reason: first.error.summary,
  });
  opts.emit?.({ type: "phase-start", phase: "llm", provider: "google", modelId: fallbackId });
  const fb = await tryProvider({ model: fallback, provider: "google", opts });
  if (fb.ok) {
    degraded.push(`llm: anthropic ${first.error.summary}, served from google`);
    return { ...fb.value, degraded };
  }

  throw new Error(
    `llm: anthropic failed (${first.error.summary}); google fallback also failed (${fb.error.summary})`,
  );
}

interface AttemptOk {
  ok: true;
  value: Omit<CascadeResult, "degraded">;
}

interface AttemptErr {
  ok: false;
  error: { transient: boolean; summary: string; cause: unknown };
}

async function tryProvider(args: {
  model: LanguageModel;
  provider: "anthropic" | "google";
  opts: CascadeOptions;
}): Promise<AttemptOk | AttemptErr> {
  const startedAt = Date.now();
  try {
    const result = streamText({
      model: args.model,
      system: args.opts.systemPrompt,
      prompt: args.opts.userPrompt,
      output: Output.object({ schema: LlmOutputSchema }),
      timeout: { totalMs: args.opts.timeoutMs },
      providerOptions:
        args.provider === "anthropic"
          ? {
              anthropic: {
                thinking: { type: "enabled", budgetTokens: args.opts.thinkingBudget },
              },
            }
          : {},
    });

    // Forward reasoning tokens to the UI in real time. Text-deltas (the JSON
    // payload) stay invisible — Q5/H2 says we render reasoning live, not the
    // raw structured output.
    (async () => {
      try {
        for await (const part of result.fullStream) {
          if (part.type === "reasoning-delta") {
            args.opts.emit?.({ type: "reasoning-delta", text: part.text });
          }
        }
      } catch {
        // fullStream errors surface via the awaited result.output below.
      }
    })();

    const output = await result.output;
    return {
      ok: true,
      value: {
        output,
        provider: args.provider,
        modelId: modelLabel(args.model),
        durationMs: Date.now() - startedAt,
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: {
        transient: classifyTransient(err),
        summary: errorSummary(err),
        cause: err,
      },
    };
  }
}

function isTransient(err: { transient: boolean }): boolean {
  return err.transient;
}

function classifyTransient(err: unknown): boolean {
  const code = errorCode(err);
  if (code === "ETIMEDOUT" || code === "ECONNRESET" || code === "ECONNREFUSED") return true;
  const status = httpStatus(err);
  if (status === 429) return true;
  if (status !== undefined && status >= 500 && status < 600) return true;
  // AI SDK timeouts surface as AbortError-shaped exceptions.
  if (err instanceof Error && /timeout|aborted/i.test(err.message)) return true;
  return false;
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

function modelLabel(model: LanguageModel): string {
  if (typeof model === "string") return model;
  if (model && typeof model === "object" && "modelId" in model) {
    const v = (model as { modelId?: unknown }).modelId;
    if (typeof v === "string") return v;
  }
  return "unknown";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
