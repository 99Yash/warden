import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "drizzle-kit";

// drizzle-kit can be invoked from any cwd (turbo runs it from packages/db/,
// but `pnpm db:migrate` from the workspace root runs it from there). Anchor
// the dev cache path to this config file's location so migrations always land
// at the workspace root regardless of cwd. Runtime cache resolution uses
// process.cwd() (see src/path.ts) — that's correct for the published CLI,
// where users run `warden` from their own project root.
const here = dirname(fileURLToPath(import.meta.url));
const devCachePath = resolve(here, "../..", ".warden", "cache.sqlite");
mkdirSync(dirname(devCachePath), { recursive: true });

export default defineConfig({
  schema: "./src/schema",
  out: "./src/migrations",
  dialect: "sqlite",
  dbCredentials: {
    url: devCachePath,
  },
});
