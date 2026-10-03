import {
  buildReviewBundlePage,
  computeReviewHandle,
  resolveDiff,
  runDetPriors,
  type DegradedEntry,
  type DetPriors,
  type DiffMode,
} from "@warden/core";
import { z } from "zod";
import {
  TOOL_NAME_RUN_DET_PRIORS,
  errorEnvelope,
  okEnvelope,
  type ToolResultEnvelope,
} from "../envelope.js";
import type { ReviewResultCache } from "../review-cache.js";

/**
 * `run_det_priors` — ADR-0053 §5, Phase 1 over MCP.
 *
 * Wraps the same exported `runDetPriors()` the CLI's `runCheck` calls, and
 * projects it through `buildReviewBundlePage` — the shared serializer in
 * `@warden/core`. There is no second bundle implementation here by
 * construction: the tier/category mapping and the citation envelope both come
 * from `toComment`, which is what the CLI already uses.
 *
 * ## Sizing
 *
 * The result is bounded **by construction**, not by truncation. Each component
 * has a cap in `BUNDLE_LIMITS` and every capped component emits an entry in
 * `omissions` naming the total, so nothing vanishes without being reported.
 *
 * The single most important property here is that `ChangedFile.addedLines` does
 * not cross the wire. Measured on this repo's own history, that one field was
 * **78%** of the entire Phase 1 payload — ~1.39 MB of bare JSON line-number
 * integers on a 332-file diff, versus 2,145 B for the same information as
 * per-file counts. Nothing outside warden reads it: its only consumers
 * (`scopeToDiff`, `scopeCommentsToDiff`) both run downstream inside warden.
 *
 * Retrieved context ships as `{path, lineStart, lineEnd}` locators rather than
 * snippets, for a second reason: core already caps retrieved context at 8
 * content-bearing chunks, so it was never the hazard — but locators also let a
 * client fetch the code it actually needs on demand instead of paying for 8
 * snippets it may never read.
 */

/** Wire schema for the bundle payload. Mirrors `buildReviewBundlePage`'s shape. */
export const RunDetPriorsResultSchema = z.object({
  schemaVersion: z.literal(1),
  reviewHandle: z.string(),
  findings: z.array(
    z.object({
      id: z.string(),
      detector: z.string(),
      file: z.string(),
      lineStart: z.number().int().nonnegative(),
      lineEnd: z.number().int().nonnegative(),
      tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
      category: z.string(),
      claim: z.string(),
      explanation: z.string(),
      sources: z.array(z.record(z.string(), z.unknown())),
      confidence: z.number().min(0).max(1),
    }),
  ),
  findingsTotal: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative().optional(),
  changedFiles: z.array(
    z.object({ path: z.string(), addedLineCount: z.number().int().nonnegative() }),
  ),
  changedFilesTotal: z.number().int().nonnegative(),
  contextHandles: z.array(
    z.object({
      path: z.string(),
      lineStart: z.number().int().nonnegative(),
      lineEnd: z.number().int().nonnegative(),
      reason: z.string(),
      sourceType: z.string(),
    }),
  ),
  degraded: z.array(
    z.object({
      kind: z.enum(["actionable", "warning", "info"]),
      topic: z.string(),
      message: z.string(),
    }),
  ),
  findingsByCategory: z.record(z.string(), z.number()),
  findingsByTier: z.record(z.string(), z.number()),
  omissions: z
    .array(
      z.object({
        component: z.enum(["changedFiles", "findings", "contextHandles", "degraded"]),
        total: z.number().int().nonnegative(),
        included: z.number().int().nonnegative(),
        omitted: z.number().int().nonnegative(),
        cursor: z.string().optional(),
      }),
    )
    .optional(),
});

/**
 * Input schema. A review target is either a literal `diff` or a `base`/`head`
 * ref pair resolved through core's `resolveDiff` — which owns the three-dot
 * merge-base semantics, so this tool does not re-derive them.
 */
