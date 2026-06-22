import { defineConfig } from "tsdown";

export default defineConfig({
  entry: "src/**/*.ts",
  sourcemap: true,
  dts: true,
  // Prompts ship as `.md` per ADR-0015 — embedding multi-hundred-line
  // prompts as TS string literals was the DeepSec failure mode the rule
  // was created to avoid. The M14 prompt loader
  // (`src/review-harness/prompts/loader.ts`) resolves its `.md` siblings
  // via `import.meta.url`, so the files must sit at the same dist/
  // subpath as the loader's bundle. Without this copy, `bin: dist/index.js`
  // consumers throw ENOENT on first prompt read — the `warden` dev/smoke
  // path runs tsx against src/ and was unaffected, which is why the bug
  // stayed latent through M4–M13 (the M4 era's `src/llm/prompts/` had the
  // same problem; M14 retired those prompts alongside the formatter).
  copy: [{ from: "src/review-harness/prompts", to: "dist/review-harness/prompts" }],
});
