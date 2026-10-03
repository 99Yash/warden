import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { type ZodType, z } from "zod";
import {
  TOOL_NAME_LOOKUP_TYPE_DEF,
  TOOL_ENVELOPE_VERSION,
  envelopeToContent,
  type ToolResultEnvelope,
} from "./envelope.js";
import { LookupTypeDefInputSchema, runLookupTypeDef } from "./tools/lookup-type-def.js";

/**
 * Warden's MCP server — ADR-0053 §2/§3.
 *
 * Transport and tool descriptors live in this package so `@warden/core` stays
 * I/O-pure and free of any MCP dependency (ADR-0013). The server is a *wrapper
 * client of core*, exactly like `@warden/cli` — it consumes exported functions
 * and adds a protocol boundary, nothing more.
 *
 * Scope for this slice is deliberately one tool. MCP tool schemas are injected
 * into the client's context window, so the surface stays small until there is
 * a reason to grow it (ADR-0053 §5a).
 */

export const MCP_SERVER_NAME = "warden";
export const MCP_SERVER_VERSION = "0.0.1";

/**
 * Tool descriptors. Kept as data rather than closures so the advertised schema
 * and the handler cannot drift — one source, two projections.
 */
const TOOL_DEFINITIONS = [
  {
    name: TOOL_NAME_LOOKUP_TYPE_DEF,
    description:
      "Resolve an exported symbol's TypeScript declaration from an installed package's .d.ts files. " +
      "Returns the signature, kind, JSDoc, file and line range, plus a pre-shaped `suggestedSource` " +
      "citation to copy verbatim. Use before claiming an API's shape — this is ground truth, not a guess. " +
      "A negative result is a complete answer, not a failure: branch on the returned `reason`.",
    inputSchema: LookupTypeDefInputSchema,
    handler: runLookupTypeDef,
  },
] as const;

/**
 * Convert a tool's zod input schema to the JSON Schema MCP advertises.
 *
 * `Tool.inputSchema` is a plain JSON Schema object (the SDK validates listings
 * against `ToolSchema`, which types `inputSchema` as `{ type: "object", … }`) —
 * it does *not* accept a zod raw shape the way older SDK versions did. Zod 4
 * ships `z.toJSONSchema` natively, so this needs no extra dependency and no
 * vendored converter.
 *
 * `io: "input"` is the correct direction: what the *model* must send. Using the
 * output direction would advertise the response shape as the request shape.
 * `$schema` is dropped because MCP clients do not expect it in a tool schema.
 */
function toInputJsonSchema(schema: ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io: "input" });
  return rest as Record<string, unknown>;
}

export interface StartMcpServerOptions {
  /** Repository root the tools resolve against. Defaults to the launch cwd. */
  repoRoot?: string;
}

export function createMcpServer(repoRoot: string): Server {
  const server = new Server(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: toInputJsonSchema(tool.inputSchema),
    })),
  }));

  server.setRequestHandler(
    CallToolRequestSchema,
    async (
      request,
    ): Promise<{
      content: { type: "text"; text: string }[];
      isError: boolean;
    }> => {
      const name = request.params.name;
      const tool = TOOL_DEFINITIONS.find((t) => t.name === name);

      if (tool === undefined) {
        // An unknown tool name is a client error, not a degraded result — but it
        // still returns an envelope rather than a protocol throw, so a client
        // that probes for an optional tool degrades instead of erroring out.
        const envelope: ToolResultEnvelope = {
          envelopeVersion: TOOL_ENVELOPE_VERSION,
          tool: name,
          status: "error",
          reason: "invalid_input",
          hint: `Unknown tool "${name}". Available: ${TOOL_DEFINITIONS.map((t) => t.name).join(", ")}.`,
        };
        return envelopeToContent(envelope);
      }

      return envelopeToContent(await tool.handler(repoRoot, request.params.arguments));
    },
  );

  return server;
}

/** Start the server on stdio and resolve when it disconnects. */
export async function startMcpServer(options: StartMcpServerOptions = {}): Promise<void> {
  const repoRoot = options.repoRoot ?? process.cwd();
  const server = createMcpServer(repoRoot);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdio is the lifetime: when the client closes the pipe the transport
  // closes, and the process is free to exit. Nothing to tear down by hand.
}
