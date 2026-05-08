import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Resolves the SQLite cache file path. Anchors to the repo root by walking
 * upward from `process.cwd()` and stopping at the first strong boundary
 * marker — `pnpm-workspace.yaml` (workspace root), `.git` (repo root), then
 * `package.json` (single-package fallback). The cache lives at
 * `<repo-root>/.warden/cache.sqlite`. Falls back to `process.cwd()` when no
 * marker is found.
 *
 * Per ADR-0007 the cache is local-only and gitignored. It's per-repo: each
 * project gets its own cache without explicit configuration.
 *
 * Override with the `WARDEN_CACHE_PATH` env var if you need a non-default
 * location (e.g. for testing).
 */
export function resolveCachePath(): string {
  const override = process.env["WARDEN_CACHE_PATH"];
  const path = override ? resolve(override) : resolve(findRepoRoot(), ".warden", "cache.sqlite");
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

function findRepoRoot(): string {
  // Nearest-marker walk: a stray parent `package.json` (a tooling sandbox,
  // an outer monorepo) must not pull warden's cache out of the project the
  // user is actually working in. `.git` is checked before `package.json`
  // because it's a stronger repo-boundary signal.
  const cwd = process.cwd();
  const workspaceRoot = findNearest(cwd, "pnpm-workspace.yaml");
  if (workspaceRoot) return workspaceRoot;
  const gitRoot = findNearest(cwd, ".git");
  if (gitRoot) return gitRoot;
  const packageRoot = findNearest(cwd, "package.json");
  if (packageRoot) return packageRoot;
  return cwd;
}

function findNearest(start: string, marker: string): string | undefined {
  let dir = start;
  while (true) {
    if (existsSync(resolve(dir, marker))) return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) return undefined;
    dir = parent;
  }
}