export const RunDetPriorsInputSchema = z
  .object({
    /** Unified diff text. Mutually exclusive with `base`. */
    diff: z.string().optional(),
    /** Base ref; diffed as `<base>...<head>`. */
    base: z.string().optional(),
    /** Right-hand ref. Defaults to `HEAD`. Ignored when `diff` is supplied. */
    head: z.string().optional(),
    /** `review` (default) selects context + banner; `check` is the working-tree mode. */
    mode: z.enum(["check", "review"]).default("review"),
    /** Findings per page. Clamped to `BUNDLE_LIMITS.findingsPerPage`. */
    limit: z.number().int().positive().optional(),
    /** Paging offset from a previous page's `nextOffset`. Omit for the first page. */
    offset: z.number().int().nonnegative().optional(),
  })
  .refine((v) => (v.diff === undefined) !== (v.base === undefined), {
    message: "Provide exactly one of `diff` or `base`",
  });

export type RunDetPriorsInput = z.infer<typeof RunDetPriorsInputSchema>;

export interface RunDetPriorsDeps {
  cache: ReviewResultCache;
}

/**
 * Cursor lookup. Returns the retained result for a handle, or a degraded
 * `review_expired` envelope naming the recovery. Split out so the eviction path
 * is testable without a live client.
 */
function resolveCursor(
  deps: RunDetPriorsDeps,
  handle: string,
): { det: DetPriors } | { envelope: ToolResultEnvelope } {
  const det = deps.cache.get(handle);
  if (det === undefined) {
    return {
      envelope: errorEnvelope(
        TOOL_NAME_RUN_DET_PRIORS,
        "review_expired",
        `No retained result for handle "${handle}". The server holds at most a few results and this one was evicted, or the server restarted since the first page. Re-issue the original request without \`offset\`.`,
      ),
    };
  }
  return { det };
}

export async function runRunDetPriors(
  repoRoot: string,
  input: unknown,
  deps: RunDetPriorsDeps,
): Promise<ToolResultEnvelope> {
  const parsed = RunDetPriorsInputSchema.safeParse(input);
  if (!parsed.success) {
    return errorEnvelope(
      TOOL_NAME_RUN_DET_PRIORS,
      "invalid_input",
      `Expected { diff } or { base, head?, mode?, limit?, offset? }; got ${parsed.error.message}`,
    );
  }
  const { diff: literalDiff, base, head, mode, limit, offset } = parsed.data;

  // Resolve the diff text, then key retention on (repoRoot, diff) so an
  // identical re-request is idempotent instead of a second cache entry.
  let diffText: string;
  let diffBase: { baseRef?: string; description: string } | undefined;
  const extraDegraded: DegradedEntry[] = [];
  if (literalDiff !== undefined) {
    diffText = literalDiff;
  } else {
    const resolved = await resolveDiff({
      repoRoot,
      mode: mode as DiffMode,
      ...(base === undefined ? {} : { baseRef: base }),
      ...(head === undefined ? {} : { headRef: head }),
    });
    if (resolved.diff === "") {
      // A git failure degrades to an empty diff plus an actionable entry, so
      // the review still returns a well-formed empty result explaining itself
      // rather than a bare protocol error.
      if (resolved.degraded) extraDegraded.push(...resolved.degraded);
    }
    diffText = resolved.diff;
    diffBase = {
      ...(resolved.baseRef === undefined ? {} : { baseRef: resolved.baseRef }),
      description: resolved.description,
    };
  }

  const handle = computeReviewHandle(repoRoot, diffText);

  // Paging path: reuse the retained result, do not re-run detectors.
  if (offset !== undefined) {
    const found = resolveCursor(deps, handle);
    if ("envelope" in found) return found.envelope;
    return okEnvelope(TOOL_NAME_RUN_DET_PRIORS, buildReviewBundlePage(found.det, handle, offset, limit === undefined ? {} : { limit }));
  }

  const det = await runDetPriors({ diff: diffText, repoRoot, mode: mode as DiffMode, diffBase });
  deps.cache.set(handle, det);

  const merged =
    extraDegraded.length === 0
      ? det
      : { ...det, degraded: [...extraDegraded, ...det.degraded] };
  return okEnvelope(
    TOOL_NAME_RUN_DET_PRIORS,
    buildReviewBundlePage(merged, handle, 0, limit === undefined ? {} : { limit }),
  );
}
