import { trace, type AttributeValue } from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { wardenEnv } from "@warden/env";
import { LangfuseExporter } from "langfuse-vercel";

/**
 * ADR-0048 — the live OTEL→self-hosted-Langfuse observability surface.
 *
 * This is the ONE place the OTEL bootstrap + Langfuse exporter live (the
 * package-boundary rule in §3: `@warden/core` sets telemetry metadata but
 * never imports Langfuse or an exporter). The surface is:
 *
 *   - **gated on keys** — absent `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY`
 *     the SDK is never constructed, `buildReviewTelemetry()` returns
 *     `{ isEnabled: false }`, and every `streamText` call path is unchanged
 *     (§7: keys-present = on, else total no-op);
 *   - **self-hosted only** — the exporter points at `LANGFUSE_HOST` (defaults
 *     to the local Docker stack); pointing at Langfuse Cloud is out of scope
 *     for v0 (§6). Source flows into spans, so it must not leave the box;
 *   - **I/O capture defaults ON** when keys are present, gated by
 *     `WARDEN_LANGFUSE_CAPTURE_IO` (§6 prose carve-out — Langfuse is
 *     non-authoritative dev tooling, distinct from ADR-0044 §7's prose-free
 *     trust spine);
 *   - **best-effort** — any failure constructing or flushing the SDK is
 *     swallowed (a review must never break because telemetry is misconfigured).
 *
 * The AI SDK's `experimental_telemetry` auto-emits OTEL spans for every LLM
 * call AND every tool call (`readFile` / `grepRepo` / `lookupTypeDef`), which
 * is the per-worker investigation signal recall iteration needs (§3). All
 * calls in one review group into a single Langfuse trace via the
 * `langfuseTraceId` metadata key set to the run-id.
 */

type ObservabilityState =
  | { kind: "uninit" }
  | { kind: "off" }
  | { kind: "on"; sdk: NodeSDK; captureIo: boolean };

let _state: ObservabilityState = { kind: "uninit" };

/**
 * Idempotently bootstrap the OTEL SDK + Langfuse exporter. Returns the
 * resolved state. Called lazily by `buildReviewTelemetry()` so a review with
 * no Langfuse keys never touches OTEL at all. Construction failures degrade to
 * `off` (logged once) rather than throwing — telemetry must never break a run.
 */
function ensureObservability(): ObservabilityState {
  if (_state.kind !== "uninit") return _state;
  const env = wardenEnv();
  if (!env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY) {
    _state = { kind: "off" };
    return _state;
  }
  // §6 "must not leave the box": reviewed source flows into spans when capture
  // is on, so refuse a non-loopback `LANGFUSE_HOST` unless the operator opts in
  // explicitly. A fat-fingered Langfuse Cloud URL would otherwise exfiltrate
  // other people's code — degrade to off (one loud warn) instead.
  if (!isLocalHost(env.LANGFUSE_HOST) && !env.WARDEN_LANGFUSE_ALLOW_REMOTE) {
    // eslint-disable-next-line no-console -- silent-off would hide an exfil-shaped misconfig.
    console.warn(
      `[warden:observability] LANGFUSE_HOST="${env.LANGFUSE_HOST}" is not a loopback/local address; ` +
        `telemetry disabled so reviewed source never leaves the box. ` +
        `Set WARDEN_LANGFUSE_ALLOW_REMOTE=1 to override (ADR-0048 §6).`,
    );
    _state = { kind: "off" };
    return _state;
  }
  try {
    const sdk = new NodeSDK({
      // LangfuseExporter implements OTEL's `SpanExporter`. NodeSDK wires it as
      // the trace exporter; no auto-instrumentations are registered — we only
      // want the AI SDK's own `experimental_telemetry` spans.
      traceExporter: new LangfuseExporter({
        publicKey: env.LANGFUSE_PUBLIC_KEY,
        secretKey: env.LANGFUSE_SECRET_KEY,
        baseUrl: env.LANGFUSE_HOST,
      }),
    });
    sdk.start();
    _state = { kind: "on", sdk, captureIo: env.WARDEN_LANGFUSE_CAPTURE_IO };
  } catch (err) {
    // eslint-disable-next-line no-console -- best-effort dev tooling; one warn beats a broken review.
    console.warn(`[warden:observability] OTEL bootstrap failed, telemetry off: ${formatErr(err)}`);
    _state = { kind: "off" };
  }
  return _state;
}

/** Whether the live Langfuse surface is active this process (keys present + SDK started). */
export function isObservabilityEnabled(): boolean {
  return ensureObservability().kind === "on";
}

/**
 * ADR-0048 §6 loopback allowlist. `true` for hosts that resolve on the local
 * box: `localhost` (+ `*.localhost`), the IPv4 loopback block `127.0.0.0/8`,
 * the IPv6 loopback `::1`, and the unspecified `0.0.0.0`. Anything else (LAN
 * IPs, Langfuse Cloud, …) is "remote" and gated behind
 * `WARDEN_LANGFUSE_ALLOW_REMOTE`. Unparseable URLs are treated as non-local.
 */
