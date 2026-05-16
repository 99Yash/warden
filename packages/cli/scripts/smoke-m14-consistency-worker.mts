/**
 * Smoke for the M14 consistency worker (Sonnet tier). Plants an
 * unambiguous JSDoc-vs-impl drift: docstring promises an async Promise
 * return, the function returns synchronously. Asserts deterministic
 * facets per the M14 plan §Q3.
 *
 * Skip semantics + assertion shape mirror smoke-m14-correctness-worker.mts.
 *
 * Usage:
 *   pnpm --filter @warden/cli smoke:m14-consistency-worker
 */

import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const TMP_ROOT = resolve(tmpdir(), `warden-m14-consistency-${process.pid}`);
const TMP_DB = resolve(tmpdir(), `warden-m14-consistency-${process.pid}.sqlite`);
process.env["WARDEN_CACHE_PATH"] = TMP_DB;

if (existsSync(TMP_DB)) unlinkSync(TMP_DB);
if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });
mkdirSync(resolve(TMP_ROOT, "src"), { recursive: true });
writeFileSync(
  resolve(TMP_ROOT, "package.json"),
  JSON.stringify({ name: "smoke-fixture", version: "0.0.0", private: true }, null, 2),
);

const FIXTURE_PATH = "src/user.ts";
const FIXTURE_CONTENT = [
  `interface User { id: string; name: string }`,
  ``,
  `/**`,
  ` * Asynchronously fetches the user's display name from the auth service.`,
  ` * Returns a Promise that resolves to the display name string.`,
  ` */`,
  `export function getDisplayName(user: User): string {`,
  `  return user.name;`,
  `}`,
  ``,
].join("\n");
writeFileSync(resolve(TMP_ROOT, FIXTURE_PATH), FIXTURE_CONTENT);

const hasKey =
  typeof process.env["ANTHROPIC_API_KEY"] === "string" &&
  process.env["ANTHROPIC_API_KEY"].length > 0;
if (!hasKey) {
  process.stdout.write(`\n[skip] ANTHROPIC_API_KEY not set\n`);
  if (existsSync(TMP_DB)) unlinkSync(TMP_DB);
  if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });
  process.exit(2);
}

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

process.stdout.write(`\n[1] consistency worker catches doc vs impl drift\n`);

const apiClaimDegraded: import("@warden/core").DegradedEntry[] = [];
const route = makeWorkerRoute({
  repoRoot: TMP_ROOT,
  changed: [{ path: FIXTURE_PATH, addedLines: [1, 2, 3, 4, 5, 6, 7, 8, 9] }],
  apiClaimDegraded,
});

const result = await route({
  repoRoot: TMP_ROOT,
  files: [FIXTURE_PATH],
  concern: "consistency",
  phase: "plan",
  focus: "Does the JSDoc match the implementation?",
});

process.stdout.write(
  `  → worker emitted ${result.findings.length} finding(s) in ${result.durationMs}ms (${result.toolCalls} tool call(s))\n`,
);
for (const f of result.findings) {
  const summary = f.claim.length > 100 ? f.claim.slice(0, 100) + "…" : f.claim;
  process.stdout.write(`    [${f.category}/${f.kind}/T${f.tier}] ${f.file}:${f.lineStart} — ${summary}\n`);
}

assert(result.findings.length >= 1, `worker returned ≥1 finding`);

const ourCat = result.findings.filter((f) => f.category === "consistency");
assert(ourCat.length >= 1, `≥1 finding has category="consistency" (got ${ourCat.length})`);

const fileMatched = result.findings.filter((f) => f.file === FIXTURE_PATH);
assert(
  fileMatched.length === result.findings.length,
  `every finding's file equals fixture path`,
);

const inLineRange = result.findings.filter((f) => f.lineStart >= 1 && f.lineStart <= 10);
assert(
  inLineRange.length === result.findings.length,
  `every finding's lineStart ∈ [1,10]`,
);

for (const f of result.findings) {
  assert(f.kind === "assertion" || f.kind === "question", `kind ∈ {assertion,question} for ${f.id}`);
  assert(f.sources.length > 0, `${f.id} carries ≥1 source`);
  for (const s of f.sources) {
    assert(s.type === "tool" || s.type === "api_def", `${f.id} source.type ∈ {tool,api_def}`);
  }
}

const softKeywords = ["jsdoc", "doc", "promise", "async", "sync", "comment", "drift", "mismatch", "returns"];
const softHit = result.findings.some((f) =>
  softKeywords.some((kw) => f.claim.toLowerCase().includes(kw)),
);
process.stdout.write(
  `  ${softHit ? "✓" : "·"} soft: at least one claim mentions a consistency-adjacent keyword\n`,
);

const laneDrops = result.degraded.filter((d) => d.topic === "review-harness");
assert(laneDrops.length === 0, `no lane-drop entries`);

if (existsSync(TMP_DB)) unlinkSync(TMP_DB);
if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });

if (failed > 0) {
  process.stdout.write(`\n${failed} assertion(s) failed\n`);
  process.exit(1);
}
process.stdout.write(`\nall assertions passed\n`);
