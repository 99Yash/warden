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
 * Offline: mock models only, no network, no paid call.
 *
 * Usage: pnpm --filter @warden/cli smoke:cost-gaps
 */

import { tool } from "@warden/ai";
import { MockLanguageModelV3 } from "@warden/ai/test";
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

if (failed > 0) {
  process.stdout.write(`\n${failed} assertion(s) failed\n`);
  process.exit(1);
}
process.stdout.write("\n✓ smoke-cost-gaps passed\n");
