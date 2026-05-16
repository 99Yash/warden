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
  // M11 (ADR-0026): a type-definition citation produced by `lookupTypeDef`.
  // Re-uses SourceSchema's M10 {path, line, snippet} triple — `path` =
  // dts_file (repoRoot-relative, points into node_modules/), `line` =
  // line_start, `snippet` = the single-line-normalized signature. `id`
  // carries `${package}@${version}#${symbol}`; `title` carries
  // `${kind} ${symbol}`. Verified by the API-claim-verifier post-pass.
  'api_def',
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
  // ADR-0020: Copilot-delta categories (M6). The LLM emits these only as
  // questions — there are no deterministic producers yet (M7+ work).
  'scalability',
  'consistency',
  'deadcode',
  'committability',
  // ADR-0027: M12 — second producer pair against the ADR-0008 citation thesis.
  // The leverage detector emits assertions for bounded stdlib patterns; the
  // leverage sub-agent emits questions for library-substitution suggestions.
  'leverage',
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

export const SourceSchema = z
  .object({
    type: SourceTypeEnum,
    url: z.url().optional(),
    id: z.string().optional(),
    title: z.string().optional(),
    /** ISO-8601 timestamp when the source was retrieved (citation freshness). */
    retrievedAt: z.string(),
    /**
     * M10 (ADR-0021 §3): grounded citation triple. Producers that quote file
     * content (committability sub-agent, future LLM workers, future
     * snippet-citing detectors) populate all three. Tool-grounded sources
     * (TSC / ESLint / npm-audit / OSV) leave them undefined — their grounding
     * is the tool's exit code, not a snippet to substring-verify.
     *
     * Invariant: either all three of `{path, line, snippet}` are populated or
     * all three are undefined. The `.refine()` below enforces this at parse
     * time — partial triples fail validation rather than being silently
     * skipped downstream. The global verifier (`verify-citations.ts`) then
     * substring-checks every fully-populated triple and drops sources whose
     * snippet does not match the cited file at `line ± DRIFT`.
     */
    path: z.string().optional(),
    line: z.number().int().positive().optional(),
    snippet: z.string().optional(),
  })
  .refine(
    (s) =>
      (s.path !== undefined && s.line !== undefined && s.snippet !== undefined) ||
      (s.path === undefined && s.line === undefined && s.snippet === undefined),
    {
      message:
        "Source citation triple must be all-or-nothing: populate {path, line, snippet} together or leave all three undefined",
    },
  );
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

/**
 * Discriminated `degradedWorkers` entry (ADR-0021 #7). Replaces the M4/M5
 * flat-string shape so the banner renderer reads `kind` instead of substring-
 * matching prefixes. Topic is an open string with conventional values
 * (`context`, `osv`, `gitignore`, `committability`, `scalability`,
 * `consistency`, `deadcode`, `embeddings`, `schema`, `llm`, `vuln`, `tsc`,
 * `eslint`, `jscpd`, `audit`, `banner`, `ecosystem`) so new workers add
 * their own without churn.
 *
 *  - `actionable`: user can fix this; surfaces in default mode + the banner.
 *  - `warning`: a worker partially failed but the review is still useful;
 *    verbose-only by default.
 *  - `info`: forensic / informational; never blocks; verbose-only.
 */
export const DegradedEntrySchema = z.object({
  kind: z.enum(["actionable", "warning", "info"]),
  topic: z.string(),
  message: z.string(),
});
export type DegradedEntry = z.infer<typeof DegradedEntrySchema>;

/**
 * M14 (ADR-0030): per-model-tier token usage surfaced on `CommentSet`.
 * `opus` is the boss; `sonnet` and `haiku` are the worker tiers
 * (sonnet for correctness/scalability/consistency/security; haiku for
 * committability/leverage by default). Cached input tokens are tracked
 * when the provider reports them (Anthropic ≥ 2026-01).
 */
export const TokenUsageBlockSchema = z.object({
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  cachedInputTokens: z.number().nonnegative().optional(),
});
export type TokenUsageBlock = z.infer<typeof TokenUsageBlockSchema>;

export const TokenUsageByTierSchema = z.object({
  opus: TokenUsageBlockSchema.optional(),
  sonnet: TokenUsageBlockSchema.optional(),
  haiku: TokenUsageBlockSchema.optional(),
});
export type TokenUsageByTier = z.infer<typeof TokenUsageByTierSchema>;

export const CommentSetMetadataSchema = z.object({
  durationMs: z.number().nonnegative(),
  /** Workers that timed out or otherwise failed; surfaced per `vision.md` §11. */
  degradedWorkers: z.array(DegradedEntrySchema).default([]),
  /**
   * Per-model-tier token usage (M14+). Absent on the check-mode path
   * (no LLM call) and on review runs where every LLM call's `usage`
   * field came back undefined. Render layer reads this to compute the
   * cost summary line.
   */
  tokenUsage: TokenUsageByTierSchema.optional(),
  /**
   * Total estimated USD cost of the LLM calls. Computed from
   * `tokenUsage` via a static pricing table inline in the harness
   * (Opus 4.6 = $5/$25 per 1M; Sonnet 4.6 = $3/$15; Haiku 4.5 = $1/$5
   * as of 2026-05). Absent when token usage is absent.
   */
  costUsd: z.number().nonnegative().optional(),
});
export type CommentSetMetadata = z.infer<typeof CommentSetMetadataSchema>;

export const CommentSetSchema = z.object({
  comments: z.array(CommentSchema),
  metadata: CommentSetMetadataSchema,
});
export type CommentSet = z.infer<typeof CommentSetSchema>;

/**
 * Output of the M5 context-selection layer (ADR-0018). `chunks` carries the
 * evidence-bearing ranges with ±5 lines of surrounding code; `sameFolderPaths`
 * is the path-only awareness signal for same-folder neighbors (folders are
 * noisy → no content surfaced).
 *
 * Each chunk carries enough citation metadata that the LLM can reference it
 * via `path:line` in clarification questions. M4 always passed `{ chunks: [] }`;
 * M5 populates both fields and the formatter renders them in two distinct
 * prompt sections.
 */
export const RetrievedChunkSchema = z.object({
  path: z.string(),
  lineStart: z.number().int().nonnegative(),
  lineEnd: z.number().int().nonnegative(),
  snippet: z.string(),
  /** Why the selector picked this chunk (e.g. "imported-by src/login.ts", "symbol-ref login"). */
  reason: z.string(),
  sourceType: SourceTypeEnum,
});
export type RetrievedChunk = z.infer<typeof RetrievedChunkSchema>;

export const RetrievedContextSchema = z.object({
  chunks: z.array(RetrievedChunkSchema).default([]),
  /** Same-folder neighbors — path-only awareness signal, no content. */
  sameFolderPaths: z.array(z.string()).default([]),
});
export type RetrievedContext = z.infer<typeof RetrievedContextSchema>;
