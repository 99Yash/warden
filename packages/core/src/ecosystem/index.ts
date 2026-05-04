import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface EcosystemContext {
  repoRoot: string;
  isMonorepo: boolean;
  tsconfigPaths: string[];
  hasEslint: boolean;
  hasPackageJson: boolean;
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
  ".warden",
]);

const ESLINT_CONFIG_FILES = [
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "eslint.config.ts",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.json",
  ".eslintrc.yaml",
  ".eslintrc.yml",
  ".eslintrc",
];

export function detectEcosystem(repoRoot: string): EcosystemContext {
  return {
    repoRoot,
    isMonorepo: detectMonorepo(repoRoot),
    tsconfigPaths: findTsconfigs(repoRoot),
    hasEslint: detectEslint(repoRoot),
    hasPackageJson: existsSync(join(repoRoot, "package.json")),
  };
}

function detectMonorepo(repoRoot: string): boolean {
  if (existsSync(join(repoRoot, "pnpm-workspace.yaml"))) return true;
  if (existsSync(join(repoRoot, "turbo.json"))) return true;
  const pkgPath = join(repoRoot, "package.json");
  if (!existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { workspaces?: unknown };
    return Boolean(pkg.workspaces);
  } catch {
    return false;
  }
}

function detectEslint(repoRoot: string): boolean {
  for (const f of ESLINT_CONFIG_FILES) {
    if (existsSync(join(repoRoot, f))) return true;
  }
  const pkgPath = join(repoRoot, "package.json");
  if (!existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { eslintConfig?: unknown };
    return Boolean(pkg.eslintConfig);
  } catch {
    return false;
  }
}

function findTsconfigs(repoRoot: string, maxDepth = 6): string[] {
  const found: string[] = [];
  walk(repoRoot, 0, maxDepth, found);
  return found;
}

function walk(dir: string, depth: number, maxDepth: number, acc: string[]): void {
  if (depth > maxDepth) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      walk(full, depth + 1, maxDepth, acc);
    } else if (entry === "tsconfig.json") {
      acc.push(full);
    }
  }
}
