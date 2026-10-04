import { z } from "zod";
import { CommentSchema, DegradedEntrySchema } from "./schema.js";
import { toComment } from "./runners/to-comment.js";
import type { ToolFinding } from "./runners/types.js";
import type { DetPriors } from "./review-harness/harness.js";

/**
 * The review-bundle serializer — ADR-0053 §5(a), as measured 2026-10-03 and
 * corrected by review round 0 (2026-10-04).
 *
 * This module is the CLI-agnostic seam #40 requires. It is deliberately *pure*:
 * it takes a `DetPriors` that Phase 1 already produced and projects it into a
 * bounded, versioned shape. It runs no detector, reads no file, and resolves no
 * git ref — the MCP tool owns transport and diff resolution, the CLI owns
 * process exit codes, and both consume this one projection so the two paths
 * cannot drift.
 *
 * ## Why the shape is per-component, not bundle-vs-handles
 *
 * The ADR originally framed this as "return the bundle, or return handles."
 * Measured on this repo's own history (pinned in the ADR amendment), the full
 * `DetPriors` serializes to ~1.8 MB pretty, and the component breakdown is
 * dominated by one field: `ChangedFile.addedLines`, a JSON array of bare
 * line-number integers, was **~1.4 MB standalone** — roughly 78-93% of the
 * payload depending on whether you measure the component standalone or embedded.
 *
 * So the components get three different treatments:
 *
 * - **Findings ship inline**, capped and paged. They are the product; handing
 *   back a handle instead of the finding would make the tool useless.
 * - **`addedLines` does not cross the wire** — only `path` + `addedLineCount`.
 *   It has at least eight consumers in this repo (`scopeToDiff`,
 *   `scopeCommentsToDiff`, `comment-scope`, `_shared.parseFile` and the
 *   scalability/deadcode/leverage detectors, `pruneDiff`, `boss-loop`,
 *   `file-snippet`) and **all of them are internal to warden** — none is
 *   reachable from the MCP wire. An external caller needs the file list and a
 *   count, not 120,318 integers. (Round 0 caught an earlier version of this
 *   comment claiming there were only two consumers; the conclusion held, the
 *   stated reason did not.)
 * - **Retrieved context ships as locators**, not snippets — and this one is
 *   *not* bounded by the constants round 0 hoped. See the note below.
 *
 * ## Retrieved context is NOT structurally bounded (round-0 correction)
 *
 * `MAX_CONTENT_BEARING = 8` and `SAME_FOLDER_CAP = 12` cap **candidates**, not
 * chunks, and prompt assembly emits one chunk per merged evidence range with no
 * snippet-byte ceiling (`context/prompt.ts:37-51`). A single candidate with ten
 * widely-spaced evidence ranges produces ten chunks; a constructed case reached
 * **115,537 B** of retrieved context from *one* selected candidate. So context
 * size is bounded in practice by the selector's candidate caps but has no byte
 * guarantee of its own — which is precisely why it ships as `{path, lineStart,
 * lineEnd}` locators here and the caller fetches code on demand.
 */

/**
 * Bundle shape version. Independent of `TOOL_ENVELOPE_VERSION`: that one
 * versions the *envelope* every tool shares, this one versions the payload
 * inside one tool's envelope. Bumped when a field here changes shape. Adding an
 * optional field is additive.
 *
 * This module is the **single owner** of the bundle's wire shape. `@warden/mcp`
 * re-binds `ReviewBundlePageSchema` rather than re-spelling it — the same
 * discipline `lookup-type-def.ts` follows with
 * `LookupTypeDefResultSchema = LookupTypeDefFoundResultSchema`, and the reason
 * round 0 flagged the first version of this file: a hand-copied schema had
 * silently weakened `category` to `z.string()` and dropped `SourceSchema`'s
 * all-or-nothing citation-triple refinement, so a `{path, line}` citation with
 * no snippet validated on the wire.
 */
export const REVIEW_BUNDLE_VERSION = 2 as const;

/**
 * Per-component caps. These make the result bounded *by construction* rather than
 * by truncation after the fact; the hard byte backstop in `@warden/mcp` is only
 * a guard against pathological single-item payloads, not the sizing mechanism.
 *
 * `DEGRADED_CAP` matches the existing prompt-side precedent in
 * `review-harness/boss-loop.ts` so the two paths agree on how many degraded
 * entries are worth surfacing.
 */
