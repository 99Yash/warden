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
 * line-number integers, was **1,410,562 B standalone** — **76.5%** of the
 * review-mode total and **78.1%** of the check-mode total at the pinned range
 * `eecefea...92fe52d`. Reproduce with `measure:review-bundle`.
 *
 * So the components get three different treatments:
 *
 * - **Findings ship inline**, capped and paged. They are the product; handing
 *   back a handle instead of the finding would make the tool useless.
 * - **`addedLines` does not cross the wire** — only `path` + `addedLineCount`.
 *   Six files in this repo consume it — `runners/to-comment.ts` (`scopeToDiff`),
 *   `review-harness/comment-scope.ts` (`scopeCommentsToDiff`, called from
 *   `harness.ts`), `runners/_shared.ts` plus the scalability/deadcode/leverage
 *   detectors, `diff/prune.ts`, `review-harness/boss-loop.ts`, and
 *   `review-harness/workers/file-snippet.ts`. **All of them are internal to
 *   warden** and none is reachable from the MCP wire. An external caller needs
 *   the file list and a count, not 120,318 integers. (Round 0 caught an earlier
 *   version of this comment claiming there were only two consumers; the
 *   conclusion held, the stated reason did not.)
 * - **Retrieved context ships as locators**, not snippets — and this one is
 *   *not* bounded by the constants round 0 hoped. See the note below.
 *
 * ## Retrieved context is NOT structurally bounded (round-0 correction)
 *
 * `MAX_CONTENT_BEARING = 8` and `SAME_FOLDER_CAP = 12` cap **candidates**, not
 * chunks, and prompt assembly emits one chunk per merged evidence range with no
 * snippet-byte ceiling (`context/prompt.ts:37-51`). Measured on the pinned
 * range: **14 chunks / 44,321 B**, largest single snippet **5,693 B**. A
 * hand-built adversarial fixture (one candidate, ten widely-spaced 1,000-char
 * lines) reached **115,537 B from a single selected candidate** — that figure
 * comes from a constructed case rather than a retained measurement, so read it
 * as an illustration that no bound exists, not as a reproducible number. There
 * is no structural worst case to quote; the figure must be measured. Context
 * therefore ships as `{path, lineStart, lineEnd}` locators, which is a stronger
 * reason than the one originally given.
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
   * The count caps above are **not** sufficient alone: the smoke's synthetic
   * case of 50 findings each carrying a 400-character evidence snippet
   * serializes past the 64 KiB backstop without any of them being individually
   * unrepresentable. `smoke:mcp-run-det-priors` asserts that case.
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
 * `findings` goes **first** despite being last in `OMITTED_COMPONENTS` — round 1
 * aliased this to the component enum and thereby inverted the priority, so a
 * 40-finding page that delivered 20 findings also delivered **zero** changed
 * files where round 0 delivered all ten. Findings still go first because a
 * trimmed finding remainder is *recoverable*: the client pages on with
 * `nextOffset`. `degraded` goes **last**, deliberately — a silently-dropped
 * degradation is exactly the "one unavailable detector fails quietly" failure
 * ADR-0053 §5(c) exists to prevent.
 */
const TRIM_ORDER = ["findings", "changedFiles", "contextHandles", "degraded"] as const;

/** Serialized size of one entry, measured the way the wire measures it. */
function entryBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value, null, 2), "utf8") + 10;
}

/**
 * Headroom held back for the `omissions` array itself.
 *
 * The budget is enforced against the page *body*, but the emitted page also
 * carries `omissions` — up to four entries of roughly 150 B. Without this
 * reserve the serialized result overran `pageByteBudget` by exactly the size of
 * the array reporting the overrun.
 */
