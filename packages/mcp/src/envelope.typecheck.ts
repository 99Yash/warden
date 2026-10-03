import { TOOL_ENVELOPE_VERSION, type ToolResultEnvelope } from "./envelope.js";

// Compile-only regressions. These directives become errors if the public
// envelope type ever permits incomplete or mixed branches again.
const common = { envelopeVersion: TOOL_ENVELOPE_VERSION, tool: "lookup_type_def" };

// @ts-expect-error A success must carry data.
const missingData: ToolResultEnvelope = { ...common, status: "ok" };
// @ts-expect-error An error must carry a reason.
const missingReason: ToolResultEnvelope = { ...common, status: "error" };
const mixedErrorCandidate = {
  ...common,
  status: "error" as const,
  reason: "internal_error" as const,
  data: {},
};
// @ts-expect-error Error and success payloads are mutually exclusive.
const mixedError: ToolResultEnvelope = mixedErrorCandidate;
const mixedSuccessCandidate = {
  ...common,
  status: "ok" as const,
  data: {},
  reason: "internal_error" as const,
};
// @ts-expect-error A success cannot carry an error reason.
const mixedSuccess: ToolResultEnvelope = mixedSuccessCandidate;

void [missingData, missingReason, mixedError, mixedSuccess];
