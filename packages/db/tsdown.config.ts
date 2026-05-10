import { defineConfig } from "tsdown";

// `copy: ["src/migrations"]` lands the SQL files + meta/_journal.json under
// `dist/migrations/` so the runtime `migrate()` call in `src/index.ts` finds
// them when `@warden/db` is consumed from a published artifact instead of the
// workspace TS source. Path resolution is `import.meta.url`-relative either
// way (see MIGRATIONS_DIR in src/index.ts).
export default defineConfig({
  entry: ["src/**/*.ts", "!src/migrations/**"],
  sourcemap: true,
  dts: true,
  copy: ["src/migrations"],
});
