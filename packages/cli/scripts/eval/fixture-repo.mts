/**
 * Slice #43: fixture repos for the OpenCode eval runtime. Each fixture
 * becomes a real two-commit git repo (base + head) whose `<base>...HEAD`
 * diff is the fixture patch, so `driveOpencodeLane({ baseRef })` reviews
 * exactly the fixture target through the same path a user gets.
 *
 * Also owns the sparse post-image materializer (moved out of `run.mts`
 * with the trailing-blank-line fix) used for fixtures without a
 * resolvable `meta.json` head tree.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import type { Fixture } from "./types.js";

export interface FixtureRepo {
  root: string;
  baseSha: string;
  excludedBinary: number;
  /** Patch temp dir outside `root`, removed by `removeFixtureRepo`. */
  patchDir?: string;
}

/** `git -c` identity flags so the temp repo commits without global config. */
const GIT_IDENTITY = [
  "-c",
  "user.name=warden-eval",
  "-c",
  "user.email=eval@warden.invalid",
  "-c",
  "commit.gpgsign=false",
];

function git(root: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", root, ...GIT_IDENTITY, ...args], {
      encoding: "utf8",
    }) as string;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`warden-eval-oc: git ${args.join(" ")} failed: ${detail}`);
  }
}

/**
 * The `b/` path of every `diff --git` section that contains a
 * `GIT binary patch` or `Binary files … differ` line. `git apply`
 * cannot reverse such sections (no full index), so the caller excludes
 * them from both applies; the prune drops binary files anyway.
 */
export function binaryPatchPaths(diff: string): string[] {
  const out: string[] = [];
  let current: string | null = null;
  let binary = false;
  const flush = (): void => {
    if (current !== null && binary) out.push(current);
    current = null;
    binary = false;
  };
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
      const idx = line.lastIndexOf(" b/");
      current =
        idx === -1
          ? null
          : line
              .slice(idx + 3)
              .trim()
              .replace(/^"|"$/g, "");
      if (current === "") current = null;
      continue;
    }
    if (line.startsWith("GIT binary patch") || line.startsWith("Binary files ")) {
      binary = true;
    }
  }
  flush();
  return out;
}

/**
 * Build the two-commit repo for one fixture. Throws a descriptive error
 * on any failed step; the caller turns it into a sample error with zero
 * spend. Also throws when the resulting `<base>...HEAD` file list is
 * empty (nothing for the lane to review).
 */
