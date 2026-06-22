/**
 * Smoke harness for M13's ESLint security detector (ADR-0028 §2). Builds
 * in-memory fixtures with security-plugin trigger patterns, runs
 * `runEslintSecurity()`, and asserts:
 *
 *   1. `eval(req.body.code)` fires `security/detect-eval-with-expression`.
 *   2. `child_process.exec(userCmd)` fires `security/detect-child-process`.
 *   3. `crypto.pseudoRandomBytes(...)` fires `security/detect-pseudoRandomBytes`.
 *   4. A hardcoded high-entropy API-key string fires `no-secrets/no-secrets`.
 *   5. The rule-prefix routing in `to-comment.ts` maps every Warden-security
 *      finding to `{ category: "security", tier: 1 }`.
 *
 * Usage:
 *   pnpm --filter @warden/cli smoke:m13-eslint-security
 */

import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const TMP_ROOT = resolve(tmpdir(), `warden-m13-eslint-security-${process.pid}`);
const TMP_DB = resolve(tmpdir(), `warden-m13-eslint-security-${process.pid}.sqlite`);
process.env["WARDEN_CACHE_PATH"] = TMP_DB;

if (existsSync(TMP_DB)) unlinkSync(TMP_DB);
if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });
mkdirSync(resolve(TMP_ROOT, "src"), { recursive: true });

const { runEslintSecurity } = await import("@warden/core/runners/eslint-security");
const { toComment } = await import("@warden/core/runners/to-comment");

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
// 1. eval-with-expression.
// ---------------------------------------------------------------------------

process.stdout.write(`\n[1] security/detect-eval-with-expression\n`);
const evalPath = "src/eval.js";
writeFileSync(
  resolve(TMP_ROOT, evalPath),
  [
    `// Smoke fixture — security/detect-eval-with-expression.`,
    `module.exports = function run(req, res) {`,
    `  const out = eval(req.body.code);`,
    `  res.send(out);`,
    `};`,
    ``,
  ].join("\n"),
);
const evalResult = await runEslintSecurity(TMP_ROOT, [evalPath]);
const evalFindings = evalResult.findings.filter(
  (f) => f.ruleId === "security/detect-eval-with-expression",
);
assert(evalFindings.length >= 1, `eval finding fires (got ${evalFindings.length})`);

// ---------------------------------------------------------------------------
// 2. child_process.exec.
// ---------------------------------------------------------------------------

process.stdout.write(`\n[2] security/detect-child-process\n`);
const execPath = "src/exec.js";
writeFileSync(
  resolve(TMP_ROOT, execPath),
  [
    `const { exec } = require("child_process");`,
    `module.exports = function run(userCmd) {`,
    `  exec(userCmd, (err, out) => out);`,
    `};`,
    ``,
  ].join("\n"),
);
const execResult = await runEslintSecurity(TMP_ROOT, [execPath]);
const execFindings = execResult.findings.filter(
  (f) => f.ruleId === "security/detect-child-process",
);
assert(execFindings.length >= 1, `child_process finding fires (got ${execFindings.length})`);

// ---------------------------------------------------------------------------
// 3. pseudoRandomBytes.
// ---------------------------------------------------------------------------

process.stdout.write(`\n[3] security/detect-pseudoRandomBytes\n`);
const cryptoPath = "src/crypto.js";
writeFileSync(
  resolve(TMP_ROOT, cryptoPath),
  [
    `const crypto = require("crypto");`,
    `module.exports = function token() {`,
    `  return crypto.pseudoRandomBytes(16).toString("hex");`,
    `};`,
    ``,
  ].join("\n"),
);
const cryptoResult = await runEslintSecurity(TMP_ROOT, [cryptoPath]);
const cryptoFindings = cryptoResult.findings.filter(
  (f) => f.ruleId === "security/detect-pseudoRandomBytes",
);
assert(
  cryptoFindings.length >= 1,
  `pseudoRandomBytes finding fires (got ${cryptoFindings.length})`,
);

// ---------------------------------------------------------------------------
// 4. no-secrets / hardcoded API key.
// ---------------------------------------------------------------------------

process.stdout.write(`\n[4] no-secrets/no-secrets\n`);
const secretsPath = "src/secrets.js";
// A high-entropy 64-char string the plugin's entropy check should flag.
// Built from parts so secret-scanning does not treat this source file as containing a live key literal.
const fakeKey = [
  "sk",
  "_live_8f2a1c9b3d4e6f70",
  "81e9af0c2b5d8a16",
  "234567890abcdef0",
  "123456789abcd",
].join("");
writeFileSync(
  resolve(TMP_ROOT, secretsPath),
  [`module.exports = {`, `  apiKey: "${fakeKey}",`, `};`, ``].join("\n"),
);
const secretsResult = await runEslintSecurity(TMP_ROOT, [secretsPath]);
const secretsFindings = secretsResult.findings.filter((f) =>
  (f.ruleId ?? "").startsWith("no-secrets/"),
);
assert(secretsFindings.length >= 1, `no-secrets finding fires (got ${secretsFindings.length})`);

// ---------------------------------------------------------------------------
// 5. to-comment routing — every security/no-secrets finding maps to
//    category "security", tier 1.
// ---------------------------------------------------------------------------

process.stdout.write(`\n[5] to-comment routing → category security, tier 1\n`);
const all = [...evalFindings, ...execFindings, ...cryptoFindings, ...secretsFindings];
assert(all.length > 0, `produced at least one Warden-security finding for routing assertion`);
for (const f of all) {
  const c = toComment(f);
  assert(c.category === "security", `${f.ruleId} → category security (got ${c.category})`);
  assert(c.tier === 1, `${f.ruleId} → tier 1 (got ${c.tier})`);
}

// ---------------------------------------------------------------------------
// 6. No JS/TS files → empty findings, no degraded (silent skip).
// ---------------------------------------------------------------------------

process.stdout.write(`\n[6] no JS/TS files → silent skip\n`);
const emptyResult = await runEslintSecurity(TMP_ROOT, ["README.md", "docs/intro.md"]);
assert(emptyResult.findings.length === 0, "no findings (no lintable inputs)");
assert(emptyResult.degraded.length === 0, "no degraded entries (silent skip)");

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
