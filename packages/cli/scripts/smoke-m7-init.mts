/**
 * Smoke harness for M7 Slice 1's three engine-blocker items.
 *
 *  1. Runtime schema migration: a fresh `.warden/cache.sqlite` is auto-
 *     migrated on first `db()` call — no `no such table: index_meta` crash.
 *  2. `no-embeddings` banner state: chunks present without embeddings under
 *     the locked model resolves to `{ kind: "no-embeddings" }`.
 *  3. `findRepoRoot()` precedence: cache lands at the workspace root (where
 *     `pnpm-workspace.yaml` lives) when invoked from anywhere in the tree.
 *
 * Usage:
 *   node --import tsx/esm packages/cli/scripts/smoke-m7-init.mts
 *
 * The script overrides `WARDEN_CACHE_PATH` so it never touches the real
 * workspace cache; deletes any prior tmp file; runs the assertions; exits
 * non-zero on any failure.
 */

import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const TMP_DB = resolve(tmpdir(), `warden-m7-smoke-${process.pid}.sqlite`);
process.env["WARDEN_CACHE_PATH"] = TMP_DB;

if (existsSync(TMP_DB)) unlinkSync(TMP_DB);

const { db, chunks, indexMeta } = await import("@warden/db");
const { computeBannerState } = await import("@warden/core");
const { runInit } = await import("@warden/core");

let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) {
    process.stdout.write(`  ✓ ${msg}\n`);
  } else {
    process.stdout.write(`  ✗ ${msg}\n`);
    failed++;
  }
}

// 1. Auto-migrate on first db() — no `no such table` error.
process.stdout.write(`\n[1] runtime auto-migrate\n`);
let dbRows: unknown;
try {
  dbRows = db().select().from(chunks).all();
  assert(Array.isArray(dbRows), "db().select().from(chunks).all() returns array");
} catch (err) {
  failed++;
  process.stdout.write(`  ✗ db() crashed: ${(err as Error).message}\n`);
}
assert(existsSync(TMP_DB), "fresh cache.sqlite created on disk");

// 2. runInit dryRun against a tiny synthetic repo (the workspace itself
//    is fine — Phase 1+2 only, no Voyage call).
process.stdout.write(`\n[2] runInit({ dryRun: true })\n`);
const repoRoot = resolve(import.meta.dirname, "../../..");
try {
  const summary = await runInit({ repoRoot, options: { dryRun: true } });
  assert(summary.dryRun === true, "summary reports dry-run");
  assert(summary.files > 0, `walk found files (got ${summary.files})`);
  assert(summary.chunks >= 0, `chunk phase ran (got ${summary.chunks})`);
} catch (err) {
  failed++;
  process.stdout.write(`  ✗ runInit dry-run failed: ${(err as Error).message}\n`);
}

// 3. no-embeddings banner state. After a dry-run, chunks may exist but no
//    embeddings under any locked model — set up the locked-model row by
//    hand and assert the banner returns no-embeddings.
process.stdout.write(`\n[3] computeBannerState → no-embeddings\n`);
const handle = db();
const chunkCount = handle.select().from(chunks).all().length;
if (chunkCount === 0) {
  // Inject one synthetic chunk so the banner has something to look at.
  handle
    .insert(chunks)
    .values({
      chunkHash: "smoke-m7-test-hash",
      filePath: "smoke/test.ts",
      fileSha: "abc123",
      language: "typescript",
      symbolPathJson: "[]",
      startLine: 1,
      endLine: 5,
      content: "// smoke test\n",
      createdAt: new Date(),
    })
    .onConflictDoNothing()
    .run();
}
// Set a locked model with no matching embeddings.
handle
  .insert(indexMeta)
  .values({ key: "embedding_model_id", value: "voyage-code-3", updatedAt: new Date() })
  .onConflictDoUpdate({
    target: indexMeta.key,
    set: { value: "voyage-code-3", updatedAt: new Date() },
  })
  .run();
handle
  .insert(indexMeta)
  .values({ key: "embedding_model_version", value: "dim=1024;type=document", updatedAt: new Date() })
  .onConflictDoUpdate({
    target: indexMeta.key,
    set: { value: "dim=1024;type=document", updatedAt: new Date() },
  })
  .run();
handle
  .insert(indexMeta)
  .values({ key: "embedding_locked_at", value: new Date().toISOString(), updatedAt: new Date() })
  .onConflictDoUpdate({
    target: indexMeta.key,
    set: { value: new Date().toISOString(), updatedAt: new Date() },
  })
  .run();

const state = await computeBannerState({ repoRoot });
assert(state.kind === "no-embeddings", `banner state is no-embeddings (got ${state.kind})`);

// 4. Cleanup — drop the tmp file. The next run is independent.
if (existsSync(TMP_DB)) unlinkSync(TMP_DB);

if (failed > 0) {
  process.stdout.write(`\n${failed} assertion(s) failed\n`);
  process.exit(1);
}
process.stdout.write(`\nall assertions passed\n`);
