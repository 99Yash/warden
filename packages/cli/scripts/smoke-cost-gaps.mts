/**
 * Smoke for the two cost-accounting gaps that PR #79 left open.
 *
 * Gap 1 — a failed LLM call records the usage it spent. A worker call that
 * fails (a stream error after a finished step, a schema parse failure, a
 * timeout) still returns the usage of every step that finished, and counts
 * the requests whose usage is unknown instead of a guess. Driven through
 * `callWorker()` (the worker's LLM-call seam) with a mock model, so the real
 * `streamText` + `CallUsageMeter` wiring runs.
 *
 * Gap 2 — the GPT-6.x long-context tier. A request whose prompt is more
 * than 272k input tokens pays the tier rates for all of its tokens. The cost
 * is priced per request, not on the summed total. The models.dev catalog
 * parser reads `cost.tiers`, and a bad tier entry does not break the parse.
 *
 * Offline: mock models and a mock `fetch` only, no network, no paid call.
 *
 * Usage: pnpm --filter @warden/cli smoke:cost-gaps
 */

import { requestCostUsd, tool, type LlmModelPrice, type ResolvedLlmModel } from "@warden/ai";
import { _resetModelCatalogCacheForTests, modelCatalogPrice } from "@warden/ai/model-catalog";
import { MockLanguageModelV3 } from "@warden/ai/test";
import { priceRequestsByTier } from "@warden/core/review-harness/harness";
import { CallUsageMeter, ReviewScratchpad } from "@warden/core/review-harness/scratchpad";
import { callWorker } from "@warden/core/review-harness/workers/run-worker";
import { z } from "zod";

