import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/**/*.ts", "!src/migrations/**"],
  sourcemap: true,
  dts: true,
});
