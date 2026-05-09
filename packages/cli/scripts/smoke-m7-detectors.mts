/**
 * Smoke harness for M7's two deterministic detectors (scalability + deadcode).
 * Builds in-memory fixtures, runs each detector, asserts the expected findings
 * fire. The consistency detector and the committability sub-agent ship in
 * separate slices and have their own smoke harnesses.
 *
 * Usage:
 *   pnpm --filter @warden/cli smoke:m7-detectors
 */

import { mkdirSync, writeFileSync, existsSync, unlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const TMP_ROOT = resolve(tmpdir(), `warden-m7-detectors-${process.pid}`);
const TMP_DB = resolve(tmpdir(), `warden-m7-detectors-${process.pid}.sqlite`);
process.env["WARDEN_CACHE_PATH"] = TMP_DB;

if (existsSync(TMP_DB)) unlinkSync(TMP_DB);
if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });
mkdirSync(TMP_ROOT, { recursive: true });

const { runScalability } = await import("@warden/core/runners/scalability");
const { runDeadcode } = await import("@warden/core/runners/deadcode");
const { db, importGraph } = await import("@warden/db");

let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) {
    process.stdout.write(`  ✓ ${msg}\n`);
  } else {
    process.stdout.write(`  ✗ ${msg}\n`);
    failed++;
  }
}

// 1. Scalability: load-then-narrow.
process.stdout.write(`\n[1] scalability — load-then-narrow\n`);
const ltnPath = "src/load-then-narrow.ts";
const ltnAbs = resolve(TMP_ROOT, ltnPath);
mkdirSync(resolve(TMP_ROOT, "src"), { recursive: true });
writeFileSync(
  ltnAbs,
  `
import { db } from "./db";
export async function listOpenForUser(userId: string) {
  return (await db.select().from(orders).where(eq(orders.userId, userId)).all())
    .filter((r) => r.status === "open");
}
declare const orders: { userId: string; status: string };
declare function eq(a: unknown, b: unknown): boolean;
`,
);
const ltnAddedLines = Array.from({ length: 12 }, (_, i) => i + 1);
const r1 = await runScalability({
  repoRoot: TMP_ROOT,
  changed: [{ path: ltnPath, addedLines: ltnAddedLines }],
});
assert(
  r1.findings.some((f) => f.ruleId === "load-then-narrow"),
  "load-then-narrow finding emitted",
);

// 2. Scalability: sequential-await.
process.stdout.write(`\n[2] scalability — sequential-await\n`);
const seqPath = "src/sequential.ts";
const seqAbs = resolve(TMP_ROOT, seqPath);
writeFileSync(
  seqAbs,
  `
declare function getUser(id: string): Promise<{ name: string }>;
declare function getOrders(): Promise<unknown[]>;
declare function getProducts(): Promise<unknown[]>;
export async function loadAll(uid: string) {
  const user = await getUser(uid);
  const orders = await getOrders();
  const products = await getProducts();
  return { user, orders, products };
}
`,
);
const seqAddedLines = Array.from({ length: 9 }, (_, i) => i + 1);
const r2 = await runScalability({
  repoRoot: TMP_ROOT,
  changed: [{ path: seqPath, addedLines: seqAddedLines }],
});
assert(
  r2.findings.some((f) => f.ruleId === "sequential-await"),
  "sequential-await finding emitted",
);

// 3. Deadcode: optional param never passed.
process.stdout.write(`\n[3] deadcode — unreachable optional param\n`);
const dcPath = "src/dead.ts";
const dcAbs = resolve(TMP_ROOT, dcPath);
writeFileSync(
  dcAbs,
  `
export function fetchSomething(id: string, opts?: { stale?: boolean }) {
  if (opts) {
    return { id, stale: opts.stale ?? false };
  }
  return { id, stale: false };
}
`,
);
const callerPath = "src/caller.ts";
const callerAbs = resolve(TMP_ROOT, callerPath);
writeFileSync(
  callerAbs,
  `
import { fetchSomething } from "./dead";
export const a = fetchSomething("a");
export const b = fetchSomething("b");
`,
);

// Populate import_graph: caller imports dead.ts. The detector queries this
// table for reverse callers; it never runs the M5 selector itself.
db()
  .insert(importGraph)
  .values({
    filePath: callerPath,
    fileSha: "smoke-caller-sha",
    importsJson: JSON.stringify([
      {
        module: "./dead",
        resolved: dcAbs,
        kind: "value",
        symbols: ["fetchSomething"],
        startLine: 2,
        endLine: 2,
      },
    ]),
    exportsJson: JSON.stringify([]),
    computedAt: new Date(),
  })
  .onConflictDoNothing()
  .run();

const dcAddedLines = Array.from({ length: 8 }, (_, i) => i + 1);
const r3 = await runDeadcode({
  repoRoot: TMP_ROOT,
  changed: [{ path: dcPath, addedLines: dcAddedLines }],
});
assert(
  r3.findings.some(
    (f) =>
      f.ruleId === "unreachable-optional-param" &&
      f.message.includes("opts") &&
      f.file === dcPath,
  ),
  `unreachable-optional-param finding emitted (got ${r3.findings.length} findings)`,
);

// 4. Cleanup.
if (existsSync(TMP_DB)) unlinkSync(TMP_DB);
if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });

if (failed > 0) {
  process.stdout.write(`\n${failed} assertion(s) failed\n`);
  process.exit(1);
}
process.stdout.write(`\nall assertions passed\n`);
