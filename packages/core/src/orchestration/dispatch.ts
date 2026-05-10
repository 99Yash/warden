import { performance } from "node:perf_hooks";
import type { Runner, RunnerInput, RunnerOutput } from "./runner.js";
import type { Scratchpad } from "./scratchpad.js";

/**
 * Parallel runner invocation (ADR-0023 #9). Each runner runs concurrently
 * via `Promise.all`; per-runner failures land in `RunnerOutput.error?` plus
 * a `degraded` warning entry naming the runner. The rest of the review is
 * unaffected — same posture as M4's per-worker degraded-channel pattern.
 *
 * The dispatcher overrides `durationMs` so a runner can't accidentally
 * report a clock that doesn't match the wall-clock time the dispatcher
 * actually waited.
 */
export async function dispatch(
  runners: Runner[],
  input: RunnerInput,
  scratchpad: Scratchpad,
): Promise<void> {
  const outputs = await Promise.all(runners.map((runner) => invokeOne(runner, input)));
  for (const output of outputs) {
    scratchpad.record(output);
  }
}

async function invokeOne(runner: Runner, input: RunnerInput): Promise<RunnerOutput> {
  const start = performance.now();
  try {
    const result = await runner.run(input);
    return { ...result, name: runner.name, durationMs: performance.now() - start };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    return {
      name: runner.name,
      findings: [],
      degraded: [
        {
          kind: "warning",
          topic: runner.name,
          message: `${runner.name}: runner failed (${error.message.slice(0, 160)})`,
        },
      ],
      durationMs: performance.now() - start,
      error,
    };
  }
}
