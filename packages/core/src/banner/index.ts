import { CURRENT_DEFAULT, VOYAGE_MODELS } from "@warden/ai";
import {
  SqliteChunkStore,
  SqliteEmbeddingStore,
  SqliteMerkleStore,
  readLockedModel,
} from "../indexing/index.js";
import { assertNever } from "../assert-never.js";
import type { ChunkStore, EmbeddingStore, MerkleStore } from "../indexing/index.js";
import type { DegradedEntry } from "../schema.js";

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
  | { kind: "no-embeddings" }
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
  embeddingStore?: EmbeddingStore;
  merkleStore?: MerkleStore;
  /** Current file→sha map; when supplied, drives stale detection. */
  currentHashes?: Map<string, string>;
}

export async function computeBannerState(inputs: BannerInputs): Promise<BannerState> {
  const currentDefault = inputs.currentDefault ?? CURRENT_DEFAULT;
  const chunkStore = inputs.chunkStore ?? new SqliteChunkStore();
  const embeddingStore = inputs.embeddingStore ?? new SqliteEmbeddingStore();
  const merkleStore = inputs.merkleStore ?? new SqliteMerkleStore();

  const chunkCount = await chunkStore.count();
  if (chunkCount === 0) return { kind: "no-index" };

  // Locked-model deprecation runs first: an EOL'd SKU is the most severe
  // state, and the user needs to switch models when re-running init.
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
  }

  // Partial-init detection: chunks exist but no embeddings for the locked
  // model — Phase 3 of `warden init` failed wholesale (Voyage outage,
  // payment block, Ctrl-C). Without this state, the banner returns
  // no-banner and the run looks clean despite missing semantic context.
  // No locked-model row with chunks > 0 means meta was never written —
  // same actionable outcome (re-run init).
  if (!locked) return { kind: "no-embeddings" };
  const embeddingCount = await embeddingStore.count(locked.modelId, locked.modelVersion);
  if (embeddingCount === 0) return { kind: "no-embeddings" };

  // Aged-model notice once the user is on a behind-by-≥6-months SKU.
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

/**
 * Translate banner state to discriminated `degradedWorkers` entries
 * (ADR-0021 #7). All banner states are `kind: "actionable"` — the banner
 * surfaces precisely the entries the user can fix; non-actionable banner
 * states don't exist by construction. The renderer reads `kind` instead
 * of substring-matching on message prefixes.
 */
export function bannerStateToDegraded(state: BannerState): DegradedEntry[] {
  switch (state.kind) {
    case "no-banner":
      return [];
    case "no-index":
      return [
        {
          kind: "actionable",
          topic: "context",
          message: "context: no index — run `warden init` once for context-aware findings",
        },
      ];
    case "no-embeddings":
      return [
        {
          kind: "actionable",
          topic: "embeddings",
          message: "context: no embeddings yet — re-run `warden init` to complete indexing",
        },
      ];
    case "stale":
      return [
        {
          kind: "actionable",
          topic: "context",
          message: `context: index stale — ${state.filesChanged} file${state.filesChanged === 1 ? "" : "s"} changed since last init`,
        },
      ];
    case "model-aged":
      return [
        {
          kind: "actionable",
          topic: "context",
          message: `context: locked model ${state.indexedModel} is >6mo behind current ${state.currentDefault} (age ${state.ageDays}d) — \`warden init --rebuild\` to upgrade`,
        },
      ];
    case "model-deprecated":
      return [
        {
          kind: "actionable",
          topic: "context",
          message: `context: locked model ${state.indexedModel} deprecated as of ${state.deprecatedAfter} — \`warden init --rebuild\` to switch`,
        },
      ];
    default:
      return assertNever(state, "BannerState");
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
