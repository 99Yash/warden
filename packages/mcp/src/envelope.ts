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

/** ADR-0053 §5(a): cap each JSON tool-content block, measured as UTF-8 bytes. */
export const MAX_TOOL_RESULT_BYTES = 16 * 1024;

export const TOOL_NAME_LOOKUP_TYPE_DEF = "lookup_type_def" as const;

/** Structured failure reasons. Closed union so clients can branch. */
export const TOOL_ERROR_REASONS = [
  "invalid_input",
  "package_not_installed",
  "no_types",
  "symbol_not_found",
  "lookup_error",
  "result_too_large",
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
        `Tool result exceeds the ${MAX_TOOL_RESULT_BYTES}-byte content limit. Read the package's local .d.ts files in node_modules directly; this single-symbol result cannot be returned without truncating its citation.`,
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
    isError:
      serialized.status === "error" &&
      !["package_not_installed", "no_types", "symbol_not_found"].includes(serialized.reason),
  };
}
