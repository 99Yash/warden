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
 *   4. Statement GC across async file reads does not abort the process (#39).
 *
 * Usage: pnpm --filter @warden/cli smoke:bugfloor-db-automigrate
 */

import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

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

process.stdout.write(`\n[3] SQLite statement GC across async file reads\n`);
// Run in a child: the old V8 ObjectWrap addon aborts natively, so a try/catch
// cannot observe the failure. Automatic GC during a file-close microtask is
// essential here — explicit global.gc() runs with a different context.
const gc = spawnSync(
  process.execPath,
  [
    "--import",
    import.meta.resolve("tsx/esm"),
    "--input-type=module",
    "-e",
    `
      import { readFile } from "node:fs/promises";
      import { db, closeDb, jobs } from "@warden/db";
      try {
        for (let i = 0; i < 200; i++) {
          db().select().from(jobs).all();
          await readFile("package.json");
          const pressure = Array.from({ length: 100_000 }, (_, n) => ({ n }));
          if (pressure.length !== 100_000) throw new Error("Allocation failed");
        }
        console.log("200 automatic-GC passes");
      } finally {
        closeDb();
      }
    `,
  ],
  { env: { ...process.env, WARDEN_CACHE_PATH: TEST_DB }, encoding: "utf8" },
);
assert(
  gc.status === 0 && gc.signal === null && gc.stdout.includes("200 automatic-GC passes"),
  "child survives 200 statement/read/allocation cycles without a native crash",
);
if (gc.status !== 0) process.stderr.write(gc.stderr || String(gc.error ?? gc.signal));
if (existsSync(TEST_DB)) rmSync(TEST_DB, { force: true });

if (failed > 0) {
  process.stdout.write(`\n${failed} assertion(s) failed\n`);
  process.exit(1);
}
process.stdout.write(`\nall assertions passed\n`);
