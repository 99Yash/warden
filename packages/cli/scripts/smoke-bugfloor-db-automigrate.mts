/**
 * M14 bug-floor smoke for `@warden/db`'s on-open migration path.
 *
 * Regression for the PR #3 "no such table: index_meta" failure mode. `db()`
 * already runs `migrate()` on first open at `packages/db/src/index.ts:30-31`,
 * so this smoke asserts existing behavior:
 *
 *   1. A fresh cache file boots cleanly (no "no such table" error).
 *   2. Every M6 schema table is queryable post-boot (sample: `chunks`,
 *      `embeddings`, `merkle`, `index_meta`, `jobs`).
 *   3. The cache file is physically created at the override path.
 *
 * Usage: pnpm --filter @warden/cli smoke:bugfloor-db-automigrate
 */

import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const TEST_DB = resolve(tmpdir(), `warden-bugfloor-db-${process.pid}-${Date.now()}.sqlite`);

if (existsSync(TEST_DB)) rmSync(TEST_DB, { force: true });
process.env["WARDEN_CACHE_PATH"] = TEST_DB;

const { db, closeDb, chunks, embeddings, merkle, indexMeta, jobs } = await import("@warden/db");

let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) {
    process.stdout.write(`  ✓ ${msg}\n`);
  } else {
    process.stdout.write(`  ✗ ${msg}\n`);
    failed++;
  }
}

process.stdout.write(`\n[1] db() bootstraps fresh cache\n`);

let handle: ReturnType<typeof db>;
try {
  handle = db();
  assert(true, "db() returns without throwing on a non-existent cache file");
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  assert(false, `db() threw on fresh cache: ${message}`);
  process.exit(1);
}

assert(existsSync(TEST_DB), `cache file physically created at ${TEST_DB}`);

process.stdout.write(`\n[2] each M6 schema table is queryable post-bootstrap\n`);

for (const [name, table] of [
  ["chunks", chunks],
  ["embeddings", embeddings],
  ["merkle", merkle],
  ["index_meta", indexMeta],
  ["jobs", jobs],
] as const) {
  try {
    const rows = handle.select().from(table).all();
    assert(Array.isArray(rows) && rows.length === 0, `${name}: queryable, empty on fresh cache`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    assert(false, `${name}: query failed (${message})`);
  }
}

closeDb();
if (existsSync(TEST_DB)) rmSync(TEST_DB, { force: true });

if (failed > 0) {
  process.stdout.write(`\n${failed} assertion(s) failed\n`);
  process.exit(1);
}
process.stdout.write(`\nall assertions passed\n`);
