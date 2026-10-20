/**
 * Offline smoke for the boss final-step submit (`makeBossPrepareStep` in
 * `boss-loop.ts`).
 *
 * The bug: the boss loop stops on `stepCountIs(stepCap)`. A boss that
 * dispatched a worker in its last allowed step never called
 * `submit_review`, and the review failed. The fix makes the last allowed
 * step a submit step: only `submit_review` is sent, and a final-step
 * instruction is appended.
 *
 * `runBossLoop()` builds its model from `getBossModel()` and takes no model
 * argument, so this smoke checks two things:
 *   [1-2] the hook as a pure function (step numbers, meter calls);
 *   [3-4] the hook inside a real `streamText` loop with a mock model and the
 *         same `stopWhen` as the boss. This proves that the AI SDK sends only
 *         `submit_review` on the last step, that the tool result of the step
 *         before is in the last-step prompt, and that `CallUsageMeter` still
 *         counts every request.
 *
 * Offline: mock models only, no network, no paid call.
 *
 * Usage: pnpm --filter @warden/cli smoke:boss-final-step
 */

import { hasToolCall, stepCountIs, streamText, tool, type ModelMessage } from "@warden/ai";
import { MockLanguageModelV3 } from "@warden/ai/test";
import {
  BOSS_FINAL_STEP_INSTRUCTION,
  makeBossPrepareStep,
} from "@warden/core/review-harness/boss-loop";
import { CallUsageMeter } from "@warden/core/review-harness/scratchpad";
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

const SEED: ModelMessage[] = [{ role: "user", content: "review this diff" }];

// ---------------------------------------------------------------------------
// [1-2] The hook as a pure function.
// ---------------------------------------------------------------------------

process.stdout.write("\n[1] stepCap=5: steps 0-3 have no override, step 4 is the submit step\n");
{
  let meterCalls = 0;
  const hook = makeBossPrepareStep({
    stepCap: 5,
    meter: {
      prepareStep: () => {
        meterCalls++;
        return undefined;
      },
    },
  });
  const early = [0, 1, 2, 3].map((stepNumber) => hook({ stepNumber, messages: SEED }));
  assert(
    early.every((r) => r === undefined),
    "steps 0-3 return undefined (all tools, no extra message)",
  );
  const last = hook({ stepNumber: 4, messages: SEED });
  assert(
    last?.activeTools.length === 1 && last.activeTools[0] === "submit_review",
    "step 4 sends only submit_review",
  );
  assert(last?.messages.length === SEED.length + 1, "step 4 appends one message");
  const appended = last?.messages.at(-1);
  assert(
    appended?.role === "user" && appended.content === BOSS_FINAL_STEP_INSTRUCTION,
    "the appended message is the final-step instruction",
  );
  assert(SEED.length === 1, "the input messages array is not mutated");
  assert(meterCalls === 5, `meter.prepareStep runs on every step (got ${meterCalls})`);
}

process.stdout.write("\n[2] stepCap=1: the first step is the submit step\n");
{
  const hook = makeBossPrepareStep({ stepCap: 1, meter: new CallUsageMeter() });
  const first = hook({ stepNumber: 0, messages: SEED });
  assert(first?.activeTools.join(",") === "submit_review", "step 0 sends only submit_review");
}

// ---------------------------------------------------------------------------
// [3-4] The hook inside a real streamText loop.
// ---------------------------------------------------------------------------

type DoStream = MockLanguageModelV3["doStream"];
type DoStreamOptions = Parameters<DoStream>[0];
type StreamResult = Awaited<ReturnType<DoStream>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer P> ? P : never;

function toolCallStream(toolCallId: string, toolName: string, input: string): StreamResult {
  const parts: StreamPart[] = [
    { type: "stream-start", warnings: [] },
    { type: "tool-call", toolCallId, toolName, input },
    {
      type: "finish",
      finishReason: { unified: "tool-calls", raw: "tool_use" },
      usage: {
        inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: undefined },
        outputTokens: { total: 10, text: 10, reasoning: undefined },
      },
    },
  ];
  return {
    stream: new ReadableStream<StreamPart>({
      start(controller) {
        for (const p of parts) controller.enqueue(p);
        controller.close();
      },
    }),
  };
}

const WORKER_MARKER = "WORKER-RESULT-MARKER-7f3a";

interface LoopRun {
  calls: { toolNames: string[]; prompt: string }[];
  submitted: unknown;
  dispatches: number;
  meter: CallUsageMeter;
}

