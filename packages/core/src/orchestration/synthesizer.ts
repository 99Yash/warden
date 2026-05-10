import type { ChangedFile } from "../diff/index.js";
import type { FormatterListener } from "../llm/events.js";
import { formatReview } from "../llm/formatter.js";
import { scopeToDiff, toComment } from "../runners/to-comment.js";
import type { Comment, DegradedEntry, RetrievedContext } from "../schema.js";
import type { Scratchpad } from "./scratchpad.js";

/**
 * `review`-mode synthesis (ADR-0023 #7-#8). Reads the scratchpad, flattens
 * findings → toolComments via the existing M4 mapping, calls the M4
 * formatter (cascade unchanged per ADR-0017), and appends sub-agent
 * questions verbatim. The formatter's prompt — `system.md` +
 * `user-template.md` — is byte-identical to M4; M8 is a refactor of the
 * call site, not a prompt redesign.
 *
 * Sub-agent questions (e.g. committability) **bypass** the formatter:
 * they're already grounded with substring-verified citations per
 * ADR-0021 #2/#3, so re-triaging them through the LLM would dilute the
 * lane discipline. They're appended after the formatter output.
 *
 * Vuln comments come in pre-collapsed (per ADR-0021 #8) — vuln stays
 * inline outside the scratchpad in M8 because its already-mapped
 * `Comment[]` shape doesn't fit the `Runner` contract's `findings:
 * ToolFinding[]` cleanly. M9+ may revisit if it earns its keep.
 */

export interface SynthesizeInput {
  scratchpad: Scratchpad;
  /** Pre-collapsed vuln comments produced inline (vuln runner is not
   * scratchpad-routed in M8). */
  vulnComments: Comment[];
  diff: string;
  retrievedContext: RetrievedContext;
  /** Diff-scope filter for findings; omit when running on a fixture without
   * a parsed diff. */
  changed?: ChangedFile[];
  emit?: FormatterListener;
}

export interface SynthesizeOutput {
  comments: Comment[];
  degraded: DegradedEntry[];
}

export async function synthesize(input: SynthesizeInput): Promise<SynthesizeOutput> {
  const allFindings = input.scratchpad.flatten();
  const scoped = input.changed ? scopeToDiff(allFindings, input.changed) : allFindings;
  const toolComments = scoped.map(toComment);

  // Sub-agent questions land in the scratchpad with citations already
  // verified by their producer. They bypass the formatter by design.
  const subAgentQuestions = input.scratchpad.flattenQuestions();

  if (toolComments.length === 0 && input.vulnComments.length === 0) {
    // No findings to triage → no LLM call. Sub-agent questions still flow
    // through. Same posture as M4 (formatter only runs when comments exist).
    return { comments: subAgentQuestions, degraded: [] };
  }

  const formatted = await formatReview({
    diff: input.diff,
    toolComments,
    vulnComments: input.vulnComments,
    retrievedContext: input.retrievedContext,
    emit: input.emit,
  });

  return {
    comments: [...formatted.comments, ...subAgentQuestions],
    degraded: formatted.degraded,
  };
}

/**
 * `check`-mode synthesis (ADR-0023 #7). Deterministic-only — no LLM call.
 * Mirrors `synthesize()`'s scratchpad-flattening but skips the formatter.
 * Output bytes are equivalent to pre-M8 `check` (acceptance criterion).
 */
export interface DeterministicSynthesizeInput {
  scratchpad: Scratchpad;
  vulnComments: Comment[];
  changed?: ChangedFile[];
}

export function deterministicSynthesize(
  input: DeterministicSynthesizeInput,
): SynthesizeOutput {
  const allFindings = input.scratchpad.flatten();
  const scoped = input.changed ? scopeToDiff(allFindings, input.changed) : allFindings;
  const toolComments = scoped.map(toComment);
  const subAgentQuestions = input.scratchpad.flattenQuestions();
  return {
    comments: [...toolComments, ...input.vulnComments, ...subAgentQuestions],
    degraded: [],
  };
}
