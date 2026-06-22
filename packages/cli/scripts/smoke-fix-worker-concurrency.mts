/**
 * Smoke for the `fix/worker-concurrency` bundle (ADR-0033). Validates the
 * per-tier dispatch concurrency cap at three layers, none of which need a
 * live LLM or any API keys:
 *
 *   [1] Direct Semaphore — N=5 acquires × 100ms × cap=2 finishes near
 *       `Math.ceil(5/2) × 100ms = 300ms` wall-clock.
 *   [2] Per-tier isolation — strong-tier saturation does NOT block cheap-
 *       tier acquires. 4 strong + 1 cheap in parallel, strong cap=2: the
 *       cheap acquire returns at ~100ms (one batch), not ~300ms (would
 *       happen if the tiers shared a single slot pool).
 *   [3] Dispatch-tool integration — stubbed route, 6 dispatches against
 *       `makeDispatchWorkerTool({ concurrency })` with strong cap=2,
 *       asserts `scratchpad.concurrencyAggregate().totalQueued === 4`
 *       (6 − 2) and the wall-clock matches the ceil-division formula.
 *
 * Timing assertions tolerate ±50ms slack — node's `setTimeout` drifts
 * under CI load. ADR-0033 §Caveats allows up to ±50ms before earning a
 * different timing primitive; we start there.
 *
 * Usage:
 *   pnpm --filter @warden/cli smoke:fix-worker-concurrency
 */

import { Semaphore } from "@warden/core/orchestration/semaphore";
import { ReviewScratchpad } from "@warden/core/review-harness/scratchpad";
import {
  makeDispatchWorkerTool,
  type WorkerInvocation,
  type WorkerInvocationResult,
} from "@warden/core/review-harness/tools/dispatch-worker";

const SLOT_MS = 100;
const SLACK_MS = 50;

let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) {
    process.stdout.write(`  ✓ ${msg}\n`);
  } else {
    process.stdout.write(`  ✗ ${msg}\n`);
    failed += 1;
  }
}

