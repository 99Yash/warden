import { sha256Hex } from "../hash.js";
import type { MerkleNode } from "./interfaces.js";

/**
 * Repo-level Merkle root over the per-file leaves. Init computes this once
 * after its full walk; reconcile recomputes it after every successful
 * incremental refresh so the `index_meta.repo_merkle_root` snapshot stays
 * truthful as the index evolves.
 *
 * Algorithm is stable across both call sites — sort by `nodePath` then hash
 * the `kind:path:hash\n` triples — so a reconcile that ends at the same set
 * of leaves as a fresh init produces the same root. One digest over the
 * joined triples is byte-identical to feeding them to the hasher one by one.
 */
export function computeRepoMerkleRoot(nodes: MerkleNode[]): string {
  const sorted = [...nodes].sort((a, b) => a.nodePath.localeCompare(b.nodePath));
  return sha256Hex(sorted.map((n) => `${n.kind}:${n.nodePath}:${n.hash}\n`).join(""));
}
