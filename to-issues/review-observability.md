# Per-worker review observability (trace what each worker investigated)

**Severity:** medium (tooling). **Maybe an ADR** if we adopt a hosted backend.

## Problem

Iterating on recall (the `diligent` variant, lever B/C, prompt tweaks) is
blind right now. The CLI surfaces only the final `Comment[]` + cost + degraded
entries. To know *why* recall moved, we need to see, per worker: which files it
`readFile`'d, what it `grepRepo`'d, which symbols it traced, how many steps it
spent, and which candidate findings it dropped pre-citation. Today none of that
is observable — a worker that never grepped a caller and a worker that grepped
and cleared it look identical in the output.

This is the enabling instrumentation for the whole "judgmental review" revamp:
every lever above is a hypothesis about worker behavior we currently can't
inspect.

## Options

- **Local-first:** structured per-worker trace events (tool calls, step count,
  dropped candidates) written to the existing scratchpad + an optional
  `--trace` JSON dump. No new dependency. Probably the right v0.
- **Hosted (Langfuse or similar):** the AI SDK has OTEL/telemetry hooks;
  `streamText` calls in `boss-loop.ts` / `run-worker.ts` could emit spans. Gives
  flame-graph-style trace inspection and prompt/version diffing across eval
  runs. Heavier; only worth it if we go all-in on the reasoned-lane bet.

Recommendation: build the local trace first (cheap, unblocks lever A/B/C
iteration); defer the hosted backend until a lever proves out and we want
cross-run comparison.

## Refs

- `packages/core/src/review-harness/scratchpad.ts`, `run-worker.ts`, `boss-loop.ts`
- memory `project_warden_recall_is_agency_gap`
