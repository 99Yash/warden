import {
  buildReviewBundlePage,
  resolveDiff,
  runDetPriors,
  ReviewBundlePageSchema,
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
 * from `toComment`, which is what the CLI already uses, and the wire schema is a
 * re-bind of the core one rather than a copy.
 *
 * ## Two request shapes
 *
 * A **first page** names a review target (`diff`, or `base` for git). A
 * **continuation** names the `reviewHandle` it was given. Continuations do not
 * re-resolve refs and do not re-run detectors: `runDetPriors` shells out to
 * `tsc`/`eslint`/`jscpd`, so paging by re-submitting the target would cost a full
 * detector sweep per page *and* silently review whatever the refs point at now.
 *
 * Round 0 found the first version keyed the cache on a `(repoRoot, diff)`
 * fingerprint, which conflated request identity with result identity: two
 * identical requests double-wrote one key, fixing the working tree and
 * re-requesting returned the same handle with different contents, and advancing
 * `HEAD` made a still-cached snapshot unreachable. The handle is now allocated
 * per completed run and identifies exactly one immutable result.
 *
 * ## No `head` parameter
 *
 * Round 0 also caught that accepting a `head` ref manufactured false-cleans: git
 * would supply that revision's diff while `tsc` and the file-reading detectors
 * inspected the **current working tree**, so a request for a known-broken
 * revision returned `status: "ok"` with zero findings. Supporting `head`
 * correctly needs an isolated target checkout, which is real work and out of
 * scope here, so the parameter is absent rather than present-and-wrong.
 */

/** Wire schema: a re-bind of the core owner, never a copy. */
export const RunDetPriorsResultSchema = ReviewBundlePageSchema;

/**
 * Three request shapes behind an explicit `target` discriminator, rather than
 * inferred from which fields are present. A model picking a shape from field
 * presence alone reliably sends both `diff` and `base` at once; naming the shape
 * makes the choice part of the request.
 */
const RunDetPriorsRequestSchema = z.discriminatedUnion("target", [
  z.strictObject({
    target: z.literal("diff"),
    /**
     * Unified diff text, as `git diff` would produce it. **May be empty** — a
     * clean checkout yields `""`, and that is a legitimate "nothing to review",
     * not an input error. Round 1 rejected it with `.min(1)`, which made an
     * empty literal diff disagree with an empty git-resolved one.
     */
    diff: z.string(),
    /** `review` (default) selects context + banner; `check` is the working-tree mode. */
    mode: z.enum(["check", "review"]).default("review"),
    /** Findings per page. Clamped to `BUNDLE_LIMITS.findingsPerPage`. */
    limit: z.number().int().positive().optional(),
  }),
  z.strictObject({
    target: z.literal("base"),
    /** Base ref; diffed as `<base>...HEAD`. */
    base: z.string().min(1),
    mode: z.enum(["check", "review"]).default("review"),
    limit: z.number().int().positive().optional(),
  }),
  z.strictObject({
    target: z.literal("page"),
    /** Handle from a previous page. Addresses one immutable retained result. */
    reviewHandle: z.string().min(1),
    /** The `nextOffset` a previous page returned. */
    offset: z.number().int().nonnegative(),
    limit: z.number().int().positive().optional(),
  }),
]);

/**
 * Wrapped in a single-property object rather than exposed as the union directly,
 * because MCP requires `inputSchema.type === "object"` at the root (the SDK
 * validates listings against `ToolSchema`) and a bare `discriminatedUnion`
 * serializes with no root `type`. The nesting is what lets the wire schema keep
 * the discriminated union — and therefore keep runtime validation of which
 * fields belong together — while still satisfying the protocol.
 */
export const RunDetPriorsInputSchema = z.strictObject({
  request: RunDetPriorsRequestSchema,
});

export type RunDetPriorsInput = z.infer<typeof RunDetPriorsInputSchema>;

export interface RunDetPriorsDeps {
  cache: ReviewResultCache;
}

/**
 * Allocate an id for one immutable retained result.
 *
 * Not derived from the request: two runs of the same target are two results, and
 * collapsing them would let a later run silently replace the pages of a review
 * already in progress. The id only has to be unique within this server process,
 * which the cache's own keying guarantees.
 */
function newReviewHandle(): string {
  return `rb_${crypto.randomUUID().replace(/-/g, "")}`;
}

function invalidInput(detail: string): ToolResultEnvelope {
  return errorEnvelope(
    TOOL_NAME_RUN_DET_PRIORS,
    "invalid_input",
    'Expected a { "request": { ... } } object. First page: ' +
      '{ "request": { "target": "diff", "diff": "<unified diff>" } } or ' +
      '{ "request": { "target": "base", "base": "<ref>" } }. ' +
      'Continuation: { "request": { "target": "page", "reviewHandle": "<handle>", "offset": <n> } }. ' +
      `Got: ${detail}`,
  );
}

export async function runRunDetPriors(
  repoRoot: string,
  input: unknown,
  deps: RunDetPriorsDeps,
): Promise<ToolResultEnvelope> {
  const parsed = RunDetPriorsInputSchema.safeParse(input);
  if (!parsed.success) {
    return invalidInput(parsed.error.message);
  }
  const args = parsed.data.request;

  // ---- continuation -------------------------------------------------------
  if (args.target === "page") {
    const det = deps.cache.get(args.reviewHandle);
    if (det === undefined) {
      return errorEnvelope(
        TOOL_NAME_RUN_DET_PRIORS,
        "review_expired",
        `No retained result for handle "${args.reviewHandle}". The server holds at most a few results and this one was evicted, or the server restarted. Start a new review with ` +
          `{ "request": { "target": "diff", "diff": "<unified diff>" } } or ` +
          `{ "request": { "target": "base", "base": "<ref>" } }.`,
      );
    }
    return okEnvelope(
      TOOL_NAME_RUN_DET_PRIORS,
      buildReviewBundlePage(
        det,
        args.reviewHandle,
        args.offset,
        args.limit === undefined ? {} : { limit: args.limit },
      ),
    );
  }

  // ---- first page: resolve the target -------------------------------------
  let diffText: string;
  let diffBase: { baseRef?: string; description: string } | undefined;

  if (args.target === "diff") {
    diffText = args.diff;
  } else {
    const resolved = await resolveDiff({ repoRoot, mode: args.mode, baseRef: args.base });
    // A git failure is a **failed target**, not an empty review. Round 0 caught
    // this returning `status: "ok"` with zero findings and the failure buried in
    // an info entry — indistinguishable from a clean repo, which is the
    // silent-false-clean shape issue #29 is about. So it fails here, before any
    // detector runs, and the reason rides the envelope.
    //
    // `resolveDiff` sets `degraded` only when git itself failed, so there is no
    // merge-with-partial-warnings case to handle on the success path.
    if (resolved.degraded) {
      return errorEnvelope(
        TOOL_NAME_RUN_DET_PRIORS,
        "invalid_input",
        `Could not resolve the review target: ${resolved.description}. ${resolved.degraded.map((d) => d.message).join(" ")}`,
      );
    }
    diffText = resolved.diff;
    diffBase = {
      ...(resolved.baseRef === undefined ? {} : { baseRef: resolved.baseRef }),
      description: resolved.description,
    };
  }

  const det = await runDetPriors({ diff: diffText, repoRoot, mode: args.mode, diffBase });
  // One handle per completed run. Not derived from the target: two runs of the
  // same diff are two results, and keying on the request would let a later run
  // silently replace the pages of a review already in progress.
  const handle = newReviewHandle();
  deps.cache.set(handle, det);

  return okEnvelope(
    TOOL_NAME_RUN_DET_PRIORS,
    buildReviewBundlePage(det, handle, 0, args.limit === undefined ? {} : { limit: args.limit }),
  );
}
