import type { CommentSetMetadata } from "../schema.js";

/**
 * The spend that a failed review knows at the failure. The fields have the
 * same meaning as the cost fields of `CommentSetMetadata`: when
 * `usageUnknownRequests` is set, the token counts and the cost are lower
 * bounds. `costUsd` is absent when no model request reported usage.
 */
export interface ReviewSpend extends Pick<
  CommentSetMetadata,
  "tokenUsage" | "costUsd" | "costByTier" | "costLabels" | "usageUnknownRequests"
> {
  /** The `reviewRuns` row that holds the same spend (ADR-0048 §2). */
  runId: string;
}

/**
 * `runReviewHarness()` throws this error when the boss loop hard-fails.
 * The message is the message of the boss error, unchanged, and `cause` is
 * the boss error. `spend` is the spend known at the failure, or `undefined`
 * when the usage could not be read: usage is telemetry, so a failed usage
 * read never replaces the failure.
 */
export class ReviewFailedError extends Error {
  override readonly name = "ReviewFailedError";
  readonly spend: ReviewSpend | undefined;

  constructor(cause: unknown, spend: ReviewSpend | undefined) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.spend = spend;
  }
}
