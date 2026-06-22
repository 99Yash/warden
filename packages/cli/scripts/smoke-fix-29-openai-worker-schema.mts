/**
 * Smoke for issue #29 — OpenAI worker path must not 400 on the worker output
 * schema (and must not silently false-clean when it does).
 *
 * Before the fix, with `OPENAI_API_KEY` set the worker routes to gpt-5.4-mini,
 * and `streamText({ output: Output.object(...) })` 400s with:
 *   `Invalid schema for response_format 'response': ... 'required' is required
 *    to be supplied ... Missing 'url'.`
 * OpenAI strict structured-output requires every property to appear in
 * `required`; our shared `SourceSchema` carries optional fields. Every worker
 * then errors, the boss emits an empty review, and the CLI false-cleans.
 *
 * The fix sets `providerOptions.openai.strictJsonSchema: false` on the OpenAI
 * worker model (`packages/ai/src/models.ts`), so the request schema is
 * guidance and our own zod parse still validates the response.
 *
 * This smoke plants an unambiguous off-by-one bug, forces the OpenAI worker
 * path, dispatches the correctness worker, and asserts:
 *   - the resolved worker provider is `openai` (we're exercising the buggy path),
 *   - the worker did NOT fail (`result.failed !== true`) — i.e. no schema 400,
 *   - findings (if any) carry the expected shape.
 *
 * Skips cleanly with `process.exit(2)` when OPENAI_API_KEY is unavailable.
 *
 * Usage:
 *   pnpm --filter @warden/cli smoke:fix-29-openai-worker-schema
 */

import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

// Self-contained env load: pull the two LLM keys from the repo `.env` into
// `process.env` when the shell hasn't already exported them, so the smoke is
// runnable via `pnpm smoke:...` without a manual `export`. Mirrors how the
// existing worker smokes expect keys on `process.env`.
function hydrateKeysFromEnvFile(): void {
  const envPath = resolve(process.cwd(), ".env");
  // cwd is packages/cli under pnpm --filter; walk up to the repo root .env.
  const candidates = [envPath, resolve(process.cwd(), "../../.env")];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    const text = readFileSync(p, "utf8");
    for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]) {
      if (process.env[key]) continue;
      const m = text.match(new RegExp(`^${key}=(.+)$`, "m"));
      if (m?.[1]) process.env[key] = m[1].trim();
    }
  }
}
hydrateKeysFromEnvFile();

const TMP_ROOT = resolve(tmpdir(), `warden-fix29-${process.pid}`);
const TMP_DB = resolve(tmpdir(), `warden-fix29-${process.pid}.sqlite`);
process.env["WARDEN_CACHE_PATH"] = TMP_DB;

if (existsSync(TMP_DB)) unlinkSync(TMP_DB);
if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });
mkdirSync(resolve(TMP_ROOT, "src"), { recursive: true });

writeFileSync(
  resolve(TMP_ROOT, "package.json"),
  JSON.stringify({ name: "smoke-fixture", version: "0.0.0", private: true }, null, 2),
);

const FIXTURE_PATH = "src/last-item.ts";
const FIXTURE_CONTENT = [
  `export function lastItem<T>(arr: T[]): T {`,
  `  // Returns the final element of \`arr\`.`,
  `  // BUG: accesses arr[arr.length] (undefined) instead of arr[arr.length - 1].`,
  `  return arr[arr.length] as T;`,
  `}`,
  ``,
].join("\n");
writeFileSync(resolve(TMP_ROOT, FIXTURE_PATH), FIXTURE_CONTENT);

function cleanup(): void {
  if (existsSync(TMP_DB)) unlinkSync(TMP_DB);
  if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });
}

const hasOpenAI =
  typeof process.env["OPENAI_API_KEY"] === "string" && process.env["OPENAI_API_KEY"].length > 0;
if (!hasOpenAI) {
  process.stdout.write(`\n[skip] OPENAI_API_KEY not set — this smoke verifies the OpenAI path\n`);
  cleanup();
  process.exit(2);
}

const { getWorkerStrongModelInfo } = await import("@warden/ai");
const { makeWorkerRoute } = await import("@warden/core/review-harness/workers/dispatch");

let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) {
    process.stdout.write(`  ✓ ${msg}\n`);
  } else {
    process.stdout.write(`  ✗ ${msg}\n`);
    failed++;
  }
}

process.stdout.write(`\n[1] OpenAI worker path does not 400 on the output schema (issue #29)\n`);

// Confirm we're actually exercising the OpenAI worker path. With both keys
// present, workerStrong prefers OpenAI (gpt-5.4-mini) — the path that 400s
// pre-fix.
const info = getWorkerStrongModelInfo();
process.stdout.write(`  → worker model resolved to ${info.provider} / ${info.modelId}\n`);
assert(info.provider === "openai", `worker provider is openai (got ${info.provider})`);

const apiClaimDegraded: import("@warden/core").DegradedEntry[] = [];
const route = makeWorkerRoute({
  repoRoot: TMP_ROOT,
  changed: [{ path: FIXTURE_PATH, addedLines: [1, 2, 3, 4, 5] }],
  apiClaimDegraded,
});

const result = await route({
  repoRoot: TMP_ROOT,
  files: [FIXTURE_PATH],
  concern: "correctness",
  phase: "plan",
  focus: "Does this off-by-one access produce undefined?",
});

process.stdout.write(
  `  → worker emitted ${result.findings.length} finding(s) in ${result.durationMs}ms ` +
    `(${result.toolCalls} tool call(s)); failed=${result.failed === true}\n`,
);
for (const d of result.degraded) {
  process.stdout.write(`    degraded[${d.kind}/${d.topic}] ${d.message}\n`);
}

// The core assertion: the worker LLM call completed. Pre-fix it 400s on the
// schema, returns no findings, and marks failed=true.
assert(result.failed !== true, `worker did NOT fail on the output schema`);

// No worker-failure warning entry should be present (the 400 surfaces as a
// `warning`-kind entry whose message names the schema rejection).
const failureEntries = result.degraded.filter(
  (d) => d.kind === "warning" && d.topic.startsWith("worker-"),
);
assert(failureEntries.length === 0, `no worker-failure degraded entries (got ${failureEntries.length})`);

// If the worker found something (it usually does on this fixture), the shape
// should still validate — proving the schema round-tripped under strict:false.
for (const f of result.findings) {
  assert(f.file === FIXTURE_PATH, `finding file equals fixture path (got ${f.file})`);
  assert(f.sources.length > 0, `${f.id} carries ≥1 source`);
}

cleanup();

if (failed > 0) {
  process.stdout.write(`\n${failed} assertion(s) failed\n`);
  process.exit(1);
}
process.stdout.write(`\nall assertions passed\n`);