export function buildFixtureRepo(fixture: Fixture): FixtureRepo {
  const root = mkdtempSync(join(tmpdir(), "warden-eval-oc-"));
  // The patch file lives in a separate temp dir outside `root` so it can
  // never leak into the reviewed tree.
  const patchDir = mkdtempSync(join(tmpdir(), "warden-eval-oc-patch-"));
  const patchFile = join(patchDir, "fixture.patch");
  try {
    writeFileSync(patchFile, fixture.diff);
    if (fixture.realRepo) {
      extractHeadTree(fixture.realRepo.repoPath, fixture.realRepo.commit, root);
    } else {
      materializePatchPostImages(fixture.diff, root);
      ensurePackageJsonStub(root);
    }
    execFileSync("git", ["init", "-q", root], { stdio: "ignore" });
    const excluded = binaryPatchPaths(fixture.diff);
    const excludeArgs = excluded.flatMap((p) => [`--exclude=${p}`]);
    applyPatch(root, patchFile, ["-R", ...excludeArgs]);
    // `-f`: the tree holds only tracked or patch files, and an ignore rule
    // (the tree's own or the operator's global excludes) must not drop one.
    git(root, ["add", "-A", "-f"]);
    git(root, ["commit", "--allow-empty", "-q", "-m", "base"]);
    applyPatch(root, patchFile, excludeArgs);
    git(root, ["add", "-A", "-f"]);
    git(root, ["commit", "--allow-empty", "-q", "-m", "head"]);
    const baseSha = git(root, ["rev-parse", "HEAD~1"]).trim();
    const names = execFileSync("git", ["-C", root, "diff", "--name-only", `${baseSha}...HEAD`], {
      encoding: "utf8",
    }) as string;
    if (names.trim() === "") {
      throw new Error(`warden-eval-oc: empty <base>...HEAD file list for ${fixture.name}`);
    }
    return { root, baseSha, excludedBinary: excluded.length, patchDir };
  } catch (err) {
    removeFixtureRepo({ root, baseSha: "", excludedBinary: 0, patchDir });
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/** Full post-PR tree, no worktree registration in the source repo. */
function extractHeadTree(repoPath: string, commit: string, dest: string): void {
  // Archive to a temp tar file first (alfred is large — no stdout
  // buffering limits to worry about), then extract.
  const tarFile = join(mkdtempSync(join(tmpdir(), "warden-eval-oc-tar-")), "head.tar");
  try {
    const archived = spawnSync("git", ["-C", repoPath, "archive", "-o", tarFile, commit], {
      stdio: "ignore",
    });
    if (archived.status !== 0) {
      throw new Error(`git archive of ${commit} exited ${archived.status}`);
    }
    const extracted = spawnSync("tar", ["-xf", tarFile, "-C", dest], { stdio: "ignore" });
    if (extracted.status !== 0) {
      throw new Error(`tar extract exited ${extracted.status}`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("warden-eval-oc: ")) throw err;
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`warden-eval-oc: head-tree extract failed: ${detail}`);
  } finally {
    rmSync(dirname(tarFile), { recursive: true, force: true });
  }
}

function applyPatch(root: string, patchFile: string, extraArgs: string[]): void {
  try {
    execFileSync("git", ["-C", root, "apply", "--recount", ...extraArgs, patchFile], {
      stdio: "pipe",
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`warden-eval-oc: git apply failed: ${detail}`);
  }
}

/** Same stub `run.mts`'s shared repoRoot carries, for ecosystem detection. */
function ensurePackageJsonStub(root: string): void {
  const pkgPath = resolve(root, "package.json");
  if (!existsSync(pkgPath)) {
    writeFileSync(
      pkgPath,
      JSON.stringify({ name: "warden-eval-fixture", version: "0.0.0", private: true }, null, 2),
    );
  }
}

export function removeFixtureRepo(repo: FixtureRepo): void {
  try {
    rmSync(repo.root, { recursive: true, force: true });
  } catch {
    // Best-effort.
  }
  if (repo.patchDir !== undefined) {
    try {
      rmSync(repo.patchDir, { recursive: true, force: true });
    } catch {
      // Best-effort.
    }
  }
}

/**
 * Parse a unified diff and write sparse post-image files under `repoRoot`.
 * Returns the list of paths written so the caller can clean them up after
 * the harness invocation.
 *
 * This intentionally does not reconstruct unchanged file regions outside
 * diff hunks; it preserves line numbers and local hunk context, which are
 * the only pieces the review workers and verifier need for fixture scoring.
 *
 * Handles standard two-sided git unified diffs only: it relies on `diff --git`
 * separators to reset state (so a `+++` file header is never misread as hunk
 * body), and the `@@ -a +b @@` hunk regex does not match combined/merge `@@@`
 * headers. No fixture uses either of those shapes; broaden the regex if that
 * changes.
 */
export function materializePatchPostImages(diff: string, repoRoot: string): string[] {
  const written = new Set<string>();
  let currentPath: string | null = null;
  let currentLines = new Map<number, string>();
  let nextNewLine: number | null = null;
  // Post-image line number after which a `\ No newline at end of file`
  // marker appeared. Cleared when a later post-image line is written, so
  // at flush it is only live when the marker ends the file — then the
  // file is written without a trailing newline, like the true post-image.
  // Without this, `git apply -R` cannot reverse such sections ("patch
  // does not apply") and `git apply` would add a newline the real file
  // never had.
  let noTrailingNewlineAt: number | null = null;
  let prevWasPostLine = false;

  const flush = (): void => {
    if (currentPath === null || currentLines.size === 0) {
      currentPath = null;
      currentLines = new Map<number, string>();
      nextNewLine = null;
      noTrailingNewlineAt = null;
      prevWasPostLine = false;
      return;
    }

    const maxLine = Math.max(...currentLines.keys());
    const out: string[] = [];
    for (let line = 1; line <= maxLine; line++) {
      out.push(currentLines.get(line) ?? "");
    }
    const fullPath = resolve(repoRoot, currentPath);
    const rootAbs = resolve(repoRoot);
    // Defense-in-depth: never write outside repoRoot (an absolute or traversing
    // `+++` target in a hand-authored fixture would otherwise escape).
    if (fullPath !== rootAbs && !fullPath.startsWith(rootAbs + sep)) {
      currentPath = null;
      currentLines = new Map<number, string>();
      nextNewLine = null;
      noTrailingNewlineAt = null;
      prevWasPostLine = false;
      return;
    }
    mkdirSync(dirname(fullPath), { recursive: true });
    const body = out.join("\n");
    writeFileSync(fullPath, noTrailingNewlineAt === maxLine ? body : body + "\n");
    written.add(fullPath);

    currentPath = null;
    currentLines = new Map<number, string>();
    nextNewLine = null;
    noTrailingNewlineAt = null;
    prevWasPostLine = false;
  };

  const lines = diff.split("\n");
  // A patch that ends in `\n` yields a final `""` element, which the
  // bare-empty-line branch below would treat as a blank context line —
  // every sparse file would gain one extra trailing blank line. Drop it.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    if (line.startsWith("diff --git ")) {
      flush();
      continue;
    }

    if (nextNewLine === null && line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      currentPath = target.startsWith("b/") ? target.slice(2) : target;
      prevWasPostLine = false;
      continue;
    }

    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      nextNewLine = Number(hunk[1]);
      prevWasPostLine = false;
      continue;
    }

    if (currentPath === null || nextNewLine === null) continue;

    if (line.startsWith("+")) {
      currentLines.set(nextNewLine, line.slice(1));
      nextNewLine++;
      noTrailingNewlineAt = null;
      prevWasPostLine = true;
    } else if (line.startsWith(" ")) {
      currentLines.set(nextNewLine, line.slice(1));
      nextNewLine++;
      noTrailingNewlineAt = null;
      prevWasPostLine = true;
    } else if (line.startsWith("-")) {
      // Deleted lines have no post-image line number.
      prevWasPostLine = false;
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file" marker. When it follows a
      // post-image line, the file ends without a trailing newline —
      // unless a later hunk line advances past it (cleared above).
      if (prevWasPostLine && nextNewLine !== null) {
        noTrailingNewlineAt = nextNewLine - 1;
      }
      prevWasPostLine = false;
    } else if (line === "") {
      // Bare empty line inside an active hunk = blank context line. Git emits a
      // single-space " " for these, but hand-authored fixtures write a bare "".
      // Treat it as context (advance the counter) so the rest of the hunk is not
      // silently truncated — dropping it would shift every later line's number.
      currentLines.set(nextNewLine, "");
      nextNewLine++;
      noTrailingNewlineAt = null;
      prevWasPostLine = true;
    } else {
      nextNewLine = null;
      prevWasPostLine = false;
    }
  }
  flush();
  return [...written];
}

export function cleanupMaterialized(paths: string[]): void {
  for (const p of paths) {
    try {
      unlinkSync(p);
    } catch {
      // Ignore — best-effort cleanup.
    }
  }
}
