/**
 * Reasoned-lane Step 1 (ADR-0044 precision; `reasoned-lane-plan.md` §Step 1).
 *
 * Off-hunk anchoring drop. In `warden review` every emitted comment is
 * boss-produced (sourced det-priors + the collapsed vuln summary surface only
 * in `warden check` — see `runCheck` in `../index.ts`), so a comment that
 * points at a line the diff never added is almost always noise the boss
 * hallucinated onto unchanged context. This module is the deterministic guard
 * for that false-positive class — four of the eight `alfred-pr131-falsepos`
 * precision traps are exactly this shape.
 *
 * Pure, no I/O. Wired into `applyHardRules()` for the `m14-review` path only;
 * `check` and the m18-security path never pass an added-line map, so their
 * comments are never anchoring-dropped.
 */

import { parseUnifiedDiff } from "../diff/index.js";
import type { Comment } from "../schema.js";

/**
 * Build the path → added-line-set map the anchoring drop consumes. Keys are
 * repo-relative POSIX paths (matching `Comment.file`); values are the new-side
 * line numbers the diff added for that file.
 */
export function buildAddedLineMap(diff: string): ReadonlyMap<string, ReadonlySet<number>> {
  return new Map(parseUnifiedDiff(diff).map((cf) => [cf.path, new Set(cf.addedLines)]));
}

/**
 * A comment is anchored iff its `[lineStart, lineEnd]` range overlaps at least
 * one added line in its target file. Context lines just outside a hunk
 * legitimately sit next to added lines, so we require overlap with one added
 * line — not that every cited line be added. A comment on a file with no added
 * lines (or absent from the diff) is unanchored.
 */
export function anchorsToAddedLine(
  comment: Pick<Comment, "file" | "lineStart" | "lineEnd">,
  addedLinesByFile: ReadonlyMap<string, ReadonlySet<number>>,
): boolean {
  const added = addedLinesByFile.get(comment.file);
  if (added === undefined || added.size === 0) return false;
  for (let line = comment.lineStart; line <= comment.lineEnd; line++) {
    if (added.has(line)) return true;
  }
  return false;
}

/**
 * Partition comments into anchored (kept) and the count dropped for being
 * anchored outside the diff's added lines.
 */
export function dropUnanchoredComments(
  comments: Comment[],
  addedLinesByFile: ReadonlyMap<string, ReadonlySet<number>>,
): { kept: Comment[]; dropped: number } {
  const kept = comments.filter((c) => anchorsToAddedLine(c, addedLinesByFile));
  return { kept, dropped: comments.length - kept.length };
}