let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) {
    process.stdout.write(`  ✓ ${msg}\n`);
  } else {
    process.stdout.write(`  ✗ ${msg}\n`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Mock-model helpers (AI SDK 6 / LanguageModelV3 stream parts).
// ---------------------------------------------------------------------------

type DoStream = MockLanguageModelV3["doStream"];
type StreamPart =
  Awaited<ReturnType<DoStream>>["stream"] extends ReadableStream<infer P> ? P : never;

function usage(input: number, output: number, cacheRead = 0) {
  return {
    inputTokens: { total: input, noCache: input - cacheRead, cacheRead, cacheWrite: undefined },
    outputTokens: { total: output, text: output, reasoning: undefined },
  };
}

function streamOf(parts: StreamPart[]): Awaited<ReturnType<DoStream>> {
  return {
    stream: new ReadableStream<StreamPart>({
      start(controller) {
        for (const p of parts) controller.enqueue(p);
        controller.close();
      },
    }),
  };
}

function toolCallStep(input: number, output: number, cacheRead = 0): Awaited<ReturnType<DoStream>> {
  return streamOf([
    { type: "stream-start", warnings: [] },
    { type: "tool-call", toolCallId: `call-${input}`, toolName: "noop", input: "{}" },
    {
      type: "finish",
      finishReason: { unified: "tool-calls", raw: "tool_use" },
      usage: usage(input, output, cacheRead),
    },
  ]);
}

function textStep(text: string, input: number, output: number): Awaited<ReturnType<DoStream>> {
  return streamOf([
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: text },
    { type: "text-end", id: "t1" },
    {
      type: "finish",
      finishReason: { unified: "stop", raw: "end_turn" },
      usage: usage(input, output),
    },
  ]);
}

/** A model that plays `steps` in order, one per model request. */
type StepScript = (signal: AbortSignal | undefined) => Promise<Awaited<ReturnType<DoStream>>>;

function scriptedModel(id: string, steps: StepScript[]) {
  let call = 0;
  const model = new MockLanguageModelV3({
    provider: "stub",
    modelId: id,
    doStream: async (options) => {
      const step = steps[call];
      call++;
      if (!step) throw new Error(`no scripted step ${call}`);
      return step(options.abortSignal);
    },
  });
  return { model, calls: () => call };
}

const tools = {
  noop: tool({
    description: "No-op tool for the smoke.",
    inputSchema: z.object({}),
    execute: async () => ({ ok: true }),
  }),
};

const baseOpts = {
  tier: "sonnet" as const,
  systemPrompt: "stub worker",
  userPrompt: "stub prompt",
  tools,
  timeoutMs: 5_000,
};

// ---------------------------------------------------------------------------
// Gap 1 — failed calls record usage.
// ---------------------------------------------------------------------------

process.stdout.write("\n[1] success: usage is the sum over every step\n");
{
  const { model } = scriptedModel("ok", [
    async () => toolCallStep(1_000, 50, 200),
    async () => textStep('{"findings":[]}', 1_200, 30),
  ]);
  const r = await callWorker({ ...baseOpts, primary: model });
  assert(r.ok, "call succeeds");
  assert(r.usage.requests.length === 2, `two requests recorded (got ${r.usage.requests.length})`);
  assert(
    r.usage.total.inputTokens === 2_200,
    `input sums both steps (got ${r.usage.total.inputTokens})`,
  );
  assert(
    r.usage.total.outputTokens === 80,
    `output sums both steps (got ${r.usage.total.outputTokens})`,
  );
  assert(r.usage.total.cachedInputTokens === 200, "cache reads carried");
  assert(r.usage.unknownRequests === 0, "no unknown requests");
}

process.stdout.write("\n[2] stream error after one finished step: step 1 usage is kept\n");
{
  const { model, calls } = scriptedModel("err", [
    async () => toolCallStep(4_000, 120),
    async () => {
      throw new Error("simulated provider 500 on step 2");
    },
  ]);
  const r = await callWorker({ ...baseOpts, primary: model });
  assert(calls() === 2, `two model requests made (got ${calls()})`);
  assert(!r.ok, "call fails");
  assert(
    r.usage.total.inputTokens === 4_000,
    `step-1 input kept (got ${r.usage.total.inputTokens})`,
  );
  assert(
    r.usage.total.outputTokens === 120,
    `step-1 output kept (got ${r.usage.total.outputTokens})`,
  );
  assert(
    r.usage.unknownRequests === 1,
    `failed step 2 is unknown (got ${r.usage.unknownRequests})`,
  );
}

process.stdout.write("\n[3] schema parse failure: usage is complete\n");
{
  const { model } = scriptedModel("bad-json", [async () => textStep("not json at all", 900, 40)]);
  const r = await callWorker({ ...baseOpts, primary: model });
  assert(!r.ok, "call fails on the output schema");
  assert(r.usage.total.inputTokens === 900, `input kept (got ${r.usage.total.inputTokens})`);
  assert(r.usage.total.outputTokens === 40, `output kept (got ${r.usage.total.outputTokens})`);
  assert(r.usage.unknownRequests === 0, "no unknown requests: the stream finished");
}

process.stdout.write("\n[4] timeout during step 2: step 1 kept, step 2 unknown\n");
{
  const { model } = scriptedModel("timeout", [
    async () => toolCallStep(2_500, 60),
    // Step 2 starts to stream, then stalls until the worker's total timeout
    // aborts it. The provider never sends its final usage.
    async (signal) => ({
      stream: new ReadableStream<StreamPart>({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "t1" });
          signal?.addEventListener("abort", () => controller.error(signal.reason));
        },
      }),
    }),
  ]);
  // `AbortSignal.timeout` timers do not keep Node's event loop alive, and a
  // mock has no open socket. This guard keeps the loop alive and fails the
  // smoke if the call hangs.
  const guard = setTimeout(() => {
    process.stdout.write("  ✗ timeout case hung\n");
    process.exit(1);
  }, 10_000);
  const r = await callWorker({ ...baseOpts, primary: model, timeoutMs: 300 });
  clearTimeout(guard);
  assert(!r.ok, "call fails on the timeout");
  assert(
    r.usage.total.inputTokens === 2_500,
    `step-1 input kept (got ${r.usage.total.inputTokens})`,
  );
  assert(
    r.usage.unknownRequests === 1,
    `in-flight step is unknown (got ${r.usage.unknownRequests})`,
  );
}

