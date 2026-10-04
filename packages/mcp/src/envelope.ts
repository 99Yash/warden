import { z } from "zod";

/**
 * Tool result envelopes — ADR-0053 §5.
 *
 * Every tool result crosses a process boundary to a model that was not written
 * against this code, so three properties are non-negotiable:
 *
 * - **Versioned.** A runtime upgrade must not silently change a result's shape.
 *   The version is a first-class field, not a comment.
 * - **Degrading, never throwing.** One unavailable detector must not fail a
 *   whole review. A tool that throws across the transport hands the client an
 *   opaque protocol error with no way to degrade, so every failure mode is a
 *   structured `status: "error"` result instead.
 * - **Self-describing.** `reason` is a closed union, not free text, so a client
 *   can branch on it. `hint` carries the actionable half for a human.
 */

/**
 * Bump `TOOL_ENVELOPE_VERSION` whenever the *shape* of any envelope changes —
 * a new required field, a renamed field, a narrowed enum. Adding an optional
 * field is additive and does not require a bump, but should still be reflected
 * in the per-tool schema so clients can detect it. Validation cannot prove a
 * version bump happened: that remains a human review responsibility.
 */
// Version 2 narrows the accepted contract to complete, exclusive branches.
export const TOOL_ENVELOPE_VERSION = 2 as const;

/**
 * Hard byte backstop per JSON tool-content block, measured as UTF-8 bytes.
 *
 * Raised 16 KiB → 64 KiB on 2026-10-03 with a measurement behind it. The old
 * value was not a safety rail but a tripwire on normal input: `runDetPriors` on
 * a 332-file diff produces 86,304 B even in its leanest defensible shape, so
 * the 16 KiB cap made `envelopeToContent` substitute a `result_too_large`
 * envelope and return *no review at all* for any substantial change. This is
 * the opposite of §5(c)'s degrading intent.
 *
 * It is now a **backstop, not the sizing mechanism**. Results are bounded by
 * construction — `BUNDLE_LIMITS` in `@warden/core` caps each component, reserves
 * room for findings, and emits an explicit omitted-count plus an unretrievable
 * count — so this constant only fires on pathological single-item payloads. It
 * has no asserted worst-case figure: the previous "~30 KB" was never measured.
 * Raising it does not license an unbounded return shape; it is the last line of
 * defence, not the first.
 */
export const MAX_TOOL_RESULT_BYTES = 64 * 1024;

export const TOOL_NAME_LOOKUP_TYPE_DEF = "lookup_type_def" as const;
export const TOOL_NAME_RUN_DET_PRIORS = "run_det_priors" as const;

/** Structured failure reasons. Closed union so clients can branch. */
export const TOOL_ERROR_REASONS = [
  "invalid_input",
  "package_not_installed",
  "no_types",
  "symbol_not_found",
  "lookup_error",
  "result_too_large",
  /**
   * A paging cursor referenced a Phase 1 result the server no longer holds —
   * evicted from the bounded LRU, or the server restarted since the first page.
   * Carries `isError: true`: the page was not delivered. `runDetPriors` shells
   * out to `tsc`/`eslint`/`jscpd`, so the recovery (re-issue the original target)
   * is not free, which is why the cursor rides a retained result at all.
   */
  "review_expired",
  "internal_error",
] as const;

export type ToolErrorReason = (typeof TOOL_ERROR_REASONS)[number];

export const ToolErrorReasonSchema = z.enum(TOOL_ERROR_REASONS);

/** Each descriptor binds its success data to the same exclusive envelope. */
export function toolResultEnvelopeSchema<Data extends Record<string, unknown>>(
  dataSchema: z.ZodType<Data>,
  toolSchema: z.ZodType<string> = z.string(),
) {
  const common = {
    envelopeVersion: z.literal(TOOL_ENVELOPE_VERSION),
    tool: toolSchema,
  };
  return z.discriminatedUnion("status", [
    z.strictObject({
      ...common,
      status: z.literal("ok"),
      data: dataSchema,
      reason: z.never().optional(),
      hint: z.never().optional(),
    }),
    z.strictObject({
      ...common,
      status: z.literal("error"),
      reason: ToolErrorReasonSchema,
      hint: z.string().optional(),
      data: z.never().optional(),
    }),
  ]);
}

