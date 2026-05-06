import { z } from "zod";
import { CommentSchema } from "../schema.js";

/**
 * LLM output contract per the M4 grilling Q4 decision (F3 + schema reuse).
 *
 * Field types are pulled from `CommentSchema.shape` so the LLM output stays
 * in sync with the canonical Comment shape — if the assertion comment shape
 * changes, the LLM patch shape changes alongside it without a parallel edit.
 *
 * Hard rule baked into the schema: the LLM cannot author `sources[]`,
 * `tier`, `category`, `file`, `line*`, or `id` for revisions — those fields
 * aren't part of `RevisedCommentSchema`. The LLM can only patch human-prose
 * fields (`claim`, `explanation`, `suggestedAction`) and `confidence` (which
 * the surrounding code clamps to be ≤ the input's confidence — see Q4).
 */

const c = CommentSchema.shape;

/**
 * One revision the LLM wants to apply to a tool finding. `id` references
 * the input comment. Unmentioned ids are kept verbatim by the formatter
 * (default-keep per Q9 / M1).
 */
export const RevisedCommentSchema = z.object({
  id: c.id,
  claim: c.claim.optional(),
  explanation: c.explanation.optional(),
  suggestedAction: c.suggestedAction,
  confidence: c.confidence.optional(),
  drop: z.boolean().optional(),
});
export type RevisedComment = z.infer<typeof RevisedCommentSchema>;

/**
 * A clarification question the LLM wants to ask. Anchored to a file/line
 * range. No `sources[]` — questions don't claim, they ask, so the citation
 * thesis is preserved. The formatter assigns `id`, `kind: 'question'`, and
 * a synthesized `tier` before adding to the final comment list.
 */
export const QuestionSchema = z.object({
  file: c.file,
  lineStart: c.lineStart,
  lineEnd: c.lineEnd,
  category: c.category,
  claim: c.claim,
  explanation: c.explanation,
  confidence: c.confidence,
});
export type Question = z.infer<typeof QuestionSchema>;

export const LlmOutputSchema = z.object({
  revisedComments: z.array(RevisedCommentSchema).default([]),
  questions: z.array(QuestionSchema).default([]),
});
export type LlmOutput = z.infer<typeof LlmOutputSchema>;
