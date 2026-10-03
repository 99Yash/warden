import { createHash } from "node:crypto";
import type { Category, Comment, DegradedEntry, Source, Tier } from "./schema.js";
import { toComment } from "./runners/to-comment.js";
import type { ToolFinding } from "./runners/types.js";
import type { DetPriors } from "./review-harness/harness.js";

/**
 * The review-bundle serializer — ADR-0053 §5(a), as measured 2026-10-03.
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
 * Measured on this repo's own history (`git diff eecefea HEAD`: 332 files,
 * 120,318 added lines, 257 findings) the full `DetPriors` serializes to
 * 1,807,423 B pretty / 679,080 B compact, and the breakdown is:
 *
 * | component       | pretty bytes | share |
 * | --------------- | -----------: | ----: |
 * | `changed`       |    1,410,562 | 78.0% |
 * | `findings`      |       73,535 |  4.1% |
 * | `vulnComments`  |       52,066 |  2.9% |
 * | everything else |    <1,719 ea |  0.1% |
 *
 * So the three components have very different value density and get three
 * different treatments:
 *
 * - **`addedLines` never crosses the wire.** It is ~1.39 MB of bare JSON
 *   integers; the same information as a per-file count is 2,145 B (647x less).
 *   Nothing outside warden reads it — its only consumers, `scopeToDiff`
 *   (`runners/to-comment.ts`) and `scopeCommentsToDiff`
 *   (`review-harness/harness.ts`), both run *inside* warden, downstream of
 *   Phase 1. An external caller needs the file list and a count.
 * - **Findings ship inline**, capped and paged. They are the product; handing
 *   back a handle instead of the finding would make the tool useless.
 * - **Retrieved context ships as locators**, not snippets.
 *
 * ## On the chunk payload
 *
 * ADR-0053 §5(a) warned about "an unbounded raw diff or chunk payload." The
 * chunk payload was never the risk: core already count-caps it
 * (`MAX_CONTENT_BEARING = 8`, `SAME_FOLDER_CAP = 12`,
 * `context/index.ts:103-107`), a 16-line ±5-line window measures ~786 B, and
 * the structural worst case is therefore ~6 KB.
 *
 * ## Why these are locators and not content hashes
 *
 * `RetrievedChunk` carries no `chunkHash`. The hash exists on the selector's
 * semantic `Reason` (`context/index.ts:25-30`) but `renderReasonLabel`
 * (`context/prompt.ts:90-116`) renders it as `semantic similarity=…` and drops
 * it when materializing chunks, so by the time a chunk exists the hash is
 * gone. These handles are therefore `{path, lineStart, lineEnd}` locators. A
 * content-addressed handle needs the hash plumbed through prompt assembly,
 * which is slice #44's job alongside `ChunkStore.getByHash` — that store is
 * currently never called from a request/response path.
 */

/**
 * Bundle shape version. Independent of `TOOL_ENVELOPE_VERSION`: that one
 * versions the *envelope* every tool shares, this one versions the payload
 * inside one tool's envelope. Bumped when a field here changes shape — a
 * renamed field, a narrowed enum, a changed unit. Adding an optional field is
 * additive.
 */
export const REVIEW_BUNDLE_VERSION = 1 as const;

/**
 * Per-component caps. These are what make the result bounded *by
 * construction* rather than by truncation after the fact — the hard byte
 * backstop in `@warden/mcp` is only a guard against pathological single-item
 * payloads (a 4 KB `message` string), not the normal sizing mechanism.
 *
 * Sized from the measurements above: 200 changed files is ~13 KB of paths,
 * 50 findings ~14 KB, 20 degraded entries ~2 KB, so a worst-case page lands
 * near 30 KB against a 64 KiB backstop.
 *
 * `DEGRADED_CAP` matches the existing prompt-side precedent in
 * `review-harness/boss-loop.ts:627` so the two paths agree on how many
 * degraded entries are worth surfacing.
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
   * The count caps above are **not** sufficient on their own, and the smoke
   * proves it: a page of 50 findings each carrying a 24-line evidence snippet
   * (the existing `SNIPPET_LINE_CAP`) serializes to ~75 KB, over the 64 KiB
   * backstop. Real leverage and react-doctor findings ship snippets that long,
   * so this is not a pathological input.
   *
   * This budget closes that gap **without truncating a citation** — ADR-0053
   * forbids that, because a partial citation is not ground truth. Whole
   * entries are dropped instead, and every drop is reported in `omissions`.
   *
   * Set below `MAX_TOOL_RESULT_BYTES` to leave room for the envelope wrapper
   * (tool name, version, status) that `@warden/mcp` adds around this payload.
   */
  pageByteBudget: 48 * 1024,
} as const;

