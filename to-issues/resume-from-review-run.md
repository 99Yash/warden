# Resume / per-worker output cache off the review-run key

**Severity:** medium (cost + iteration speed). **Designed in ADR-0048 §8; no code yet.**

## Problem

A review has no resume. The scratchpad is in-memory (`harness.ts:131`), nothing
is checkpointed, and the `llm_review_cache` table (ADR-0007) is wired to zero
consumers — it predates the M14 boss/worker harness and its content key doesn't
fit the worker model. So an interrupted or re-run review re-pays for every
worker from scratch, and the $11 dogfood run (handoff `2026-06-21T163552Z`) had
no way to resume after the user killed it.

## What ADR-0048 already decided

ADR-0048 ships the durable run identity this builds on:
- `reviewRuns.id` = random `createId("run")` (identity + trace grouping).
- `reviewRuns.input_hash` = content hash over `(diff_hash, resolved config,
  sorted model-set)` — the dedup/resume lookup key.

It explicitly **defers** the cache/resume implementation and names the contract:

- Cache unit = **completed worker outputs**, keyed by a per-worker sub-key
  `(concern, sorted dispatched files, prompt-hash, model)`.
- On resume of a matching `input_hash`: replay completed workers, re-enter the
  boss loop. Boss-round checkpointing is a later layer.
- This **supersedes the dead `llm_review_cache`** (ADR-0007) as the substrate.

## Open questions (for the implementation ADR/pass)

- Where does the per-worker output persist — extend `reviewRuns` with a child
  table, or a dedicated `review_worker_outputs` table keyed by the sub-key?
- Boss non-determinism: replaying workers is safe (pure-ish given inputs), but
  the boss loop's dispatch decisions vary run to run. Is "replay workers, re-run
  boss" the right granularity, or do we also memoize boss rounds?
- Invalidation: model SKU change, prompt-file change (the variant work), or a
  diff edit must all miss the cache — covered by `input_hash` + prompt-hash, but
  verify the prompt-hash actually folds in the `diligent`/variant composition.
- Interaction with the Anthropic 5-min prompt-cache TTL (orthogonal, but worth a
  note so the two caches aren't conflated).

## Refs

- ADR-0048 §8, ADR-0007 (`llm_review_cache`, superseded), `CONTEXT.md §9` (run-id, input-hash)
- `packages/core/src/review-harness/harness.ts`, `workers/dispatch.ts`, `workers/run-worker.ts`
- handoff `.handoff/2026-06-21T163552Z.md` (the killed $11 run, no-resume finding)
