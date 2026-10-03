import type { DetPriors } from "@warden/core";

/**
 * Bounded retention of Phase 1 results, keyed by `reviewHandle`.
 *
 * ## Why this exists
 *
 * `runDetPriors` shells out to `tsc`, `eslint` and `jscpd`, so paging through
 * findings **cannot** mean re-running it per page — a 25-finding page would
 * cost a full detector sweep. The first call therefore retains its result and
 * hands back an opaque handle; later pages address that retained result.
 *
 * This is ADR-0053 §7 state authority in the direction that matters: warden
 * owns the canonical record and the client never holds a second copy. It is
 * emphatically **not** the client's session database growing a shadow review.
 *
 * ## Why it is in-memory and bounded
 *
 * The stdio server is a single child process that dies with the client
 * (ADR-0053: client EOF drains in-flight work, then the process exits). A
 * cursor therefore cannot outlive the session, and a miss is recoverable by
 * re-issuing the original request — hence the `review_expired` reason rather
 * than a persistence layer. Entries are held as the raw `DetPriors`, not a
 * pre-serialized page, so paging cost stays independent of page size.
 *
 * Capacity is deliberately tiny. Real usage is one review target per session;
 * four entries covers a client that re-requests after a schema change without
 * letting a long-lived server accumulate whole-repo detector output.
 */

export interface ReviewResultCache {
  get(handle: string): DetPriors | undefined;
  set(handle: string, det: DetPriors): void;
  /** Number of retained results. Exposed for the smoke's eviction assertion. */
  readonly size: number;
}

export const DEFAULT_REVIEW_CACHE_CAPACITY = 4;

export function createReviewResultCache(
  capacity: number = DEFAULT_REVIEW_CACHE_CAPACITY,
): ReviewResultCache {
  // Map preserves insertion order, which is what makes the eviction below a
  // plain LRU: re-inserting on read would need a second structure.
  const entries = new Map<string, DetPriors>();
  const max = Math.max(1, Math.trunc(capacity));

  return {
    get(handle) {
      return entries.get(handle);
    },
    set(handle, det) {
      // Delete-then-set so an overwrite of the live key moves it to the
      // newest slot instead of keeping its original insertion position.
      entries.delete(handle);
      entries.set(handle, det);
      while (entries.size > max) {
        const oldest = entries.keys().next();
        if (oldest.done === true) break;
        entries.delete(oldest.value);
      }
    },
    get size() {
      return entries.size;
    },
  };
}
