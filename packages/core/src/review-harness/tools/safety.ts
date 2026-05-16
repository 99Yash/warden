import { spawn } from "node:child_process";
import { resolve as resolvePath, sep as pathSep } from "node:path";

/**
 * Safety primitives shared by the M14 review-harness tools (`readFile`,
 * `grepRepo`, and any future tool that takes a path or returns paths). Each
 * tool runs inside an LLM tool-use loop; an LLM can pass any string as a
 * path. These checks are the boundary that keeps a misbehaving worker from
 * reading outside the repo or surfacing secret-file contents back into the
 * prompt.
 *
 * Mirrors the duplicated `resolveWithinRoot` + `SENSITIVE_PATH_PATTERNS`
 * scattered across `runners/{committability,security,leverage-libraries}.ts`
 * + `llm/verify-citations.ts`. M14 retires the first three (Q4 full
 * replacement); `verify-citations.ts`'s copy stays since it lives in a
 * different layer.
 */

/**
 * Resolve `relativePath` against `repoRoot` and return the absolute path
 * iff it lies inside (or equals) `repoRoot`. Returns `null` for empty
 * input, absolute paths outside the root, and any `..` escape. Containment
 * uses the OS path separator after normalization, so on macOS/Linux a path
 * like `/Users/me/repo/../../etc/passwd` resolves to `/etc/passwd` and is
 * rejected; on Windows the same `\` separator is honored via `pathSep`.
 *
 * The empty-string short-circuit catches `tool({ path: "" })` calls — an
 * empty path normalizes to `repoRoot` itself, which is technically inside
 * the root but never a useful target for these tools.
 */
export function resolveWithinRoot(repoRoot: string, relativePath: string): string | null {
  if (relativePath.length === 0) return null;
  const rootAbs = resolvePath(repoRoot);
  const candidate = resolvePath(rootAbs, relativePath);
  if (candidate === rootAbs) return rootAbs;
  if (candidate.startsWith(rootAbs + pathSep)) return candidate;
  return null;
}

/**
 * Paths whose *content* would leak secrets if streamed back to the LLM
 * provider. The path itself is fair game — `.env.local` showing up in a
 * diff is signal — but the bytes inside must not flow into a prompt or
 * tool return value. Mirrors the constant in committability/security/
 * leverage-libraries verbatim; consolidated here so the M14 retirement of
 * those runners doesn't lose the list.
 */
export const SENSITIVE_PATH_PATTERNS: ReadonlyArray<RegExp> = [
  /(^|\/)\.env(\..+)?$/,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.crt$/i,
  /(^|\/)id_(rsa|ed25519|dsa|ecdsa)(\.pub)?$/,
  /(^|\/)\.aws\/credentials$/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.netrc$/,
];

export function isSensitivePath(relativePath: string): boolean {
  return SENSITIVE_PATH_PATTERNS.some((re) => re.test(relativePath));
}

/**
 * Common directory names that are never useful as worker context — they
 * either bloat output (`node_modules`, `dist`) or carry repo internals
 * (`.git`, `.warden`). Used by `grepRepo`'s manual walker (when git is
 * unavailable) and by `readFile` as a belt-and-suspenders check for
 * gitignore-blind environments. Kept aligned with `init/walk.ts`'s
 * `FALLBACK_SKIP_DIRS`.
 */
export const SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".turbo",
  ".next",
  ".warden",
  ".vercel",
  ".cache",
  "coverage",
  "out",
]);

/**
 * `true` if any path segment matches `SKIP_DIRS`. Lightweight pre-check so
 * the tool can bail before shelling out to `git check-ignore`.
 */
export function isInSkipDir(relativePath: string): boolean {
  const segments = relativePath.split("/");
  for (const seg of segments) {
    if (SKIP_DIRS.has(seg)) return true;
  }
  return false;
}

/**
 * Check whether `relativePath` is gitignored via `git check-ignore --quiet`.
 * Exit 0 = ignored, exit 1 = not ignored, exit 128 = not in a git repo (or
 * other git error). We treat 128 as "not gitignored" so non-git checkouts
 * don't lose access to their files; `SKIP_DIRS` still defends the common
 * cases. Errors invoking git also fall through to "not ignored" — the
 * worker tools degrade rather than fail.
 *
 * Returns a Promise<boolean>. Callers should await; the worker tool-call
 * latency budget already absorbs a single git invocation per readFile/
 * grepRepo call.
 */
export function isGitIgnored(repoRoot: string, relativePath: string): Promise<boolean> {
  return new Promise((resolveP) => {
    const child = spawn("git", ["check-ignore", "--quiet", "--", relativePath], {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.on("error", () => resolveP(false));
    child.on("close", (code) => {
      resolveP(code === 0);
    });
  });
}
