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
 * in the per-tool schema so clients can detect it.
 */
export const TOOL_ENVELOPE_VERSION = 1 as const;

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
  "internal_error",
] as const;

export type ToolErrorReason = (typeof TOOL_ERROR_REASONS)[number];

export const ToolErrorReasonSchema = z.enum(TOOL_ERROR_REASONS);

/**
 * Successful result. `data` is deliberately a loose record here — each tool
 * owns its own `data` schema and exports it (see `tools/lookup-type-def.ts`),
 * so the envelope stays transport-level and the tool-level schema stays
 * testable on its own.
 */
export const ToolResultEnvelopeSchema = z.object({
  /** Envelope contract version. See `TOOL_ENVELOPE_VERSION`. */
  envelopeVersion: z.literal(TOOL_ENVELOPE_VERSION),
  tool: z.string(),
  status: z.enum(["ok", "error"]),
  /** Present iff `status === "ok"`. */
  data: z.record(z.string(), z.unknown()).optional(),
  /** Present iff `status === "error"`. */
  reason: ToolErrorReasonSchema.optional(),
  /** Human-actionable half of an error. Never the only channel — a model reads `reason`. */
  hint: z.string().optional(),
});

export type ToolResultEnvelope = z.infer<typeof ToolResultEnvelopeSchema>;

export function okEnvelope(tool: string, data: Record<string, unknown>): ToolResultEnvelope {
  return { envelopeVersion: TOOL_ENVELOPE_VERSION, tool, status: "ok", data };
}

export function errorEnvelope(
  tool: string,
  reason: ToolErrorReason,
  hint?: string,
): ToolResultEnvelope {
  return {
    envelopeVersion: TOOL_ENVELOPE_VERSION,
    tool,
    status: "error",
    reason,
    ...(hint === undefined ? {} : { hint }),
  };
}

/**
 * Run `fn`, converting any thrown error into a structured `internal_error`
 * envelope. This is the ADR-0053 §5(c) "degrade, don't throw" rule enforced at
 * the single boundary every tool call passes through, rather than trusting each
 * tool to remember.
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
): Promise<ToolResultEnvelope> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorEnvelope(tool, "internal_error", message);
  }
}

/** Render an envelope as MCP tool content: one JSON text block. */
export function envelopeToContent(envelope: ToolResultEnvelope): {
  content: { type: "text"; text: string }[];
  isError: boolean;
} {
  let text = JSON.stringify(envelope, null, 2);
  if (Buffer.byteLength(text, "utf8") > MAX_TOOL_RESULT_BYTES) {
    // Never truncate citation snippets: a partial citation is not ground truth.
    // Bound even an unknown client-supplied tool name in the fallback envelope.
    text = JSON.stringify(
      errorEnvelope(
        envelope.tool.slice(0, 128),
        "internal_error",
        `Tool result exceeds the ${MAX_TOOL_RESULT_BYTES}-byte content limit. Try a narrower symbol.`,
      ),
      null,
      2,
    );
  }
  return {
    content: [{ type: "text", text }],
    // A structured error is still a *successful* protocol call — the tool ran
    // and reported a degraded result. Marking isError would make clients
    // discard the envelope instead of branching on `reason`.
    isError: false,
  };
}