export const ToolResultEnvelopeSchema = toolResultEnvelopeSchema(z.record(z.string(), z.unknown()));

export type ToolResultEnvelope = z.infer<typeof ToolResultEnvelopeSchema>;

export function okEnvelope<Data extends Record<string, unknown>>(tool: string, data: Data) {
  return { envelopeVersion: TOOL_ENVELOPE_VERSION, tool, status: "ok" as const, data };
}

export function errorEnvelope(
  tool: string,
  reason: ToolErrorReason,
  hint?: string,
): Extract<ToolResultEnvelope, { status: "error" }> {
  return {
    envelopeVersion: TOOL_ENVELOPE_VERSION,
    tool,
    status: "error",
    reason,
    ...(hint === undefined ? {} : { hint }),
  };
}

/**
 * Server dispatch boundary: run the handler, validate its full result, and
 * serialize it inside the same try. Tools must not own this wrapper.
 *
 * `fn` returns an envelope directly rather than bare data, so a tool can
 * return a *structured* not-found — a legitimate complete answer, `status:
 * "error"` with a real `reason` — without signalling it by throwing. Throwing
 * stays reserved for the genuinely unexpected.
 *
 * `hint` deliberately carries the error *message*: it is the actionable half for
 * whoever debugs the review, and it never carries a stack.
 */
export async function degrade(
  tool: string,
  fn: () => Promise<ToolResultEnvelope>,
  schema: z.ZodType<ToolResultEnvelope> = ToolResultEnvelopeSchema,
): Promise<ToolContent> {
  try {
    return envelopeToContent(schema.parse(await fn()), schema);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return envelopeToContent(errorEnvelope(tool, "internal_error", message));
  }
}

export type ToolContent = {
  content: { type: "text"; text: string }[];
  structuredContent: ToolResultEnvelope;
  isError: boolean;
};

/** Render and validate the actual wire value, not just the pre-JSON object. */
export function envelopeToContent(
  envelope: ToolResultEnvelope,
  schema: z.ZodType<ToolResultEnvelope> = ToolResultEnvelopeSchema,
): ToolContent {
  let text = JSON.stringify(envelope, null, 2);
  if (Buffer.byteLength(text, "utf8") > MAX_TOOL_RESULT_BYTES) {
    // Never truncate citation snippets: a partial citation is not ground truth.
    // Bound even an unknown client-supplied tool name in the fallback envelope.
    text = JSON.stringify(
      errorEnvelope(
        envelope.tool.slice(0, 128),
        "result_too_large",
        `Tool result exceeds the ${MAX_TOOL_RESULT_BYTES}-byte content limit. That limit is a backstop against a pathologically large single item, not the normal size budget — results are capped per component and any omission is reported in \`omissions\`. Read the package's local .d.ts files in node_modules directly, or narrow the request.`,
      ),
      null,
      2,
    );
  }
  const serialized = schema.parse(JSON.parse(text));
  return {
    content: [{ type: "text", text }],
    structuredContent: serialized,
    // Domain negatives completed the lookup. Operational failures should drive
    // standard MCP client recovery; isError does not discard recovery content.
    //
    // `review_expired` is deliberately NOT in the non-error list. Round 0 argued
    // the other way and won: unlike determining a symbol is absent — a complete
    // answer — an expired cursor means the requested page was never delivered.
    // That is failed tool execution, and reporting it as success is how a client
    // ends up treating "I could not fetch the rest" as "there was nothing else."
    isError:
      serialized.status === "error" &&
      !["package_not_installed", "no_types", "symbol_not_found"].includes(serialized.reason),
  };
}
