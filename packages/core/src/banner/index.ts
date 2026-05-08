import { CURRENT_DEFAULT, VOYAGE_MODELS } from "@warden/ai";
import { SqliteChunkStore, SqliteMerkleStore, readLockedModel } from "../indexing/index.js";
import type { ChunkStore, MerkleStore } from "../indexing/index.js";

/**
 * Limitation banner state (ADR-0019 #7). Computed before the selector runs
 * — banner reflects index state, not "we tried to retrieve and got empty."
 * `warden check` never invokes this; only `review` and `init`.
 *
 * D-soft (newer SKU) is its own surface — `init` print-once, never in
 * `degradedWorkers`. D-aged kicks in once the new SKU has been the default
 * for >6 months (registry's `defaultSince`, NOT the user's `locked_at`).
 * D-deprecated fires the moment Voyage marks a SKU EOL'd.
 */

export type BannerState =
  | { kind: "no-banner" }
  | { kind: "no-index" }
  | { kind: "stale"; filesChanged: number }
  | { kind: "model-aged"; indexedModel: string; currentDefault: string; ageDays: number }
  | { kind: "model-deprecated"; indexedModel: string; deprecatedAfter: string };

export type SoftNotice = {
  kind: "model-soft";
  indexedModel: string;
  currentDefault: string;
};

export interface BannerInputs {
  repoRoot: string;
  currentDefault?: string;
  /** Test seam — defaults wire up the SQLite stores. */
  chunkStore?: ChunkStore;
  merkleStore?: MerkleStore;
  /** Current file→sha map; when supplied, drives stale detection. */
  currentHashes?: Map<string, string>;
}

export async function computeBannerState(inputs: BannerInputs): Promise<BannerState> {
  const currentDefault = inputs.currentDefault ?? CURRENT_DEFAULT;
  const chunkStore = inputs.chunkStore ?? new SqliteChunkStore();
  const merkleStore = inputs.merkleStore ?? new SqliteMerkleStore();

  const chunkCount = await chunkStore.count();
  if (chunkCount === 0) return { kind: "no-index" };

  // Locked-model checks: deprecation > aged > nothing. Look these up before
  // the merkle diff so EOL'd-SKU users always see the high-priority banner.
  const locked = await readLockedModel();
  if (locked) {
    const meta = VOYAGE_MODELS[locked.modelId];
    if (meta?.deprecatedAfter) {
      const deprecated = new Date(meta.deprecatedAfter);
      if (!Number.isNaN(deprecated.getTime()) && deprecated.getTime() <= Date.now()) {
        return {
          kind: "model-deprecated",
          indexedModel: locked.modelId,
          deprecatedAfter: meta.deprecatedAfter,
        };
      }
    }
    if (locked.modelId !== currentDefault) {
      const ageDays = computeDefaultAgeDays(currentDefault);
      if (ageDays !== null && ageDays >= 180) {
        return {
          kind: "model-aged",
          indexedModel: locked.modelId,
          currentDefault,
          ageDays,
        };
      }
    }
  }

  // Stale check via Merkle diff. When no current hashes are supplied (caller
  // didn't recompute the working tree), we can't claim staleness — return
  // "no-banner" rather than fabricate a state.
  if (inputs.currentHashes) {
    const diff = await merkleStore.diff(inputs.currentHashes);
    const filesChanged = diff.changed.length + diff.added.length + diff.removed.length;
    if (filesChanged > 0) return { kind: "stale", filesChanged };
  }

  return { kind: "no-banner" };
}

export async function computeSoftNotice(inputs: BannerInputs): Promise<SoftNotice | null> {
  const currentDefault = inputs.currentDefault ?? CURRENT_DEFAULT;
  const locked = await readLockedModel();
  if (!locked || locked.modelId === currentDefault) return null;

  // Only soft when the more-severe banners aren't already firing.
  const meta = VOYAGE_MODELS[locked.modelId];
  if (meta?.deprecatedAfter) {
    const deprecated = new Date(meta.deprecatedAfter);
    if (!Number.isNaN(deprecated.getTime()) && deprecated.getTime() <= Date.now()) return null;
  }
  const ageDays = computeDefaultAgeDays(currentDefault);
  if (ageDays !== null && ageDays >= 180) return null;

  return { kind: "model-soft", indexedModel: locked.modelId, currentDefault };
}

/** Translate banner state to structured `degradedWorkers` strings. */
export function bannerStateToDegraded(state: BannerState): string[] {
  switch (state.kind) {
    case "no-banner":
      return [];
    case "no-index":
      return ["context: no index — run `warden init` once for context-aware findings"];
    case "stale":
      return [
        `context: index stale — ${state.filesChanged} file${state.filesChanged === 1 ? "" : "s"} changed since last init`,
      ];
    case "model-aged":
      return [
        `context: locked model ${state.indexedModel} is >6mo behind current ${state.currentDefault} (age ${state.ageDays}d) — \`warden init --rebuild\` to upgrade`,
      ];
    case "model-deprecated":
      return [
        `context: locked model ${state.indexedModel} deprecated as of ${state.deprecatedAfter} — \`warden init --rebuild\` to switch`,
      ];
  }
}

function computeDefaultAgeDays(currentDefault: string): number | null {
  const meta = VOYAGE_MODELS[currentDefault];
  if (!meta) return null;
  const since = new Date(meta.defaultSince);
  if (Number.isNaN(since.getTime())) return null;
  const ms = Date.now() - since.getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}
