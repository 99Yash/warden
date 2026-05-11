/**
 * Smoke harness for M10's consistency detector (ADR-0021 §1c).
 *
 * Builds a fixture repo in a temp dir with three deliberate doc-vs-code
 * mismatches:
 *   - README claims `VOYAGE_API_KEY` is "required" — the schema treats it as
 *     optional → `env-required-mismatch`.
 *   - A `## Usage` fenced block invokes `warden frobnicate --bogus` — that
 *     verb doesn't exist on the commander surface → `cli-unknown-verb`.
 *   - A paragraph references `.warden/legacy-cache.bin` — no source file
 *     contains that literal → `stale-path`.
 *
 * Asserts each finding's `ruleId` + message substring.
 *
 * Usage:
 *   pnpm --filter @warden/cli smoke:m10-consistency
 */

import { existsSync, mkdirSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const TMP_ROOT = resolve(tmpdir(), `warden-m10-consistency-${process.pid}`);

if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });
mkdirSync(TMP_ROOT, { recursive: true });
mkdirSync(resolve(TMP_ROOT, "packages/env/src"), { recursive: true });
mkdirSync(resolve(TMP_ROOT, "packages/cli/src/commands"), { recursive: true });
mkdirSync(resolve(TMP_ROOT, "packages/core/src"), { recursive: true });

// Copy real env + CLI source so the detector sees the actual surface.
const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
copyFileSync(
  resolve(REPO_ROOT, "packages/env/src/index.ts"),
  resolve(TMP_ROOT, "packages/env/src/index.ts"),
);
copyFileSync(
  resolve(REPO_ROOT, "packages/cli/src/index.ts"),
  resolve(TMP_ROOT, "packages/cli/src/index.ts"),
);
copyFileSync(
  resolve(REPO_ROOT, "packages/cli/src/commands/init.ts"),
  resolve(TMP_ROOT, "packages/cli/src/commands/init.ts"),
);

// Source file referencing some `.warden/*` literal — proves the verifier's
// "found in source" branch works. We deliberately omit `legacy-cache.bin`.
writeFileSync(
  resolve(TMP_ROOT, "packages/core/src/cache.ts"),
  `export const CACHE_PATH = ".warden/cache.sqlite";\n`,
);

// README with three planted mismatches.
const README = [
  "# Fixture repo",
  "",
  "## Environment variables",
  "",
  "| Var | Notes |",
  "| --- | --- |",
  "| `VOYAGE_API_KEY` | Required for embedding |",
  "",
  "## Usage",
  "",
  "```bash",
  "warden frobnicate --bogus",
  "```",
  "",
  "## Cache layout",
  "",
  "Warden writes a `.warden/legacy-cache.bin` file alongside `.warden/cache.sqlite`.",
  "",
].join("\n");
writeFileSync(resolve(TMP_ROOT, "README.md"), README);

const { runConsistency } = await import("@warden/core/runners/consistency");

let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) {
    process.stdout.write(`  ✓ ${msg}\n`);
  } else {
    process.stdout.write(`  ✗ ${msg}\n`);
    failed++;
  }
}

process.stdout.write(`\n[1] runConsistency — fixture diff that touches README.md\n`);

// Simulate a diff touching README.md (so the doc-edit trigger fires for all
// claim types).
const result = await runConsistency({
  repoRoot: TMP_ROOT,
  changed: [{ path: "README.md", addedLines: Array.from({ length: 20 }, (_, i) => i + 1) }],
});

const ruleIds = result.findings.map((f) => f.ruleId).sort();
process.stdout.write(`  ruleIds=${JSON.stringify(ruleIds)}\n`);
for (const f of result.findings) {
  process.stdout.write(`    ${f.ruleId} @ ${f.file}:${f.line} — ${f.message}\n`);
}

const envRequired = result.findings.find((f) => f.ruleId === "env-required-mismatch");
const cliUnknownVerb = result.findings.find((f) => f.ruleId === "cli-unknown-verb");
const stalePath = result.findings.find((f) => f.ruleId === "stale-path");

assert(envRequired !== undefined, "env-required-mismatch fires on VOYAGE_API_KEY claim");
assert(
  envRequired?.message.includes("VOYAGE_API_KEY"),
  "env-required-mismatch message names the offending var",
);
assert(envRequired?.file === "README.md", "env mismatch anchored at the doc that made the claim");

assert(cliUnknownVerb !== undefined, "cli-unknown-verb fires on `warden frobnicate`");
assert(
  cliUnknownVerb?.message.includes("frobnicate"),
  "cli-unknown-verb message names the unknown verb",
);

assert(stalePath !== undefined, "stale-path fires on .warden/legacy-cache.bin");
assert(
  stalePath?.message.includes("legacy-cache.bin"),
  "stale-path message names the missing literal",
);

// Verify legitimate path .warden/cache.sqlite does NOT fire — the source file
// references it.
const okPathFalsePositive = result.findings.find(
  (f) => f.ruleId === "stale-path" && f.message.includes("cache.sqlite"),
);
assert(okPathFalsePositive === undefined, "no false positive on .warden/cache.sqlite (present in source)");

// Verify legitimate verb `warden init` would not have fired had we used it.
// (Sanity: the parser actually populated verbs from the copied cli/src/index.ts.)
const cliInitFalsePositive = result.findings.find(
  (f) => f.ruleId === "cli-unknown-verb" && /\binit\b/.test(f.message),
);
assert(cliInitFalsePositive === undefined, "real verb `init` is not flagged unknown (sanity)");

// Cleanup.
if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });

if (failed > 0) {
  process.stdout.write(`\n${failed} assertion(s) failed\n`);
  process.exit(1);
}
process.stdout.write(`\nall assertions passed\n`);
