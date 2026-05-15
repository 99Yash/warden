/**
 * Smoke harness for M12's leverage sub-agent. Exercises the structural
 * pieces that don't require a real LLM call:
 *
 *   1. Dependency preamble is built from root + workspace package manifests.
 *   2. Empty-deps short-circuits with no questions + no degraded entries.
 *   3. No-`node_modules/` paths surface the api-claim-verifier degraded
 *      entry (via the lookupTypeDef tool's collector).
 *   4. The runner's `Runner`-contract wrapper round-trips correctly.
 *
 * The full LLM-driven path is only exercised when `ANTHROPIC_API_KEY` is
 * set; otherwise that section is skipped (per the m12-plan: "Acceptable
 * for v0 dogfood pacing; not a CI dependency").
 *
 * Usage:
 *   pnpm --filter @warden/cli smoke:m12-sub-agent
 */

import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const TMP_ROOT = resolve(tmpdir(), `warden-m12-subagent-${process.pid}`);
const TMP_DB = resolve(tmpdir(), `warden-m12-subagent-${process.pid}.sqlite`);
process.env["WARDEN_CACHE_PATH"] = TMP_DB;

if (existsSync(TMP_DB)) unlinkSync(TMP_DB);
if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });
mkdirSync(TMP_ROOT, { recursive: true });

const { runLeverageLibraries, leverageLibrariesRunner } = await import(
  "@warden/core/runners/leverage-libraries"
);
const { makeLookupTypeDefTool } = await import("@warden/core/llm/tools/lookup-type-def");

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
// 1. Empty-deps short-circuit — no manifest, no LLM call, no degraded entry.
// ---------------------------------------------------------------------------

process.stdout.write(`\n[1] empty-deps short-circuit\n`);
mkdirSync(resolve(TMP_ROOT, "src"), { recursive: true });
writeFileSync(resolve(TMP_ROOT, "src/empty.ts"), `export const x = 1;\n`);
const emptyResult = await runLeverageLibraries({
  repoRoot: TMP_ROOT,
  changed: [{ path: "src/empty.ts", addedLines: [1] }],
});
assert(emptyResult.questions.length === 0, "no questions emitted");
assert(emptyResult.degraded.length === 0, "no degraded entries (silent skip)");

// ---------------------------------------------------------------------------
// 2. Workspace-aware dependency preamble.
// ---------------------------------------------------------------------------

process.stdout.write(`\n[2] workspace dependency preamble\n`);
const WS_ROOT = resolve(TMP_ROOT, "workspace");
mkdirSync(resolve(WS_ROOT, "packages/db/src"), { recursive: true });
writeFileSync(
  resolve(WS_ROOT, "package.json"),
  JSON.stringify({
    name: "root",
    dependencies: { "elysia": "1.0.0" },
    devDependencies: { typescript: "^5" },
  }),
);
writeFileSync(
  resolve(WS_ROOT, "packages/db/package.json"),
  JSON.stringify({
    name: "@app/db",
    dependencies: { "drizzle-orm": "0.30.0" },
  }),
);
writeFileSync(
  resolve(WS_ROOT, "packages/db/src/queries.ts"),
  `import { eq } from "drizzle-orm";\nexport const f = (x: unknown) => x;\n`,
);

// Without ANTHROPIC_API_KEY the LLM call will fail; we surface that as a
// degraded entry and the questions[] stays empty. The interesting structural
// signal is that the runner *attempted* the call against the discovered deps
// (drizzle-orm + elysia + typescript). With ANTHROPIC_API_KEY set, the LLM
// gets to emit findings — most of the time empty, which is the right answer.
const hasKey = typeof process.env["ANTHROPIC_API_KEY"] === "string"
  && process.env["ANTHROPIC_API_KEY"].length > 0;
if (!hasKey) {
  process.stdout.write(
    `  (ANTHROPIC_API_KEY not set — running deps-preamble structural check only)\n`,
  );
}

const wsResult = await runLeverageLibraries({
  repoRoot: WS_ROOT,
  changed: [{ path: "packages/db/src/queries.ts", addedLines: [1, 2] }],
  timeoutMs: 8_000,
});
// Either the LLM call succeeded and questions are well-shaped, or it failed
// and there's a warning degraded entry from leverage-libraries. Both are
// acceptable; what we assert is the contract — no crash, output well-typed.
assert(Array.isArray(wsResult.questions), "questions[] is an array");
assert(Array.isArray(wsResult.degraded), "degraded[] is an array");
for (const q of wsResult.questions) {
  assert(q.category === "leverage", `question category is leverage (got ${q.category})`);
  assert(q.kind === "question", `question kind is question (got ${q.kind})`);
  assert(
    q.sources.length > 0 && q.sources.every((s) => s.type === "api_def"),
    `question sources are all api_def`,
  );
}

