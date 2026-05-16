import { z } from "zod";
import { SourceSchema } from "../../schema.js";

/**
 * Per-finding output shape emitted by every M14 review-harness worker. Each
 * worker calls `streamText({ output: Output.object({ schema: WorkerOutputSchema }) })`
 * and lets the AI SDK enforce this shape; the shared worker runtime then
 * maps each `WorkerFinding` to a `Comment` with a `stableCommentId`, the
 * concern's category, and a `retrievedAt` defaulted timestamp on bare
 * `tool` sources.
 *
 * Differences from `CommentSchema`:
 *   - No `id` — assigned by the shared worker runtime via `stableCommentId(...)`.
 *   - No `category` — assigned by the dispatcher from the worker's concern slug.
 *   - No `file` — derived from `path` (the worker-level field). `Comment.file`
 *     mirrors the first source's path, which equals `path` by lane-discipline.
 *   - `tier`/`confidence` carry sensible defaults (`tier: 2`, `confidence: 0.75`)
 *     so workers can omit them when their prompt's template doesn't fill them in.
 *
 * `sources[]` reuses the canonical `SourceSchema` so api_def sources from
 * `lookupTypeDef` can be copied verbatim and pass schema validation
 * unchanged. The shared runtime injects `retrievedAt: new Date().toISOString()`
 * on any source missing it (`api_def` sources from `lookupTypeDef.suggestedSource`
 * already carry the field).
 */

export const WorkerFindingSchema = z.object({
  path: z.string().min(1).describe(
    "Repo-relative POSIX path to the file the finding is about. MUST be a member of " +
      "the dispatched `files` set — out-of-lane findings are dropped silently.",
  ),
  lineStart: z.number().int().nonnegative().describe("1-indexed start line; 0 for file-level."),
  lineEnd: z.number().int().nonnegative().describe("1-indexed end line (≥ lineStart)."),
  tier: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(2),
  kind: z.enum(["assertion", "question"]).default("assertion"),
  claim: z.string().min(1).describe("One concrete sentence."),
  explanation: z.string().min(1).describe("1–2 sentences naming the failure mode + the fix shape."),
  suggestedAction: z.string().optional().describe("One imperative sentence; omit when the fix is obvious."),
  confidence: z.number().min(0).max(1).default(0.75),
  sources: z
    .array(SourceSchema)
    .min(1)
    .describe(
      "At least one source with a `{path, line, snippet}` triple from the dispatched file. " +
        "Add `api_def` sources verbatim from `lookupTypeDef.suggestedSource` when the finding " +
        "hinges on a library API claim.",
    ),
});
export type WorkerFinding = z.infer<typeof WorkerFindingSchema>;

export const WorkerOutputSchema = z.object({
  findings: z.array(WorkerFindingSchema).default([]),
});
export type WorkerOutput = z.infer<typeof WorkerOutputSchema>;