export const BUNDLE_LIMITS = {
  changedFiles: 200,
  findingsPerPage: 50,
  findingsDefaultPage: 25,
  contextHandles: 8,
  degraded: 20,
  /**
   * Byte budget for the serialized page, measured the same way
   * `MAX_TOOL_RESULT_BYTES` is: UTF-8 bytes of `JSON.stringify(page, null, 2)`,
   * which is exactly what `@warden/mcp` puts on the wire.
   *
   * The count caps above are **not** sufficient alone: 50 findings carrying a
   * 24-line source window serialize to ~80 KB, over the 64 KiB backstop.
   *
   * This budget closes that gap **without truncating a citation** — ADR-0053
   * forbids that, because a partial citation is not ground truth. Whole entries
   * are dropped instead, and every drop is reported in `omissions`.
   */
  pageByteBudget: 48 * 1024,
} as const;

export interface BundleFindingLimits {
  /** Max findings on one page. Clamped to `BUNDLE_LIMITS.findingsPerPage`. */
  limit?: number;
}

export const BundleFindingSchema = CommentSchema.extend({
  /**
   * Which producer emitted this. For tool findings, `ToolFinding.source`
   * (`tsc`, `eslint`, `jscpd`, …). For vulnerability comments — which arrive as
   * canonical `Comment`s from the audit/OSV path, not as `ToolFinding`s — the
   * literal `"vuln"`, with the real citation carried in `sources[].type`.
   */
  detector: z.string(),
});

export const BundleChangedFileSchema = z.strictObject({
  path: z.string(),
  /**
   * How many lines this diff added to the file. This is the *count*, not the
   * line-number array — see the module docstring for why the array stays inside
   * warden.
   */
  addedLineCount: z.number().int().nonnegative(),
});

export const BundleContextHandleSchema = z.strictObject({
  path: z.string(),
  lineStart: z.number().int().nonnegative(),
  lineEnd: z.number().int().nonnegative(),
  /**
   * Why the selector picked this chunk, as a human-readable label. Not a content
   * hash: `RetrievedChunk` carries no `chunkHash`, because
   * `renderReasonLabel` (`context/prompt.ts:90-116`) renders the semantic reason
   * as `semantic similarity=…` and drops the hash when materializing chunks.
   */
  reason: z.string(),
  sourceType: z.string(),
});

const OMITTED_COMPONENTS = ["changedFiles", "findings", "contextHandles", "degraded"] as const;

export const BundleOmissionSchema = z.strictObject({
  component: z.enum(OMITTED_COMPONENTS),
  /** How many entries exist in total. */
  total: z.number().int().nonnegative(),
  /** How many were actually included. */
  included: z.number().int().nonnegative(),
  /** `total - included`. */
  omitted: z.number().int().nonnegative(),
  /**
   * Entries that exist but **cannot be delivered at any page size** — a finding
   * whose own serialization exceeds the byte budget on its own. Distinct from a
   * trimmed remainder, which is recoverable by paging. When this is present the
   * tool emits no `nextOffset`, because handing back a cursor that returns the
   * same page forever is the non-progressing-cursor defect round 0 found.
   */
  unretrievable: z.number().int().nonnegative().optional(),
});

/**
 * The page without its omission report. Named rather than derived with `Omit`,
 * because `Omit` over a schema carrying a catchall/unknown key collapses the
 * named keys.
 */
export const ReviewBundleBodySchema = z.strictObject({
  schemaVersion: z.literal(REVIEW_BUNDLE_VERSION),
  /** Opaque id for one immutable retained Phase 1 result. */
  reviewHandle: z.string(),
  /** Findings on this page, as canonical `Comment`s plus an explicit producer. */
  findings: z.array(BundleFindingSchema),
  /** Total findings across all pages, so a client can size its own loop. */
  findingsTotal: z.number().int().nonnegative(),
  /**
   * Offset of the next page. Absent on the last page **and** whenever nothing was
   * delivered while findings remain — see `BundleOmissionSchema.unretrievable`.
   */
  nextOffset: z.number().int().nonnegative().optional(),
  changedFiles: z.array(BundleChangedFileSchema),
  changedFilesTotal: z.number().int().nonnegative(),
  contextHandles: z.array(BundleContextHandleSchema),
  /** Degraded entries verbatim — an unavailable runner degrades, never throws. */
  degraded: z.array(DegradedEntrySchema),
  findingsByCategory: z.record(z.string(), z.number()),
  findingsByTier: z.record(z.string(), z.number()),
});

export const ReviewBundlePageSchema = ReviewBundleBodySchema.extend({
  /** Present only when something was actually capped. */
  omissions: z.array(BundleOmissionSchema).optional(),
});

