import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DegradedEntry } from "../schema.js";
import type { ChangedFile } from "./index.js";
import { buildDiffTree, type DiffTreeNode } from "./tree.js";

/**
 * Diff-level noise filter (ADR-0022 / ADR-0025 / m9-plan §4). The prune
 * stage runs once between `parseUnifiedDiff()` and runner dispatch. Every
 * runner downstream (TSC, ESLint, jscpd, vuln, scalability, deadcode,
 * consistency, committability) consumes the *pruned* `ChangedFile[]`.
 *
 * Order of application (m9-plan §4):
 *   1. `BASELINE_NOISE` — language-agnostic floor (OS / editor junk).
 *   2. JS profile `alwaysNoise.directories` — ecosystem-specific dirs.
 *   3. JS profile `alwaysNoise.extensions` — ecosystem-specific exts.
 *
 * Steps 1+2 emit one `DegradedEntry` per pruned subtree (loud about
 * directories). Step 3 (extension drops) is *quiet about individual small
 * files* — m9-plan §4 — but **loud about large ones**: a single pruned file
 * whose changed-line count exceeds `LARGE_FILE_LINE_THRESHOLD` emits one
 * `info` entry so a big generated drop (e.g. a 6,618-line Drizzle
 * `_snapshot.json`) is never invisible the way it was when it silently drove
 * a review to $11 (issue #34). Small extension drops stay silent.
 */

interface NoiseProfile {
  ecosystem: string;
  alwaysNoise: {
    directories: string[];
    extensions: string[];
  };
}

const PROFILE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "ecosystem", "profiles");

/**
 * A pruned-by-extension file whose changed-line count exceeds this emits one
 * loud `info` degraded entry (issue #34). The threshold is a proxy: a
 * wholesale-regenerated artifact (lockfile, Drizzle snapshot, minified
 * bundle) carries its entire body in `addedLines`, so `addedLines.length`
 * tracks its diff weight — the thing that actually costs tokens.
 */
const LARGE_FILE_LINE_THRESHOLD = 500;

let cachedJsProfile: NoiseProfile | undefined;

function loadJsProfile(): NoiseProfile {
  if (cachedJsProfile) return cachedJsProfile;
  const raw = readFileSync(resolve(PROFILE_DIR, "javascript.json"), "utf8");
  cachedJsProfile = JSON.parse(raw) as NoiseProfile;
  return cachedJsProfile;
}

/**
 * Language-agnostic noise floor (ADR-0025 §5 / m9-plan §2). Applied
 * unconditionally before any ecosystem profile. OS / editor junk that's
 * noise regardless of which ecosystem the project belongs to.
 *
 * Migrated from the M7 committability runner's Tier-1 hard-skip list. The
 * single source of truth lives here so every runner (not just
 * committability) benefits.
 */
const BASELINE_NOISE = {
  directories: [".git", ".vscode/.history"],
  fileNames: [".DS_Store", "Thumbs.db"],
  extensions: [".pyc", ".swp"],
} as const;

export interface PruneResult {
  pruned: ChangedFile[];
  degraded: DegradedEntry[];
}

export function pruneDiff(changed: ChangedFile[]): PruneResult {
  if (changed.length === 0) return { pruned: [], degraded: [] };

  const tree = buildDiffTree(changed);
  const degraded: DegradedEntry[] = [];

  // 1. Apply BASELINE_NOISE. Directory drops emit one degraded entry per
  // pruned subtree; per-file drops (file names / extensions) are silent —
  // m9-plan §4: "loud about subtrees, quiet about individual files".
  const baselineDirs = new Set<string>(BASELINE_NOISE.directories);
  pruneDirectories(tree, baselineDirs, "baseline noise", degraded);
  const baselineFileNames = new Set<string>(BASELINE_NOISE.fileNames);
  pruneFileNames(tree, baselineFileNames);
  const baselineExts = new Set<string>(BASELINE_NOISE.extensions);
  pruneExtensions(tree, baselineExts, "baseline noise", degraded);

  // 2. Apply JS profile alwaysNoise.directories.
  const profile = loadJsProfile();
  const profileDirs = new Set<string>(profile.alwaysNoise.directories);
  pruneDirectories(tree, profileDirs, "JS ecosystem profile", degraded);

  // 3. Apply JS profile alwaysNoise.extensions. Silent for small files,
  // loud for any single drop over LARGE_FILE_LINE_THRESHOLD.
  const profileExts = new Set<string>(profile.alwaysNoise.extensions);
  pruneExtensions(tree, profileExts, "JS ecosystem profile", degraded);

  return { pruned: collect(tree), degraded };
}

