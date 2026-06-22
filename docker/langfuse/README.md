# Self-hosted Langfuse (Warden dev observability)

The local stack backing Warden's **observability surface** (ADR-0048): a live,
dev-time view of every review run — boss + worker LLM calls, the tool calls each
worker made (`readFile` / `grepRepo` / `lookupTypeDef`), per-call cost, and the
**dropped-candidate spans** that explain recall moves. Grouped by **run-id** so
one review is one trace tree, and taggable by config/fixture/sample for
cross-run eval diffing.

As of 2026-06-22 (issue #32) Warden **emits spans to this stack** when the
`LANGFUSE_*` keys are set: the OTEL bootstrap + AI-SDK telemetry wiring, run-id
threading (grouped by `langfuseTraceId`), dropped-candidate spans (standalone
spans carrying the run-id — the exporter maps span *attributes*, not events,
so events would be invisible), and `reviewRuns` persistence are live (see
`packages/ai/src/observability.ts`). Absent the keys it is a total no-op. A
non-loopback `LANGFUSE_HOST` is refused unless `WARDEN_LANGFUSE_ALLOW_REMOTE` is
set, so reviewed source can't accidentally ship to Langfuse Cloud. Not yet
wired: per-call cost on spans and per-worker cache/resume (ADR-0048 §5/§8). The
end-to-end span→Langfuse mapping is best verified by running a real review
against this stack.

This is **not** ADR-0044 §7's persisted, prose-free, never-gating _review trace_
(the trust spine) — that is specified to live in `.warden/cache.sqlite` when
implemented. This surface is a non-authoritative debugging tool. See
`decisions.md` ADR-0048 and `CONTEXT.md §9`.

## Why self-hosted only

Warden reviews other people's source. The diff and repo contents flow into
prompts and — with `WARDEN_LANGFUSE_CAPTURE_IO` on (the default) — into the
spans here. So the stack binds to localhost, the secrets are local-only
throwaways, and `observability.ts` refuses a non-loopback `LANGFUSE_HOST`
unless `WARDEN_LANGFUSE_ALLOW_REMOTE` is explicitly set. **Do not** point
Warden at Langfuse Cloud or reuse these secrets for any hosted deploy.

## Usage

```bash
# start
docker compose -f docker/langfuse/docker-compose.yml up -d
# UI: http://localhost:3200   (warden@warden.local / warden-local-dev)

# wire warden (.env) — keys are bootstrapped headlessly on first boot:
#   LANGFUSE_HOST=http://localhost:3200
#   LANGFUSE_PUBLIC_KEY=pk-lf-2acd0cf8-694d-4eed-8f2f-8e7b3aaf57ea
#   LANGFUSE_SECRET_KEY=sk-lf-d4f36d8f-0372-4f8f-8199-0794be6348ed

docker compose -f docker/langfuse/docker-compose.yml down      # stop
docker compose -f docker/langfuse/docker-compose.yml down -v   # stop + wipe data
```

Host ports are offset (web 3200, worker 3032, clickhouse 8124/9002, minio
9092/9093) so this can coexist with a sibling repo's Langfuse stack. Emission
is keys-gated: with no `LANGFUSE_*` keys set, Warden never constructs the
exporter (total no-op).