export type BundleFinding = z.infer<typeof BundleFindingSchema>;
export type BundleChangedFile = z.infer<typeof BundleChangedFileSchema>;
export type BundleContextHandle = z.infer<typeof BundleContextHandleSchema>;
export type BundleOmission = z.infer<typeof BundleOmissionSchema>;
export type ReviewBundleBody = z.infer<typeof ReviewBundleBodySchema>;
export type ReviewBundlePage = z.infer<typeof ReviewBundlePageSchema>;

/**
 * Project one `ToolFinding` onto `BundleFinding`.
 *
 * Every field except `detector` comes straight off `toComment(f)` — the *same*
 * function `runCheck` uses to build the CLI's `CommentSet`. That is the shared
 * seam: one tier/category mapping and one citation-envelope construction, and
 * the two consumers cannot disagree about either. Do not re-derive tier or
 * category here.
 */
export function toBundleFinding(f: ToolFinding): BundleFinding {
  return { ...toComment(f), detector: f.source };
}

/**
 * Vulnerability comments arrive from the audit/OSV path already shaped as
 * canonical `Comment`s, so they pass through untouched apart from the `detector`
 * label. Their `category` is `"vulnerability"` and their tier comes from
 * advisory severity (`vuln/index.ts`).
 *
 * They are deliberately **not** passed through `collapseVulnComments` or
 * `applyHardRules`. Those are CLI *output* policy — manifest filtering, the
 * Tier-3 verbose gate, the confidence floor — and folding them in here would
 * conflate Phase 1 data with one consumer's presentation rules. Round 0 found
 * this stream missing from the bundle entirely, which meant a vulnerability-only
 * Phase 1 result reported `findingsTotal: 0`: a silent false-clean on the
 * security class.
 */
function toBundleVulnFinding(c: z.infer<typeof CommentSchema>): BundleFinding {
  return { ...c, detector: "vuln" };
}

/**
 * The complete deterministic-finding projection for a Phase 1 result.
 *
 * Order matches the CLI's merge at `core/src/index.ts`
 * (`[...toolComments, ...vulnComments]`) so the two consumers agree on sequence
 * as well as content.
 */
export function projectBundleFindings(det: DetPriors): BundleFinding[] {
  return [...det.findings.map(toBundleFinding), ...det.vulnComments.map(toBundleVulnFinding)];
}

/** First `n` entries plus the total, so a capped component can report the shortfall. */
function capped<T>(items: T[], n: number): { included: T[]; total: number } {
  return { included: items.slice(0, n), total: items.length };
}

