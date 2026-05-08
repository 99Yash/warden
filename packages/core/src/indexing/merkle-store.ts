import { db, merkle as merkleTable, sql } from "@warden/db";
import type { MerkleDiffResult, MerkleNode, MerkleStore } from "./interfaces.js";

/**
 * SQLite `MerkleStore` impl (ADR-0019 #10). M6 only writes leaf (`file`)
 * rows; the directory-aggregate layer is reserved for the M7+ chunk-level
 * Merkle expansion. Diff is computed in JS — small enough at our scale
 * (5k-file repo = 5k rows = ~10ms full-table read on SQLite).
 */
export class SqliteMerkleStore implements MerkleStore {
  async upsertNode(node: MerkleNode): Promise<void> {
    await this.upsertNodes([node]);
  }

  async upsertNodes(nodes: MerkleNode[]): Promise<void> {
    if (nodes.length === 0) return;
    // Chunked batch insert with conflict→update on the new value via
    // SQLite's `excluded` row alias (Drizzle passes `sql\`excluded.col\``
    // through verbatim).
    const BATCH = 500;
    for (let i = 0; i < nodes.length; i += BATCH) {
      const slice = nodes.slice(i, i + BATCH);
      db()
        .insert(merkleTable)
        .values(
          slice.map((n) => ({
            nodePath: n.nodePath,
            hash: n.hash,
            kind: n.kind,
            observedAt: new Date(),
          })),
        )
        .onConflictDoUpdate({
          target: merkleTable.nodePath,
          set: {
            hash: sql`excluded.hash`,
            kind: sql`excluded.kind`,
            observedAt: sql`excluded.observed_at`,
          },
        })
        .run();
    }
  }

  async getAllFileHashes(): Promise<Map<string, string>> {
    const rows = db()
      .select({ nodePath: merkleTable.nodePath, hash: merkleTable.hash, kind: merkleTable.kind })
      .from(merkleTable)
      .all();
    const out = new Map<string, string>();
    for (const r of rows) {
      if (r.kind === "file") out.set(r.nodePath, r.hash);
    }
    return out;
  }

  async diff(currentHashes: Map<string, string>): Promise<MerkleDiffResult> {
    const stored = await this.getAllFileHashes();
    const changed: string[] = [];
    const added: string[] = [];
    const removed: string[] = [];

    for (const [path, hash] of currentHashes) {
      const prior = stored.get(path);
      if (prior === undefined) added.push(path);
      else if (prior !== hash) changed.push(path);
    }
    for (const path of stored.keys()) {
      if (!currentHashes.has(path)) removed.push(path);
    }
    return { changed, added, removed };
  }

  async clear(): Promise<void> {
    db().delete(merkleTable).run();
  }
}
