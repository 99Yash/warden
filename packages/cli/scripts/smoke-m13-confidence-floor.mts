/**
 * Smoke harness for M13's confidence-threshold subsystem (ADR-0028 §5).
 * Verifies:
 *
 *   1. Default floor (`security: 0.8`) drops a Tier-2 0.6-confidence finding.
 *   2. Tier-1 findings bypass the floor unconditionally (Tier-1 short-circuit
 *      per `project_warden_security_depth_tiers.md`).
 *   3. High-confidence findings are kept.
 *   4. The `securityFloor` override flips the gate at the same threshold.
 *   5. Drops surface as exactly one info-level degraded entry per category
 *      with the count + effective floor in the message.
 *   6. Comments in *other* categories (no floor configured) are kept regardless
 *      of confidence.
 *
 * Usage:
 *   pnpm --filter @warden/cli smoke:m13-confidence-floor
 */

import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const TMP_DB = resolve(tmpdir(), `warden-m13-confidence-${process.pid}.sqlite`);
process.env["WARDEN_CACHE_PATH"] = TMP_DB;
if (existsSync(TMP_DB)) unlinkSync(TMP_DB);

const { applyConfidenceFloor, dropsToDegraded } = await import(
  "@warden/core/confidence"
);
import type { Comment } from "@warden/core";

let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) {
    process.stdout.write(`  ✓ ${msg}\n`);
  } else {
    process.stdout.write(`  ✗ ${msg}\n`);
    failed++;
  }
}

function mkComment(overrides: Partial<Comment> & { id: string }): Comment {
  const base: Comment = {
    id: "placeholder",
    file: "src/x.ts",
    lineStart: 1,
    lineEnd: 1,
    tier: 2,
    category: "security",
    kind: "question",
    claim: "test",
    explanation: "test",
    sources: [],
    confidence: 0.9,
  } as Comment;
  return { ...base, ...overrides } as Comment;
}

// ---------------------------------------------------------------------------
// 1. Default floor drops Tier-2 < 0.8.
// ---------------------------------------------------------------------------

process.stdout.write(`\n[1] default floor drops 0.6 Tier-2 security finding\n`);
const lowConfSec = mkComment({ id: "low-sec", tier: 2, confidence: 0.6 });
const r1 = applyConfidenceFloor([lowConfSec]);
assert(r1.kept.length === 0, `dropped (got kept=${r1.kept.length})`);
const sec1 = r1.drops.get("security");
assert(sec1?.count === 1, `drops.security.count === 1 (got ${sec1?.count})`);
assert(sec1?.floor === 0.8, `drops.security.floor === 0.8 (got ${sec1?.floor})`);

// ---------------------------------------------------------------------------
// 2. Tier-1 bypass.
// ---------------------------------------------------------------------------

process.stdout.write(`\n[2] Tier-1 bypasses floor unconditionally\n`);
const t1 = mkComment({ id: "t1-sec", tier: 1, confidence: 0.3 });
const r2 = applyConfidenceFloor([t1]);
assert(r2.kept.length === 1, `Tier-1 kept (got ${r2.kept.length})`);
assert(r2.drops.size === 0, `no drops recorded for Tier-1 bypass`);

// ---------------------------------------------------------------------------
// 3. High-confidence kept.
// ---------------------------------------------------------------------------

process.stdout.write(`\n[3] high-confidence security finding kept\n`);
const highConf = mkComment({ id: "hi-sec", tier: 2, confidence: 0.95 });
const r3 = applyConfidenceFloor([highConf]);
assert(r3.kept.length === 1, `kept (got ${r3.kept.length})`);
assert(r3.drops.size === 0, `no drops`);

// ---------------------------------------------------------------------------
// 4. Override flips the gate.
// ---------------------------------------------------------------------------

process.stdout.write(`\n[4] securityFloor=0.5 keeps 0.6, drops 0.4\n`);
const a = mkComment({ id: "a", tier: 2, confidence: 0.6 });
const b = mkComment({ id: "b", tier: 2, confidence: 0.4 });
const r4 = applyConfidenceFloor([a, b], { securityFloor: 0.5 });
assert(r4.kept.length === 1, `one kept (0.6) (got ${r4.kept.length})`);
assert(r4.kept[0]?.id === "a", `kept id=a (got ${r4.kept[0]?.id})`);
const sec4 = r4.drops.get("security");
assert(sec4?.count === 1, `one drop (got ${sec4?.count})`);
assert(sec4?.floor === 0.5, `effective floor is 0.5 (got ${sec4?.floor})`);

// ---------------------------------------------------------------------------
// 5. Degraded surface — one entry per category, count + floor in message.
// ---------------------------------------------------------------------------

process.stdout.write(`\n[5] dropsToDegraded → one info entry per category\n`);
const c = mkComment({ id: "c", tier: 2, confidence: 0.2 });
const d = mkComment({ id: "d", tier: 2, confidence: 0.3 });
const r5 = applyConfidenceFloor([c, d]);
const entries = dropsToDegraded(r5.drops);
assert(entries.length === 1, `exactly one degraded entry (got ${entries.length})`);
assert(entries[0]?.kind === "info", `kind is info (got ${entries[0]?.kind})`);
assert(entries[0]?.topic === "security", `topic is security (got ${entries[0]?.topic})`);
assert(
  entries[0]?.message.includes("2") && entries[0]?.message.includes("0.8"),
  `message mentions count=2 and floor=0.8 ("${entries[0]?.message}")`,
);

// ---------------------------------------------------------------------------
// 6. Other categories with no floor configured are kept regardless of conf.
// ---------------------------------------------------------------------------

process.stdout.write(`\n[6] other categories with no floor are kept regardless\n`);
const lowStyle = mkComment({
  id: "low-style",
  tier: 3,
  category: "style",
  confidence: 0.1,
});
const lowLeverage = mkComment({
  id: "low-leverage",
  tier: 2,
  category: "leverage",
  confidence: 0.05,
});
const r6 = applyConfidenceFloor([lowStyle, lowLeverage]);
assert(r6.kept.length === 2, `both kept (got ${r6.kept.length})`);
assert(r6.drops.size === 0, `no drops for non-floored categories`);

// ---------------------------------------------------------------------------
// Cleanup.
// ---------------------------------------------------------------------------

if (existsSync(TMP_DB)) unlinkSync(TMP_DB);

if (failed > 0) {
  process.stdout.write(`\n${failed} assertion(s) failed\n`);
  process.exit(1);
}
process.stdout.write(`\nall assertions passed\n`);