function near(actual: number, expected: number, slack: number): boolean {
  return Math.abs(actual - expected) <= slack;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// [1] Direct semaphore — 5 acquires × cap=2 × SLOT_MS each.
// ---------------------------------------------------------------------------

process.stdout.write(`\n[1] Semaphore N=5 cap=2 batches sequentially\n`);
{
  const sem = new Semaphore(2);
  const N = 5;
  const start = Date.now();
  await Promise.all(
    Array.from({ length: N }, async () => {
      const { release } = await sem.acquire();
      try {
        await sleep(SLOT_MS);
      } finally {
        release();
      }
    }),
  );
  const elapsed = Date.now() - start;
  const expected = Math.ceil(N / 2) * SLOT_MS; // 3 batches × 100ms = 300ms
  assert(
    near(elapsed, expected, SLACK_MS),
    `wall-clock ${elapsed}ms near ${expected}ms (±${SLACK_MS}ms)`,
  );
}

// ---------------------------------------------------------------------------
// [2] Per-tier isolation — strong saturation doesn't block cheap.
// ---------------------------------------------------------------------------

process.stdout.write(`\n[2] Strong-cap saturation does not delay cheap acquires\n`);
{
  const strong = new Semaphore(2);
  const cheap = new Semaphore(2);
  const cheapAcquiredAt: number[] = [];
  const start = Date.now();
  await Promise.all([
    // 4 strong workers — would take 2 batches × 100ms = 200ms on its own.
    ...Array.from({ length: 4 }, async () => {
      const { release } = await strong.acquire();
      try {
        await sleep(SLOT_MS);
      } finally {
        release();
      }
    }),
    // 1 cheap worker — must clear immediately (cheap pool is unsaturated).
    (async () => {
      const { release } = await cheap.acquire();
      cheapAcquiredAt.push(Date.now() - start);
      try {
        await sleep(SLOT_MS);
      } finally {
        release();
      }
    })(),
  ]);
  assert(
    cheapAcquiredAt.length === 1 && cheapAcquiredAt[0]! < SLOT_MS,
    `cheap acquire happened at ${cheapAcquiredAt[0]}ms (< ${SLOT_MS}ms)`,
  );
}

// ---------------------------------------------------------------------------
// [3] Dispatch tool integration — stubbed route, scratchpad totals match.
// ---------------------------------------------------------------------------

process.stdout.write(`\n[3] makeDispatchWorkerTool wires the semaphore + scratchpad correctly\n`);
{
  const strong = new Semaphore(2);
  const cheap = new Semaphore(8); // intentionally loose — only strong should engage
  const scratchpad = new ReviewScratchpad();

  let routeCalls = 0;
  const route = async (_invocation: WorkerInvocation): Promise<WorkerInvocationResult> => {
    routeCalls += 1;
    await sleep(SLOT_MS);
    return {
      findings: [],
      toolCalls: 0,
      degraded: [],
      durationMs: SLOT_MS,
      tier: "sonnet",
    };
  };

  const handle = makeDispatchWorkerTool({
    repoRoot: "/tmp/fake-root",
    scratchpad,
    route,
    concurrency: { strong, cheap },
  });

  const N = 6;
  const start = Date.now();
  await Promise.all(
    Array.from({ length: N }, () =>
      handle.dispatch({
        files: ["src/fake.ts"],
        concern: "correctness", // → resolves to "sonnet" tier → strong pool
        phase: "plan",
      }),
    ),
  );
  const elapsed = Date.now() - start;
  const expected = Math.ceil(N / 2) * SLOT_MS;

  assert(routeCalls === N, `route invoked once per dispatch (${routeCalls}/${N})`);
  assert(
    near(elapsed, expected, SLACK_MS),
    `dispatch wall-clock ${elapsed}ms near ${expected}ms (±${SLACK_MS}ms)`,
  );

  const agg = scratchpad.concurrencyAggregate();
  assert(agg !== null, "concurrencyAggregate is non-null when the cap engaged");
  if (agg !== null) {
    assert(agg.totalDispatches === N, `totalDispatches === ${N} (got ${agg.totalDispatches})`);
    assert(
      agg.totalQueued === Math.max(N - 2, 0),
      `totalQueued === max(N-cap, 0) = ${Math.max(N - 2, 0)} (got ${agg.totalQueued})`,
    );
    assert(
      agg.maxWaitMs > 0 && agg.maxWaitMs <= expected,
      `maxWaitMs in (0, ${expected}] (got ${agg.maxWaitMs})`,
    );
    assert(
      agg.totalQueuedMs >= agg.maxWaitMs,
      `totalQueuedMs >= maxWaitMs (${agg.totalQueuedMs} ≥ ${agg.maxWaitMs})`,
    );
  }
}

// ---------------------------------------------------------------------------
// [4] Aggregate is null on the happy path (no queueing).
// ---------------------------------------------------------------------------

process.stdout.write(`\n[4] Aggregate stays null when the cap never engages\n`);
{
  const strong = new Semaphore(8); // generous — no dispatch should queue
  const cheap = new Semaphore(8);
  const scratchpad = new ReviewScratchpad();

  const route = async (_invocation: WorkerInvocation): Promise<WorkerInvocationResult> => {
    await sleep(20);
    return {
      findings: [],
      toolCalls: 0,
      degraded: [],
      durationMs: 20,
      tier: "haiku",
    };
  };

  const handle = makeDispatchWorkerTool({
    repoRoot: "/tmp/fake-root",
    scratchpad,
    route,
    concurrency: { strong, cheap },
  });

  await Promise.all(
    Array.from({ length: 3 }, () =>
      handle.dispatch({
        files: ["src/fake.ts"],
        concern: "leverage", // → resolves to "haiku"
        phase: "plan",
      }),
    ),
  );

  const agg = scratchpad.concurrencyAggregate();
  assert(agg === null, `concurrencyAggregate is null on happy path (got ${JSON.stringify(agg)})`);
}

// ---------------------------------------------------------------------------
// [5] Semaphore rejects invalid maxConcurrent.
// ---------------------------------------------------------------------------

process.stdout.write(`\n[5] Semaphore constructor rejects 0 and negatives\n`);
{
  let threwOnZero = false;
  try {
    new Semaphore(0);
  } catch {
    threwOnZero = true;
  }
  assert(threwOnZero, "Semaphore(0) throws");

  let threwOnNeg = false;
  try {
    new Semaphore(-1);
  } catch {
    threwOnNeg = true;
  }
  assert(threwOnNeg, "Semaphore(-1) throws");

  let threwOnFloat = false;
  try {
    new Semaphore(1.5);
  } catch {
    threwOnFloat = true;
  }
  assert(threwOnFloat, "Semaphore(1.5) throws (must be integer)");
}

if (failed > 0) {
  process.stdout.write(`\n${failed} assertion(s) failed\n`);
  process.exit(1);
}
process.stdout.write(`\nall assertions passed\n`);
