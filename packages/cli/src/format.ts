import type { CommentSet, ReviewInput } from "@warden/core";
import pc from "picocolors";

/**
 * Pretty-prints a `CommentSet` for terminal output. Severity-colored,
 * priority-ordered (per ADR-0012), with OSC 8 hyperlinks for `file:line`
 * references where the terminal supports them.
 *
 * M1 stub: prints a "not implemented yet" message and the empty result.
 * M4 will fill this in with the full priority-ordered renderer.
 */
export function formatCommentSet(
  result: CommentSet,
  mode: ReviewInput["config"]["mode"],
): string {
  if (result.comments.length === 0) {
    return [
      pc.dim(`warden ${mode}: not implemented yet (M1 scaffold).`),
      pc.dim(`  duration: ${result.metadata.durationMs}ms`),
      result.metadata.degradedWorkers.length > 0
        ? pc.yellow(`  degraded workers: ${result.metadata.degradedWorkers.join(", ")}`)
        : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  // Placeholder for M4: priority-ordered render (correctness → clarity → style → dedup → tests).
  return result.comments.map((c) => `${c.file}:${c.lineStart}  ${c.claim}`).join("\n");
}
