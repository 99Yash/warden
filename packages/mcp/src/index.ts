/**
 * `@warden/mcp` — Warden's MCP tool-provider (ADR-0053 §2/§3).
 *
 * A thin protocol wrapper over `@warden/core`'s exported deterministic
 * capabilities. It exists so `@warden/core` stays I/O-pure and free of any MCP
 * dependency: this package owns the transport, the tool descriptors, and the
 * versioned result envelopes, and does nothing else.
 */

export {
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  createMcpServer,
  startMcpServer,
  type StartMcpServerOptions,
} from "./server.js";

export {
  MAX_TOOL_RESULT_BYTES,
  TOOL_ENVELOPE_VERSION,
  TOOL_ERROR_REASONS,
  TOOL_NAME_LOOKUP_TYPE_DEF,
  ToolErrorReasonSchema,
  ToolResultEnvelopeSchema,
  toolResultEnvelopeSchema,
  degrade,
  envelopeToContent,
  errorEnvelope,
  okEnvelope,
  type ToolErrorReason,
  type ToolResultEnvelope,
} from "./envelope.js";

export {
  LookupTypeDefInputSchema,
  LookupTypeDefResultSchema,
  runLookupTypeDef,
  type LookupTypeDefInput,
} from "./tools/lookup-type-def.js";
