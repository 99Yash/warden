import { createInterface } from "node:readline";
import {
  chunks as chunksTable,
  db,
  embeddings as embeddingsTable,
  indexMeta,
  merkle as merkleTable,
  sql,
} from "@warden/db";
import type { ExportCounts, IndexImporter } from "./interfaces.js";

/**
 * Streaming JSONL importer paired with `SqliteIndexExporter`. Two modes:
 *
 *  - `merge`: inserts conflicting rows are no-ops (`INSERT OR IGNORE` on
 *    chunks/embeddings; merkle/meta upsert on the new value). Lossless if
 *    the incoming archive carries newer data.
 *  - `replace`: clears destination tables first, then writes. Used by
 *    full-restore round-trips.
 *
 * No CLI consumer in M6 (per ADR-0019 #8); tests + ops scripts call
 * `importAll()` directly.
 */
export class SqliteIndexImporter implements IndexImporter {
  async importAll(
    stream: NodeJS.ReadableStream,
    opts: { mode: "merge" | "replace" },
  ): Promise<{ counts: ExportCounts }> {
    if (opts.mode === "replace") {
      db().delete(embeddingsTable).run();
      db().delete(chunksTable).run();
      db().delete(merkleTable).run();
      db().delete(indexMeta).run();
    }

    const counts: ExportCounts = { chunks: 0, embeddings: 0, merkleNodes: 0, meta: 0 };
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    for await (const rawLine of rl) {
      const line = rawLine.trim();
      if (!line) continue;
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      switch (record.kind) {
        case "manifest":
          // Format version hand-off. M6 only knows version 1; bumping is ADR-worthy.
          continue;
        case "meta":
          db()
            .insert(indexMeta)
            .values({
              key: String(record.key),
              value: String(record.value),
              updatedAt: parseDate(record.updatedAt) ?? new Date(),
            })
            .onConflictDoUpdate({
              target: indexMeta.key,
              set: { value: sql`excluded.value`, updatedAt: sql`excluded.updated_at` },
            })
            .run();
          counts.meta++;
          break;
        case "chunk":
          db()
            .insert(chunksTable)
            .values({
              chunkHash: String(record.chunkHash),
              filePath: String(record.filePath),
              fileSha: String(record.fileSha),
              language: String(record.language),
              symbolPathJson: String(record.symbolPathJson),
              startLine: Number(record.startLine),
              endLine: Number(record.endLine),
              content: String(record.content),
              createdAt: new Date(),
            })
            .onConflictDoNothing()
            .run();
          counts.chunks++;
          break;
        case "embedding": {
          const buf = Buffer.from(String(record.vectorBase64), "base64");
          db()
            .insert(embeddingsTable)
            .values({
              chunkHash: String(record.chunkHash),
              modelId: String(record.modelId),
              modelVersion: String(record.modelVersion),
              vector: buf,
              createdAt: new Date(),
            })
            .onConflictDoNothing()
            .run();
          counts.embeddings++;
          break;
        }
        case "merkle":
          db()
            .insert(merkleTable)
            .values({
              nodePath: String(record.nodePath),
              hash: String(record.hash),
              kind: (record.nodeKind === "dir" ? "dir" : "file") as "file" | "dir",
              observedAt: new Date(),
            })
            .onConflictDoUpdate({
              target: merkleTable.nodePath,
              set: {
                hash: sql`excluded.hash`,
                kind: sql`excluded.kind`,
                observedAt: sql`excluded.observed_at`,
              },
            })
            .run();
          counts.merkleNodes++;
          break;
        default:
          // Unknown kinds are skipped — forward-compatible with M7+ formats
          // that learn new record types (so long as format_version bumps).
          break;
      }
    }
    return { counts };
  }
}

function parseDate(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
