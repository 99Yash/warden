/**
 * Smoke harness for M11 acceptance criterion 5 (ADR-0026 + plan §11):
 * the formatter LLM's `lookupTypeDef` tool emits exactly one
 * `topic: "api-claim-verifier"`, `kind: "actionable"` degraded entry
 * per review when `node_modules/` is missing, regardless of how many
 * times the LLM invokes the tool. Subsequent calls silently return
 * `package_not_installed`.
 *
 * Exercises the tool descriptor's `noNodeModulesEmitted` collector
 * directly. The literal "mv node_modules aside" interpretation from
 * the plan would break the warden CLI runtime itself (CLI deps live
 * in node_modules), so the smoke points the tool at a tmpdir without
 * any node_modules instead — same code path, no risk.
 *
 * Usage: pnpm --filter @warden/cli smoke:m11-no-node-modules
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const TMP_ROOT = resolve(tmpdir(), `warden-m11-no-nm-${process.pid}-${Date.now()}`);

if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });
mkdirSync(TMP_ROOT, { recursive: true });
// Deliberately do NOT create node_modules/ — that's the whole point.

const { makeLookupTypeDefTool } = await import("@warden/core");

import type { DegradedEntry, LookupTypeDefResult } from "@warden/core";

let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) {
    process.stdout.write(`  ✓ ${msg}\n`);
  } else {
    process.stdout.write(`  ✗ ${msg}\n`);
    failed++;
  }
}

process.stdout.write(`\n[1] makeLookupTypeDefTool — node_modules/ missing\n`);

const degraded: DegradedEntry[] = [];
const t = makeLookupTypeDefTool({ repoRoot: TMP_ROOT, degraded });

const execute = t.execute;
if (!execute) {
  process.stdout.write(`  ✗ tool descriptor exposes no execute()\n`);
  process.exit(1);
}

// The AI SDK `tool().execute` may return an AsyncIterable. This tool returns
// one result, so a stream is a failure of the smoke.
const lookup = async (
  args: { package: string; symbol: string },
  toolCallId: string,
): Promise<LookupTypeDefResult> => {
  const result = await execute(args, { toolCallId, messages: [] });
  if (Symbol.asyncIterator in result) throw new Error("lookupTypeDef returned a stream");
  return result;
};

const reasonOf = (r: LookupTypeDefResult): string | undefined => (r.found ? undefined : r.reason);

// First call: should push exactly one actionable degraded entry.
const r1 = await lookup({ package: "drizzle-orm", symbol: "with" }, "test-1");
assert(r1.found === false, "first call returns found:false");
assert(
  reasonOf(r1) === "package_not_installed",
  `first call reason is package_not_installed (got ${reasonOf(r1)})`,
);
assert(
  degraded.length === 1,
  `exactly one degraded entry after first call (got ${degraded.length})`,
);
assert(
  degraded[0]?.kind === "actionable",
  `degraded[0].kind === "actionable" (got ${degraded[0]?.kind})`,
);
assert(
  degraded[0]?.topic === "api-claim-verifier",
  `degraded[0].topic === "api-claim-verifier" (got ${degraded[0]?.topic})`,
);
assert(
  /no node_modules/.test(degraded[0]?.message ?? ""),
  `degraded[0].message mentions "no node_modules" (got "${degraded[0]?.message}")`,
);

// Second call: should NOT push another entry; collector is once-per-review.
const r2 = await lookup({ package: "react", symbol: "useState" }, "test-2");
assert(r2.found === false, "second call returns found:false");
assert(
  reasonOf(r2) === "package_not_installed",
  `second call reason is package_not_installed (got ${reasonOf(r2)})`,
);
assert(
  degraded.length === 1,
  `degraded entry count UNCHANGED after second call (got ${degraded.length})`,
);

// Third call into a third "package" to be extra sure — still no new entry.
const r3 = await lookup({ package: "ai", symbol: "generateText" }, "test-3");
assert(r3.found === false, "third call returns found:false");
assert(
  degraded.length === 1,
  `degraded entry count UNCHANGED after third call (got ${degraded.length})`,
);

// Cleanup.
if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });

if (failed > 0) {
  process.stdout.write(`\n${failed} assertion(s) failed\n`);
  process.exit(1);
}
process.stdout.write(`\nall assertions passed\n`);
