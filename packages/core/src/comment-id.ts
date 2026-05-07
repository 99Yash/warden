import { createHash } from "node:crypto";

/**
 * Stable, content-addressed comment id. Re-running a review on the same diff
 * with the same finding produces the same id — required for the future
 * GitHub PR bot's update-don't-duplicate semantics (ADR-0013) and for the
 * content-addressed LLM cache (ADR-0007 / vision.md §9).
 *
 * Callers build a deterministic key from the finding's identity (file, line,
 * rule id, source, message for tool findings; file, line, GHSA, package for
 * vuln findings) and pass it here.
 */
export function stableCommentId(key: string): string {
  return `W-${createHash("sha256").update(key).digest("hex").slice(0, 10)}`;
}