process.stdout.write("\n[5] first request fails: no usage, one unknown request\n");
{
  const { model } = scriptedModel("first-fail", [
    async () => {
      throw new Error("simulated 5xx");
    },
  ]);
  const r = await callWorker({ ...baseOpts, primary: model });
  assert(!r.ok, "call fails");
  assert(r.usage.requests.length === 0, "no request reported usage");
  assert(r.usage.total.inputTokens === 0 && r.usage.total.outputTokens === 0, "no invented tokens");
  assert(r.usage.unknownRequests === 1, `one unknown request (got ${r.usage.unknownRequests})`);
}

process.stdout.write("\n[6] boss meter: retried attempts and the scratchpad record\n");
{
  // Boss path: `ai-retry` reports each failed attempt via `onError`.
  const meter = new CallUsageMeter();
  meter.prepareStep();
  meter.attemptFailed(); // a timed-out attempt that a retry recovered
  meter.onStepFinish({
    usage: {
      inputTokens: 10_000,
      inputTokenDetails: { noCacheTokens: 10_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
      outputTokens: 500,
      outputTokenDetails: { textTokens: 500, reasoningTokens: 0 },
      totalTokens: 10_500,
    },
  });
  meter.prepareStep(); // step 2 starts and the boss call then throws
  const snap = meter.snapshot();
  assert(snap.total.inputTokens === 10_000, "boss step-1 usage kept");
  assert(
    snap.unknownRequests === 2,
    `retried attempt + in-flight step unknown (got ${snap.unknownRequests})`,
  );
  const pad = new ReviewScratchpad();
  pad.recordBossUsage(snap);
  assert(pad.bossTokens()?.inputTokens === 10_000, "scratchpad holds the failed boss usage");
  assert(pad.bossUsage()?.unknownRequests === 2, "scratchpad holds the unknown count");
}

// ---------------------------------------------------------------------------
// Gap 2 — long-context tier, priced per request.
// ---------------------------------------------------------------------------

// models.dev `openai/gpt-6.1-sol` on 2026-10-20 (same rates as the OpenAI
// pricing page: $2 / $0.10 / $2.50 / $10 short, $4 / $0.20 / $5 / $15 long).
const SOL: LlmModelPrice = {
  input: 2,
  output: 10,
  cachedInput: 0.1,
  cacheWriteInput: 2.5,
  contextTiers: [
    {
      aboveInputTokens: 272_000,
      rates: { input: 4, output: 15, cachedInput: 0.2, cacheWriteInput: 5 },
    },
  ],
};
const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

process.stdout.write("\n[7] one request above 272k pays the tier for all its tokens\n");
{
  const big = { inputTokens: 300_000, outputTokens: 2_000, cachedInputTokens: 50_000 };
  // 250k uncached x $4 + 50k cached x $0.20 + 2k output x $15, per 1M.
  const want = 1.0 + 0.01 + 0.03;
  const got = requestCostUsd(SOL, big);
  assert(close(got, want), `300k-input request costs $${want} (got $${got})`);
  const base = 0.5 + 0.005 + 0.02;
  assert(close(requestCostUsd({ ...SOL, contextTiers: [] }, big), base), "no tier = base rates");
}

process.stdout.write("\n[8] the threshold is strict and per request\n");
{
  const at = requestCostUsd(SOL, { inputTokens: 272_000, outputTokens: 0 });
  const over = requestCostUsd(SOL, { inputTokens: 272_001, outputTokens: 0 });
  assert(close(at, 0.544), `272,000 input tokens pay the base rate (got $${at})`);
  assert(close(over, 1.088004), `272,001 input tokens pay the tier rate (got $${over})`);
}

process.stdout.write("\n[9] harness prices each step, not the summed total\n");
{
  // A worker tool loop with two 200k-token steps. No single request is
  // above 272k, so no request pays the tier, though the sum (400k) is.
  const step = { inputTokens: 200_000, outputTokens: 1_000 };
  const usage = { sonnet: { inputTokens: 400_000, outputTokens: 2_000 } };
  const prices = { opus: SOL, sonnet: SOL, haiku: SOL };
  const perStep = priceRequestsByTier(usage, { opus: [], sonnet: [step, step], haiku: [] }, prices);
  assert(close(perStep.costUsd, 0.82), `two 200k steps cost $0.82 (got $${perStep.costUsd})`);
  const asOne = requestCostUsd(SOL, usage.sonnet);
  assert(close(asOne, 1.63), `pricing the sum as one request would say $1.63 (got $${asOne})`);
  assert(perStep.costByTier.sonnet === 0.82, "costByTier carries the per-step sum");
  assert(perStep.costByTier.opus === undefined, "no block, no tier entry");

  // A boss with one long step and one short step: only the long one pays more.
  const mixed = priceRequestsByTier(
    { opus: { inputTokens: 400_000, outputTokens: 2_000 } },
    {
      opus: [
        { inputTokens: 300_000, outputTokens: 1_000 },
        { inputTokens: 100_000, outputTokens: 1_000 },
      ],
      sonnet: [],
      haiku: [],
    },
    prices,
  );
  // 300k x $4 + 1k x $15 = 1.215; 100k x $2 + 1k x $10 = 0.21.
  assert(close(mixed.costUsd, 1.425), `mixed steps cost $1.425 (got $${mixed.costUsd})`);
}

process.stdout.write("\n[10] models.dev catalog: tiers parse, bad entries skip\n");
{
  const MODEL = {
    provider: "openai",
    modelId: "gpt-6.1-sol",
    label: "gpt-6.1-sol high",
    fallbackPricePerMillionTokens: {
      input: 99,
      output: 199,
      cachedInput: 9,
      cacheWriteInput: 12,
      contextTiers: [
        { aboveInputTokens: 1, rates: { input: 1, output: 1, cachedInput: 1, cacheWriteInput: 1 } },
      ],
    },
  } satisfies ResolvedLlmModel;
  const originalFetch = globalThis.fetch;
  try {
    _resetModelCatalogCacheForTests();
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          openai: {
            models: {
              "gpt-6.1-sol": {
                id: "gpt-6.1-sol",
                cost: {
                  input: 2,
                  output: 10,
                  cache_read: 0.1,
                  cache_write: 2.5,
                  tiers: [
                    "not a tier",
                    { input: 9, output: 9, tier: { type: "batch", size: 1 } },
                    {
                      input: 4,
                      output: 15,
                      cache_read: 0.2,
                      cache_write: 5,
                      tier: { type: "context", size: 272000 },
                    },
                  ],
                },
              },
              "gpt-odd": { id: "gpt-odd", cost: { input: 1, output: 2, tiers: { not: "array" } } },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const price = await modelCatalogPrice(MODEL);
    assert(price.input === 2, "catalog base price used (the catalog parsed)");
    const tiers = price.contextTiers ?? [];
    assert(
      tiers.length === 1,
      `one context tier kept, bad and non-context skipped (got ${tiers.length})`,
    );
    assert(tiers[0]?.aboveInputTokens === 272_000, "tier threshold is 272000");
    assert(
      tiers[0]?.rates.input === 4 &&
        tiers[0].rates.output === 15 &&
        tiers[0].rates.cachedInput === 0.2 &&
        tiers[0].rates.cacheWriteInput === 5,
      "tier rates are $4 / $15 / $0.20 / $5",
    );

    _resetModelCatalogCacheForTests();
    globalThis.fetch = async () => new Response("down", { status: 503 });
    const fallback = await modelCatalogPrice(MODEL);
    assert(fallback.contextTiers?.length === 1, "unreachable catalog keeps the fallback tiers");
  } finally {
    globalThis.fetch = originalFetch;
    _resetModelCatalogCacheForTests();
  }
}

if (failed > 0) {
  process.stdout.write(`\n${failed} assertion(s) failed\n`);
  process.exit(1);
}
process.stdout.write("\n✓ smoke-cost-gaps passed\n");