export interface BundleFindingLimits {
  /** Max findings on one page. Clamped to `BUNDLE_LIMITS.findingsPerPage`. */
  limit?: number;
}

export interface BundleFinding {
  /** Warden's content-addressed comment id (`comment-id.ts`) — stable per finding. */
  id: string;
  /**
   * The `ToolFinding.source` runner that produced this finding (e.g. `tsc`,
   * `eslint`, `jscpd`). On the canonical `Comment` this is recoverable only by
   * parsing `sources[0].title`, so it is surfaced explicitly here; the
   * `Comment` fields below are passed through untouched.
   */
  detector: string;
  file: string;
  lineStart: number;
  lineEnd: number;
  tier: Tier;
  category: Category;
  claim: string;
  explanation: string;
  /** Includes the `{path, line, snippet}` evidence triple when the detector shipped one. */
  sources: Source[];
  confidence: number;
}

export interface BundleChangedFile {
  path: string;
  /**
   * How many lines this diff added to the file. This is the *count*, not the
   * line-number array — see the module docstring for why the array never
   * crosses the wire.
   */
  addedLineCount: number;
}

export interface BundleContextHandle {
  path: string;
  lineStart: number;
  lineEnd: number;
  /** Why the selector picked this chunk, as a human-readable label. */
  reason: string;
  sourceType: string;
}

export interface BundleOmission {
  /** Component that was capped. */
  component: "changedFiles" | "findings" | "contextHandles" | "degraded";
  /** How many entries exist in total. */
  total: number;
  /** How many were actually included. */
  included: number;
  /** `total - included`. */
  omitted: number;
  /**
   * How to reach the rest. `cursor` is set only for `findings`, which is the
   * one component this tool can re-page; the others are capped for good and
   * the caller reaches them another way (or not at all — see the module
   * docstring on which components are lossy and why that is acceptable).
   */
  cursor?: string;
}

/**
 * The page without its omission report. Named rather than derived with `Omit`,
 * because `Omit` over an interface carrying an index signature collapses every
 * named key — `Omit<ReviewBundlePage, "omissions">` would silently degrade to
 * the index signature alone.
 */
export interface ReviewBundleBody {
  schemaVersion: typeof REVIEW_BUNDLE_VERSION;
  /** Opaque, content-addressed id for the retained Phase 1 result. */
  reviewHandle: string;
  /** Findings on this page, as canonical `Comment`s plus an explicit detector. */
  findings: BundleFinding[];
  /** Total findings across all pages, so a client can size its own loop. */
  findingsTotal: number;
  /** Offset of the next page, absent on the last page. */
  nextOffset?: number;
  changedFiles: BundleChangedFile[];
  changedFilesTotal: number;
  contextHandles: BundleContextHandle[];
  /** Degraded entries verbatim — an unavailable runner degrades, never throws. */
  degraded: DegradedEntry[];
  findingsByCategory: Record<string, number>;
  findingsByTier: Record<string, number>;
}

/**
 * Extends `Record<string, unknown>` so the page satisfies the envelope's `data`
 * branch (`okEnvelope` requires it). zod-inferred object types satisfy that
 * constraint structurally; a hand-written interface does not, and widening the
 * envelope's generic instead would weaken the contract for every tool. Declared
 * field types are unaffected.
 */
export interface ReviewBundlePage extends ReviewBundleBody, Record<string, unknown> {
  /** Present only when something was actually capped. */
  omissions?: BundleOmission[];
}

/**
 * Content-addressed handle for a Phase 1 result.
 *
 * `runDetPriors` shells out to `tsc`/`eslint`/`jscpd`, so paging cannot mean
 * re-running it — the MCP server retains results and this handle addresses
 * them. Keying on `(repoRoot, diff)` means the same request against the same
 * diff is idempotent and cache-friendly, which also keeps the server from
 * growing a second entry per identical call.
 */
export function computeReviewHandle(repoRoot: string, diff: string): string {
  const h = createHash("sha256").update(repoRoot, "utf8").update("\0", "utf8").update(diff, "utf8");
  return `rb_${h.digest("hex").slice(0, 32)}`;
}