const OMISSION_RESERVE_BYTES = 1024;

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
  /**
   * Where traversal stopped: the index of the first finding neither delivered nor
   * rejected as oversized. Computed by the planner, not derived from
   * `page.length` — round 1 derived it from the delivered count, which is only
   * equivalent when nothing is skipped.
   */
  let nextOffset = start;

  const compose = (): ReviewBundleBody => {
    const more = nextOffset < allFindings.length;
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

  // ---- Phase 1: make room for findings -----------------------------------
  //
  // The non-finding components are trimmed first *in effect* (findings are
  // trimmed last), so shrink them until the page with zero findings leaves a
  // usable reserve. Without the reserve a bulky `contextHandles.reason` could
  // consume the entire budget, leave zero capacity, make every finding look
  // oversized, and then be trimmed away itself — leaving a 525-byte page that
  // claimed nothing was retrievable (round 1).
  const RESERVE_FRACTION = 0.5;
  const reserve = Math.floor(BUNDLE_LIMITS.pageByteBudget * RESERVE_FRACTION);
  const shrinkTo = (component: "changedFiles" | "contextHandles" | "degraded"): number =>
    component === "changedFiles"
      ? changed.included.length
      : component === "contextHandles"
        ? handles.included.length
        : degraded.included.length;
  const shrink = (component: "changedFiles" | "contextHandles" | "degraded", next: number): void => {
    if (component === "changedFiles") {
      changed = { included: changed.included.slice(0, next), total: totals.changedFiles };
    } else if (component === "contextHandles") {
      handles = { included: handles.included.slice(0, next), total: totals.contextHandles };
    } else {
      degraded = { included: degraded.included.slice(0, next), total: totals.degraded };
    }
  };

  page = [];
  let body = compose();
  for (const component of ["changedFiles", "contextHandles", "degraded"] as const) {
    for (;;) {
      if (bodyBytes(body) + OMISSION_RESERVE_BYTES <= BUNDLE_LIMITS.pageByteBudget - reserve) break;
      const current = shrinkTo(component);
      if (current === 0) break;
      shrink(component, Math.floor(current / 2));
      body = compose();
    }
  }

  // ---- Phase 2: pack the findings ----------------------------------------
  //
  // Walk forward from `start`, classifying each entry against the capacity left
  // over once everything else is placed:
  //
  //   - too big even alone  -> **skip it and keep going**, counting it as
  //     unretrievable. Round 1 stopped here, or kept it and dropped the small
  //     findings behind it, and in both cases reported the small findings as
  //     impossible when they were reachable in ~1.3 KB.
  //   - fits, room remains  -> include it.
  //   - fits, no room left  -> stop; the rest is a later page.
  //
  // Progress is therefore unconditional: every entry examined is either
  // delivered or rejected, so `nextOffset` always advances while findings
  // remain. There is no reachable state that hands back a non-progressing cursor.
  const capacityFor = (overhead: number): number =>
    BUNDLE_LIMITS.pageByteBudget - overhead - OMISSION_RESERVE_BYTES;

  /**
   * Greedy forward pack. `capacity` is what is left after everything else is
   * placed. Returns the packed slice, how much of it was used, how many entries
   * were rejected as individually oversized, and where traversal stopped.
   */
  const pack = (
    capacity: number,
  ): { packed: BundleFinding[]; used: number; rejected: number; cursor: number } => {
    const packed: BundleFinding[] = [];
    let used = 0;
    let rejected = 0;
    let i = start;
    while (i < allFindings.length) {
      const size = entryBytes(allFindings[i]);
      if (size > capacity) {
        rejected++;
        i++;
        continue;
      }
      if (used + size > capacity) break;
      packed.push(allFindings[i] as BundleFinding);
      used += size;
      i++;
    }
    return { packed, used, rejected, cursor: i };
  };

  const overhead = bodyBytes(body);
  let plan = pack(capacityFor(overhead));
  page = plan.packed;
  nextOffset = plan.cursor;
  body = compose();

  // `entryBytes` measures a finding standalone; nested in the page array it is
  // re-indented, so the estimate runs low and the first pack can overrun. Correct
  // by scaling capacity by the observed overshoot rather than halving the page:
  // halving after the cursor has advanced drops findings without delivering or
  // rejecting them (round 1 shipped that and lost ~14 findings per page).
  for (let attempt = 0; attempt < 3; attempt++) {
    const size = bodyBytes(body) + OMISSION_RESERVE_BYTES;
    if (size <= BUNDLE_LIMITS.pageByteBudget) break;
    const spent = size - overhead;
    if (spent <= 0) break;
    const scaled = Math.floor(
      capacityFor(overhead) * ((BUNDLE_LIMITS.pageByteBudget - overhead) / spent),
    );
    if (scaled >= capacityFor(overhead)) break; // no progress available
    plan = pack(scaled);
    page = plan.packed;
    nextOffset = plan.cursor;
    body = compose();
  }

  // Final safety, if measurement noise still leaves it over: trim the tail AND
  // rewind the cursor to match what was actually delivered. Rewinding is safe
  // because traversal is idempotent — entries are re-examined, and an oversized
  // one is simply rejected again on the next page. Losing them is not.
  while (bodyBytes(body) + OMISSION_RESERVE_BYTES > BUNDLE_LIMITS.pageByteBudget && page.length > 0) {
    page = page.slice(0, Math.floor(page.length / 2));
    nextOffset = start + page.length;
    body = compose();
  }

  const included: Record<(typeof TRIM_ORDER)[number], number> = {
    findings: page.length,
    changedFiles: changed.included.length,
    contextHandles: handles.included.length,
    degraded: degraded.included.length,
  };
  const omissions: BundleOmission[] = [];
  for (const component of OMITTED_COMPONENTS) {
    const total = totals[component];
    if (total <= included[component]) continue;
    // `included`/`omitted` describe **this response**; `total` is the whole
    // result. For findings, `omitted` therefore also counts entries an earlier
    // page already delivered — the serializer is stateless and cannot know that.
    // Use `nextOffset` to size what is genuinely still ahead.
    const extra =
      component === "findings" && plan.rejected > 0 ? { unretrievable: plan.rejected } : {};
    omissions.push({
      component,
      total,
      included: included[component],
      omitted: total - included[component],
      ...extra,
    });
  }

  return { ...body, ...(omissions.length > 0 ? { omissions } : {}) };
}
