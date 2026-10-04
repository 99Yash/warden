/**
 * Reproducible measurement for ADR-0053 §5(a)'s size-discipline amendment.
 *
 * Round 0 falsified the numbers the ADR recorded, because the throwaway script
 * that produced them had been deleted and the ADR cited figures no one could
 * regenerate. This script is that measurement, kept — run it, paste the output
 * into the ADR, and the claim is checkable.
 *
 * Usage:
 *   pnpm --filter @warden/cli measure:review-bundle -- <base> [head]
 *   pnpm --filter @warden/cli measure:review-bundle -- HEAD~6 HEAD
 *
 * Every figure printed here states its serialization, because the ratios depend
 * entirely on it: the wire format is `JSON.stringify(x, null, 2)`
 * (`envelopeToContent`), and pretty-printing costs 2.5x on a bare integer array
 * because every element lands on its own indented line.
 */
import { execFileSync } from "node:child_process";
import { runDetPriors } from "@warden/core";

const git = (args: string[], cwd: string): string =>
  execFileSync("git", args, { cwd, maxBuffer: 512 * 1024 * 1024, encoding: "utf8" });

// Resolve the repo root from git rather than cwd: this runs through pnpm, which
// executes it in the package directory, and `runDetPriors` detects the ecosystem
// at `repoRoot` — measuring `packages/cli` reports different detector behaviour
// than measuring the repository.
const REPO = git(["rev-parse", "--show-toplevel"], process.cwd()).trim();
// `pnpm run <script> -- <args>` forwards the `--` itself, so drop it before
// reading positionals.
const argv = process.argv.slice(2).filter((a) => a !== "--");
const [base, head = "HEAD"] = argv;

if (base === undefined) {
  process.stderr.write("usage: measure:review-bundle -- <base> [head]\n");
  process.exit(2);
}

/** The wire format: what `envelopeToContent` actually emits. */
const wire = (v: unknown): number => Buffer.byteLength(JSON.stringify(v, null, 2), "utf8");
/** Compact, for comparison. */
const compact = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), "utf8");

const range = `${base}...${head}`;
const diff = git(["diff", range], REPO);

process.stdout.write(`# ADR-0053 §5(a) bundle measurement\n\n`);
process.stdout.write(`range        ${range}\n`);
process.stdout.write(`diff         ${(diff.length / 1024).toFixed(1)} KiB\n`);
process.stdout.write(`repoRoot     ${REPO}\n`);
process.stdout.write(`mode         review\n\n`);

for (const mode of ["review", "check"] as const) {
  const det = await runDetPriors({ diff, repoRoot: REPO, mode });

  const parts: Array<[string, unknown]> = [
    ["changed", det.changed],
    ["changedPaths", det.changedPaths],
    ["findings", det.findings],
    ["vulnComments", det.vulnComments],
    ["retrievedContext", det.retrievedContext],
    ["selectorOutput", det.selectorOutput],
    ["degraded", det.degraded],
    ["ecosystem", det.ecosystem],
    ["bannerState", det.bannerState],
  ];

  const total = wire(det);
  process.stdout.write(`## mode=${mode}\n\n`);
  process.stdout.write(`${"component".padEnd(20)}${"wire B".padStart(12)}${"share".padStart(9)}\n`);
  const rows = parts
    .map(([k, v]) => [k, wire(v)] as const)
    .sort((a, b) => b[1] - a[1]);
  for (const [k, n] of rows) {
    process.stdout.write(`${k.padEnd(20)}${String(n).padStart(12)}${`${((n / total) * 100).toFixed(1)}%`.padStart(9)}\n`);
  }
  process.stdout.write(`${"TOTAL DetPriors".padEnd(20)}${String(total).padStart(12)}${"100.0%".padStart(9)}\n`);
  process.stdout.write(`${"TOTAL compact".padEnd(20)}${String(compact(det)).padStart(12)}\n`);

  const addedLineNumbers = det.changed.reduce((a, f) => a + f.addedLines.length, 0);
  const asArrays = wire(det.changed);
  const asCounts = wire(det.changed.map((f) => ({ path: f.path, addedLineCount: f.addedLines.length })));
  const linesOnly = wire(Array.from({ length: addedLineNumbers }, (_, i) => i + 1));

  process.stdout.write(`\n### addedLines, the field that dominated\n\n`);
  process.stdout.write(`changed files                ${det.changed.length}\n`);
  process.stdout.write(`added line numbers           ${addedLineNumbers}\n`);
  process.stdout.write(`changed, wire format         ${asArrays} B\n`);
  process.stdout.write(`  same data as counts        ${asCounts} B\n`);
  process.stdout.write(`  reduction                  ${(asArrays / asCounts).toFixed(2)}x\n`);
  process.stdout.write(`bare line-number array       ${linesOnly} B\n`);
  process.stdout.write(`  vs counts                  ${(linesOnly / asCounts).toFixed(2)}x\n`);
  process.stdout.write(`  compact, changed            ${compact(det.changed)} B (${(compact(det.changed) / asArrays).toFixed(2)}x of wire)\n`);

  const chunks = det.retrievedContext.chunks;
  const ctxBytes = wire(chunks);
  process.stdout.write(`\n### retrieved context — the claim round 0 falsified\n\n`);
  process.stdout.write(`chunks                       ${chunks.length}\n`);
  process.stdout.write(`candidate cap                MAX_CONTENT_BEARING (candidates, not chunks)\n`);
  process.stdout.write(`retrieved context, wire      ${ctxBytes} B\n`);
  if (chunks.length > 0) {
    const sizes = chunks.map((c) => Buffer.byteLength(c.snippet, "utf8"));
    process.stdout.write(`  snippet max / mean         ${Math.max(...sizes)} / ${Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length)} B\n`);
    process.stdout.write(`  chunks from one path       ${new Set(chunks.map((c) => c.path)).size} distinct path(s)\n`);
  }
  process.stdout.write(
    `\nNOTE: there is no byte ceiling on retrieved context. The selector caps\n` +
      `candidates, and prompt assembly emits one chunk per merged evidence range\n` +
      `with no snippet-byte bound (context/prompt.ts). Do not quote a structural\n` +
      `worst case for this figure — measure it.\n`,
  );

  process.stdout.write(`\n### findings\n\n`);
  process.stdout.write(`tool findings                ${det.findings.length}\n`);
  process.stdout.write(`vuln comments                ${det.vulnComments.length}\n`);
  const bySource = new Map<string, number>();
  for (const f of det.findings) bySource.set(f.source, (bySource.get(f.source) ?? 0) + 1);
  process.stdout.write(`by source                    ${[...bySource].map(([k, v]) => `${k}=${v}`).join(" ") || "(none)"}\n`);
  process.stdout.write(`wire bytes per finding       ${det.findings.length > 0 ? Math.round(wire(det.findings) / det.findings.length) : 0} B avg\n`);
  process.stdout.write(`\n`);
}
