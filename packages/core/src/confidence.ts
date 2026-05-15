import { wardenEnv } from "@warden/env";
import type { Category, Comment, DegradedEntry } from "./schema.js";

/**
 * Per-category confidence floor (ADR-0028 §5 / CONTEXT.md §7). v0 ships
 * exactly one non-zero entry; future categories opt in by adding a key to
 * the map. Style is the natural next candidate per CONTEXT.md §7's note.
 *
 * Applied in `applyHardRules()` *before* the priority sort. **Tier-1
 * findings bypass the floor unconditionally** — the critical-finding
 * short-circuit from `project_warden_security_depth_tiers.md`. A clear-cut
 * Tier-1 security finding (e.g. ESLint's `detect-eval-with-expression`)
 * surfaces regardless of confidence; the floor only curates the noisier
 * sub-agent residue.
 *
 * Override surface: `WARDEN_SECURITY_CONFIDENCE_FLOOR` env var. Future
 * categories add their own env var on demand — there is no per-category
 * config file, flag, or per-comment threshold per ADR-0028 alternatives.
 */
export const CATEGORY_CONFIDENCE_FLOOR: Partial<Record<Category, number>> = {
  security: 0.8,
};

export interface ConfidenceFloorResult {
  kept: Comment[];
  /** Per-category drop counts paired with the effective floor at decision
   * time, so the degraded-entry message can quote the actual threshold
   * (env override or static default) rather than always-the-default. */
  drops: Map<Category, { count: number; floor: number }>;
}

export interface ApplyConfidenceFloorOptions {
  /** Override the `security` floor — used by smoke harnesses that need
   * the floor applied without mutating process env (and to dodge
   * `wardenEnv()`'s parse-once singleton in same-process test runs). */
  securityFloor?: number;
}

/**
 * Drop comments whose confidence is below their category's floor. Tier-1
 * bypasses unconditionally. Returns the surviving comments plus per-category
 * drop counts so the caller can fold them into `CommentSet.degradedWorkers`.
 */
export function applyConfidenceFloor(
  comments: Comment[],
  opts: ApplyConfidenceFloorOptions = {},
): ConfidenceFloorResult {
  const floors = resolveFloors(opts);
  const kept: Comment[] = [];
  const drops = new Map<Category, { count: number; floor: number }>();
  for (const c of comments) {
    if (c.tier === 1) {
      kept.push(c);
      continue;
    }
    const floor = floors[c.category];
    if (floor === undefined || c.confidence >= floor) {
      kept.push(c);
      continue;
    }
    const prev = drops.get(c.category);
    drops.set(c.category, { count: (prev?.count ?? 0) + 1, floor });
  }
  return { kept, drops };
}

export function dropsToDegraded(
  drops: Map<Category, { count: number; floor: number }>,
): DegradedEntry[] {
  const entries: DegradedEntry[] = [];
  for (const [cat, { count, floor }] of drops) {
    entries.push({
      kind: "info",
      topic: cat,
      message: `Dropped ${count} low-confidence ${cat} ${
        count === 1 ? "finding" : "findings"
      } below floor ${floor}`,
    });
  }
  return entries;
}

function resolveFloors(opts: ApplyConfidenceFloorOptions): Partial<Record<Category, number>> {
  // Static map is the v0 source of truth. The explicit smoke override wins
  // over env so a same-process test can flip the floor without fighting
  // `wardenEnv()`'s singleton cache; env wins over the static default when
  // the smoke override is absent.
  if (opts.securityFloor !== undefined) {
    return { ...CATEGORY_CONFIDENCE_FLOOR, security: opts.securityFloor };
  }
  let envFloor: number | undefined;
  try {
    const env = wardenEnv();
    if (env.WARDEN_SECURITY_CONFIDENCE_FLOOR !== undefined) {
      envFloor = Number(env.WARDEN_SECURITY_CONFIDENCE_FLOOR);
    }
  } catch {
    // Env validation failures are surfaced elsewhere (the CLI's first
    // wardenEnv() call). Confidence-floor is a downstream consumer; falling
    // back to the static map keeps the review running rather than escalating
    // an env error through a category-filter code path.
  }
  if (envFloor !== undefined) {
    return { ...CATEGORY_CONFIDENCE_FLOOR, security: envFloor };
  }
  return { ...CATEGORY_CONFIDENCE_FLOOR };
}
