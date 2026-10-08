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
   * the floor applied without mutating process env. */
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

/**
 * Default assertion threshold for categories with no `CATEGORY_CONFIDENCE_FLOOR`
 * entry (ADR-0044 §6). Worker prompts use 0.7 for questions and ≥0.85 for
 * assertions — a model below 70% sure should ask, not assert.
 */
export const DEFAULT_ASSERTION_THRESHOLD = 0.7;

export interface ConfidenceDemotionResult {
  comments: Comment[];
  /** Per-category demotion counts paired with the effective threshold at
   * decision time, mirroring `ConfidenceFloorResult.drops`. */
  demotions: Map<Category, { count: number; threshold: number }>;
}

/**
 * True iff some source is a fully-populated `api_def` citation triple
 * pointing at an installed type declaration. Must run after
 * `verifyCitations` so the triple is verified — lane output is
 * model-owned, so a model-chosen `type: "cve"`/`"web"`/`"tool"` label is
 * not authority the post-pass can check. Letting such a label exempt a
 * finding from demotion would make demotion discretionary. The `api_def`
 * label itself is model-chosen on this path too, so the exemption
 * additionally requires the `lookupTypeDef` output contract (`schema.ts`
 * `api_def` docs): a normalized path inside `node_modules/` ending in
 * `.d.ts`. The cost of being strict is a question instead of an
 * assertion, never a drop.
 *
 * Residual (shared with m14): a real but unrelated `.d.ts` line still
 * exempts — the post-pass checks the citation is a genuine type
 * declaration, not that it is relevant to the claim.
 */
export function hasVerifiedAuthority(c: Comment): boolean {
  return c.sources.some((s) => {
    if (
      s.type !== "api_def" ||
      s.path === undefined ||
      s.line === undefined ||
      s.snippet === undefined
    ) {
      return false;
    }
    const normalized = s.path.replace(/\\/g, "/");
    const inNodeModules =
      normalized.startsWith("node_modules/") || normalized.includes("/node_modules/");
    return inNodeModules && normalized.endsWith(".d.ts");
  });
}

/**
 * Demote low-confidence assertions to questions (ADR-0044 §6). For each
 * comment with `kind === "assertion"`, no verified authority, and
 * `confidence` below the category threshold (resolved floor, else
 * `DEFAULT_ASSERTION_THRESHOLD`), rewrite `kind` to `"question"`. Tier 1
 * is not exempt — Tier-1 never drops, but it still degrades. Never drops,
 * never promotes a question.
 */
export function applyConfidenceToKind(
  comments: Comment[],
  opts: ApplyConfidenceFloorOptions = {},
): ConfidenceDemotionResult {
  const floors = resolveFloors(opts);
  const out: Comment[] = [];
  const demotions = new Map<Category, { count: number; threshold: number }>();
  for (const c of comments) {
    const threshold = floors[c.category] ?? DEFAULT_ASSERTION_THRESHOLD;
    if (c.kind === "assertion" && !hasVerifiedAuthority(c) && c.confidence < threshold) {
      out.push({ ...c, kind: "question" });
      const prev = demotions.get(c.category);
      demotions.set(c.category, { count: (prev?.count ?? 0) + 1, threshold });
      continue;
    }
    out.push(c);
  }
  return { comments: out, demotions };
}

export function demotionsToDegraded(
  demotions: Map<Category, { count: number; threshold: number }>,
): DegradedEntry[] {
  const entries: DegradedEntry[] = [];
  for (const [cat, { count, threshold }] of demotions) {
    entries.push({
      kind: "info",
      topic: cat,
      message: `Demoted ${count} low-confidence ${cat} ${
        count === 1 ? "assertion" : "assertions"
      } below threshold ${threshold} to questions`,
    });
  }
  return entries;
}

function resolveFloors(opts: ApplyConfidenceFloorOptions): Partial<Record<Category, number>> {
  // Static map is the v0 source of truth. The explicit smoke override wins
  // over env so a same-process test can flip the floor; env wins over the
  // static default when the smoke override is absent.
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
