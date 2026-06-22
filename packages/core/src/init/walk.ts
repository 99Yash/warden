import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";

/**
 * Repo file walker for `warden init` (ADR-0019 #5 — Phase 1). Prefers
 * `git ls-files` so `.gitignore` is honored automatically (which keeps
 * `node_modules`, `dist`, `.warden/` etc. out without a hardcoded skip
 * list). Falls back to a recursive `fs.readdir` walk with a small skip
 * list when `git` isn't available.
 */

export interface WalkedFile {
  /** Repo-relative POSIX path. */
  path: string;
  /** UTF-8 contents. */
  content: string;
  /** sha256 hex of the bytes. */
  fileSha: string;
  /** Line count (cheap LOC proxy for the pre-flight estimate). */
  loc: number;
}

export interface WalkResult {
  files: Map<string, WalkedFile>;
  /** `true` when we fell back to the manual walk. Surfaces in `degradedWorkers`. */
  usedFallback: boolean;
  /** Total bytes walked (raw file content). */
  totalBytes: number;
}

const FALLBACK_SKIP_DIRS = new Set([
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

const SOURCE_EXT_RE = /\.(?:tsx?|jsx?|mjs|cjs|py|rs|go|java)$/i;

const WALK_BATCH = 32;

export async function walkRepo(repoRoot: string): Promise<WalkResult> {
  let paths: string[];
  let usedFallback = false;
  try {
    paths = await gitListFiles(repoRoot);
  } catch {
    paths = await manualWalk(repoRoot);
    usedFallback = true;
  }

  const filtered = paths.filter((p) => SOURCE_EXT_RE.test(p));

  const files = new Map<string, WalkedFile>();
  let totalBytes = 0;

  for (let i = 0; i < filtered.length; i += WALK_BATCH) {
    const slice = filtered.slice(i, i + WALK_BATCH);
    const results = await Promise.all(
      slice.map(async (rel) => {
        const abs = resolvePath(repoRoot, rel);
        try {
          const content = await readFile(abs, "utf8");
          const fileSha = createHash("sha256").update(content, "utf8").digest("hex");
          const loc = content.length === 0 ? 0 : content.split("\n").length;
          return { rel, content, fileSha, loc, bytes: Buffer.byteLength(content, "utf8") };
        } catch {
          return null;
        }
      }),
    );
    for (const r of results) {
      if (!r) continue;
      files.set(r.rel, { path: r.rel, content: r.content, fileSha: r.fileSha, loc: r.loc });
      totalBytes += r.bytes;
    }
  }

  return { files, usedFallback, totalBytes };
}

function gitListFiles(repoRoot: string): Promise<string[]> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn("git", ["ls-files"], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.on("error", (err) => rejectP(err));
    child.on("close", (code) => {
      if (code !== 0) {
        rejectP(new Error(`git ls-files exited ${code ?? "?"}`));
        return;
      }
      resolveP(
        stdout
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length > 0),
      );
    });
  });
}

async function manualWalk(repoRoot: string): Promise<string[]> {
  const out: string[] = [];
  await walkDir(repoRoot, "", out);
  return out;
}

async function walkDir(repoRoot: string, relDir: string, out: string[]): Promise<void> {
  const absDir = resolvePath(repoRoot, relDir);
  // Force the string-name overload — Node 22 typings widen Dirent's name to
  // `string | Buffer` when no encoding is supplied.
  let entries: Array<{
    name: string;
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  }>;
  try {
    entries = await readdir(absDir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return;
  }
  for (const entry of entries) {
    const name = entry.name;
    if (FALLBACK_SKIP_DIRS.has(name)) continue;
    const childRel = relDir ? `${relDir}/${name}` : name;
    if (entry.isDirectory()) {
      await walkDir(repoRoot, childRel, out);
    } else if (entry.isFile()) {
      out.push(childRel);
    } else if (entry.isSymbolicLink()) {
      // Resolve symlinks once — avoids walking the same files via duplicate
      // entries while keeping linked source directories visible.
      try {
        const s = await stat(resolvePath(repoRoot, childRel));
        if (s.isFile()) out.push(childRel);
      } catch {
        // dangling symlink — skip silently.
      }
    }
  }
}
