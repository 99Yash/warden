import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Resolves the SQLite cache file path. Anchors to the nearest repo root
 * (highest ancestor containing `pnpm-workspace.yaml`, then `package.json`,
 * then `.git`) so the cache lives at `<repo-root>/.warden/cache.sqlite`
 * regardless of which subdirectory the CLI was invoked from. Falls back to
 * `process.cwd()` if no marker is found.
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
  // Highest ancestor with pnpm-workspace.yaml wins (workspace root in monorepos);
  // otherwise highest ancestor with package.json (single-package projects);
  // otherwise nearest .git. cwd is the final fallback.
  const cwd = process.cwd();
  const workspaceRoot = findHighest(cwd, "pnpm-workspace.yaml");
  if (workspaceRoot) return workspaceRoot;
  const packageRoot = findHighest(cwd, "package.json");
  if (packageRoot) return packageRoot;
  const gitRoot = findHighest(cwd, ".git");
  if (gitRoot) return gitRoot;
  return cwd;
}

function findHighest(start: string, marker: string): string | undefined {
  let dir = start;
  let highest: string | undefined;
  while (true) {
    if (existsSync(resolve(dir, marker))) highest = dir;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return highest;
}
