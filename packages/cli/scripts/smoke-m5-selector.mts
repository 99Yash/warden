import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CheapSignalsSelector,
  candidatesToRetrievedContext,
  detectEcosystem,
  parseUnifiedDiff,
} from "@warden/core";

async function main() {
  const here = fileURLToPath(import.meta.url);
  const repoRoot = resolve(here, "../../../..");
  const ecosystem = detectEcosystem(repoRoot);
  const fakeDiff = `diff --git a/packages/core/src/index.ts b/packages/core/src/index.ts
--- a/packages/core/src/index.ts
+++ b/packages/core/src/index.ts
@@ -41,1 +41,1 @@
+const x = 1;
`;
  const changed = parseUnifiedDiff(fakeDiff);
  const selector = new CheapSignalsSelector();

  console.log(`run 1 (cold)...`);
  const t0 = Date.now();
  const r1 = await selector.select({ repoRoot, changed, ecosystem });
  console.log(`  took ${Date.now() - t0}ms, degraded=${JSON.stringify(r1.degraded)}`);
  console.log(`  ${r1.candidates.length} candidates`);

  console.log(`run 2 (warm)...`);
  const t1 = Date.now();
  const r2 = await selector.select({ repoRoot, changed, ecosystem });
  console.log(`  took ${Date.now() - t1}ms, degraded=${JSON.stringify(r2.degraded)}`);

  for (const c of r2.candidates.slice(0, 8)) {
    console.log(`  - ${c.path} (score=${c.score.toFixed(2)}, reasons=${c.reasons.length})`);
    for (const r of c.reasons.slice(0, 3)) {
      console.log(`      ${JSON.stringify(r)}`);
    }
  }

  const ctx = await candidatesToRetrievedContext(r2.candidates, repoRoot);
  console.log(`\nchunks: ${ctx.chunks.length}, sameFolderPaths: ${ctx.sameFolderPaths.length}`);
  if (ctx.chunks[0]) {
    console.log(
      `first chunk: ${ctx.chunks[0].path}:${ctx.chunks[0].lineStart}-${ctx.chunks[0].lineEnd}`,
    );
    console.log(`  reason: ${ctx.chunks[0].reason}`);
    console.log(`  snippet (first 200 chars): ${ctx.chunks[0].snippet.slice(0, 200)}`);
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