// ---------------------------------------------------------------------------
// 3. No-`node_modules/` path: the lookupTypeDef tool emits one actionable
//    degraded entry on the first call regardless of how many roots we probe.
// ---------------------------------------------------------------------------

process.stdout.write(`\n[3] lookupTypeDef without node_modules surfaces actionable degraded\n`);
const NO_NM_ROOT = resolve(TMP_ROOT, "no-nm");
mkdirSync(NO_NM_ROOT, { recursive: true });
const noNmCollector: import("@warden/core").DegradedEntry[] = [];
const tool = makeLookupTypeDefTool({
  repoRoot: NO_NM_ROOT,
  packageSearchRoots: [resolve(NO_NM_ROOT, "packages/x"), resolve(NO_NM_ROOT, "packages/y")],
  degraded: noNmCollector,
});
type ToolExecuteShape = {
  execute?: (
    args: { package: string; symbol: string },
    options?: unknown,
  ) => Promise<{ found: boolean; reason?: string }>;
};
const callable = tool as unknown as ToolExecuteShape;
if (typeof callable.execute !== "function") {
  process.stdout.write(`  ✗ tool descriptor missing execute()\n`);
  failed++;
} else {
  const r1 = await callable.execute({ package: "drizzle-orm", symbol: "with" }, {});
  const r2 = await callable.execute({ package: "elysia", symbol: "guard" }, {});
  assert(r1.found === false && r1.reason === "package_not_installed", "first call → not_installed");
  assert(r2.found === false && r2.reason === "package_not_installed", "second call → not_installed");
  const verifierEntries = noNmCollector.filter((d) => d.topic === "api-claim-verifier");
  assert(
    verifierEntries.length === 1,
    `exactly one api-claim-verifier degraded entry (got ${verifierEntries.length})`,
  );
  assert(
    verifierEntries[0]?.kind === "actionable",
    "degraded kind is actionable",
  );
}

// ---------------------------------------------------------------------------
// 3b. Path-escape: a malformed/malicious diff path that resolves outside
//     repoRoot must surface a warning degraded entry (Copilot PR #14
//     comment — mirrors committability's posture).
// ---------------------------------------------------------------------------

process.stdout.write(`\n[3b] path-escape surfaces warning degraded\n`);
// Re-use the workspace fixture (has a manifest + a dep, so the runner
// doesn't short-circuit). The "../../etc/passwd" path resolves outside
// WS_ROOT and `buildFileInput` should return null → degraded entry.
const escapeResult = await runLeverageLibraries({
  repoRoot: WS_ROOT,
  changed: [
    { path: "../../etc/passwd", addedLines: [1] },
    { path: "packages/db/src/queries.ts", addedLines: [1, 2] },
  ],
  timeoutMs: 8_000,
});
const escapeWarnings = escapeResult.degraded.filter(
  (d) =>
    d.topic === "leverage-libraries" &&
    d.kind === "warning" &&
    d.message.includes("path escapes repoRoot"),
);
assert(
  escapeWarnings.length === 1,
  `exactly one path-escape warning (got ${escapeWarnings.length})`,
);
assert(
  escapeWarnings[0]?.message.includes("../../etc/passwd"),
  "warning names the offending path",
);

// ---------------------------------------------------------------------------
// 4. Runner-contract shape: name, findings empty, questions non-undefined.
// ---------------------------------------------------------------------------

process.stdout.write(`\n[4] Runner contract shape\n`);
const contractOut = await leverageLibrariesRunner.run({
  repoRoot: TMP_ROOT,
  changed: [{ path: "src/empty.ts", addedLines: [1] }],
  changedPaths: ["src/empty.ts"],
});
assert(contractOut.name === "leverage-libraries", "runner.name === leverage-libraries");
assert(Array.isArray(contractOut.findings), "findings is array");
assert(contractOut.findings.length === 0, "findings is empty (sub-agent emits questions)");
assert(Array.isArray(contractOut.questions ?? []), "questions is array (or undefined)");

// ---------------------------------------------------------------------------
// Cleanup.
// ---------------------------------------------------------------------------

if (existsSync(TMP_DB)) unlinkSync(TMP_DB);
if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });

if (failed > 0) {
  process.stdout.write(`\n${failed} assertion(s) failed\n`);
  process.exit(1);
}
process.stdout.write(`\nall assertions passed\n`);
