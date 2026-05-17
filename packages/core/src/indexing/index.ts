/**
 * Barrel for the M6 indexing layer (ADR-0019 #10). Consumers import only
 * from here; SQLite-specific impls stay swappable behind the interfaces.
 */

export type {
  ChunkRecord,
  ChunkStore,
  EmbeddingRecord,
  EmbeddingStore,
  ExportCounts,
  FileChunksStore,
  IndexExporter,
  IndexImporter,
  JobRunResult,
  JobRunner,
  JobRunnerProgress,
  MerkleDiffResult,
  MerkleNode,
  MerkleStore,
  Task,
} from "./interfaces.js";

export { SqliteChunkStore } from "./chunk-store.js";
export { SqliteEmbeddingStore } from "./embedding-store.js";
export { SqliteFileChunksStore } from "./file-chunks-store.js";
export { SqliteMerkleStore } from "./merkle-store.js";
export { computeRepoMerkleRoot } from "./merkle-root.js";
export { SyncJobRunner, taskIdFor } from "./job-runner.js";
export { SqliteIndexExporter } from "./exporter.js";
export { SqliteIndexImporter } from "./importer.js";
export {
  CURRENT_FORMAT_VERSION,
  META_KEYS,
  readFormatVersion,
  readLockedModel,
  readMeta,
  readRepoMerkleRoot,
  writeFormatVersion,
  writeLockedModel,
  writeMeta,
  writeRepoMerkleRoot,
  type LockedModel,
  type MetaKey,
} from "./meta.js";
