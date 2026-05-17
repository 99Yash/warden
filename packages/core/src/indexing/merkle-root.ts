import { createHash } from "node:crypto";
import type { MerkleNode } from "./interfaces.js";

/**
 * Repo-level Merkle root over the per-file leaves. Init computes this once
 * after its full walk; reconcile recomputes it after every successful
 * incremental refresh so the `index_meta.repo_merkle_root` snapshot stays
 * truthful as the index evolves.
 *
 * Algorithm is stable across both call sites — sort by `nodePath` then hash
 * the `kind:path:hash\n` triples — so a reconcile that ends at the same set
 * of leaves as a fresh init produces the same root.
 */
export function computeRepoMerkleRoot(nodes: MerkleNode[]): string {
  const sorted = [...nodes].sort((a, b) => a.nodePath.localeCompare(b.nodePath));
  const h = createHash("sha256");
  for (const n of sorted) {
    h.update(`${n.kind}:${n.nodePath}:${n.hash}\n`, "utf8");
  }
  return h.digest("hex");
}
