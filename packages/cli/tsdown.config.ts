import { defineConfig } from "tsdown";

export default defineConfig({
  entry: "src/index.ts",
  sourcemap: true,
  dts: true,
  // Preserve the shebang on the executable entry so the published `bin`
  // is runnable without an explicit interpreter.
  shims: true,
  // Bundle workspace deps (@warden/*) into the CLI binary so the published
  // `bin` is self-contained. Without this, dist/index.js imports from
  // ./src/index.ts of sibling packages at runtime, which Node can't load.
  noExternal: [/^@warden\//],
});
