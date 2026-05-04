import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Resolves the SQLite cache file path. Defaults to `.warden/cache.sqlite`
 * relative to the directory where the CLI was invoked (`process.cwd()`).
 *
 * Per ADR-0007 the cache is local-only and gitignored. It's per-repo: the
 * path is relative to wherever you run `warden`, so each project gets its
 * own cache without explicit configuration.
 *
 * Override with the `WARDEN_CACHE_PATH` env var if you need a non-default
 * location (e.g. for testing).
 */
export function resolveCachePath(): string {
  const override = process.env["WARDEN_CACHE_PATH"];
  const path = override
    ? resolve(override)
    : resolve(process.cwd(), ".warden", "cache.sqlite");
  mkdirSync(dirname(path), { recursive: true });
  return path;
}
