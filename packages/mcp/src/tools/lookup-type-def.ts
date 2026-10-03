import { lookupTypeDef, SuggestedApiDefSourceSchema, type LookupTypeDefResult } from "@warden/core";
import { z } from "zod";
import {
  TOOL_NAME_LOOKUP_TYPE_DEF,
  errorEnvelope,
  okEnvelope,
  type ToolErrorReason,
  type ToolResultEnvelope,
} from "../envelope.js";

/**
 * `lookup_type_def` — ADR-0053 §5's model-invoked tool, backed by the existing
 * M11/ADR-0026 `.d.ts` resolver.
 *
 * The smallest possible tool: it proves the transport, tool discovery, the
 * result envelope, and the degradation path end-to-end without dragging a new
 * dependency surface into the engine.
 *
 * Two properties are inherited from the resolver and are the reason this tool
 * is worth exposing at all:
 *
 * - **The citation is pre-shaped.** The resolver returns a `suggestedSource`
 *   the caller copies verbatim, because hand-assembling `Source` fields is a
 *   documented LLM failure mode (ADR-0026 §11). We pass it through untouched.
 * - **Negative results are structured.** The resolver already returns a closed
 *   `reason` union; we map it onto the envelope's `reason` rather than
 *   flattening it to prose.
 */

export const LookupTypeDefInputSchema = z.object({
  /** Import path of the package, subpath included (`drizzle-orm`, `ai/tool`). */
  package: z.string().min(1).describe("Import path of the installed package, subpaths included."),
  symbol: z.string().min(1).describe("Exported symbol to resolve, e.g. `streamText`."),
});

export type LookupTypeDefInput = z.infer<typeof LookupTypeDefInputSchema>;

/**
 * Tool result schema, exported so a client (and the smoke test) can validate
 * against the same definition the server advertises.
 */
export const LookupTypeDefResultSchema = z.strictObject({
  found: z.literal(true),
  package: z.string(),
  version: z.string(),
  symbol: z.string(),
  signature: z.string(),
  kind: z.enum([
    "function",
    "class",
    "interface",
    "type",
    "variable",
    "namespace",
    "method",
    "property",
    "enum",
  ]),
  jsdoc: z.string().nullable(),
  dts_file: z.string(),
  line_start: z.number(),
  line_end: z.number(),
  suggestedSource: SuggestedApiDefSourceSchema,
}) satisfies z.ZodType<Extract<LookupTypeDefResult, { found: true }>>;

/**
 * Map the resolver's not-found reasons onto the envelope's closed union.
 * `lookup_error` is the resolver's own catch-all and maps straight across; an
 * unrecognised value degrades to it rather than widening the union.
 */
function mapNotFoundReason(reason: string): ToolErrorReason {
  switch (reason) {
    case "package_not_installed":
    case "no_types":
    case "symbol_not_found":
    case "lookup_error":
      return reason;
    default:
      return "lookup_error";
  }
}

/** Actionable half of a negative lookup, per reason. */
function notFoundHint(pkg: string, symbol: string, reason: ToolErrorReason): string {
  switch (reason) {
    case "package_not_installed":
      return `No installed copy of "${pkg}" was found. Check the import path, or run the index/build so its node_modules is populated.`;
    case "no_types":
      return `"${pkg}" ships no type declarations, so "${symbol}" cannot be resolved from a .d.ts. Check the package's exports map.`;
    case "symbol_not_found":
      return `"${symbol}" is not exported from "${pkg}"'s type declarations. Verify the exact exported name.`;
    case "lookup_error":
      return `Resolution of "${symbol}" in "${pkg}" failed. The resolver caught an error; re-run with a different symbol or check the package's layout.`;
    default:
      return `Lookup of "${symbol}" in "${pkg}" did not resolve.`;
  }
}

export async function runLookupTypeDef(
  repoRoot: string,
  input: unknown,
): Promise<ToolResultEnvelope> {
  const parsed = LookupTypeDefInputSchema.safeParse(input);
  if (!parsed.success) {
    return errorEnvelope(
      TOOL_NAME_LOOKUP_TYPE_DEF,
      "invalid_input",
      `Expected { package, symbol } as non-empty strings; got ${parsed.error.message}`,
    );
  }

  const { package: pkg, symbol } = parsed.data;

  const result = await lookupTypeDef(repoRoot, pkg, symbol);

  // A negative lookup is a *correct, complete* answer — the symbol may
  // genuinely not exist. It rides the error envelope so a client can branch
  // on `reason`, but it is not a protocol failure and not `internal_error`.
  if (!result.found) {
    const reason = mapNotFoundReason(result.reason);
    return errorEnvelope(TOOL_NAME_LOOKUP_TYPE_DEF, reason, notFoundHint(pkg, symbol, reason));
  }

  return okEnvelope(TOOL_NAME_LOOKUP_TYPE_DEF, result);
}