/**
 * Walk the tree; for every subtree whose `name` matches `dirNames`, drop
 * the subtree and emit one degraded entry. `dirNames` may contain bare
 * names (`node_modules`) or single-segment paths (`.vscode/.history`) —
 * the multi-segment case matches against `path` rather than `name`.
 */
function pruneDirectories(
  tree: DiffTreeNode,
  dirNames: Set<string>,
  reasonSuffix: string,
  degraded: DegradedEntry[],
): void {
  // Partition into single-segment names (matched on `name`) and
  // multi-segment paths (matched as a prefix on `path`).
  const bareNames = new Set<string>();
  const pathPrefixes: string[] = [];
  for (const entry of dirNames) {
    if (entry.includes("/")) pathPrefixes.push(entry);
    else bareNames.add(entry);
  }

  walk(tree);

  function walk(node: DiffTreeNode): void {
    for (const [childName, child] of node.children) {
      const matchesBare = bareNames.has(childName);
      const matchesPrefix = pathPrefixes.some(
        (p) => child.path === p || child.path.startsWith(`${p}/`),
      );
      if (matchesBare || matchesPrefix) {
        const count = child.fileCount;
        if (count > 0) {
          const reasonName = matchesPrefix
            ? (pathPrefixes.find((p) => child.path === p || child.path.startsWith(`${p}/`)) ??
              childName)
            : childName;
          degraded.push({
            kind: "actionable",
            topic: "noise-filter",
            message: `noise-filter: skipped ${count} file${count === 1 ? "" : "s"} in ${child.path}/ (${reasonName} — ${reasonSuffix})`,
          });
        }
        node.children.delete(childName);
        node.fileCount -= count;
        continue;
      }
      walk(child);
    }
  }
}

function pruneFileNames(tree: DiffTreeNode, fileNames: Set<string>): void {
  walk(tree);

  function walk(node: DiffTreeNode): void {
    if (node.files.length > 0) {
      const remaining: ChangedFile[] = [];
      for (const file of node.files) {
        if (fileNames.has(basename(file.path))) {
          decrementAncestors(tree, file.path);
        } else {
          remaining.push(file);
        }
      }
      node.files = remaining;
    }
    for (const child of node.children.values()) walk(child);
  }
}

function pruneExtensions(
  tree: DiffTreeNode,
  exts: Set<string>,
  reasonSuffix: string,
  degraded: DegradedEntry[],
): void {
  walk(tree);

  function walk(node: DiffTreeNode): void {
    if (node.files.length > 0) {
      const remaining: ChangedFile[] = [];
      for (const file of node.files) {
        const matched = matchedExtension(file.path, exts);
        if (matched !== undefined) {
          // Loud about large drops, quiet about small ones (m9-plan §4 +
          // issue #34): a big regenerated artifact disappearing with no log
          // line is what hid the original cost problem.
          const changedLines = file.addedLines.length;
          if (changedLines > LARGE_FILE_LINE_THRESHOLD) {
            degraded.push({
              kind: "info",
              topic: "noise-filter",
              message: `noise-filter: skipped ${changedLines}-line generated ${file.path} (${matched} — ${reasonSuffix})`,
            });
          }
          decrementAncestors(tree, file.path);
        } else {
          remaining.push(file);
        }
      }
      node.files = remaining;
    }
    for (const child of node.children.values()) walk(child);
  }
}

/** Returns the matched suffix (for the log message) or `undefined`. */
function matchedExtension(path: string, exts: Set<string>): string | undefined {
  const base = basename(path);
  for (const ext of exts) {
    if (base.endsWith(ext)) return ext;
  }
  return undefined;
}

function basename(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

/**
 * After dropping a single file, decrement `fileCount` for every ancestor
 * along its path. Walking the tree top-down to find the file is cheap
 * (depth ≤ MAX_DEPTH); a precomputed parent-pointer map is overkill.
 */
function decrementAncestors(tree: DiffTreeNode, path: string): void {
  const segments = path.split("/").filter((s) => s.length > 0);
  let node: DiffTreeNode | undefined = tree;
  node.fileCount--;
  for (let i = 0; i < segments.length - 1 && node; i++) {
    const seg = segments[i];
    if (seg === undefined) break;
    const next: DiffTreeNode | undefined = node.children.get(seg);
    if (!next) break;
    next.fileCount--;
    node = next;
  }
}

function collect(tree: DiffTreeNode): ChangedFile[] {
  const out: ChangedFile[] = [];
  visit(tree);
  return out;

  function visit(node: DiffTreeNode): void {
    for (const file of node.files) out.push(file);
    for (const child of node.children.values()) visit(child);
  }
}
