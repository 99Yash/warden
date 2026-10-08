import type { ChangedFile } from "../diff/index.js";
import type { Comment } from "../schema.js";

export interface DiffScopedComments {
  comments: Comment[];
  droppedCount: number;
}

/**
 * A comment is in-scope iff at least one of its sources cites a path in
 * the trusted scope set. The comment — including its sources — is
 * model-owned on the externally-driven path; only the scope set is
 * trusted. Comments with zero path-bearing sources (e.g. pure-tool
 * sources with no `path`) are kept — they aren't pinned to any file, so
 * lane discipline doesn't apply. Extracted from the Phase 2
 * worker-dispatch boundary (`dispatch-worker.ts`) for the externally-driven
 * post-pass (ADR-0053 §4): the dispatch's file set is model-chosen, but the
 * lane's scope envelope is driver-owned, so the same membership rule runs
 * here against trusted input.
 */
export function commentInScope(comment: Comment, scope: ReadonlySet<string>): boolean {
  let sawPath = false;
  for (const src of comment.sources) {
    if (src.path === undefined) continue;
    sawPath = true;
    const normalized = src.path.replace(/\\/g, "/");
    if (scope.has(normalized)) return true;
  }
  return !sawPath;
}

/**
 * The post-pass anchor check (ADR-0053 §4): the finding's own
 * `comment.file` must be in the lane's trusted scope set. `commentInScope`
 * above only inspects `sources[].path`, which is model-owned on the
 * externally-driven path — a finding with zero sources, or with one
 * in-scope source and an out-of-scope anchor, would otherwise publish on
 * any changed file. The anchor is model-owned too, but requiring both
 * closes the sourceless/out-of-scope-anchor sequences. Kept separate from
 * `commentInScope` (and `dispatch-worker.ts` unchanged): the dispatch path
 * enforces `commentInScope` only.
 */
export function anchorInScope(comment: Comment, scope: ReadonlySet<string>): boolean {
  return scope.has(comment.file.replace(/\\/g, "/"));
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
  // Boss prompt convention: `0:0` means a file-level finding. Keep those when
  // the path is in the changed-file set; there is no line span to intersect.
  if (comment.lineStart === 0 && comment.lineEnd === 0) return true;
  if (comment.lineStart <= 0 || comment.lineEnd <= 0) return false;
  const start = Math.min(comment.lineStart, comment.lineEnd);
  const end = Math.max(comment.lineStart, comment.lineEnd);
  for (let line = start; line <= end; line++) {
    if (addedLines.has(line)) return true;
  }
  return false;
}
