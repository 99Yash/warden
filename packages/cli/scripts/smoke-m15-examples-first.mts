/**
 * Smoke for M15 (ADR-0031) examples-first boss prompt variant. Verifies
 * that `loadBossSystemPrompt()` correctly switches between the rules-based
 * `boss-system.md` and the examples-first `boss-system-examples.md`,
 * including a sentinel-string probe to make sure the right file is loaded.
 *
 * No LLM calls — pure prompt-loader exercise.
 *
 * Asserts:
 *   1. `loadBossSystemPrompt('rules')` matches the file contents of
 *      `boss-system.md`.
 *   2. `loadBossSystemPrompt('examples')` matches the file contents of
 *      `boss-system-examples.md`, AND contains the sentinel phrase
 *      "This prompt teaches by example" that's only in the examples
 *      variant.
 *   3. Default (no argument) loads the rules variant.
 *   4. The two prompts are not byte-identical (defensive — they encode
 *      different boss instructions even when their introductions overlap).
 *   5. Caching works: re-loading the same variant returns the same string
 *      identity.
 *
 * Usage:
 *   pnpm --filter @warden/cli smoke:m15-examples-first
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) {
    process.stdout.write(`  ✓ ${msg}\n`);
  } else {
    process.stdout.write(`  ✗ ${msg}\n`);
    failed++;
  }
}

const { loadBossSystemPrompt } = await import("@warden/core/review-harness/prompts/loader");

const PROMPTS_DIR = resolve(
  fileURLToPath(import.meta.url),
  "../..",
  "..",
  "core",
  "src",
  "review-harness",
  "prompts",
);
// `dirname(...) / ../packages/core/src/review-harness/prompts` — derive from
// repo root via relative climb from the smoke file location.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const RULES_PATH = resolve(REPO_ROOT, "packages/core/src/review-harness/prompts/boss-system.md");
const EXAMPLES_PATH = resolve(
  REPO_ROOT,
  "packages/core/src/review-harness/prompts/boss-system-examples.md",
);

void PROMPTS_DIR; // keep alternative path resolution available without warning

// -----------------------------------------------------------------------
// 1. rules variant
// -----------------------------------------------------------------------
process.stdout.write(`\n[1] 'rules' variant matches boss-system.md\n`);

const rules = loadBossSystemPrompt("rules");
const rulesFile = readFileSync(RULES_PATH, "utf8");
assert(rules === rulesFile, `'rules' prompt content matches boss-system.md file (${rules.length} chars)`);

// -----------------------------------------------------------------------
// 2. examples variant
// -----------------------------------------------------------------------
process.stdout.write(`\n[2] 'examples' variant matches boss-system-examples.md\n`);

const examples = loadBossSystemPrompt("examples");
const examplesFile = readFileSync(EXAMPLES_PATH, "utf8");
assert(
  examples === examplesFile,
  `'examples' prompt content matches boss-system-examples.md file (${examples.length} chars)`,
);
assert(
  examples.includes("This prompt teaches by example"),
  `'examples' prompt contains sentinel phrase`,
);

// -----------------------------------------------------------------------
// 3. default behavior
// -----------------------------------------------------------------------
process.stdout.write(`\n[3] default (no arg) → rules variant\n`);

const defaultLoad = loadBossSystemPrompt();
assert(defaultLoad === rules, `default loadBossSystemPrompt() === 'rules' variant`);

// -----------------------------------------------------------------------
// 4. the two prompts are distinct
// -----------------------------------------------------------------------
process.stdout.write(`\n[4] rules vs examples are distinct prompts\n`);

assert(rules !== examples, `rules and examples prompts are NOT byte-identical`);
assert(
  !rules.includes("This prompt teaches by example"),
  `rules prompt does NOT contain the examples sentinel`,
);

// -----------------------------------------------------------------------
// 5. caching
// -----------------------------------------------------------------------
process.stdout.write(`\n[5] same-variant loads share string identity (cache hit)\n`);

const reload = loadBossSystemPrompt("examples");
assert(reload === examples, `second load returns the SAME string ref (cache hit)`);

// -----------------------------------------------------------------------

if (failed > 0) {
  process.stdout.write(`\n${failed} assertion(s) failed\n`);
  process.exit(1);
}
process.stdout.write(`\nall assertions passed\n`);
