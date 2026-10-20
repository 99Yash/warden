// Selector scoring weights and candidate caps. They live in their own module, not in
// `./index.ts`, because `./selector.ts` and `./signals/same-folder.ts` read them and
// `./index.ts` re-exports `./selector.ts`: reading them from the barrel is an import
// cycle (`import/no-cycle`).

/**
 * Per-reason weights for v2 scoring (ADR-0019 #9). Cheap signals stay
 * binary; `semantic` is intensity-scaled by the chunk's max cosine
 * similarity. `MAX_REASON_WEIGHT_SUM = 3.6` is the sum of all weights —
 * normalizing by it keeps `score ∈ [0, 1]`.
 *
 * Direction note: `imported-by` is upstream (contracts the changed file
 * depends on); `imports` is downstream (consumers / blast radius). The
 * 1.0 / 0.8 split is a deferred tuning call (ADR-0018).
 */
export const REASON_WEIGHTS = {
  "imported-by": 1.0,
  semantic: 0.9,
  imports: 0.8,
  "symbol-ref": 0.6,
  "same-folder": 0.3,
} as const;

export const MAX_REASON_WEIGHT_SUM =
  REASON_WEIGHTS["imported-by"] +
  REASON_WEIGHTS.semantic +
  REASON_WEIGHTS.imports +
  REASON_WEIGHTS["symbol-ref"] +
  REASON_WEIGHTS["same-folder"];

/** Top content-bearing candidates (any reason except same-folder-only). */
export const MAX_CONTENT_BEARING = 8;
/** Top same-folder-only candidates surfaced as path-only entries. */
export const MAX_SAME_FOLDER_ONLY = 12;
/** Per-folder cap before same-folder signal stops emitting (folders get noisy fast). */
export const SAME_FOLDER_CAP = 12;
