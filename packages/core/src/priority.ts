import type { Category, Comment } from "./schema.js";

/**
 * Canonical review-priority order (ADR-0012, extended by ADR-0020). Lower
 * index posts first. Shared by `applyHardRules()` (the m14 `review` path)
 * and the externally-driven post-pass (`post-pass.ts`) so both paths sort
 * identically.
 */
export const PRIORITY_ORDER: Category[] = [
  "correctness",
  "security",
  "vulnerability",
  "contract",
  "scalability",
  "consistency",
  "deadcode",
  "committability",
  "clarity",
  "style",
  "leverage",
  "dedup",
  "tests",
];

/**
 * Priority comparator: category order, then tier ascending, then confidence
 * descending. Byte-identical semantics to the inline sort formerly in
 * `applyHardRules()`.
 */
export function compareByPriority(a: Comment, b: Comment): number {
  const pa = PRIORITY_ORDER.indexOf(a.category);
  const pb = PRIORITY_ORDER.indexOf(b.category);
  if (pa !== pb) return pa - pb;
  if (a.tier !== b.tier) return a.tier - b.tier;
  return b.confidence - a.confidence;
}
