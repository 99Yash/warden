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
  // The down-lane agent config ships as files, not strings: the driver
  // resolves `opencode.json` relative to its own module (`src/opencode/`
  // in dev, `dist/opencode/` here) and hands the absolute path to the
  // OpenCode child via `OPENCODE_CONFIG`.
  copy: [{ from: "opencode", to: "dist/opencode" }],
});
