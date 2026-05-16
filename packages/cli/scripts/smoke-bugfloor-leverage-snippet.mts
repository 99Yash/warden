/**
 * M14 bug-floor smoke for the leverage detector's multi-line emission path.
 *
 * Regression guard for PR #14: a multi-line `JSON.parse(JSON.stringify(...))`
 * construct should still produce a Comment that survives the global verifier
 * (`verify-citations.ts`). The detector achieves this by leaving evidence
 * undefined on multi-line nodes; the verifier then skips the source (its
 * `{path, line, snippet}` triple is fully undefined) and the Comment passes
 * through with no citation.
 *
 * Belt-and-suspenders: Commit 1 generalized the verifier to handle multi-
 * line snippets too, so the detector *could* now emit them safely. But the
 * detector keeps the undefined-evidence guard because (a) leverage findings
 * are descriptive of an entire construct, not a single line of code, and
 * (b) the wider window in the verifier makes single-line evidence noisier
 * to surface in the rendered comment.
 *
 * Usage: pnpm --filter @warden/cli smoke:bugfloor-leverage-snippet
 */

import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const TMP_ROOT = resolve(
  tmpdir(),
  `warden-bugfloor-leverage-${process.pid}-${Date.now()}`,
);
const TMP_DB = resolve(
  tmpdir(),
  `warden-bugfloor-leverage-${process.pid}-${Date.now()}.sqlite`,
);
process.env["WARDEN_CACHE_PATH"] = TMP_DB;

if (existsSync(TMP_DB)) unlinkSync(TMP_DB);
if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });
mkdirSync(resolve(TMP_ROOT, "src"), { recursive: true });

const { runLeverage } = await import("@warden/core/runners/leverage");
const { toComment } = await import("@warden/core/runners/to-comment");
const { verifyCitations } = await import("@warden/core");

let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) {
    process.stdout.write(`  ✓ ${msg}\n`);
  } else {
    process.stdout.write(`  ✗ ${msg}\n`);
    failed++;
  }
}

process.stdout.write(`\n[1] multi-line JSON.parse(JSON.stringify(...)) end-to-end\n`);

const MULTI_PATH = "src/multi-stringify.ts";
writeFileSync(
  resolve(TMP_ROOT, MULTI_PATH),
  [
    `export function deepClone(payload: Record<string, unknown>) {`,
    `  return JSON.parse(`,
    `    JSON.stringify(`,
    `      payload,`,
    `    ),`,
    `  );`,
    `}`,
    ``,
  ].join("\n"),
);

const detectorResult = await runLeverage({
  repoRoot: TMP_ROOT,
  changed: [{ path: MULTI_PATH, addedLines: [1, 2, 3, 4, 5, 6, 7, 8] }],
});

const cloneFindings = detectorResult.findings.filter(
  (f) => f.ruleId === "structured-clone",
);
assert(
  cloneFindings.length === 1,
  `multi-line structured-clone finding fires (got ${cloneFindings.length})`,
);

const finding = cloneFindings[0];
if (!finding) {
  process.stdout.write(`\nfinding missing — cannot continue\n`);
  process.exit(1);
}

assert(
  finding.evidence === undefined,
  "multi-line construct leaves evidence undefined (snippet guard intact)",
);
assert(
  finding.endLine !== undefined && finding.endLine > finding.line,
  "endLine > line (confirms construct really spans multiple lines)",
);

process.stdout.write(`\n[2] toComment + verifyCitations: Comment survives\n`);

const comment = toComment(finding);
assert(comment.category === "leverage", "category is leverage");
assert(comment.kind === "assertion", "kind is assertion");
assert(comment.tier === 2, "tier is 2");
assert(
  comment.sources.length === 1 &&
    comment.sources[0]?.path === undefined &&
    comment.sources[0]?.line === undefined &&
    comment.sources[0]?.snippet === undefined,
  "tool source carries an undefined-triple (verifier skip path)",
);

const verifyResult = await verifyCitations({
  comments: [comment],
  repoRoot: TMP_ROOT,
});

assert(
  verifyResult.comments.find((c) => c.id === comment.id) !== undefined,
  "Comment survives the global verifier (undefined triple is a pass-through)",
);
assert(
  verifyResult.degraded.length === 0,
  "no degraded entries — nothing was dropped",
);

if (existsSync(TMP_DB)) unlinkSync(TMP_DB);
if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });

if (failed > 0) {
  process.stdout.write(`\n${failed} assertion(s) failed\n`);
  process.exit(1);
}
process.stdout.write(`\nall assertions passed\n`);