function isLocalHost(rawUrl: string): boolean {
  let hostname: string;
  try {
    // `URL` strips IPv6 brackets in `.hostname`, so `::1` arrives bare.
    hostname = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (hostname === "::1" || hostname === "0.0.0.0") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

export type ReviewTelemetryRole = "boss" | "worker";

export interface ReviewTelemetryContext {
  /** ADR-0048 §2 run-id — the Langfuse trace-grouping key. */
  runId: string;
  role: ReviewTelemetryRole;
  /** Worker concern (`correctness` / `security` / …). Omitted for the boss. */
  concern?: string;
  /** Resolved worker tier (`sonnet` / `haiku`). Omitted for the boss. */
  tier?: string;
  /** Primary file under review, when a single file dominates the dispatch. */
  file?: string;
}

/**
 * The AI SDK `experimental_telemetry` settings object. Typed structurally
 * (not against the AI SDK's `TelemetrySettings`) so `@warden/core` can spread
 * it into `streamText({ experimental_telemetry })` without importing the AI
 * SDK type surface twice.
 */
export interface ReviewTelemetrySettings {
  isEnabled: boolean;
  functionId?: string;
  recordInputs?: boolean;
  recordOutputs?: boolean;
  metadata?: Record<string, AttributeValue>;
}

/**
 * Build the `experimental_telemetry` settings for one review `streamText`
 * call. Returns `{ isEnabled: false }` (a total no-op the AI SDK ignores) when
 * Langfuse keys are absent. When on: groups the call under the run-id's
 * Langfuse trace (`langfuseTraceId`), tags it by role/concern/tier/file for
 * cross-run filtering, and records prompt/completion I/O only when capture is
 * on.
 */
export function buildReviewTelemetry(ctx: ReviewTelemetryContext): ReviewTelemetrySettings {
  const state = ensureObservability();
  if (state.kind !== "on") return { isEnabled: false };
  const metadata: Record<string, AttributeValue> = {
    // Group every boss + worker call in this review into one Langfuse trace.
    langfuseTraceId: ctx.runId,
    "warden.runId": ctx.runId,
    "warden.role": ctx.role,
  };
  if (ctx.concern !== undefined) metadata["warden.concern"] = ctx.concern;
  if (ctx.tier !== undefined) metadata["warden.tier"] = ctx.tier;
  if (ctx.file !== undefined) metadata["warden.file"] = ctx.file;
  return {
    isEnabled: true,
    functionId: ctx.concern ? `warden.review.${ctx.role}.${ctx.concern}` : `warden.review.${ctx.role}`,
    recordInputs: state.captureIo,
    recordOutputs: state.captureIo,
    metadata,
  };
}

/**
 * ADR-0048 §4 — record a dropped candidate as a standalone Langfuse
 * observation grouped under the review's run-id trace.
 *
 * Why a fresh span and not `getActiveSpan().addEvent(...)`:
 *   1. The `langfuse-vercel` exporter maps OTEL *span attributes* into Langfuse
 *      observations and never reads span *events* — `addEvent` is dropped on
 *      the floor.
 *   2. Every drop call site runs *outside* any active LLM-call span anyway:
 *      the off-hunk scope pass is post-boss-loop, and the uncited pass fires
 *      after the worker stream has already closed. There is no ambient span to
 *      attach to.
 *
 * So we mint our own span on the AI-SDK-named tracer (the exporter's
 * `isAiSdkSpan` filter drops every other instrumentation scope) and carry the
 * run-id as `langfuseTraceId` so it lands in the right trace. `langfuseUpdate
 * Parent=false` attaches the observation without overwriting the trace's
 * name/I/O. No-op when telemetry is off.
 *
 * `reason` is one of ADR-0044 §7's deterministic-transform kinds
 * (`lane` / `uncited` / `off-hunk` / `volume-cap` / `degrade`).
 */
export function recordDroppedCandidate(
  reason: string,
  ctx: { runId: string; attrs?: Record<string, AttributeValue> },
): void {
  if (!isObservabilityEnabled()) return;
  // The instrumentation scope MUST be "ai" — `langfuse-vercel`'s `isAiSdkSpan`
  // ignores spans from any other tracer.
  const span = trace.getTracer("ai").startSpan("warden.dropped_candidate");
  span.setAttributes({
    "ai.telemetry.metadata.langfuseTraceId": ctx.runId,
    "ai.telemetry.metadata.langfuseUpdateParent": false,
    "ai.telemetry.metadata.warden.runId": ctx.runId,
    "ai.telemetry.metadata.warden.drop_reason": reason,
  });
  for (const [key, value] of Object.entries(ctx.attrs ?? {})) {
    span.setAttribute(`ai.telemetry.metadata.${key}`, value);
  }
  span.end();
}

/**
 * Force-flush + shut down the OTEL SDK. The CLI is a short-lived process, so
 * without this in-flight spans are lost (§3). Best-effort: swallows errors and
 * is safe to call when telemetry never started.
 */
export async function shutdownObservability(): Promise<void> {
  if (_state.kind !== "on") return;
  try {
    await _state.sdk.shutdown();
  } catch (err) {
    // eslint-disable-next-line no-console -- flush failure is dev-tooling noise, not a review failure.
    console.warn(`[warden:observability] OTEL shutdown failed: ${formatErr(err)}`);
  }
}

function formatErr(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 200);
  return String(err).slice(0, 200);
}
