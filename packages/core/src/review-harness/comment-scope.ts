import type { ChangedFile } from "../diff/index.js";
import type { Comment } from "../schema.js";

export interface DiffScopedComments {
  comments: Comment[];
  droppedCount: number;
}

/**
 * Keep only comments whose rendered line range overlaps an added line.
 *
 * Deterministic runner findings already use the same range-overlap policy via
 * `scopeToDiff()`. This is the matching post-pass for LLM-authored comments:
 * the worker may read caller/callee context outside the diff, but the review
 * surface should stay anchored to lines introduced by the patch.
 */
export function scopeCommentsToDiff(
  comments: Comment[],
  changed: ChangedFile[],
): DiffScopedComments {
  const byPath = new Map<string, Set<number>>();
  for (const file of changed) byPath.set(file.path, new Set(file.addedLines));

  const kept: Comment[] = [];
  let droppedCount = 0;

  for (const comment of comments) {
    const addedLines = byPath.get(comment.file);
    if (addedLines !== undefined && overlapsAddedLine(comment, addedLines)) {
      kept.push(comment);
    } else {
      droppedCount += 1;
    }
  }

  return { comments: kept, droppedCount };
}

function overlapsAddedLine(comment: Comment, addedLines: Set<number>): boolean {
  if (comment.lineStart <= 0 || comment.lineEnd <= 0) return false;
  const start = Math.min(comment.lineStart, comment.lineEnd);
  const end = Math.max(comment.lineStart, comment.lineEnd);
  for (let line = start; line <= end; line++) {
    if (addedLines.has(line)) return true;
  }
  return false;
}
