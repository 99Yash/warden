import type { ChangedFile } from "./index.js";

/**
 * Depth-limited diff tree (ADR-0025 / m9-plan §3). The prune stage walks
 * directories rather than per-file lists so a 500K-file `node_modules/`
 * dump produces a tree whose node count is O(directories), not O(files).
 *
 * Beyond `MAX_DEPTH`, leaves aggregate into the depth-limit node — that
 * node's `fileCount` grows; its `files[]` carries every leaf below; no
 * deeper `children` materialise.
 *
 * Stays internal to `diff/`: the orchestration `Runner` contract (ADR-0023
 * §5 / β interface) still passes `ChangedFile[]`. The tree is a transient
 * intermediate the prune step builds, walks, and discards.
 */

export const MAX_DEPTH = 3;

export interface DiffTreeNode {
  /** Empty string for the root; otherwise the directory or file segment. */
  name: string;
  /** Repo-relative POSIX path. Empty string for the root. */
  path: string;
  depth: number;
  /** Total number of files in this subtree (including aggregated leaves). */
  fileCount: number;
  /** Files anchored at this node — leaves at the depth limit also land here. */
  files: ChangedFile[];
  children: Map<string, DiffTreeNode>;
}

export function buildDiffTree(
  changed: ChangedFile[],
  maxDepth: number = MAX_DEPTH,
): DiffTreeNode {
  const root: DiffTreeNode = {
    name: "",
    path: "",
    depth: 0,
    fileCount: 0,
    files: [],
    children: new Map(),
  };
  for (const file of changed) {
    insert(root, file, maxDepth);
  }
  return root;
}

function insert(root: DiffTreeNode, file: ChangedFile, maxDepth: number): void {
  // Normalize to POSIX for consistent splitting; the diff loader already
  // emits POSIX paths but a defensive split avoids surprises if a future
  // caller hands us Windows-style separators.
  const segments = file.path.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) {
    // Pathological: empty path. Anchor at root and stop.
    root.fileCount++;
    root.files.push(file);
    return;
  }

  let node = root;
  node.fileCount++;

  // Walk down the directory chain until we either hit the file's parent
  // directory or reach the depth limit. The last segment is the file
  // itself — we don't create a child node for it; the file lives in the
  // `files[]` of its parent (the directory we land on).
  for (let i = 0; i < segments.length - 1; i++) {
    if (node.depth >= maxDepth) {
      // Aggregation point: file (and every remaining segment) collapses
      // into this node. No deeper children materialise.
      node.files.push(file);
      return;
    }
    const segment = segments[i];
    if (segment === undefined) continue;
    const childPath = node.path === "" ? segment : `${node.path}/${segment}`;
    let child = node.children.get(segment);
    if (!child) {
      child = {
        name: segment,
        path: childPath,
        depth: node.depth + 1,
        fileCount: 0,
        files: [],
        children: new Map(),
      };
      node.children.set(segment, child);
    }
    child.fileCount++;
    node = child;
  }

  // We've descended to the file's parent (or the depth limit, but the
  // loop above handles that). Anchor the file here.
  node.files.push(file);
}
