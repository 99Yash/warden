/**
 * Smoke for ADR-0048 observability wiring (issue #32).
 *
 * Two deterministic, zero-LLM, zero-network assertions:
 *
 *  A. **Keys-absent = total no-op (§7).** With `LANGFUSE_PUBLIC_KEY` /
 *     `LANGFUSE_SECRET_KEY` unset, `isObservabilityEnabled()` is false,
 *     `buildReviewTelemetry()` returns `{ isEnabled: false }` (the AI SDK
 *     ignores it — the call path is unchanged), and `recordDroppedCandidate()`
 *     + `shutdownObservability()` are safe no-ops that never throw. This is the
 *     property that guarantees a key-less CI/dev run pays nothing.
 *
 *  B. **`reviewRuns` round-trips (§2).** The migration applied and the split
 *     key persists: insert a row with a `createId("run")` id + content
 *     `inputHash`, read it back, and assert both columns survive. Proves the
 *     substrate issue #33 (resume off `inputHash`) builds on.
 *
 * The live OTEL→Langfuse export path (keys present + a running Docker stack)
 * is NOT covered here — it needs the stack + a real paid review and is the
 * ADR's own "verify with a real review" acceptance step.
 *
 * Usage:
 *   pnpm --filter @warden/cli smoke:adr-0048-observability
 */

import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const TMP_DB = resolve(tmpdir(), `warden-adr-0048-${process.pid}.sqlite`);
process.env["WARDEN_CACHE_PATH"] = TMP_DB;
// Force the no-op path regardless of the developer's local .env.
delete process.env["LANGFUSE_PUBLIC_KEY"];
delete process.env["LANGFUSE_SECRET_KEY"];

if (existsSync(TMP_DB)) unlinkSync(TMP_DB);

let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) {
    process.stdout.write(`  ✓ ${msg}\n`);
  } else {
    process.stdout.write(`  ✗ ${msg}\n`);
    failed++;
  }
}

const { isObservabilityEnabled, buildReviewTelemetry, recordDroppedCandidate, shutdownObservability } =
  await import("@warden/ai");

process.stdout.write("A. keys-absent = total no-op\n");
assert(isObservabilityEnabled() === false, "isObservabilityEnabled() is false without keys");

const bossTel = buildReviewTelemetry({ runId: "run_smoke", role: "boss" });
assert(bossTel.isEnabled === false, "buildReviewTelemetry(boss) returns { isEnabled: false }");
assert(
  bossTel.metadata === undefined && bossTel.functionId === undefined,
  "disabled telemetry carries no metadata/functionId (AI SDK ignores it)",
);

const workerTel = buildReviewTelemetry({
  runId: "run_smoke",
  role: "worker",
  concern: "correctness",
  tier: "sonnet",
  file: "src/foo.ts",
});
assert(workerTel.isEnabled === false, "buildReviewTelemetry(worker) returns { isEnabled: false }");

let threw = false;
try {
  recordDroppedCandidate("lane", { "warden.count": 3 });
  recordDroppedCandidate("uncited");
} catch {
  threw = true;
}
assert(threw === false, "recordDroppedCandidate() is a no-op (no throw) without keys / active span");

await shutdownObservability();
assert(true, "shutdownObservability() resolves without keys (no-op)");

process.stdout.write("\nB. reviewRuns round-trips\n");
const { db, reviewRuns, createId, eq } = await import("@warden/db");
const runId = createId("run");
const inputHash = "a".repeat(64);
db()
  .insert(reviewRuns)
  .values({
    id: runId,
    inputHash,
    mode: "review",
    modelBoss: "claude-opus-4-8",
    modelWorkerStrong: "claude-sonnet-4-6",
    modelWorkerCheap: "claude-haiku-4-5",
    inputTokens: 1234,
    outputTokens: 567,
    costUsd: 0.42,
    commentsEmitted: 2,
  })
  .run();

const rows = db().select().from(reviewRuns).where(eq(reviewRuns.id, runId)).all();
assert(rows.length === 1, "inserted review-run row reads back");
assert(rows[0]?.id === runId, "id (createId('run')) survives round-trip");
assert(rows[0]?.inputHash === inputHash, "inputHash (split-key) survives round-trip");
assert(rows[0]?.mode === "review", "mode column persists");
assert(rows[0]?.commentsEmitted === 2, "commentsEmitted persists");

if (existsSync(TMP_DB)) unlinkSync(TMP_DB);

process.stdout.write(failed === 0 ? "\nPASS\n" : `\nFAIL (${failed})\n`);
process.exit(failed === 0 ? 0 : 1);
