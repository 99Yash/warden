import { spawn } from "node:child_process";
import type { DegradedEntry } from "../schema.js";

/**
 * Diff source resolution per the M4 grilling Q3 / D1 decision.
 *
 *  - `check` mode (pre-commit / CI gating, ADR-0011): default to **uncommitted**
 *    changes — `git diff HEAD` covers staged + working tree against HEAD.
 *  - `review` mode (PR-time): default to **diff against the default branch**
 *    auto-detected via `git symbolic-ref refs/remotes/origin/HEAD`, falling
 *    back to `origin/main`, `origin/master`, then local `main` / `master`.
 *
 * Override with `baseRef` (`--base`) when the auto-pick is wrong. Stdin
 * pipe-in is handled at the CLI layer — this function only deals with
 * "ask git for the diff."
 */

export type DiffMode = "check" | "review";

export interface ResolveDiffOptions {
  repoRoot: string;
  mode: DiffMode;
  /** Explicit override (`--base <ref>`). Bypasses auto-detection. */
  baseRef?: string;
}

export interface ResolvedDiff {
  diff: string;
  /** Human-readable description of which range was diffed (for telemetry / debug). */
  description: string;
  /**
   * Surfaced when git itself failed (e.g. `--base` resolved to a tree, an
   * unknown ref, or any other non-zero exit). Pre-2026-05 the failure was
   * swallowed and the review proceeded against an empty diff — repo-audit
   * 2026-05-18 #3 caught that.
   */
  degraded?: DegradedEntry[];
}

export async function resolveDiff(opts: ResolveDiffOptions): Promise<ResolvedDiff> {
  if (opts.baseRef) {
    // Two-dot for an explicit base: caller said "diff against this exact ref,"
    // not "diff against branch's merge-base with HEAD." Three-dot rejects
    // <tree>...<commit> ranges (e.g. git's empty-tree SHA), which was the
    // silent-empty-diff path before this fix.
    const { diff, degraded } = await runGitDiff(opts.repoRoot, [
      `${opts.baseRef}..HEAD`,
    ]);
    return {
      diff,
      description: `vs ${opts.baseRef} (override)`,
      ...(degraded ? { degraded: [degraded] } : {}),
    };
  }

  if (opts.mode === "check") {
    // Working tree + staged changes against HEAD. Mirrors what a developer
    // about to commit is actually looking at.
    const { diff, degraded } = await runGitDiff(opts.repoRoot, ["HEAD"]);
    return {
      diff,
      description: "uncommitted (working tree + staged)",
      ...(degraded ? { degraded: [degraded] } : {}),
    };
  }

  // review mode — auto-detect default branch.
  const base = await resolveDefaultBranch(opts.repoRoot);
  if (!base) {
    // No default branch resolvable — fall back to HEAD~1 so review at least
    // has something to operate on. degraded path; CLI will surface this.
    const { diff, degraded } = await runGitDiff(opts.repoRoot, ["HEAD~1...HEAD"]);
    return {
      diff,
      description: "vs HEAD~1 (no default branch found)",
      ...(degraded ? { degraded: [degraded] } : {}),
    };
  }
  const { diff, degraded } = await runGitDiff(opts.repoRoot, [`${base}...HEAD`]);
  return {
    diff,
    description: `vs ${base}`,
    ...(degraded ? { degraded: [degraded] } : {}),
  };
}

/**
 * Probes git for the repo's default branch. Returns a ref name suitable for
 * `git diff <ref>...HEAD`, or `undefined` if nothing usable resolves.
 */
async function resolveDefaultBranch(repoRoot: string): Promise<string | undefined> {
  const symbolic = await runGit(repoRoot, [
    "symbolic-ref",
    "--quiet",
    "refs/remotes/origin/HEAD",
  ]);
  if (symbolic.ok) {
    const ref = symbolic.stdout.trim();
    if (ref.startsWith("refs/remotes/")) return ref.slice("refs/remotes/".length);
  }

  for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
    const probe = await runGit(repoRoot, ["rev-parse", "--verify", "--quiet", candidate]);
    if (probe.ok && probe.stdout.trim().length > 0) return candidate;
  }
  return undefined;
}

async function runGitDiff(
  repoRoot: string,
  args: string[],
): Promise<{ diff: string; degraded?: DegradedEntry }> {
  const result = await runGit(repoRoot, ["diff", ...args]);
  if (!result.ok) {
    const stderrSummary = result.stderr.trim().split("\n").slice(0, 2).join(" ").slice(0, 200);
    return {
      diff: "",
      degraded: {
        kind: "actionable",
        topic: "diff-source",
        message: stderrSummary
          ? `diff: git diff ${args.join(" ")} failed — ${stderrSummary}`
          : `diff: git diff ${args.join(" ")} failed with non-zero exit`,
      },
    };
  }
  return { diff: result.stdout };
}

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function runGit(repoRoot: string, args: string[]): Promise<GitResult> {
  return new Promise((resolveP) => {
    const child = spawn("git", args, {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", () => resolveP({ ok: false, stdout, stderr }));
    child.on("close", (code) => resolveP({ ok: code === 0, stdout, stderr }));
  });
}