/**
 * Project one `ToolFinding` onto `BundleFinding`.
 *
 * Every field except `detector` is copied straight off `toComment(f)` — the
 * *same* function `runCheck` uses to build the CLI's `CommentSet`. That is the
 * shared seam: there is one tier/category mapping and one citation-envelope
 * construction, and the two consumers cannot disagree about either. Do not
 * re-derive tier or category here.
 */
export function toBundleFinding(f: ToolFinding): BundleFinding {
  const c: Comment = toComment(f);
  return {
    id: c.id,
    detector: f.source,
    file: c.file,
    lineStart: c.lineStart,
    lineEnd: c.lineEnd,
    tier: c.tier,
    category: c.category,
    claim: c.claim,
    explanation: c.explanation,
    sources: c.sources,
    confidence: c.confidence,
  };
}

/** First `n` entries plus the total, so a capped component can report the shortfall. */
function capped<T>(items: T[], n: number): { included: T[]; total: number } {
  return { included: items.slice(0, n), total: items.length };
}

function tally<T extends string | number>(values: T[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) {
    const key = String(v);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

/** Serialized page size exactly as `@warden/mcp` will put it on the wire. */
function pageBytes(page: ReviewBundleBody): number {
  return Buffer.byteLength(JSON.stringify(page, null, 2), "utf8");
}

/**
 * Components in the order they are sacrificed when the page is over budget.
 *
 * `findings` goes first because it is the only component the caller can get
 * back — the omission carries a cursor, so dropping findings is a recoverable
 * round-trip rather than a loss. `degraded` goes **last**, deliberately: a
 * silently-dropped degradation is exactly the "one unavailable detector fails
 * quietly" failure ADR-0053 §5(c) exists to prevent, so it outlives the
 * droppable payload components.
 */
const TRIM_ORDER = ["findings", "changedFiles", "contextHandles", "degraded"] as const;

/**
 * Build one bounded page of the review bundle.
 *
 * Pure: same `DetPriors` in, same page out. The only field that can differ
 * between two calls over the same input is `sources[].retrievedAt`, which
 * `toComment` stamps with the current time — comment `id` is content-addressed
 * and does *not* include it, so ids are stable across runs.
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

  // Findings first: they are the product, so page them in full-fidelity order
  // and let the summary ride along on every page.
  const allFindings = det.findings.map(toBundleFinding);
  let page = allFindings.slice(start, start + pageSize);
  let nextOffset = start + page.length;

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
      // Tallies describe the whole result, not this page, so a client sizing
      // its paging loop is not misled by a trimmed page.
      findingsByCategory: tally(allFindings.map((f) => f.category)),
      findingsByTier: tally(allFindings.map((f) => f.tier)),
    };
  };

  // Byte-budget enforcement: halve the most-droppable component until the page
  // fits. Halving (not decrementing) keeps this O(log n) and, more importantly,
  // keeps the rule simple enough to state in one sentence: "the page is halved
  // until it fits the byte budget." Whole entries only — no citation is ever
  // truncated to make room.
  let body = compose();
  for (const component of TRIM_ORDER) {
    while (pageBytes(body) > BUNDLE_LIMITS.pageByteBudget) {
      const current =
        component === "findings"
          ? page.length
          : component === "changedFiles"
            ? changed.included.length
            : component === "contextHandles"
              ? handles.included.length
              : degraded.included.length;
      if (current === 0) break;
      const next = current === 1 ? 0 : Math.floor(current / 2);
      if (component === "findings") {
        // Dropping from the *end* of the page so a cursor from `nextOffset`
        // still addresses the first undelivered finding.
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
  // `nextOffset` tracks what has actually been delivered, not what was sliced.
  nextOffset = start + page.length;

  const included: Record<(typeof TRIM_ORDER)[number], number> = {
    findings: page.length,
    changedFiles: changed.included.length,
    contextHandles: handles.included.length,
    degraded: degraded.included.length,
  };
  const omissions: BundleOmission[] = [];
  for (const component of TRIM_ORDER) {
    const total = totals[component];
    if (total > included[component]) {
      const hasMore = component === "findings" && nextOffset < total;
      omissions.push({
        component,
        total,
        included: included[component],
        omitted: total - included[component],
        ...(hasMore ? { cursor: `offset=${nextOffset}` } : {}),
      });
    }
  }

  return { ...body, ...(omissions.length > 0 ? { omissions } : {}) };
}