function tally(values: Array<string | number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) {
    const key = String(v);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

/** Serialized page size exactly as `@warden/mcp` will put it on the wire. */
function bodyBytes(body: ReviewBundleBody): number {
  return Buffer.byteLength(JSON.stringify(body, null, 2), "utf8");
}

/**
 * Components in the order they are sacrificed when the page is over budget.
 *
 * `findings` goes first because a trimmed remainder is *recoverable* — the client
 * pages on with `nextOffset`, or asks for a smaller `limit`. `degraded` goes
 * **last**, deliberately: a silently-dropped degradation is exactly the "one
 * unavailable detector fails quietly" failure ADR-0053 §5(c) exists to prevent,
 * so it outlives the droppable payload components.
 */
const TRIM_ORDER = OMITTED_COMPONENTS;

/**
 * Build one bounded page of the review bundle.
 *
 * Pure: same `DetPriors` in, same page out, for a given offset and limit. The
 * only field that can differ between two calls over the same input is
 * `sources[].retrievedAt`, which `toComment` stamps with the current time —
 * comment `id` is content-addressed and does *not* include it, so ids are stable.
 *
 * Cursor discipline is the load-bearing part. `nextOffset` is always derived from
 * the **finalized** delivered slice, never from the pre-trim page, and it is
 * withheld entirely when delivering nothing while findings remain. Round 0
 * caught both halves of that bug: a trimmed page advertised an offset past
 * findings it had dropped (skipping them permanently), and a single oversized
 * finding produced `cursor: "offset=0"` — a cursor that returned the same empty
 * page forever.
 *
 * @param offset Index of the first finding on this page.
 * @param limits Page size; clamped into `[1, BUNDLE_LIMITS.findingsPerPage]`.
 */
export function buildReviewBundlePage(
  det: DetPriors,
  reviewHandle: string,
  offset: number,
  limits: BundleFindingLimits = {},
): ReviewBundlePage {
  const requested = limits.limit ?? BUNDLE_LIMITS.findingsDefaultPage;
  const pageSize = Math.min(Math.max(1, Math.trunc(requested)), BUNDLE_LIMITS.findingsPerPage);
  const start = Math.max(0, Math.trunc(offset));

  const allFindings = projectBundleFindings(det);
  let page = allFindings.slice(start, start + pageSize);

  let changed = capped(
    det.changed.map((f) => ({ path: f.path, addedLineCount: f.addedLines.length })),
    BUNDLE_LIMITS.changedFiles,
  );
  let handles = capped(
    det.retrievedContext.chunks.map((c) => ({
      path: c.path,
      lineStart: c.lineStart,
      lineEnd: c.lineEnd,
      reason: c.reason,
      sourceType: c.sourceType,
    })),
    BUNDLE_LIMITS.contextHandles,
  );
  let degraded = capped(det.degraded, BUNDLE_LIMITS.degraded);

  const totals = {
    findings: allFindings.length,
    changedFiles: changed.total,
    contextHandles: handles.total,
    degraded: degraded.total,
  };

  /** Findings known to be individually too large to ever fit the byte budget. */
  let unretrievable = 0;

  const compose = (): ReviewBundleBody => {
    const delivered = page.length;
    const nextOffset = start + delivered;
    const undelivered = allFindings.length - nextOffset;
    // Progress is only advertised when the page actually advanced. Withholding
    // it when `delivered === 0 && undelivered > 0` is what stops a client
    // looping on an unpageable finding.
    const more = undelivered > 0 && delivered > 0;
    return {
      schemaVersion: REVIEW_BUNDLE_VERSION,
      reviewHandle,
      findings: page,
      findingsTotal: allFindings.length,
      ...(more ? { nextOffset } : {}),
      changedFiles: changed.included,
      changedFilesTotal: totals.changedFiles,
      contextHandles: handles.included,
      degraded: degraded.included,
      // Tallies describe the whole result, not this page, so a client sizing its
      // paging loop is not misled by a trimmed page.
      findingsByCategory: tally(allFindings.map((f) => f.category)),
      findingsByTier: tally(allFindings.map((f) => f.tier)),
    };
  };

  // Byte-budget enforcement: halve the most-droppable component until the page
  // fits. Halving (not decrementing) keeps this O(log n) and keeps the rule
  // statable in one sentence — "the page is halved until it fits the budget."
  // Whole entries only; no citation is ever truncated to make room.
  let body = compose();
  for (const component of TRIM_ORDER) {
    for (;;) {
      if (bodyBytes(body) <= BUNDLE_LIMITS.pageByteBudget) break;
      const current =
        component === "findings"
          ? page.length
          : component === "changedFiles"
            ? changed.included.length
            : component === "contextHandles"
              ? handles.included.length
              : degraded.included.length;
      if (current === 0) break;
      const next = Math.floor(current / 2);
      if (component === "findings") {
        // Dropping from the *end* of the page, so `nextOffset` still addresses
        // the first undelivered finding rather than skipping past the drop.
        if (next === 0 && current === 1) unretrievable++;
        page = page.slice(0, next);
      } else if (component === "changedFiles") {
        changed = { included: changed.included.slice(0, next), total: totals.changedFiles };
      } else if (component === "contextHandles") {
        handles = { included: handles.included.slice(0, next), total: totals.contextHandles };
      } else {
        degraded = { included: degraded.included.slice(0, next), total: totals.degraded };
      }
      body = compose();
    }
  }

  const included: Record<(typeof TRIM_ORDER)[number], number> = {
    findings: page.length,
    changedFiles: changed.included.length,
    contextHandles: handles.included.length,
    degraded: degraded.included.length,
  };
  const omissions: BundleOmission[] = [];
  for (const component of TRIM_ORDER) {
    const total = totals[component];
    if (total <= included[component]) continue;
    const undelivered = total - (component === "findings" ? start + included.findings : 0);
    const stranded = component === "findings" && included.findings === 0 && undelivered > 0;
    omissions.push({
      component,
      total,
      included: included[component],
      omitted: total - included[component],
      // Only claim unretrievable for the entries this page was actually asked
      // for and could not carry; a trimmed *remainder* is recoverable by paging
      // or by asking for a smaller `limit`.
      ...(stranded || unretrievable > 0
        ? { unretrievable: component === "findings" ? Math.max(unretrievable, undelivered) : undefined }
        : {}),
    });
  }

  return { ...body, ...(omissions.length > 0 ? { omissions } : {}) };
}
