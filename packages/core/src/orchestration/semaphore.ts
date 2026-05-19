/**
 * In-memory FIFO semaphore (ADR-0033).
 *
 * Used by the review harness to cap concurrent worker dispatches per LLM
 * tier. One pair of `{ strong, cheap }` instances is constructed per
 * `runReview()` invocation in `harness.ts` and threaded into the dispatch
 * tool — never module-global, so a process running multiple reviews
 * concurrently (vitest, future bot worker pool) keeps each review's
 * queue isolated.
 *
 * Shape is intentionally minimal: positive-integer concurrency cap, FIFO
 * waiter queue, idempotent release. No timers, no `AbortSignal`, no
 * priorities — those earn their rows when a real surface needs them
 * (see ADR-0033 §6). Releasing past the cap is a no-op; double-release
 * is a no-op.
 *
 * @example
 * ```ts
 * const sem = new Semaphore(4);
 * const { release, waitMs } = await sem.acquire();
 * try { await doWork(); } finally { release(); }
 * ```
 */
export class Semaphore {
  private readonly maxConcurrent: number;
  private inFlight = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(maxConcurrent: number) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new Error(
        `Semaphore: maxConcurrent must be a positive integer (got ${maxConcurrent}).`,
      );
    }
    this.maxConcurrent = maxConcurrent;
  }

  /**
   * Acquire a slot. Resolves immediately when capacity is available;
   * otherwise blocks until a holder releases.
   *
   * Returns `{ release, waitMs }`:
   *   - `release`: idempotent release fn — call in `finally` to free the
   *     slot on both success + failure paths.
   *   - `waitMs`: 0 when the slot was available immediately; positive
   *     wall-clock ms when the call queued behind an existing holder.
   *     The semaphore measures `waitMs` internally (not by the caller)
   *     so a `Date.now()` measurement that crosses a microtask boundary
   *     while inflight < cap can't false-positive as a "real" wait. The
   *     ADR-0033 aggregator filters on `waitMs > 0` to stay silent on
   *     the happy path.
   */
  async acquire(): Promise<{ release: () => void; waitMs: number }> {
    if (this.inFlight < this.maxConcurrent) {
      this.inFlight += 1;
      return { release: this.makeRelease(), waitMs: 0 };
    }
    const queuedAt = Date.now();
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
    // The releaser hands its slot directly to the woken waiter without
    // touching `inFlight`, so this path inherits the slot count.
    return { release: this.makeRelease(), waitMs: Date.now() - queuedAt };
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) {
        next();
        return;
      }
      this.inFlight -= 1;
    };
  }
}
