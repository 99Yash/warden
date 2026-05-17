import { db, eq, indexMeta, sql } from "@warden/db";

/**
 * Locked-model + repo-merkle-root + format-version helpers backed by the
 * single-key/value `index_meta` table (ADR-0019 #6 + #10). Each helper is
 * a one-row read/write — keep this surface tiny so adding a meta key in
 * M7+ is a one-constant + one-helper change rather than a new table.
 */

export const META_KEYS = {
  EMBEDDING_MODEL_ID: "embedding_model_id",
  EMBEDDING_MODEL_VERSION: "embedding_model_version",
  EMBEDDING_LOCKED_AT: "embedding_locked_at",
  FORMAT_VERSION: "format_version",
  REPO_MERKLE_ROOT: "repo_merkle_root",
  /** M16 / ADR-0032 — set once after the one-shot file_chunks backfill runs. */
  FILE_CHUNKS_BACKFILLED_AT: "file_chunks_backfilled_at",
} as const;

export type MetaKey = (typeof META_KEYS)[keyof typeof META_KEYS];

/** M6 ships at format_version 1; bumping requires explicit migration logic + an ADR. */
export const CURRENT_FORMAT_VERSION = 1;

export interface LockedModel {
  modelId: string;
  modelVersion: string;
  lockedAt: Date;
}

export async function readMeta(key: MetaKey): Promise<string | null> {
  const row = db()
    .select({ value: indexMeta.value })
    .from(indexMeta)
    .where(eq(indexMeta.key, key))
    .get();
  return row?.value ?? null;
}

export async function writeMeta(key: MetaKey, value: string): Promise<void> {
  db()
    .insert(indexMeta)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: indexMeta.key,
      set: { value: sql`excluded.value`, updatedAt: sql`excluded.updated_at` },
    })
    .run();
}

export async function readLockedModel(): Promise<LockedModel | null> {
  const [modelId, modelVersion, lockedAtIso] = await Promise.all([
    readMeta(META_KEYS.EMBEDDING_MODEL_ID),
    readMeta(META_KEYS.EMBEDDING_MODEL_VERSION),
    readMeta(META_KEYS.EMBEDDING_LOCKED_AT),
  ]);
  if (!modelId || !modelVersion || !lockedAtIso) return null;
  const lockedAt = new Date(lockedAtIso);
  if (Number.isNaN(lockedAt.getTime())) return null;
  return { modelId, modelVersion, lockedAt };
}

export async function writeLockedModel(modelId: string, modelVersion: string): Promise<void> {
  await Promise.all([
    writeMeta(META_KEYS.EMBEDDING_MODEL_ID, modelId),
    writeMeta(META_KEYS.EMBEDDING_MODEL_VERSION, modelVersion),
    writeMeta(META_KEYS.EMBEDDING_LOCKED_AT, new Date().toISOString()),
  ]);
}

export async function readRepoMerkleRoot(): Promise<string | null> {
  return readMeta(META_KEYS.REPO_MERKLE_ROOT);
}

export async function writeRepoMerkleRoot(root: string): Promise<void> {
  await writeMeta(META_KEYS.REPO_MERKLE_ROOT, root);
}

export async function readFormatVersion(): Promise<number> {
  const raw = await readMeta(META_KEYS.FORMAT_VERSION);
  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : 0;
}

export async function writeFormatVersion(version: number): Promise<void> {
  await writeMeta(META_KEYS.FORMAT_VERSION, String(version));
}
