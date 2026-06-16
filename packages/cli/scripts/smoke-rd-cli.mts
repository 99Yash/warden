/**
 * Smoke harness for the react-doctor det-prior (ADR-0046).
 *
 * The producer subprocesses the published react-doctor CLI, so an
 * end-to-end "fires on a planted SQL-injection fixture" assertion would need
 * react-doctor fetched over the network — that belongs to `review-eval`, not
 * the offline smoke tier. Here we exercise the deterministic surfaces:
 *
 *   1. Parse + map + evidence: feed a synthetic compact `JsonReport` (the
 *      exact shape react-doctor@0.5.6 emits) through `parseReactDoctorStdout`
 *      and assert the Security diagnostic maps to `{ tier: 1, category:
 *      "security" }`, Performance → scalability/2, Maintainability →
 *      clarity/3, and the evidence snippet is the whitespace-collapsed
 *      flagged line (so the citation verifier can substring-match it).
 *   2. `toComment` on the Security finding yields a Tier-1 `security` Comment
 *      carrying the snippet source.
 *   3. Graceful degrade: malformed stdout and `ok: false` reports each
 *      collapse to one actionable `react-doctor` degraded entry, no throw.
 *   4. Empty changedPaths short-circuits with no subprocess.
 *   5. The real `--no-install` path never throws (degrades if uncached).
 *
 * Usage:
 *   pnpm --filter @warden/cli smoke:rd-cli
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const { runReactDoctor, parseReactDoctorStdout } = await import(
  "@warden/core/runners/react-doctor"
);
const { mapSeverity, toComment } = await import("@warden/core/runners/to-comment");

const TMP_ROOT = resolve(tmpdir(), `warden-rd-cli-${process.pid}`);
rmSync(TMP_ROOT, { recursive: true, force: true });
mkdirSync(resolve(TMP_ROOT, "src"), { recursive: true });

// Planted source. Line 3 is the SQL-injection sink react-doctor's `scan()`
// SAST would flag; we point the synthetic Security diagnostic at it so the
// evidence read has a real line to collapse.
const DB_SRC = [
  `import { db } from "./client";`,
  ``,
  `  const rows = await db.query("SELECT * FROM users WHERE id = " + req.params.id);`,
  ``,
  `export const slowMap = items.map((i) => items.find((j) => j.id === i.ref));`,
].join("\n");
writeFileSync(resolve(TMP_ROOT, "src/db.ts"), DB_SRC);

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  rmSync(TMP_ROOT, { recursive: true, force: true });
  process.exit(1);
}

// A compact JsonReport mirroring react-doctor@0.5.6's `--json` output:
// schemaVersion 2 (baseline / `--scope changed`), ok true, three diagnostics
// across three categories.
const report = {
  schemaVersion: 2,
  version: "0.5.6",
  ok: true,
  directory: TMP_ROOT,
  mode: "baseline",
  diagnostics: [
    {
      filePath: "src/db.ts",
      plugin: "react-doctor-scan",
      rule: "sql-injection",
      severity: "error",
      message: "Untrusted input concatenated into a SQL query",
      help: "Use parameterized queries",
      line: 3,
      column: 22,
      endLine: 3,
      endColumn: 80,
      category: "Security",
    },
    {
      filePath: "src/db.ts",
      plugin: "react-doctor",
      rule: "no-nested-array-find",
      severity: "warning",
      message: "O(n^2) lookup — nested find inside map",
      help: "Build a Map once",
      line: 5,
      column: 1,
      category: "Performance",
    },
    {
      filePath: "src/db.ts",
      plugin: "react-doctor",
      rule: "prefer-named-export",
      severity: "warning",
      message: "Prefer a named export here",
      help: "Rename the default export",
      line: 1,
      column: 1,
      category: "Maintainability",
    },
  ],
  summary: {
    errorCount: 1,
    warningCount: 2,
    affectedFileCount: 1,
    totalDiagnosticCount: 3,
    score: null,
    scoreLabel: null,
  },
  elapsedMilliseconds: 12,
  error: null,
};

// ── 1. Parse + map + evidence ────────────────────────────────────────────
const parsed = await parseReactDoctorStdout(JSON.stringify(report), TMP_ROOT);
if (parsed.degraded.length !== 0) {
  fail(`valid report should not degrade — got ${JSON.stringify(parsed.degraded)}`);
}
if (parsed.findings.length !== 3) {
  fail(`expected 3 findings, got ${parsed.findings.length}`);
}
for (const f of parsed.findings) {
  if (f.source !== "react-doctor") fail(`finding source should be react-doctor, got ${f.source}`);
  if (f.file !== "src/db.ts") fail(`finding file should be repo-relative src/db.ts, got ${f.file}`);
}

const security = parsed.findings.find((f) => f.rdCategory === "Security");
if (!security) fail("missing Security finding");
const secMap = mapSeverity(security!);
if (secMap.tier !== 1 || secMap.category !== "security") {
  fail(`Security → expected {tier:1, security}, got ${JSON.stringify(secMap)}`);
}
// Evidence snippet must be the whitespace-collapsed flagged line (line 3).
const expectedSnippet =
  `const rows = await db.query("SELECT * FROM users WHERE id = " + req.params.id);`;
if (security!.evidence?.snippet !== expectedSnippet) {
  fail(`Security evidence snippet mismatch — got ${JSON.stringify(security!.evidence)}`);
}
if (security!.evidence?.path !== "src/db.ts" || security!.evidence?.line !== 3) {
  fail(`Security evidence path/line should be repo-relative src/db.ts:3`);
}

const perf = parsed.findings.find((f) => f.rdCategory === "Performance");
const perfMap = mapSeverity(perf!);
if (perfMap.tier !== 2 || perfMap.category !== "scalability") {
  fail(`Performance → expected {tier:2, scalability}, got ${JSON.stringify(perfMap)}`);
}

const maint = parsed.findings.find((f) => f.rdCategory === "Maintainability");
const maintMap = mapSeverity(maint!);
if (maintMap.tier !== 3 || maintMap.category !== "clarity") {
  fail(`Maintainability → expected {tier:3, clarity}, got ${JSON.stringify(maintMap)}`);
}
console.log("✓ parse + category→{tier,category} mapping + evidence snippet");

// ── 2. toComment on the Security finding ─────────────────────────────────
const comment = toComment(security!);
if (comment.tier !== 1 || comment.category !== "security") {
  fail(`Security Comment → expected tier 1 / security, got tier ${comment.tier} / ${comment.category}`);
}
const src = comment.sources[0];
if (!src || src.snippet !== expectedSnippet) {
  fail(`Security Comment should carry the evidence snippet as a source`);
}
console.log("✓ toComment emits Tier-1 security Comment with citable snippet");

// ── 3. Graceful degrade on malformed / ok:false stdout ───────────────────
const garbage = await parseReactDoctorStdout("npm ERR! could not find react-doctor", TMP_ROOT);
if (garbage.findings.length !== 0) fail("malformed stdout should yield no findings");
if (garbage.degraded.length !== 1 || garbage.degraded[0]?.topic !== "react-doctor") {
  fail(`malformed stdout should yield one react-doctor degraded entry`);
}
if (garbage.degraded[0]?.kind !== "actionable") {
  fail(`degrade entry should be actionable, got ${garbage.degraded[0]?.kind}`);
}

const notOk = await parseReactDoctorStdout(
  JSON.stringify({ ...report, ok: false, error: { message: "boom", name: "Err", chain: [] } }),
  TMP_ROOT,
);
if (notOk.findings.length !== 0 || notOk.degraded.length !== 1) {
  fail(`ok:false report should degrade with no findings`);
}
console.log("✓ malformed + ok:false reports degrade cleanly (no throw)");

// ── 4. Empty changedPaths short-circuits ─────────────────────────────────
const empty = await runReactDoctor({ repoRoot: TMP_ROOT, changedPaths: [], mode: "review" });
if (empty.findings.length !== 0 || empty.degraded.length !== 0) {
  fail(`empty changedPaths should return EMPTY, got ${JSON.stringify(empty)}`);
}
console.log("✓ empty changedPaths short-circuits with no subprocess");

// ── 5. Real --no-install path never throws ───────────────────────────────
// react-doctor is almost certainly not in the npx cache here, so check mode
// (`--no-install`) degrades. We only assert the shape + no-throw — whether it
// resolves depends on the host cache, so don't hard-assert the degrade.
const real = await runReactDoctor({
  repoRoot: TMP_ROOT,
  changedPaths: ["src/db.ts"],
  mode: "check",
});
if (!Array.isArray(real.findings) || !Array.isArray(real.degraded)) {
  fail(`real check-mode run returned malformed result: ${JSON.stringify(real)}`);
}
console.log(
  `✓ real --no-install run did not throw (${real.findings.length} findings, ${real.degraded.length} degraded)`,
);

rmSync(TMP_ROOT, { recursive: true, force: true });
console.log("\n✓ smoke-rd-cli passed");