/**
 * Run the boss tool wiring (`dispatch_worker` + `submit_review`, the boss
 * `stopWhen`, the boss `prepareStep`) against a mock model. The model calls
 * `dispatch_worker` while that tool is offered, and `submit_review` when it
 * is the only tool.
 */
async function runLoop(stepCap: number): Promise<LoopRun> {
  const run: LoopRun = {
    calls: [],
    submitted: undefined,
    dispatches: 0,
    meter: new CallUsageMeter(),
  };
  const model = new MockLanguageModelV3({
    provider: "stub",
    modelId: "boss-final-step",
    doStream: async (options: DoStreamOptions) => {
      const toolNames = (options.tools ?? []).map((t) => t.name);
      run.calls.push({ toolNames, prompt: JSON.stringify(options.prompt) });
      const n = run.calls.length;
      if (toolNames.includes("dispatch_worker")) {
        return toolCallStream(
          `call-${n}`,
          "dispatch_worker",
          JSON.stringify({ files: ["src/a.ts"], concern: "correctness" }),
        );
      }
      return toolCallStream(`call-${n}`, "submit_review", JSON.stringify({ comments: [] }));
    },
  });

  const result = streamText({
    model,
    system: "stub boss",
    prompt: "review this diff",
    tools: {
      dispatch_worker: tool({
        description: "stub dispatch",
        inputSchema: z.object({ files: z.array(z.string()), concern: z.string() }),
        execute: () => {
          run.dispatches++;
          return { findings: [{ claim: WORKER_MARKER }] };
        },
      }),
      submit_review: tool({
        description: "stub submit",
        inputSchema: z.object({ comments: z.array(z.unknown()) }),
        execute: (args) => {
          run.submitted = args;
          return { received: args.comments.length };
        },
      }),
    },
    stopWhen: [stepCountIs(stepCap), hasToolCall("submit_review")],
    prepareStep: makeBossPrepareStep({ stepCap, meter: run.meter }),
    onStepFinish: run.meter.onStepFinish,
  });
  for await (const part of result.fullStream) {
    if (part.type === "error") throw part.error;
  }
  return run;
}

process.stdout.write("\n[3] stepCap=2: a dispatch on step 0, then a submit-only step\n");
{
  const run = await runLoop(2);
  assert(run.calls.length === 2, `two model requests (got ${run.calls.length})`);
  assert(
    run.calls[0]?.toolNames.join(",") === "dispatch_worker,submit_review",
    `step 0 offers both tools (got ${run.calls[0]?.toolNames.join(",")})`,
  );
  assert(
    run.calls[1]?.toolNames.join(",") === "submit_review",
    `step 1 offers only submit_review (got ${run.calls[1]?.toolNames.join(",")})`,
  );
  assert(run.dispatches === 1, `the worker ran once (got ${run.dispatches})`);
  assert(
    run.calls[1]?.prompt.includes(WORKER_MARKER) === true,
    "the step-0 worker result is in the step-1 prompt",
  );
  assert(
    run.calls[1]?.prompt.includes("<final_step>") === true,
    "the final-step instruction is in the step-1 prompt",
  );
  assert(
    run.calls[0]?.prompt.includes("<final_step>") === false,
    "the final-step instruction is not in the step-0 prompt",
  );
  assert(run.submitted !== undefined, "submit_review was called");
  const usage = run.meter.snapshot();
  assert(usage.requests.length === 2, `meter recorded 2 requests (got ${usage.requests.length})`);
  assert(
    usage.unknownRequests === 0,
    `meter has 0 unknown requests (got ${usage.unknownRequests})`,
  );
}

process.stdout.write("\n[4] stepCap=1: the only step is the submit step\n");
{
  const run = await runLoop(1);
  assert(run.calls.length === 1, `one model request (got ${run.calls.length})`);
  assert(
    run.calls[0]?.toolNames.join(",") === "submit_review",
    `step 0 offers only submit_review (got ${run.calls[0]?.toolNames.join(",")})`,
  );
  assert(run.dispatches === 0, `no worker ran (got ${run.dispatches})`);
  assert(run.submitted !== undefined, "submit_review was called");
  assert(run.meter.snapshot().requests.length === 1, "meter recorded 1 request");
}

if (failed > 0) {
  process.stdout.write(`\n${failed} assertion(s) failed\n`);
  process.exit(1);
}
process.stdout.write(`\nall assertions passed\n`);
