/**
 * Smoke for the M14 committability worker (Haiku tier). Plants a
 * conspicuous "should not have been committed" signal: a file named
 * `debug-notes.md` at repo root with "TODO: remove before commit"
 * content. Asserts deterministic facets per the M14 plan §Q3.
 *
 * Skip semantics + assertion shape mirror smoke-m14-correctness-worker.mts.
 *
 * Usage:
 *   pnpm --filter @warden/cli smoke:m14-committability-worker
 */

import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const TMP_ROOT = resolve(tmpdir(), `warden-m14-committability-${process.pid}`);
const TMP_DB = resolve(tmpdir(), `warden-m14-committability-${process.pid}.sqlite`);
process.env["WARDEN_CACHE_PATH"] = TMP_DB;

if (existsSync(TMP_DB)) unlinkSync(TMP_DB);
if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });
mkdirSync(TMP_ROOT, { recursive: true });
writeFileSync(
  resolve(TMP_ROOT, "package.json"),
  JSON.stringify({ name: "smoke-fixture", version: "0.0.0", private: true }, null, 2),
);

const FIXTURE_PATH = "debug-notes.md";
const FIXTURE_CONTENT = [
  `# Debug notes`,
  ``,
  `TODO: remove this file before committing.`,
  ``,
  `Working theories on why the rate limiter is dropping requests:`,
  ``,
  `- redis client connection pool: 50, but we're seeing 200+ concurrent — investigate`,
  `- bypass header X-Bypass-Limit hardcoded in /admin route, should be env-gated`,
  `- temporary auth shim in src/auth/dev.ts is in prod build — REMOVE`,
  ``,
  `(scratch notes, not for review)`,
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

process.stdout.write(`\n[1] committability worker flags scratch notes\n`);

const apiClaimDegraded: import("@warden/core").DegradedEntry[] = [];
const route = makeWorkerRoute({
  repoRoot: TMP_ROOT,
  changed: [{ path: FIXTURE_PATH, addedLines: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] }],
  apiClaimDegraded,
});

const result = await route({
  repoRoot: TMP_ROOT,
  files: [FIXTURE_PATH],
  concern: "committability",
  phase: "plan",
  focus: "Should this file have been committed?",
});

process.stdout.write(
  `  → worker emitted ${result.findings.length} finding(s) in ${result.durationMs}ms (${result.toolCalls} tool call(s))\n`,
);
for (const f of result.findings) {
  const summary = f.claim.length > 100 ? f.claim.slice(0, 100) + "…" : f.claim;
  process.stdout.write(
    `    [${f.category}/${f.kind}/T${f.tier}] ${f.file}:${f.lineStart} — ${summary}\n`,
  );
}

assert(result.findings.length >= 1, `worker returned ≥1 finding`);

const ourCat = result.findings.filter((f) => f.category === "committability");
assert(ourCat.length >= 1, `≥1 finding has category="committability" (got ${ourCat.length})`);

const fileMatched = result.findings.filter((f) => f.file === FIXTURE_PATH);
assert(fileMatched.length === result.findings.length, `every finding's file equals fixture path`);

const inLineRange = result.findings.filter((f) => f.lineStart >= 1 && f.lineStart <= 13);
assert(inLineRange.length === result.findings.length, `every finding's lineStart ∈ [1,13]`);

for (const f of result.findings) {
  assert(
    f.kind === "assertion" || f.kind === "question",
    `kind ∈ {assertion,question} for ${f.id}`,
  );
  assert(f.sources.length > 0, `${f.id} carries ≥1 source`);
  for (const s of f.sources) {
    assert(s.type === "tool" || s.type === "api_def", `${f.id} source.type ∈ {tool,api_def}`);
  }
}

const softKeywords = ["scratch", "notes", "todo", "debug", "commit", "remove", "wip", "temporary"];
const softHit = result.findings.some((f) =>
  softKeywords.some((kw) => f.claim.toLowerCase().includes(kw)),
);
process.stdout.write(
  `  ${softHit ? "✓" : "·"} soft: at least one claim mentions a committability-adjacent keyword\n`,
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
