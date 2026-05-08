import {
  chunks as chunksTable,
  db,
  embeddings as embeddingsTable,
  indexMeta,
  merkle as merkleTable,
} from "@warden/db";
import { CURRENT_FORMAT_VERSION } from "./meta.js";
import type { ExportCounts, IndexExporter } from "./interfaces.js";

/**
 * Streaming JSONL+manifest exporter (ADR-0019 #8 — interface-ready, CLI
 * deferred). Format: each line is a JSON record with `kind` discriminator;
 * the first line is the manifest. Round-trip is `IndexImporter.importAll`.
 *
 * No CLI verb wires this up in M6 — tests / scripts construct + invoke
 * directly. The discipline of supporting streaming export here is what
 * keeps the storage layer free of SQLite-only shortcuts (per ADR-0016 #3).
 */
export class SqliteIndexExporter implements IndexExporter {
  async exportAll(stream: NodeJS.WritableStream): Promise<{ counts: ExportCounts }> {
    const counts: ExportCounts = { chunks: 0, embeddings: 0, merkleNodes: 0, meta: 0 };

    write(stream, {
      kind: "manifest",
      formatVersion: CURRENT_FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
    });

    for (const row of db().select().from(indexMeta).all()) {
      write(stream, {
        kind: "meta",
        key: row.key,
        value: row.value,
        updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : null,
      });
      counts.meta++;
    }

    for (const row of db().select().from(chunksTable).all()) {
      write(stream, {
        kind: "chunk",
        chunkHash: row.chunkHash,
        filePath: row.filePath,
        fileSha: row.fileSha,
        language: row.language,
        symbolPathJson: row.symbolPathJson,
        startLine: row.startLine,
        endLine: row.endLine,
        content: row.content,
      });
      counts.chunks++;
    }

    for (const row of db().select().from(embeddingsTable).all()) {
      write(stream, {
        kind: "embedding",
        chunkHash: row.chunkHash,
        modelId: row.modelId,
        modelVersion: row.modelVersion,
        // base64 keeps the JSONL line ASCII-safe across stream encodings.
        vectorBase64: Buffer.from(row.vector).toString("base64"),
      });
      counts.embeddings++;
    }

    for (const row of db().select().from(merkleTable).all()) {
      write(stream, {
        kind: "merkle",
        nodePath: row.nodePath,
        hash: row.hash,
        nodeKind: row.kind,
      });
      counts.merkleNodes++;
    }

    return { counts };
  }
}

function write(stream: NodeJS.WritableStream, record: Record<string, unknown>): void {
  stream.write(`${JSON.stringify(record)}\n`);
}
