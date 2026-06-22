import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runJscpd } from "@warden/core/runners/jscpd";

async function main() {
  const here = fileURLToPath(import.meta.url);
  const repoRoot = resolve(here, "../../../..");
  // Scope to a few files to verify the runner loads + executes without errors.
  const scope = [
    "packages/core/src/runners/tsc.ts",
    "packages/core/src/runners/eslint.ts",
    "packages/core/src/runners/jscpd.ts",
    "packages/core/src/runners/audit.ts",
  ];
  const t0 = Date.now();
  const r = await runJscpd(repoRoot, scope, new Set(scope));
  console.log(`jscpd ran in ${Date.now() - t0}ms`);
  console.log(`degraded:`, r.degraded);
  console.log(`findings: ${r.findings.length}`);
  for (const f of r.findings.slice(0, 5)) {
    console.log(`  - ${f.file}:${f.line}-${f.endLine ?? f.line}  ${f.message}`);
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
