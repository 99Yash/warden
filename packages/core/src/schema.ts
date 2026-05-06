import { z } from 'zod';

/**
 * Comment schema mirroring `vision.md` §14. The full LLM-formatted comment
 * shape is fixed in v0 so future bots/wrappers (ADR-0013) can serialize
 * against a stable contract. Most fields are populated only when M4 lands;
 * M1 returns an empty `comments` array.
 */

export const SourceTypeEnum = z.enum([
  'cve',
  'advisory',
  'changelog',
  'documentation',
  'web',
  'tool',
  'repo_convention',
]);
export type SourceType = z.infer<typeof SourceTypeEnum>;

export const CategoryEnum = z.enum([
  'correctness',
  'clarity',
  'style',
  'dedup',
  'tests',
  'security',
  'vulnerability',
  'contract',
]);
export type Category = z.infer<typeof CategoryEnum>;

export const TierEnum = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export type Tier = z.infer<typeof TierEnum>;

/**
 * Distinguishes assertions (claims grounded in tool/CVE evidence) from
 * questions (LLM-generated clarification asks per the M4 grilling decision).
 * Questions may have empty `sources[]` — asking is not claiming, so the
 * citation thesis is preserved.
 */
export const KindEnum = z.enum(['assertion', 'question']);
export type Kind = z.infer<typeof KindEnum>;

export const SourceSchema = z.object({
  type: SourceTypeEnum,
  url: z.url().optional(),
  id: z.string().optional(),
  title: z.string().optional(),
  /** ISO-8601 timestamp when the source was retrieved (citation freshness). */
  retrievedAt: z.string(),
});
export type Source = z.infer<typeof SourceSchema>;

export const CommentSchema = z.object({
  id: z.string(),
  file: z.string(),
  lineStart: z.number().int().nonnegative(),
  lineEnd: z.number().int().nonnegative(),
  tier: TierEnum,
  category: CategoryEnum,
  kind: KindEnum.default('assertion'),
  claim: z.string(),
  explanation: z.string(),
  suggestedAction: z.string().optional(),
  sources: z.array(SourceSchema).default([]),
  /** Confidence score in [0, 1]; comments below threshold are silently dropped. */
  confidence: z.number().min(0).max(1),
});
export type Comment = z.infer<typeof CommentSchema>;

export const CommentSetMetadataSchema = z.object({
  durationMs: z.number().nonnegative(),
  /** Workers that timed out or otherwise failed; surfaced per `vision.md` §11. */
  degradedWorkers: z.array(z.string()).default([]),
});
export type CommentSetMetadata = z.infer<typeof CommentSetMetadataSchema>;

export const CommentSetSchema = z.object({
  comments: z.array(CommentSchema),
  metadata: CommentSetMetadataSchema,
});
export type CommentSet = z.infer<typeof CommentSetSchema>;

/**
 * Forward-compat shape for the M5+ context-selection layer (per ADR-0016 +
 * the indexing-design discussion). M4 always passes `{ chunks: [] }` — the
 * placeholder lets the LLM prompt template render an empty context section
 * today and a populated one once the selector lands, without retrofitting.
 *
 * Each chunk carries enough citation metadata that the LLM can reference it
 * via `Source { type: 'repo_convention', ... }` in future assertions.
 */
export const RetrievedChunkSchema = z.object({
  path: z.string(),
  lineStart: z.number().int().nonnegative(),
  lineEnd: z.number().int().nonnegative(),
  snippet: z.string(),
  /** Why the selector picked this chunk (e.g. "imports same module", "structurally similar"). */
  reason: z.string(),
  sourceType: SourceTypeEnum,
});
export type RetrievedChunk = z.infer<typeof RetrievedChunkSchema>;

export const RetrievedContextSchema = z.object({
  chunks: z.array(RetrievedChunkSchema).default([]),
});
export type RetrievedContext = z.infer<typeof RetrievedContextSchema>;
