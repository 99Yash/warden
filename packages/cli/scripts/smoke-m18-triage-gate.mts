/**
 * M18 smoke 1 — dedicated security harness triage gate.
 *
 * No API keys or LLM calls. Asserts:
 *   1. Empty/doc-only diffs skip before det-priors and stay fast.
 *   2. Security-sensitive paths proceed.
 *   3. ESLint security det-priors proceed even without sensitive paths.
 *   4. `security_runs` records one row for the skipped invocation.
 *
 * Usage:
 *   pnpm --filter @warden/cli smoke:m18-triage-gate
 */

import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const TMP_DB = resolve(tmpdir(), `warden-m18-triage-gate-${process.pid}.sqlite`);
process.env["WARDEN_CACHE_PATH"] = TMP_DB;
if (existsSync(TMP_DB)) unlinkSync(TMP_DB);

const {
  evaluateTriageGate,
  isSecuritySensitivePath,
  runSecurityHarness,
} = await import("@warden/core");
const { db, securityRuns } = await import("@warden/db");

let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) {
    process.stdout.write(`  ✓ ${msg}\n`);
  } else {
    process.stdout.write(`  ✗ ${msg}\n`);
    failed += 1;
  }
}

process.stdout.write(`\n[1] path matching\n`);
assert(isSecuritySensitivePath("src/auth/login.ts"), "auth path is sensitive");
assert(isSecuritySensitivePath("apps/web/src/routes/session.ts"), "routes path is sensitive");
assert(isSecuritySensitivePath("pnpm-lock.yaml"), "lockfile is sensitive");
assert(!isSecuritySensitivePath("README.md"), "README path is not sensitive");

process.stdout.write(`\n[2] direct gate evaluation\n`);
const baseDet = {
  changed: [],
  findings: [],
  vulnComments: [],
};
assert(
  evaluateTriageGate({ detPriors: baseDet }).proceed === false,
  "empty changed set skips",
);
assert(
  evaluateTriageGate({
    detPriors: {
      ...baseDet,
      changed: [{ path: "src/auth/index.ts", addedLines: [1] }],
    },
  }).proceed === true,
  "security-sensitive changed path proceeds",
);
assert(
  evaluateTriageGate({
    detPriors: {
      ...baseDet,
      changed: [{ path: "src/util.ts", addedLines: [1] }],
      findings: [
        {
          source: "eslint",
          file: "src/util.ts",
          line: 1,
          column: 1,
          severity: "error",
          ruleId: "security/detect-eval-with-expression",
          message: "eval with expression",
        },
      ],
    },
  }).proceed === true,
  "security ESLint finding proceeds",
);

process.stdout.write(`\n[3] harness fast skip + run record\n`);
const startedAt = Date.now();
const result = await runSecurityHarness({
  diff: "",
  repoRoot: process.cwd(),
  config: { mode: "security" },
});
const wallMs = Date.now() - startedAt;

assert(result.comments.length === 0, "empty diff emits no comments");
assert(wallMs < 1_000, `empty diff returns in <1000ms (got ${wallMs}ms)`);
assert(
  result.metadata.degradedWorkers.some((entry) =>
    entry.message.includes("Deep security analysis skipped"),
  ),
  "skip reason is surfaced",
);

const rows = db().select().from(securityRuns).all();
assert(rows.length === 1, `security_runs has one row (got ${rows.length})`);
assert(rows[0]?.mode === "security", "security_runs mode is security");
assert(rows[0]?.commentsEmitted === 0, "security_runs comments_emitted is 0");

if (existsSync(TMP_DB)) unlinkSync(TMP_DB);

if (failed > 0) {
  process.stdout.write(`\n${failed} assertion(s) failed\n`);
  process.exit(1);
}
process.stdout.write(`\nall assertions passed\n`);
